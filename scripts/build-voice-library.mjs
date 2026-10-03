/**
 * 建立「语气参考音频库」
 *   node scripts/build-voice-library.mjs [数据集目录] [输出目录] [--limit=N]
 *
 * 做什么：
 *   1. 本地算每条音频的质量指标（时长、首尾静音、峰值、RMS）—— 不联网
 *   2. 用 LLM 给 1139 条「转写文本」打细粒度语气标签（带缓存，可断点续跑）
 *   3. 细标签映射到粗类别（运行时只按粗类别匹配）
 *   4. 每类挑出质量最好、语气最明显的若干条 → library.json
 *
 * 为什么要"细标签 → 粗类别"两层：
 *   细标签让 LLM 分得更准（比直接分 5 类准），粗类别让运行时匹配更简单。
 *   以后想调整合并方式，改 MAP 就行，不用重跑 LLM。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] || 'D:\\下载\\原神语音包\\Furina'
const OUT = process.argv[3] || join(ROOT, 'assets', 'voice')
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0

// Key 可能在进程环境、Windows 用户环境变量、或 DSH 凭据里 —— 三处都找
function regVar(n) {
  if (process.platform !== 'win32') return null
  try {
    const o = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', n],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    const m = o.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch { return null }
}
function dshCred(n) {
  const p = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(p)) return null
  try {
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${n}\\s*:\\s*(\\S+)\\s*$`, 'm'))
    return m ? m[1].replace(/^["']|["']$/g, '') : null
  } catch { return null }
}
const DS_KEY = process.env.DEEPSEEK_API_KEY || regVar('DEEPSEEK_API_KEY') || dshCred('DEEPSEEK_API_KEY')

// ---------------------------------------------------------------- 配置

/** LLM 用的细标签（分得准） */
const FINE_LABELS = ['开心', '得意', '温柔', '平静', '无奈', '生气', '厌恶', '悲伤', '惊讶', '紧张']

/**
 * 细标签 → 粗类别。
 *
 * 现在基本是一对一 —— 因为「得意」和「无奈」已经独立成类别了。
 * 这两个曾经被并进 开心 / 平静，结果是两败俱伤：
 *   · 得意 (v=3) 在打分上碾压 开心 (v=2)，于是「开心」听起来像嘲讽
 *   · 无奈 (v=3) 同样碾压 平静 (v=1)，于是「平静」听起来像绝望独白
 * 各有 63 / 60 条素材，独立成类完全撑得住。
 */
const MAP = {
  开心: '开心',
  得意: '得意',
  温柔: '温柔',
  平静: '平静',
  无奈: '无奈',
  生气: '生气',
  厌恶: '生气', // 厌恶素材少，并进生气
  悲伤: '难过',
  惊讶: '惊讶',
  紧张: '惊讶', // 紧张也是高唤醒
}

/**
 * 每个粗类别**只接受**这些细标签。
 *
 * 为什么需要它（踩过的坑）：
 *   最初每类允许整个桶参与挑选，结果参考音频的情绪是混的 ——
 *   「平静」桶里选的 4 条中有 2 条其实是「无奈」，其中一条是
 *   「（几百年间我做了那么多调查，可没有任何突破预言的希望…）」——
 *   一段绝望独白。用它当参考去念「嗯，我在听」，听起来就是在哭。
 *   用户的原话是「应该是闲聊的语气，但被分到了悲伤」。
 *
 *   根因是打分公式 confidence*10：confidence 是**语气强度**，
 *   而「平静」按定义就是低强度 —— 于是这个公式系统性地把最不平静的那几条顶了上来。
 *   同理「得意」(v=3) 挤掉了「开心」(v=2)，导致开心听起来像嘲讽。
 *
 * 后来又把「得意」和「无奈」独立成类别（各 63 / 60 条素材）——
 * 它们是芙宁娜最有辨识度的两种语气，塞进 开心 / 平静 只会两头都变味：
 *   · 撒娇式赌气「又走？你这两句话是故意气本神的吧」被判成 生气，
 *     配到的参考却是审讯腔「难不成你敢在这个地方做伪证？」
 *   · 端着架子的挑剔「哼，这种料理得不到我的认可」被当成真高兴
 */
