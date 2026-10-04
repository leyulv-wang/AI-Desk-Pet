/**
 * 会话历史的分层压缩
 *
 * 解决的问题：现在只把「最近 N 条原文」塞给模型，更早的对话直接丢了。
 * 聊得越久，她越不记得前面聊过什么 —— 而且这件事没法靠加窗口解决，
 * 上下文总有上限。
 *
 * 做法借了 OpenViking 的 L0/L1/L2 分层思路和 N.E.K.O. 的「就地摘要」，
 * 但按个人规模砍到两级：
 *
 *     全部原文 (L2, history.json，用于界面回看)
 *          │
 *          ├─ 最近 recentCount 条 ────────────→ 原样进 prompt
 *          │
 *          └─ 更早的 ──→ 切块 ──→ 每块一段「概览」(L1)
 *                                  │
 *                                  └─ 块太多时把最老的几块再合成一条「总述」(L0)
 *
 * 拼进 prompt 时按「从新到旧」装，装到字符预算用完为止。
 * 于是自然形成「近的详细、远的粗略」，而不是一刀切截断。
 *
 * 归档是纯后台的：用户不会因为它在等。
 */
const fs = require('node:fs')
const path = require('node:path')

// 摘要提示词（尽量短，摘要本身不该烧太多 token）
const PROMPT_OVERVIEW = `把下面这段对话压缩成一段概述，控制在 200 字以内。

要保留：聊了什么主题、用户表达了什么偏好/情绪/诉求、达成了什么结论或承诺、
提到的人名物件名等具体信息。
要丢掉：寒暄、重复、助手自己的语气词。

直接输出概述正文，不要任何前缀、标题或 markdown。`

const PROMPT_ABSTRACT = `用一句话（30 字以内）概括下面这段对话在聊什么。
只输出这一句话，不要任何前缀或标点修饰。`

const PROMPT_MERGE = `把下面几段对话概述合并成一段更精炼的概述，控制在 300 字以内。
保留仍然重要的信息（用户的偏好、身份、关系、未完成的事），丢掉琐碎细节和重复。
直接输出概述正文，不要任何前缀或标题。`

class History {
  /**
   * @param {object} opts
   * @param {string} opts.dir        存放目录
   * @param {function} opts.request  非流式调用：(messages) => Promise<string>
   * @param {number} [opts.recentCount]   最近多少条原文原样进 prompt
   * @param {number} [opts.archiveAfter]  未归档超过多少条就触发归档
   * @param {number} [opts.archiveChunk]  单次最多归档多少条（分块才能形成「近细远粗」的分层）
   * @param {number} [opts.maxBlocks]     档案块上限，超了就把最老的合并
   * @param {number} [opts.historyMax]    原文最多留多少条
   * @param {function} opts.log
   */
  constructor({
    dir,
    request,
    recentCount = 16,
    archiveAfter = 40,
    archiveChunk = 20,
    maxBlocks = 8,
    historyMax = 600,
    log = console.log,
  }) {
    this.dir = dir
    this.request = request
    this.log = log

    this.recentCount = recentCount
    this.archiveAfter = archiveAfter
    this.archiveChunk = archiveChunk
    this.maxBlocks = maxBlocks
    this.historyMax = historyMax

    this.historyPath = path.join(dir, 'history.json')
    this.archivePath = path.join(dir, 'archives.json')

    /** 全部原文：[{seq, role, content, ts}] */
    this.entries = []
    /**
     * { archivedUpToSeq, blocks: [...] }
     *
     * 用**自增序号**而不是时间戳来标记归档边界。
     * 时间戳不行：同一毫秒内连写多条会撞在一起，边界就失效了
     * （实测表现是「最近的原文只取到 2 条，而且全是 assistant」）。
     */
    this.archives = { archivedUpToSeq: 0, blocks: [] }
    this.nextSeq = 1

    this.busy = false
    this.generation = 0
    this.timer = null

    this.load()
  }

  // -------------------------------------------------------------- 持久化

  load() {
    const h = readJson(this.historyPath, [])
    this.entries = Array.isArray(h) ? h.filter((e) => e && typeof e.content === 'string') : []

    // 兼容老数据：没有 seq 的按顺序补上
    let maxSeq = 0
    for (const e of this.entries) {
      if (typeof e.seq !== 'number') e.seq = ++maxSeq
      else maxSeq = Math.max(maxSeq, e.seq)
    }
    this.nextSeq = maxSeq + 1

    const a = readJson(this.archivePath, null)
    if (a && typeof a === 'object') {
      this.archives = {
        archivedUpToSeq: Number(a.archivedUpToSeq) || 0,
        blocks: Array.isArray(a.blocks) ? a.blocks : [],
      }
    }

    this.log(
      `[history] 载入 ${this.entries.length} 条原文，${this.archives.blocks.length} 段档案`
    )
  }

