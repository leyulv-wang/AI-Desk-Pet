/**
 * 长期记忆 —— 事实抽取 + 混合召回（BM25 ⊕ Embedding，RRF 融合）
 *
 * 设计参考 N.E.K.O.（B站「猫娘计划」，Apache-2.0）的记忆架构，按个人规模裁剪。
 *
 *   对话结束 → 后台抽取「持久事实」→ facts.json → 下次对话时召回注入人格 prompt
 *
 * 四条刻意的取舍：
 *   - **绝不在用户等回复时抽取**。抽取一律延后到空闲，失败也不阻塞对话。
 *   - **只抽「长期仍然成立」的事实**。"今天很累"不该进记忆，"用户在做桌宠项目"该进。
 *   - **混合召回**：BM25（词面）+ Embedding（语义）各自排名后用 RRF 融合。
 *     N.E.K.O. 就是这么做的，理由是单靠任一种都有明显盲区：
 *     BM25 对同义改写无力，Embedding 对专名/数字不敏感。
 *   - **Embedding 不可用时自动降级为纯 BM25**，绝不让记忆层成为单点故障。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// ---------------------------------------------------------------- 分词 / BM25

/**
 * 字符 bigram + unigram。
 * 中文没有空格，bigram 是最省事又够用的方案（不用引入 jieba）。
 */
function tokenize(text) {
  const s = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const out = []
  for (let i = 0; i < s.length; i++) {
    out.push(s[i])
    if (i + 1 < s.length) out.push(s.slice(i, i + 2))
  }
  return out
}

const K1 = 1.2
const B = 0.75
/** RRF 的平滑常数，取业界常用的 60 */
const RRF_K = 60

// ---------------------------------------------------------------- 遗忘曲线

/**
 * 不同重要性的「半衰期」（天）。越重要衰减越慢。
 * 参考溪语 AI 的确定性遗忘曲线：重要事 90 天半衰、琐事 14 天，
 * 而且**不删数据，只降召回权重**。
 */
const HALF_LIFE_DAYS = { 5: 180, 4: 90, 3: 30, 2: 14, 1: 7 }
/** 衰减的下限 —— 再老也不会归零（她还是"记得"，只是不主动提） */
const MIN_STRENGTH = 0.2

/**
 * 一条事实当前的"强度" ∈ [0.2, 1]。
 *
 * 关键在锚点是 lastRecalledAt 而不是 createdAt：
 * **被用过的事实会回血** —— 这实际上就是间隔重复。
 * 经常被需要的事一直强，没人问的事慢慢淡出，但永远不会被删。
 */
function factStrength(fact, now = Date.now()) {
  const anchor = fact.lastRecalledAt || fact.createdAt || now
  const ageDays = Math.max(0, (now - anchor) / 86400000)
  const base = HALF_LIFE_DAYS[fact.importance] ?? 30
  // 被用过的次数越多，衰减越慢（对数增长，不会失控）
  const boost = 1 + Math.log1p(fact.recallCount || 0) * 0.6
  const halfLife = base * boost
  return Math.max(MIN_STRENGTH, Math.pow(0.5, ageDays / halfLife))
}

function bm25Rank(queryTokens, docs) {
  const N = docs.length
  if (!N || !queryTokens.length) return []
  const df = new Map()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1)
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1

  return docs
    .map((d, i) => {
      const tf = new Map()
      for (const t of d) tf.set(t, (tf.get(t) || 0) + 1)
      let score = 0
      for (const q of new Set(queryTokens)) {
        const f = tf.get(q)
        if (!f) continue
        const n = df.get(q) || 0
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
        score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.length) / avgdl))
      }
      return { i, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i)
}

/** bigram Jaccard，用于没有 embedding 时的快速去重 */
function similarity(a, b) {
  const A = new Set(tokenize(a).filter((t) => t.length === 2))
  const Bs = new Set(tokenize(b).filter((t) => t.length === 2))
  if (!A.size || !Bs.size) return 0
  let inter = 0
  for (const t of A) if (Bs.has(t)) inter++
  return inter / (A.size + Bs.size - inter)
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 超时就抛 —— 注意底层请求不会被取消，只是我们不再等它 */
function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label}超时（>${ms}ms）`)), ms)
      if (t.unref) t.unref()
    }),
  ])
}

/**
 * Reciprocal Rank Fusion —— 把多个「有序列表」融合成一个总排名。
 * 只看名次不看分数，所以 BM25 和余弦这两种量纲完全不同的分数可以直接融合。
 */
function rrf(lists, k = RRF_K) {
  const acc = new Map()
  for (const list of lists) {
    list.forEach((idx, rank) => {
      acc.set(idx, (acc.get(idx) || 0) + 1 / (k + rank + 1))
    })
  }
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([idx]) => idx)
}

// ---------------------------------------------------------------- 抽取提示词

const EXTRACT_SYSTEM = `你是一个记忆整理器。你的任务是从对话中抽取**关于用户的新增持久事实**。