const PURE = {
  开心: ['开心'],
  得意: ['得意'],
  温柔: ['温柔'],
  平静: ['平静'],
  无奈: ['无奈'],
  生气: ['生气'],
  难过: ['悲伤'],
  惊讶: ['惊讶'],
}

/**
 * 内容筛查：这些词说明台词的**内容**会把语气带偏，即使标签是对的。
 *
 * 标签标的是「说这句话的语气」，但参考音频会被整段喂给模型，
 * 内容里的重情绪词会渗出来。宁可少几条候选，也不要语气被带跑。
 */
const TONE_KILLERS = {
  平静: /(对不起|抱歉|痛苦|绝望|希望|拜托|孤独|寂寞|审判|泪水|哭泣|死|恨|牺牲)/,
  开心: /(哼|讨厌|荒唐|急死|得不到|不认可|鄙视|无聊透顶|愚蠢)/,
  得意: /(对不起|抱歉|哭泣|痛苦)/,
  无奈: /(对不起|抱歉|哭泣|审判|绝望)/,
  温柔: /(枯萎|心事|痛苦|死|审判|牺牲)/,
  生气: /(抱歉|对不起)/, // 芙宁娜的「对不起行了吧」是赌气，但内容容易被模型读成真的在道歉
  难过: null,
  惊讶: null,
}

/** 各类别的理想语气强度。平静要「淡」，其余要「明显」 */
const WANT_INTENSITY = {
  平静: 1, // 越淡越好
  无奈: 2, // 无奈是低能量但不是零能量
  温柔: 2,
  开心: 2,
  得意: 2, // 得意往往是轻飘飘的，不是咆哮
  惊讶: 3,
  生气: 3,
  难过: 3,
}

/**
 * 每个粗类别留几条参考。
 *
 * 为什么是 3~5 而不是 20：
 *   GPT-SoVITS 零样本的输出音色是**跟着参考音频走**的。
 *   同一类别里塞太多不同语气的样本，合成出来的音色会飘，听着不像同一个人。
 *   少而精更稳 —— 3~5 条已经够轮换，也不会让音色发散。
 */
const PER_CATEGORY = Number((process.argv.find((a) => a.startsWith('--per=')) || '').split('=')[1]) || 4

/** 参考音频的理想时长区间 */
const DUR_MIN = 4.5
const DUR_MAX = 9.0

// ---------------------------------------------------------------- 音频指标

function wavMetrics(path) {
  const buf = readFileSync(path)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bits = buf.readUInt16LE(34)
  if (bits !== 16) return null

  let off = 12, dataOff = -1, dataSize = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') { dataOff = off + 8; dataSize = size; break }
    off += 8 + size + (size % 2)
  }
  if (dataOff < 0) return null

  const n = Math.floor(dataSize / 2 / channels)
  const seconds = n / sampleRate
  const step = channels

  let peak = 0, sum = 0
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataOff + i * 2 * step) / 32768
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
    sum += v * v
  }
  const rms = Math.sqrt(sum / Math.max(1, n))

  // 首尾静音（-40dBFS）
  const thr = 0.01
  const win = Math.max(1, Math.floor(sampleRate * 0.01))
  let head = 0, tail = 0
  for (let i = 0; i + win <= n; i += win) {
    let p = 0
    for (let k = i; k < i + win; k++) {
      const a = Math.abs(buf.readInt16LE(dataOff + k * 2 * step) / 32768)
      if (a > p) p = a
    }
    if (p > thr) { head = i / sampleRate; break }
  }
  for (let i = n - win; i >= 0; i -= win) {
    let p = 0
    for (let k = i; k < i + win; k++) {
      const a = Math.abs(buf.readInt16LE(dataOff + k * 2 * step) / 32768)
      if (a > p) p = a
    }
    if (p > thr) { tail = (n - i - win) / sampleRate; break }
  }

  return { channels, sampleRate, seconds, peak, rms, head, tail }
}