  save() {
    if (this.entries.length > this.historyMax) {
      const dropped = this.entries.length - this.historyMax
      this.entries = this.entries.slice(-this.historyMax)
      // 原文被裁掉了，归档边界不能还落在旧序号上
      if (this.archives.archivedUpToSeq < this.entries[0].seq) {
        this.archives.archivedUpToSeq = this.entries[0].seq - 1
      }
      void dropped
    }
    writeJson(this.historyPath, this.entries)
  }

  saveArchives() {
    writeJson(this.archivePath, this.archives)
  }

  // -------------------------------------------------------------- 写入

  /** 记一轮对话。只落盘，归档延后到空闲。 */
  append(userText, assistantText) {
    const now = Date.now()
    if (userText?.trim()) this.entries.push({ seq: this.nextSeq++, role: 'user', content: userText, ts: now })
    if (assistantText?.trim()) this.entries.push({ seq: this.nextSeq++, role: 'assistant', content: assistantText, ts: now })
    this.save()
    this.schedule(20000)
    return this.entries.length
  }

  /** 只有一侧（比如被中断） */
  appendOne(role, content) {
    this.entries.push({ seq: this.nextSeq++, role, content, ts: Date.now() })
    this.save()
  }

  clear() {
    const n = this.entries.length
    this.generation++
    clearTimeout(this.timer)
    this.timer = null
    this.entries = []
    this.archives = { archivedUpToSeq: 0, blocks: [] }
    this.nextSeq = 1
    this.save()
    this.saveArchives()
    return n
  }