只抽这些（长期仍然成立、以后还用得上的）：
- 偏好与喜好（喜欢什么、讨厌什么、习惯怎样）
- 身份与背景（职业、所在地、技能、设备、在做什么项目）
- 重要的人际关系与称呼
- 明确的观点、目标、计划

不要抽这些：
- 一次性的寒暄、感谢、玩笑
- 临时状态（"今天很累""现在饿了"）
- 助手自己说的话
- 从对话里推不出来的猜测

**用户消息里会给一份带编号的「已知事实」。请这样处理：**
- 清单里已经有的事，一个字都不要再输出
- 即使换了说法、缩写、同义词（比如"AI 桌宠"和"人工智能桌宠"），
  只要指的是同一件事，也不要输出
- **但如果新内容推翻了某条已知事实，就要输出一条表述当前状态的新事实，
  并用 "supersedes" 字段写上被推翻那条的编号。**
  例：已知 [2] 用户最喜欢的颜色是蓝色，用户说"我现在改喜欢绿色了" →
  {"text":"用户最喜欢的颜色是绿色","subject":"user","importance":4,"supersedes":2}
- 被推翻的只写新的那条，不要新旧都写

**关于未来要发生的事（开环）：**
如果用户提到一件**将来会发生、之后值得回访**的事（面试、考试、约会、
旅行、要交的东西、要见的人、在等的消息），就在事实里加一个 followUpAt 字段，
写**该回访的时间点**的 ISO 时间（YYYY-MM-DDTHH:mm），按用户消息里给的当前时间推算。
例：当前时间是 2026-09-20 周四 20:00，用户说"我明天下午三点有面试" →
{"text":"用户 2026-09-21 下午三点有一场面试","subject":"user","importance":4,"followUpAt":"2026-09-21T17:00"}
只有确实有明确时间点时才加这个字段，模糊的（"以后再说"）不要加。

**你这次输出的事实之间也不要互相重复或包含。**
比如不要同时输出"用户养了一只叫豆豆的猫"和"用户的猫叫豆豆"——
它们是同一件事，合并成信息最全的那一条。