// ---------------------------------------------------------------- LLM 分类（带缓存）

const CACHE_DIR = join(ROOT, '.cache')
const CACHE_FILE = join(CACHE_DIR, 'emotion-labels.json')

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) } catch { return {} }
}
function saveCache(c) {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_FILE, JSON.stringify(c))
}

async function classifyBatch(key, items) {
  if (!DS_KEY) throw new Error('没有 DEEPSEEK_API_KEY')

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-flash',
      temperature: 0.1,
      max_tokens: 6000,
      messages: [
        {
          role: 'system',
          content:
            `你在给游戏角色的台词按「说话时的语气」分类。\n` +
            `标签只能从这些里选一个：${FINE_LABELS.join('、')}。\n` +
            `同时给出语气强度 v，1=很淡，2=明显，3=非常强烈。\n\n` +
            `判断依据是这句话**说出来的语气**，不是文字表面的意思。\n` +
            `例如「哼，这种料理得不到我的认可」是「得意」而不是「生气」，因为那是端着架子的挑剔。\n\n` +
            `输入：JSON 数组 [{"i":序号,"t":"台词"}]\n` +
            `输出：JSON 数组 [{"i":序号,"e":"标签","v":强度}]，顺序与输入一致，条数必须相同。\n` +
            `只输出 JSON，不要任何解释、不要 markdown。`,
        },
        { role: 'user', content: JSON.stringify(items) },
      ],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 150)}`)
  const j = await res.json()
  const raw = j.choices?.[0]?.message?.content ?? ''
  let parsed = null
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) } catch { /* null */ }
  if (!Array.isArray(parsed)) {
    const a = raw.indexOf('['), b = raw.lastIndexOf(']')
    if (a >= 0 && b > a) { try { parsed = JSON.parse(raw.slice(a, b + 1)) } catch { /* null */ } }
  }
  if (!Array.isArray(parsed)) throw new Error(`解析失败: ${raw.slice(0, 120)}`)
  return { parsed, usage: j.usage }
}

/** 简单并发池 */
async function pool(tasks, concurrency) {
  const results = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= tasks.length) return
      try { results[i] = await tasks[i]() } catch (e) { results[i] = { error: e.message } }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

// ---------------------------------------------------------------- 主流程

console.log('数据集:', SRC)
console.log('输出到:', OUT, '\n')

const files = readdirSync(SRC)
const wavs = files.filter((f) => f.endsWith('.wav'))
console.log(`=== 1. 本地算音频质量指标（${wavs.length} 条）===`)

const rows = []
for (const w of wavs) {
  const base = w.replace(/\.wav$/, '')
  let meta
  try { meta = JSON.parse(readFileSync(join(SRC, base + '.json'), 'utf8')) } catch { continue }
  const text = (meta.transcription || '').trim()
  if (!text || text.length < 8) continue

  let m
  try { m = wavMetrics(join(SRC, w)) } catch { continue }
  if (!m || m.channels !== 1) continue
  if (m.seconds < DUR_MIN || m.seconds > DUR_MAX) continue
  if (m.peak > 0.99) continue
  if (m.head + m.tail > 0.8) continue
  if (m.rms < 0.015) continue

  rows.push({
    id: base,
    text,
    scene: meta.voiceConfigs?.[0]?.gameTrigger || '',
    ...m,
    // 质量分：静音少、时长靠 6.5s、电平适中
    quality:
      -Math.abs(m.seconds - 6.5) * 1.0 -
      (m.head + m.tail) * 4 +
      (m.rms > 0.03 && m.rms < 0.22 ? 1 : -1),
  })
}
console.log(`  通过质量筛选: ${rows.length} 条\n`)

console.log('=== 2. LLM 分类转写文本（带缓存，可断点续跑）===')
const cache = loadCache()
const need = rows.filter((r) => !cache[r.id])
console.log(`  已有缓存 ${rows.length - need.length} 条，待分类 ${need.length} 条`)

const BATCH = 20
const batches = []
for (let i = 0; i < need.length; i += BATCH) {
  const chunk = need.slice(i, i + BATCH)
  batches.push(chunk)
}
console.log(`  分成 ${batches.length} 批，每批 ${BATCH} 条\n`)

let done = 0
const tasks = batches.map((chunk) => async () => {
  const items = chunk.map((r, k) => ({ i: k, t: r.text }))
  const { parsed } = await classifyBatch(chunk[0].id, items)
  chunk.forEach((r, k) => {
    const hit = parsed.find((p) => Number(p.i) === k)
    if (hit && FINE_LABELS.includes(hit.e)) {
      cache[r.id] = { e: hit.e, v: Math.min(3, Math.max(1, Number(hit.v) || 2)) }
    }
  })
  done++
  if (done % 5 === 0 || done === batches.length) {
    saveCache(cache)
    process.stdout.write(`  进度 ${done}/${batches.length} 批\n`)
  }
  return true
})

const t0 = Date.now()
await pool(tasks, 6)
saveCache(cache)
console.log(`  分类完成，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`)

// ---------------------------------------------------------------- 汇总

for (const r of rows) {
  const c = cache[r.id]
  r.fine = c?.e || null
  r.confidence = c?.v || 0
  r.category = r.fine ? MAP[r.fine] || null : null
}

const labeled = rows.filter((r) => r.category)
console.log('=== 3. 细标签分布 ===')
const fineCount = {}
for (const r of labeled) fineCount[r.fine] = (fineCount[r.fine] || 0) + 1
for (const [k, v] of Object.entries(fineCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(6)} ${String(v).padStart(4)} 条  →  ${MAP[k]}`)
}