  schedule(delay) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.archiveIfNeeded().catch(() => {}), delay)
    if (this.timer.unref) this.timer.unref()
  }

  // -------------------------------------------------------------- 归档

  /** 还没被档案覆盖的原文 */
  unarchived() {
    return this.entries.filter((e) => e.seq > this.archives.archivedUpToSeq)
  }

  needsArchive() {
    return this.unarchived().length > Math.max(this.archiveAfter, this.recentCount + 4)
  }

  /**
   * 把「超出最近窗口」的那部分原文压成一段档案。
   *
   * 每次**最多压 archiveChunk 条** —— 必须分块，否则一次把几百条压成一段，
   * 档案层就没有「近细远粗」的层次了，而且单段概览会糊掉细节。
   * 没压完的部分等下一轮（主进程每轮对话后会再调一次）。
   */
  async archiveIfNeeded() {
    if (this.busy) return { archived: 0 }
    const generation = this.generation

    // 块数超上限 → 先把最老的几块合并成一条，腾出空间
    if (this.archives.blocks.length > this.maxBlocks) {
      await this.mergeOldest()
      if (generation !== this.generation) return { archived: 0, cancelled: true }
    }

    if (!this.needsArchive() || !this.request) return { archived: 0 }

    const pending = this.unarchived()
    // 留出 recentCount 条不动，且单次不超过 archiveChunk 条
    const available = pending.length - this.recentCount
    const take = Math.min(available, this.archiveChunk)
    if (take < 6) return { archived: 0 }   // 太少不值得单独成块

    const toArchive = pending.slice(0, take)

    this.busy = true
    try {
      const transcript = toArchive
        .map((e) => `${e.role === 'user' ? '用户' : '助手'}：${e.content}`)
        .join('\n')

      const [overview, abstract] = await Promise.all([
        this.request([{ role: 'system', content: PROMPT_OVERVIEW }, { role: 'user', content: transcript }]),
        this.request([{ role: 'system', content: PROMPT_ABSTRACT }, { role: 'user', content: transcript }]),
      ])
      if (generation !== this.generation) return { archived: 0, cancelled: true }

      const ov = String(overview || '').trim()
      if (!ov) throw new Error('摘要为空')

      const block = {
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
        fromSeq: toArchive[0].seq,
        toSeq: toArchive[toArchive.length - 1].seq,
        fromTs: toArchive[0].ts || 0,
        toTs: toArchive[toArchive.length - 1].ts || 0,
        count: toArchive.length,
        overview: ov,
        abstract: String(abstract || '').trim().slice(0, 60),
      }
      this.archives.blocks.push(block)
      this.archives.archivedUpToSeq = block.toSeq
      this.saveArchives()

      this.log(
        `[history] 归档 ${block.count} 条（seq ${block.fromSeq}~${block.toSeq}）→ 概述 ${ov.length} 字` +
          `，现有 ${this.archives.blocks.length} 段档案`
      )
      return { archived: block.count, blocks: this.archives.blocks.length }
    } catch (e) {
      this.log(`[history] 归档失败（保留原文，下次再试）: ${e.message}`)
      return { archived: 0, error: e.message }
    } finally {
      this.busy = false
    }
  }

  /** 档案太多时，把最老的几块合并成一条更精炼的（L0 层） */
  async mergeOldest(count = 3) {
    if (this.busy || this.archives.blocks.length <= this.maxBlocks || !this.request) return 0
    const generation = this.generation
    const old = this.archives.blocks.slice(0, count)
    if (old.length < 2) return 0
    this.busy = true
    try {
      const joined = old
        .map((b, i) => `第 ${i + 1} 段（${fmtDate(b.fromTs)}）：${b.overview}`)
        .join('\n\n')
      const merged = await this.request([
        { role: 'system', content: PROMPT_MERGE },
        { role: 'user', content: joined },
      ])
      if (generation !== this.generation) return 0
      const text = String(merged || '').trim()
      if (!text) throw new Error('合并结果为空')

      const block = {
        id: `am_${Date.now().toString(36)}`,
        fromSeq: old[0].fromSeq,
        toSeq: old[old.length - 1].toSeq,
        fromTs: old[0].fromTs,
        toTs: old[old.length - 1].toTs,
        count: old.reduce((s, b) => s + (b.count || 0), 0),
        overview: text,
        abstract: old.map((b) => b.abstract).filter(Boolean).join(' / ').slice(0, 60),
        merged: old.length,
      }
      this.archives.blocks = [block, ...this.archives.blocks.slice(count)]
      this.saveArchives()
      this.log(`[history] 合并 ${old.length} 段档案 → 1 段（现共 ${this.archives.blocks.length} 段）`)
      return old.length
    } catch (e) {
      this.log(`[history] 合并档案失败: ${e.message}`)
      return 0
    } finally {
      this.busy = false
    }
  }

  // -------------------------------------------------------------- 读取

  /**
   * 拼装给模型的上下文。
   *
   * 按「从新到旧」装，装到字符预算用完为止 —— 于是近的详细、远的粗略。
   * 返回 { messages, usedChars, recent, blocks } 方便观察和测试。
   *
   * @param {number} budgetChars 历史部分最多占多少字符
   */
  buildContext(budgetChars = 6000) {
    const unarchived = this.unarchived()

    // ① 最近的原文：先从最新往回取，最多 recentCount 条，且不超过预算的 70%
    const rawBudget = Math.floor(budgetChars * 0.7)
    const recent = []
    let rawChars = 0
    for (let i = unarchived.length - 1; i >= 0 && recent.length < this.recentCount; i--) {
      const e = unarchived[i]
      const len = e.content.length + 8
      if (recent.length >= 2 && rawChars + len > rawBudget) break
      recent.unshift({ role: e.role, content: e.content })
      rawChars += len
    }

    // ② 档案概览：从最新的一段往回装，直到剩余预算用完
    let left = budgetChars - rawChars
    const picked = []
    for (let i = this.archives.blocks.length - 1; i >= 0; i--) {
      const b = this.archives.blocks[i]
      // 先试着放完整概览；放不下就退化成一行摘要
      const full = b.overview || ''
      if (full.length + 16 <= left) {
        picked.unshift({ ...b, mode: 'overview' })
        left -= full.length + 16
      } else if (b.abstract && b.abstract.length + 40 <= left) {
        picked.unshift({ ...b, mode: 'abstract' })
        left -= b.abstract.length + 40
      } else {
        break   // 再往前只会更长，停
      }
    }

    // ③ 组装成消息
    const messages = []
    for (const b of picked) {
      const when = `${fmtDate(b.fromTs)} — ${fmtDate(b.toTs)}`
      const body = b.mode === 'overview' ? b.overview : b.abstract
      messages.push({
        role: 'system',
        content: `【更早的对话 · ${when}】\n${body}`,
      })
    }
    messages.push(...recent)

    return {
      messages,
      usedChars: budgetChars - left,
      recent: recent.length,
      blocks: picked.length,
      totalBlocks: this.archives.blocks.length,
    }
  }

  /** 界面回看用：最近 n 条原文 */
  tail(n = 40) {
    return this.entries.slice(-n)
  }

  stats() {
    return {
      entries: this.entries.length,
      unarchived: this.unarchived().length,
      blocks: this.archives.blocks.length,
      busy: this.busy,
      maxBlocks: this.maxBlocks,
      recentCount: this.recentCount,
    }
  }
}

// ---------------------------------------------------------------- 工具

function fmtDate(ts) {
  if (!ts) return '?'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return fallback }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    return true
  } catch { return false }
}

module.exports = { History }