输出要求：只输出 JSON 数组，不要任何解释、不要 markdown 代码块。
每项格式：
{"text":"...","subject":"user|pet|relationship","importance":1-5,"supersedes":编号(可选),"followUpAt":"ISO时间(可选)"}
importance：5=核心身份，4=稳定偏好，3=一般信息，1-2=琐碎。
没有新的可记的就输出 []。`

// ---------------------------------------------------------------- 主类

class Memory {
  /**
   * @param {object} opts
   * @param {string} opts.dir            存放目录
   * @param {function} opts.request      非流式对话：(messages) => Promise<string>
   * @param {function} [opts.embed]      向量化：(texts[]) => Promise<number[][]>，不给就退化
   * @param {string}   [opts.embedModel]  仅用于日志/统计
   * @param {function} opts.log
   */
  constructor({
    dir,
    request,
    embed = null,
    embedModel = '',
    vecMinScore = 0.4,
    vecMargin = 0.1,
    embedTimeoutMs = 800,
    decayEnabled = true,
    maxSurfaces = 2,
    log = console.log,
  }) {
    this.dir = dir
    this.request = request
    this.embed = embed
    this.embedModel = embedModel
    this.log = log
    /** 查询向量化的超时；超了本轮退回 BM25 */
    this.embedTimeoutMs = Number(embedTimeoutMs) || 800
    /** 遗忘曲线开关。关掉就是所有有效事实等权 */
    this.decayEnabled = decayEnabled !== false
    /** 一件开环的事最多主动提几次，提够了就不再念（防止变复读机） */
    this.maxSurfaces = Number(maxSurfaces) || 2
    /** 召回计数改了但还没落盘的标记 —— 避免每说一句话就写一次文件 */
    this._recallDirty = false
    this._recallSaveTimer = null

    /**
     * 向量召回的判定参数。这两个值跟 embedding 模型强相关：
     *   - text-embedding-v4 这类：不相关内容约 0.2~0.3，阈值 0.35 合适
     *   - Qwen3-Embedding 这类：基线偏高（不相关内容也有 0.5+），靠 margin 起作用
     * 都在 config.json 的 embedding.vecMinScore / vecMargin 里可调。
     */
    this.vecMinScore = Number(vecMinScore)
    this.vecMargin = Number(vecMargin)

    this.factsPath = path.join(dir, 'facts.json')
    this.pendingPath = path.join(dir, 'pending.json')
    this.embPath = path.join(dir, 'embeddings.json')

    this.facts = []
    this.pending = []
    /** factId -> number[] */
    this.embeddings = {}
    /** 当前向量的维度，只用来写进文件方便排查 */
    this.embDim = null

    this.busy = false
    this.embedding = false
    this.timer = null
    this.queryCache = new Map()   // 查询文本 -> 向量，避免同一句重复调用

    this.load()
  }

  // -------------------------------------------------------------- 持久化

  load() {
    this.facts = asArray(readJson(this.factsPath, []))
    this.pending = asArray(readJson(this.pendingPath, []))
    this.embeddings = this.loadEmbeddings()

    // 老数据补上时效字段（加「时效性」之前存的事实没有这些）
    let migrated = 0
    for (const f of this.facts) {
      if (f.invalidAt === undefined) { f.invalidAt = null; migrated++ }
      if (f.validFrom === undefined) f.validFrom = f.sourceAt || f.createdAt || 0
      if (f.supersededBy === undefined) f.supersededBy = null
      if (f.supersedes === undefined) f.supersedes = null
      // 遗忘曲线 / 开环记忆的字段
      if (f.lastRecalledAt === undefined) f.lastRecalledAt = null
      if (f.recallCount === undefined) f.recallCount = 0
      if (f.followUpAt === undefined) f.followUpAt = null
      if (f.surfacedCount === undefined) f.surfacedCount = 0
      if (f.lastSurfacedAt === undefined) f.lastSurfacedAt = null
      if (f.closedAt === undefined) f.closedAt = null
    }
    if (migrated) {
      this.log(`[memory] 为 ${migrated} 条老事实补上时效字段`)
      this.saveFacts()
    }

    // 清掉已被删除事实的残留向量
    const alive = new Set(this.facts.map((f) => f.id))
    let dropped = 0
    for (const id of Object.keys(this.embeddings)) {
      if (!alive.has(id)) { delete this.embeddings[id]; dropped++ }
    }

    const valid = this.facts.filter((f) => !f.invalidAt).length
    const withVec = this.facts.filter((f) => Array.isArray(this.embeddings[f.id])).length
    this.log(
      `[memory] 载入 ${this.facts.length} 条事实（${valid} 条有效 / ${this.facts.length - valid} 条已失效，` +
        `${withVec} 条有向量），${this.pending.length} 条待处理` +
        (dropped ? `，清理 ${dropped} 条孤儿向量` : '')
    )
  }

  /**
   * 读向量文件，并做**模型一致性检查**。
   *
   * 这一步不能省：不同 embedding 模型的向量空间是不通用的，
   * 换了模型还用旧向量去算余弦，得到的是一堆没有意义的分数
   * —— 而且不会报错，只会悄悄召回错东西。
   */
  loadEmbeddings() {
    const raw = readJson(this.embPath, null)
    if (!raw || typeof raw !== 'object') return {}

    // 新格式：{ model, vectors }
    if (raw.vectors && typeof raw.vectors === 'object') {
      if (raw.model && this.embedModel && raw.model !== this.embedModel) {
        this.log(
          `[memory] 向量模型变了（${raw.model} → ${this.embedModel}），旧向量作废，将重新生成`
        )
        return {}
      }
      return raw.vectors
    }

    // 旧格式：扁平的 { factId: [...] }，没有模型标记 —— 保守起见作废
    const keys = Object.keys(raw)
    if (keys.length && Array.isArray(raw[keys[0]])) {
      this.log('[memory] 检测到旧格式向量文件（没有模型标记），作废重算')
      return {}
    }
    return {}
  }

  get embeddingsEnabled() {
    return typeof this.embed === 'function'
  }

  saveFacts() { writeJson(this.factsPath, this.facts) }
  savePending() { writeJson(this.pendingPath, this.pending) }
  saveEmbeddings() {
    // 带上模型名 —— 下次换模型时才知道旧向量该作废。
    // 用紧凑格式：缩进会让这个文件膨胀近一倍（1024 维 × 几百条会到几十 MB），
    // 而且这文件是机器读的，不需要好看。
    writeJson(this.embPath, { model: this.embedModel, dim: this.embDim || null, vectors: this.embeddings }, 0)
  }

  // -------------------------------------------------------------- 向量化

  /** 给还没有向量的补上。分批调用，失败就留着下次再试。 */
  async embedMissing() {
    if (!this.embeddingsEnabled) return 0
    // 并发调用时复用同一个 Promise —— 否则后到的会静默返回 0，
    // 表现就是「补向量」按钮误报"没有需要补的"
    if (this._embedPromise) return this._embedPromise
    this._embedPromise = this._doEmbedMissing().finally(() => { this._embedPromise = null })
    return this._embedPromise
  }

  async _doEmbedMissing() {
    const todo = this.facts.filter((f) => !Array.isArray(this.embeddings[f.id]))
    if (!todo.length) return 0

    this.embedding = true
    let done = 0
    try {
      const BATCH = 10
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH)
        const vecs = await this.embed(batch.map((f) => f.text))
        if (!Array.isArray(vecs) || vecs.length !== batch.length) {
          throw new Error(`向量数量不匹配：要 ${batch.length} 得到 ${vecs?.length}`)
        }
        batch.forEach((f, j) => {
          const v = vecs[j]
          if (Array.isArray(v) && v.length) {
            this.embDim = v.length
            // 存 6 位小数就够了，能把文件体积压掉一大半
            this.embeddings[f.id] = v.map((x) => Math.round(x * 1e6) / 1e6)
            done++
          }
        })
      }
      if (done) this.saveEmbeddings()
      this.log(`[memory] 向量化完成，新增 ${done} 条`)
      // 有了向量就能识别「换了说法的同一件事」—— bigram 挡不住的那类
      const merged = this.dedupeByEmbedding()
      if (merged) this.log(`[memory] 语义去重：合并掉 ${merged} 条重复事实`)
    } catch (e) {
      // 失败保留未向量化状态，下次重试；不影响 BM25 召回
      this.log(`[memory] 向量化失败（将降级为 BM25）: ${e.message}`)
    } finally {
      this.embedding = false
    }
    return done
  }

  /**
   * 用向量做语义去重 —— 这是 bigram 做不到的部分。
   *
   * 实测要拦两类（bigram 相似度只有 0.6~0.7，会被当成两条不同的事实）：
   *
   *   ① 换说法的同一件事（余弦 ≥ 0.94）
   *      "用户养了一只叫豆豆的猫，性格很粘人" / "用户养了一只叫豆豆的猫，豆豆很粘人"
   *      "用户最近在做 AI 桌宠项目" / "用户正在做一个 AI 桌宠项目"
   *
   *   ② 包含关系（余弦 ≥ 0.85 且一条文字包含另一条）
   *      "用户叫小王" ⊂ "用户叫小王，是一名前端工程师"
   *      这类余弦只有 0.9 左右，光靠阈值拦不住，但显然该合并。
   *
   * 合并时保留信息更多的：包含关系下留长的那条；否则留先记住的。
   */
  dedupeByEmbedding(threshold = 0.94, containThreshold = 0.85) {
    // 只对仍然有效的事实做语义去重；已失效的留着不动
    const withVec = this.facts.filter((f) => !f.invalidAt && Array.isArray(this.embeddings[f.id]))
    if (withVec.length < 2) return 0

    const sorted = [...withVec].sort((a, b) => a.createdAt - b.createdAt)
    const drop = new Set()
    const norm = (s) => normalize(s)

    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]
      if (drop.has(a.id)) continue
      const na = norm(a.text)

      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]
        if (drop.has(b.id)) continue
        const nb = norm(b.text)

        const c = cosine(this.embeddings[a.id], this.embeddings[b.id])
        const contained = na.includes(nb) || nb.includes(na)
        const isDup = c >= threshold || (contained && c >= containThreshold)
        if (!isDup) continue

        // 保留信息更多的那个
        if (na.length >= nb.length) {
          drop.add(b.id)
        } else {
          drop.add(a.id)
          break            // a 没了，不用再拿它比
        }
      }
    }

    if (!drop.size) return 0
    this.facts = this.facts.filter((f) => !drop.has(f.id))
    for (const id of drop) delete this.embeddings[id]
    this.saveFacts()
    this.saveEmbeddings()
    return drop.size
  }

  /** 查询向量，带缓存 + 超时兜底 */
  async embedQuery(text) {
    if (!this.embeddingsEnabled) return null
    if (this.queryCache.has(text)) return this.queryCache.get(text)

    try {
      // 超时兜底：向量化有尾部延迟（实测某个模型中位 111ms 但最慢 2846ms），
      // 偶发卡顿比稳定慢更难受。超了就这一轮退回 BM25，不让人干等。
      const vecs = await withTimeout(this.embed([text]), this.embedTimeoutMs, '查询向量化')
      const v = vecs?.[0]
      if (Array.isArray(v) && v.length) {
        if (this.queryCache.size > 100) this.queryCache.clear()
        this.queryCache.set(text, v)
        return v
      }
    } catch (e) {
      this.log(`[memory] 查询向量化失败（本轮降级为 BM25）: ${e.message}`)
    }
    return null
  }

  // -------------------------------------------------------------- 写入侧

  /** 一轮对话结束后调用。只入队，不做任何网络请求。 */
  observe(userText, assistantText) {
    if (!userText || !userText.trim()) return
    this.pending.push({ user: userText, assistant: assistantText || '', ts: Date.now() })
    if (this.pending.length >= 8) this.schedule(1000)
    else this.schedule(30000)
  }

  schedule(delay) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.consolidate().catch(() => {})
    }, delay)
    if (this.timer.unref) this.timer.unref()
  }

  /** 把 pending 里的对话交给模型抽取事实，然后清空 pending */
  async consolidate() {
    // 提前返回必须留痕。这里曾经静默 return 过一次，结果「事实没抽出来」
    // 完全查不出断在哪一环（是压根没入队？还是在忙？还是没配 request？）。
    if (this.pending.length === 0) {
      this.log('[memory] 整理跳过：没有待处理的对话')
      return { added: 0 }
    }
    if (this.busy) {
      this.log(`[memory] 整理跳过：上一轮还在跑（积压 ${this.pending.length} 条）`)
      return { added: 0 }
    }
    if (!this.request) {
      this.log('[memory] 整理跳过：没有配置 request')
      return { added: 0 }
    }

    this.busy = true
    const batch = this.pending.slice()
    try {
      const transcript = batch
        .map((m) => `用户：${m.user}${m.assistant ? `\n助手：${m.assistant}` : ''}`)
        .join('\n')

      // 把「已经记过的事」带编号给模型，从源头避免重复抽取，
      // 并且让它能指认「这条推翻了上面哪一条」。
      // 这比事后靠相似度去重可靠得多 —— 向量分不清「换了个说法」和「改主意了」，
      // 但模型能分清。
      const known = this.facts.length
        ? this.recallRanked(transcript, 15).map((r) => r.fact)
        : []
      const knownBlock =
        `当前时间：${formatNow()}\n\n` +
        (known.length
          ? `已知事实（已经记过了，不要重复输出）：\n` +
            known.map((f, i) => `[${i + 1}] ${f.text}`).join('\n') +
            `\n\n对话：\n`
          : '对话：\n')

      const raw = await this.request([
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `${knownBlock}${transcript}` },
      ])

      const extracted = parseFacts(raw)
      const added = this.addFacts(extracted, batch[0]?.ts || Date.now(), known)

      this.pending = this.pending.slice(batch.length)
      this.savePending()
      this.log(
        `[memory] 整理 ${batch.length} 轮（带了 ${known.length} 条已知事实）→ 新增 ${added} 条` +
          `（共 ${this.facts.length} 条）`
      )

      // 顺手把向量补上（后台，不阻塞调用方）
      if (added) this.embedMissing().catch(() => {})

      return { added, total: this.facts.length }
    } catch (e) {
      this.log(`[memory] 整理失败（保留待处理）: ${e.message}`)
      return { added: 0, error: e.message }
    } finally {
      this.busy = false
    }
  }

  /**
   * 去重后写入，并处理「取代关系」。
   *
   * @param {Array} list        模型抽出的事实
   * @param {number} sourceAt   来源时间
   * @param {Array} knownList   刚才给模型的已知事实（数组下标 +1 就是 prompt 里的编号）
   */
  addFacts(list, sourceAt, knownList = []) {
    let added = 0
    let superseded = 0
    const now = Date.now()

    for (const f of list) {
      const text = String(f?.text || '').trim()
      if (!text || text.length < 4) continue

      // 解析模型指认的「被推翻的那条」
      const target = resolveSupersede(f?.supersedes, knownList)

      const hash = crypto.createHash('sha1').update(normalize(text)).digest('hex').slice(0, 16)
      if (this.facts.some((x) => x.hash === hash && !x.invalidAt)) continue

      // 阈值 0.72 是实测的：
      //   "用户最喜欢的颜色是蓝色" vs "用户最喜欢颜色是蓝色！" → 0.73（该合并）
      //   "用户喜欢蓝色" vs "用户喜欢蓝色和绿色"           → 0.63（不该合并）
      // 宁可漏合并也不误删 —— 漏了只是多一条冗余，误删是真丢信息。
      //
      // 例外：本条声明了要推翻某条已知事实时，跳过这条相似度闸门 ——
      // 否则「改成绿色了」可能因为跟「喜欢蓝色」长得像而被当成重复直接丢掉。
      const isCorrection = !!target
      if (!isCorrection && this.facts.some((x) => !x.invalidAt && similarity(x.text, text) > 0.72)) continue

      const fact = {
        id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        text,
        subject: ['user', 'pet', 'relationship'].includes(f?.subject) ? f.subject : 'user',
        importance: clampInt(f?.importance, 1, 5, 3),
        createdAt: now,
        sourceAt: sourceAt || now,
        hash,
        /** 这条事实从什么时候开始成立 */
        validFrom: sourceAt || now,
        /** 什么时候失效（null = 仍然有效） */
        invalidAt: null,
        /** 被哪条事实取代了 */
        supersededBy: null,
        /** 它取代了哪条事实 */
        supersedes: target ? target.id : null,

        // ---- 遗忘曲线 ----
        /** 上次被召回注入是什么时候（衰减锚点，被用就"回血"） */
        lastRecalledAt: null,
        /** 被召回注入过多少次 */
        recallCount: 0,

        // ---- 开环记忆 ----
        /** 该回访这件事的时间点；null = 不是开环 */
        followUpAt: parseFollowUp(f?.followUpAt, now),
        /** 已经主动提过几次 */
        surfacedCount: 0,
        /** 最后一次主动提是什么时候 */
        lastSurfacedAt: null,
        /** 了结时间（提够了、或者结果已知道） */
        closedAt: null,
      }

      // 真正地让旧事实退场 —— 不删除，只是标记失效（可审计，面板里也看得到）
      if (target && !target.invalidAt) {
        target.invalidAt = now
        target.supersededBy = fact.id
        superseded++
        this.log(`[memory] 「${target.text}」被「${text}」取代`)
      }

      this.facts.push(fact)
      added++
    }

    if (added) this.saveFacts()
    return added
  }

  /** 用户手动教的东西（绕过大模型抽取） */
  remember(text) {
    // 手动教的时候也让它跟已有事实比一比，给它一个指认取代对象的机会
    const known = this.recallRanked(text, 15).map((r) => r.fact)
    const added = this.addFacts([{ text, subject: 'user', importance: 4 }], Date.now(), known)
    if (added) this.embedMissing().catch(() => {})
    return added
  }

  /** 按 id 删除，或按文本近似匹配删除 */
  forget(idOrText) {
    const key = String(idOrText || '')
    if (!key) return 0
    const before = this.facts.length
    const kept = this.facts.filter((f) => {
      if (f.id === key) return false
      if (similarity(f.text, key) >= 0.8) return false
      return true
    })
    const removedIds = this.facts.filter((f) => !kept.includes(f)).map((f) => f.id)
    this.facts = kept
    for (const id of removedIds) delete this.embeddings[id]
    if (removedIds.length) { this.saveFacts(); this.saveEmbeddings() }
    return before - this.facts.length
  }

  clear() {
    const n = this.facts.length
    this.facts = []
    this.pending = []
    this.embeddings = {}
    this.queryCache.clear()
    this.saveFacts()
    this.savePending()
    this.saveEmbeddings()
    return n
  }

  // -------------------------------------------------------------- 读取侧

  /**
   * 召回：BM25 ⊕ Embedding，RRF 融合。
   * 两者都拿不到相关结果时，退回「最重要的几条」兜底。
   *
   * @param {string} query
   * @param {number} limit
   * @param {number[]|null} queryVec 已经算好的查询向量（避免重复调用）
   */
  recallRanked(query, limit = 6, queryVec = null) {
    if (!this.facts.length) return []

    // 只召回**仍然有效**的事实。
    // 失效的留在 facts.json 里只为可审计和面板展示，绝不进 prompt。
    const pool = this.facts.filter((f) => !f.invalidAt)
    if (!pool.length) return []

    const q = tokenize(query)
    const docs = pool.map((f) => tokenize(f.text))
    const bm25List = q.length ? bm25Rank(q, docs) : []

    // 向量那一路
    let vecList = []
    if (queryVec) {
      const scored = pool
        .map((f, i) => ({ i, s: cosine(queryVec, this.embeddings[f.id]) }))
        .filter((x) => Number.isFinite(x.s))
        .sort((a, b) => b.s - a.s)

      if (scored.length) {
        const top = scored[0].s
        // 光有绝对阈值不够 —— 不同 embedding 模型的相似度基线差很多。
        // 比如 Qwen3 上「猫」↔相关是 0.67，而↔完全不相关的句子也有 0.58，
        // 用固定阈值会把几乎所有事实都收进来，向量这一路就全是噪声。
        // 所以再加一条：只保留与最高分差距在 margin 以内的。
        vecList = scored
          .filter((x) => x.s >= this.vecMinScore && x.s >= top - this.vecMargin)
          .slice(0, limit * 2)
          .map((x) => x.i)
      }
    }

    // 没有任何相关信号 → 用重要性兜底，别让她完全失忆
    if (!bm25List.length && !vecList.length) {
      return [...pool]
        .map((fact) => ({ fact, s: factStrength(fact) * (fact.importance / 5) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, Math.min(3, limit))
        .map(({ fact }) => ({ fact, bm25Rank: null, vecRank: null, vecScore: null }))
    }

    // RRF 融合。这里不用 rrf() 那个只返回序号的版本，
    // 因为还要乘上遗忘曲线的强度重新排序。
    const now = Date.now()
    const acc = new Map()
    for (const list of [bm25List, vecList]) {
      list.forEach((idx, rank) => acc.set(idx, (acc.get(idx) || 0) + 1 / (RRF_K + rank + 1)))
    }
    const ranked = [...acc.entries()]
      .map(([i, rrfScore]) => {
        const fact = pool[i]
        const strength = this.decayEnabled ? factStrength(fact, now) : 1
        return { i, fact, strength, score: rrfScore * strength }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    const bm25Pos = new Map(bm25List.map((i, r) => [i, r + 1]))
    const vecPos = new Map(vecList.map((i, r) => [i, r + 1]))

    return ranked.map(({ i, fact, strength }) => ({
      fact,
      bm25Rank: bm25Pos.get(i) ?? null,
      vecRank: vecPos.get(i) ?? null,
      vecScore: queryVec ? cosine(queryVec, this.embeddings[fact.id]) : null,
      strength,
    }))
  }

  /** 同步版（只有 BM25），给不需要向量的地方用 */
  recall(query, limit = 3) {
    return this.recallRanked(query, limit).map((r) => r.fact)
  }

  async buildContextAsync(query, limit = 6) {
    // 一条事实都没有时，算查询向量是白花钱还白等 —— 直接短路
    if (!this.facts.length) return { text: '', picked: [], usedEmbedding: false, openLoops: [] }

    const qv = await this.embedQuery(query)
    const picked = this.recallRanked(query, limit, qv)

    // 被注入过就算"用到了" —— 回血，让衰减慢下来（间隔重复）
    this.markRecalled(picked.map((p) => p.fact))

    // 开环：有到点该回访的事就顺带提一句（最多一件，且提够次数就不再念）
    const loops = this.dueOpenLoops(1)

    const blocks = []
    if (picked.length) {
      const lines = picked.map((p) => `- ${p.fact.text}`).join('\n')
      blocks.push(
        `【你记得关于他的事】\n` +
          `（这些是以前聊天记下来的，自然地用，不要生硬罗列，也不要每次都说"我记得你…"）\n${lines}`
      )
    }
    if (loops.length) {
      const when = loops
        .map((f) => `${f.text}（${fmtRel(f.followUpAt)}）`)
        .join('\n')
      blocks.push(
        `【他之前提到还没了结的事】\n${when}\n` +
          `（可以自然地关心一下后续，但别硬拗、别说教、一次只提一件）`
      )
      this.markSurfaced(loops)
    }

    return {
      text: blocks.length ? '\n\n' + blocks.join('\n\n') : '',
      picked,
      usedEmbedding: !!qv,
      openLoops: loops,
    }
  }

  // -------------------------------------------------------------- 遗忘曲线

  /**
   * 标记这些事实"被用到了"。
   * 只改内存 + 打脏标记，延迟落盘 —— 否则每说一句话都要写一次 facts.json。
   */
  markRecalled(facts) {
    if (!facts?.length) return
    const now = Date.now()
    for (const f of facts) {
      f.lastRecalledAt = now
      f.recallCount = (f.recallCount || 0) + 1
    }
    this._recallDirty = true
    if (!this._recallSaveTimer) {
      this._recallSaveTimer = setTimeout(() => {
        this._recallSaveTimer = null
        if (this._recallDirty) { this._recallDirty = false; this.saveFacts() }
      }, 5000)
      if (this._recallSaveTimer.unref) this._recallSaveTimer.unref()
    }
  }

  /** 立即把还没落的召回计数写盘（退出前调一下） */
  flush() {
    if (this._recallSaveTimer) { clearTimeout(this._recallSaveTimer); this._recallSaveTimer = null }
    if (this._recallDirty) { this._recallDirty = false; this.saveFacts() }
  }

  // -------------------------------------------------------------- 开环记忆

  /**
   * 到点该回访、且还没提够次数的事。
   * 到期时间超过 2 天的（比如出门好几天没开电脑）也算该提 —— 但只提一次。
   */
  dueOpenLoops(limit = 1) {
    const now = Date.now()
    return this.facts
      .filter(
        (f) =>
          !f.invalidAt &&
          !f.closedAt &&
          f.followUpAt &&
          f.followUpAt <= now &&
          (f.surfacedCount || 0) < this.maxSurfaces
      )
      .sort((a, b) => a.followUpAt - b.followUpAt)
      .slice(0, limit)
  }

  markSurfaced(facts) {
    const now = Date.now()
    for (const f of facts) {
      f.surfacedCount = (f.surfacedCount || 0) + 1
      f.lastSurfacedAt = now
      // 提够了就自动了结，免得她一直念同一件事
      if (f.surfacedCount >= this.maxSurfaces) f.closedAt = now
    }
    this.saveFacts()
  }

  /** 手动了结一件开环的事 */
  closeLoop(id) {
    const f = this.facts.find((x) => x.id === id)
    if (!f) return 0
    f.closedAt = Date.now()
    this.saveFacts()
    return 1
  }

  stats() {
    const valid = this.facts.filter((f) => !f.invalidAt)
    const withVec = valid.filter((f) => Array.isArray(this.embeddings[f.id])).length
    const now = Date.now()
    const loops = valid.filter((f) => f.followUpAt && !f.closedAt)
    return {
      facts: this.facts.length,
      valid: valid.length,
      invalid: this.facts.length - valid.length,
      pending: this.pending.length,
      busy: this.busy,
      embedding: this.embedding,
      embedded: withVec,
      embedModel: this.embedModel,
      embeddingsEnabled: this.embeddingsEnabled,
      decayEnabled: this.decayEnabled,
      /** 开环：还没了结的未来事项，其中 due = 已经到点该提了 */
      openLoops: loops.length,
      openLoopsDue: loops.filter((f) => f.followUpAt <= now && (f.surfacedCount || 0) < this.maxSurfaces).length,
      /** 有效事实的平均强度，用来看遗忘曲线是不是在起作用 */
      avgStrength: valid.length
        ? valid.reduce((s, f) => s + (this.decayEnabled ? factStrength(f, now) : 1), 0) / valid.length
        : 1,
    }
  }
}

// ---------------------------------------------------------------- 工具

function asArray(v) { return Array.isArray(v) ? v : [] }

function normalize(s) {
  return String(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 给模型看的当前时间（带星期，方便它推算"明天""下周三"） */
function formatNow(ts = Date.now()) {
  const d = new Date(ts)
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${w} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "3 天后""2 小时前"这种相对说法，给 prompt 里标注开环事项用 */
function fmtRel(ts, now = Date.now()) {
  if (!ts) return ''
  const diff = ts - now
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60000)
  const hours = Math.round(abs / 3600000)
  const days = Math.round(abs / 86400000)
  const unit = mins < 60 ? `${mins} 分钟` : hours < 24 ? `${hours} 小时` : `${days} 天`
  return diff >= 0 ? `${unit}后` : `${unit}前`
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

/**
 * 把模型给回来的 supersedes 编号解析成具体的事实对象。
 * 宽容处理 "[3]" / "3" / "第 3 条" / 3 这些写法。
 */
function resolveSupersede(value, knownList) {
  if (value == null || !knownList?.length) return null
  const m = String(value).match(/\d+/)
  if (!m) return null
  const idx = Number(m[0])
  if (!Number.isFinite(idx) || idx < 1 || idx > knownList.length) return null
  const target = knownList[idx - 1]
  return target && !target.invalidAt ? target : null
}

/**
 * 解析模型给的 followUpAt。要求：
 *   - 能解析成合法时间
 *   - 在将来（超过 5 分钟，避免把"刚刚"当开环）
 *   - 不超过 180 天（太远的事现在提没意义）
 * 解析不了就返回 null —— 宁可不开环，也不要因为一个坏时间戳把记忆搞乱。
 *
 * 提示词要求 ISO 格式，但模型不一定听话，所以还兜底认几种常见写法：
 *   "2026-09-21 17:00"（不带时区，按本地时间理解）
 *   "明天 17:00" / "后天上午 9:30"
 */
function parseFollowUp(value, now = Date.now()) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null

  let ts = parseAbsolute(s, now)
  if (!Number.isFinite(ts)) ts = parseRelativeCN(s, now)
  if (!Number.isFinite(ts)) return null

  const delta = ts - now
  if (delta < 5 * 60 * 1000) return null
  if (delta > 180 * 86400000) return null
  return ts
}

function parseAbsolute(s, now) {
  let ts = Date.parse(s)
  if (Number.isFinite(ts)) return ts
  // 各平台对 "2026-09-21 17:00" 这种不带时区的写法处理不一致，自己解析
  const m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/)
  if (!m) return NaN
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0).getTime()
}

/** "今天/明天/后天/大后天 + [上午|下午|晚上] + H:MM" */
function parseRelativeCN(s, now) {
  const dayMap = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }
  const dayMatch = s.match(/今天|明天|后天|大后天/)
  if (!dayMatch) return NaN

  const timeMatch = s.match(/(\d{1,2})[:：点时](\d{2})?/)
  if (!timeMatch) return NaN

  let hour = Number(timeMatch[1])
  const min = timeMatch[2] ? Number(timeMatch[2]) : 0
  if (/下午|晚上|傍晚/.test(s) && hour < 12) hour += 12
  if (/凌晨|早上|上午/.test(s) && hour === 12) hour = 0
  if (hour > 23 || min > 59) return NaN

  const base = new Date(now)
  base.setDate(base.getDate() + dayMap[dayMatch[0]])
  base.setHours(hour, min, 0, 0)
  return base.getTime()
}

/** 模型经常把 JSON 包在 ``` 里或者前后带话，尽量宽容地抠出来 */
function parseFacts(raw) {
  if (!raw) return []
  let s = String(raw).trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  const tryParse = (t) => {
    try {
      const j = JSON.parse(t)
      return Array.isArray(j) ? j : Array.isArray(j?.facts) ? j.facts : null
    } catch { return null }
  }

  let parsed = tryParse(s)
  if (!parsed) {
    const a = s.indexOf('[')
    const b = s.lastIndexOf(']')
    if (a !== -1 && b > a) parsed = tryParse(s.slice(a, b + 1))
  }
  if (!parsed) return []
  return parsed.filter((x) => x && typeof x.text === 'string')
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return fallback }
}

function writeJson(file, data, indent = 2) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, indent))
    return true
  } catch { return false }
}

module.exports = { Memory, tokenize, similarity, cosine, rrf, bm25Rank }