console.log('\n=== 4. 粗类别分布（映射后）===')
const catCount = {}
for (const r of labeled) catCount[r.category] = (catCount[r.category] || 0) + 1
for (const [k, v] of Object.entries(catCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(6)} ${String(v).padStart(4)} 条`)
}

// ---------------------------------------------------------------- 挑精选
//
// 不是简单取分数最高的 N 条 —— 那样挑出来可能全是同一种句式，
// 后面想做「问句配问句」这种智能匹配就没素材了。
// 所以按「结尾标点 × 长度档」分箱，每个箱里取最好的，保证覆盖度。

/** 结尾标点：语气最直接的线索，免费且强 */
function endPunct(text) {
  const t = text.trim()
  const last = t[t.length - 1]
  if ('？?'.includes(last)) return '问'
  if ('！!'.includes(last)) return '叹'
  if ('…'.includes(last) || t.endsWith('...')) return '省略'
  return '陈述'
}

/** 长度档：短句和长句的节奏很不一样 */
function lenBucket(text) {
  const n = text.replace(/\s/g, '').length
  if (n <= 20) return '短'
  if (n <= 35) return '中'
  return '长'
}

console.log(`\n=== 5. 每类挑 ${PER_CATEGORY} 条（先保情绪纯度，再保句式覆盖）===`)
const library = []
const categories = Object.keys(PURE)

for (const cat of categories) {
  const allowed = PURE[cat]
  const killer = TONE_KILLERS[cat]

  // ① 只留纯标签的候选 —— 这是这一版最重要的改动
  const pool = labeled.filter((r) => r.category === cat)
  let cands = pool.filter((r) => allowed.includes(r.fine))

  // ② 内容筛查：会把语气带偏的台词不要
  const beforeScreen = cands.length
  if (killer) cands = cands.filter((r) => !killer.test(r.text))
  const screened = beforeScreen - cands.length

  for (const r of cands) {
    r.endsWith = endPunct(r.text)
    r.lenBucket = lenBucket(r.text)
    r.chars = r.text.replace(/\s/g, '').length
    // 强度分：离理想强度越近越好。故意**不是**越高越好 ——
    // 平静要的是淡，给高强度的打分才是那个 bug 的来源。
    const want = WANT_INTENSITY[cat] ?? 2
    const intensityFit = 3 - Math.abs((r.confidence || 2) - want)
    r.score = intensityFit * 10 + r.quality
  }

  // ③ 分箱覆盖。分两轮，顺序很重要：
  //
  //    第一轮：**先保证四种句尾都有**
  //      选择器最强的信号是「句尾标点对齐」（权重 4.0，见 voice-select.js）——
  //      问句配问句参考，语调才对得上。如果某个类别一条问句参考都没有，
  //      这个信号就白搭了。
  //
  //      上一版没这么做：它按总分排箱、取前 N 个箱，结果「生气」桶里明明有
  //      问短1/问中4/问长2，却因为强度分低而被陈述/叹气的箱子挤掉 ——
  //      实测「诶，这就走啦？」（问句）配到了陈述参考。
  //
  //    第二轮：再按总分补长度档的多样性。
  const used = new Set()
  const picked = []

  for (const ends of ['问', '叹', '陈述', '省略']) {
    if (picked.length >= PER_CATEGORY) break
    const sameEnd = cands.filter((r) => r.endsWith === ends).sort((a, b) => b.score - a.score)
    if (!sameEnd.length) continue
    picked.push(sameEnd[0])
    used.add(sameEnd[0].id)
  }

  // 第二轮：剩下的名额按「箱内最好的」补，优先长度档多样性
  const boxes = new Map()
  for (const r of cands) {
    if (used.has(r.id)) continue
    const box = `${r.endsWith}-${r.lenBucket}`
    if (!boxes.has(box)) boxes.set(box, [])
    boxes.get(box).push(r)
  }
  const ranked = [...boxes.entries()]
    .map(([box, list]) => {
      list.sort((a, b) => b.score - a.score)
      return { box, best: list[0], rest: list.slice(1) }
    })
    .sort((a, b) => b.best.score - a.best.score)

  for (const g of ranked) {
    if (picked.length >= PER_CATEGORY) break
    picked.push(g.best)
    used.add(g.best.id)
  }
  if (picked.length < PER_CATEGORY) {
    const leftovers = ranked.flatMap((g) => g.rest).sort((a, b) => b.score - a.score)
    for (const r of leftovers) {
      if (picked.length >= PER_CATEGORY) break
      picked.push(r)
    }
  }

  const purity = picked.length ? (picked.every((p) => allowed.includes(p.fine)) ? '纯' : '混') : '-'
  console.log(
    `  ${cat.padEnd(4)} 桶内 ${String(pool.length).padStart(3)} → 纯标签 ${String(beforeScreen).padStart(3)}` +
      ` → 内容筛查掉 ${String(screened).padStart(2)} → 选 ${picked.length}  [${purity}]  ` +
      `句式 ${picked.map((p) => p.endsWith + p.lenBucket).join(' ')}`
  )
  for (const p of picked) {
    library.push({
      id: p.id,
      file: p.id + '.wav',
      text: p.text,
      category: cat,
      fine: p.fine,
      confidence: p.confidence,
      seconds: Number(p.seconds.toFixed(2)),
      chars: p.chars,
      endsWith: p.endsWith,
      lenBucket: p.lenBucket,
      scene: p.scene,
    })
  }
}

console.log(`\n  共 ${library.length} 条`)

if (LIMIT) {
  console.log(`\n  （--limit=${LIMIT} 生效，只保留前 ${LIMIT} 条）`)
  library.length = Math.min(library.length, LIMIT)
}

mkdirSync(OUT, { recursive: true })
const outFile = join(OUT, 'library.json')
writeFileSync(
  outFile,
  JSON.stringify(
    {
      version: 1,
      source: SRC,
      builtAt: new Date().toISOString(),
      fineLabels: FINE_LABELS,
      map: MAP,
      categories: [...new Set(Object.values(MAP))],
      stats: { total: rows.length, labeled: labeled.length, kept: library.length },
      clips: library,
    },
    null,
    2
  )
)

const size = statSync(outFile).size
console.log(`\n=== 6. 输出 ===`)
console.log(`  ${outFile}  (${(size / 1024).toFixed(1)} KB，${library.length} 条)`)
console.log(`\n每条包含：id / 文本 / 类别 / 细标签 / 置信度 / 时长 / 场景`)
console.log(`运行时用法：给回复文本打一个粗类别标签 → 在该类别的候选里轮换取一条当参考音频`)
