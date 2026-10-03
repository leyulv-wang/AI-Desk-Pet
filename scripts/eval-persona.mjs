/**
 * 人格回归测试
 *   node scripts/eval-persona.mjs [角色id] [--runs=1]
 *
 * 干什么：拿真实的 system prompt + 真实的历史上下文（可选），问一组固定的问题，
 * 然后把「不该出现的口癖」和「该出现的风格」数出来。
 *
 * 为什么需要它：
 *   人格 prompt 里有一条「不要每句都自称本神」，但实测禁令完全没用 ——
 *   真实对话 4/4 条都在说。光靠肉眼看几条回复根本判断不了改好没有，
 *   必须有个能跑的量化指标。
 *
 * 三个已知的坑，这个脚本就是为它们服务的：
 *   ① prompt 里的**例子**比禁令强得多。我在「性格」段里写了句
 *      「嘴上说『本神只是恰好有空』」当示范，等于亲手教她这么说。
 *   ② 否定式指令天生弱。「不要每次都提自己是水神」→ 她照提不误。
 *   ③ 历史会自我强化。她过去的回复全带「本神」，那比 system prompt 更靠近、
 *      更具体，模型会照着学。所以这个脚本默认**带上真实历史**来测。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const emotion = require(join(ROOT, 'src', 'emotion.js'))

const CHAR_ID = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'furina'
const RUNS = Number((process.argv.find((a) => a.startsWith('--runs=')) || '').split('=')[1]) || 1
const HISTORY_DIR = (process.argv.find((a) => a.startsWith('--history=')) || '').split('=')[1] || '.userdata-dev'
const NO_HISTORY = process.argv.includes('--no-history')

// ---------------------------------------------------------------- Key

function regVar(n) {
  if (process.platform !== 'win32') return null
  try {
    const o = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', n], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    const m = o.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}
function dshCred(n) {
  const p = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(p)) return null
  const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${n}\\s*:\\s*(\\S+)\\s*$`, 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}
const KEY = process.env.DEEPSEEK_API_KEY || regVar('DEEPSEEK_API_KEY') || dshCred('DEEPSEEK_API_KEY')
if (!KEY) {
  console.error('没找到 DEEPSEEK_API_KEY')
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const char = JSON.parse(readFileSync(join(ROOT, 'characters', `${CHAR_ID}.json`), 'utf8'))

const parts = [char.systemPrompt]
if (char.emotionalVoice !== false) parts.push(emotion.promptRule())
const SYSTEM = parts.join('\n\n')

// ---------------------------------------------------------------- 历史

/** 把真实历史转成 messages —— 复刻主进程的做法：带标签存、原样喂回 */
function loadHistory() {
  if (NO_HISTORY) return []
  const p = join(ROOT, HISTORY_DIR, 'history.json')
  if (!existsSync(p)) return []
  const arr = JSON.parse(readFileSync(p, 'utf8'))
  return arr.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
}

const history = loadHistory()

// ---------------------------------------------------------------- 测试问题

const PROMPTS = [
  '我叫阿远，在做一个桌宠项目。',
  '我先去忙一会儿，等下回来。',
  '你觉得我今天该干什么？',
  '这个 bug 我修了两个小时还没修好。',
  '算了，不想弄了。',
  '晚安，我要睡了。',
  '我给你带了一块小蛋糕。',
  '你记得我喜欢喝什么吗？',
]

/** 该少出现的口癖 */
const TICS = [
  { name: '本神', re: /本神/g, maxPerReply: 1 },
  { name: '神明/水神', re: /(神明|水神|芙卡洛斯)/g, maxPerReply: 1 },
]

/** 风格检查（只统计，不判定好坏 —— 有些是刻意的） */
const STYLE = [
  { name: '含问号（句内疑问也算）', re: /[？?]/g },
  // 语气词分两类，混在一起数会得出错误结论：
  //   感叹类 —— 句首的语气，哼/诶/唔/唉/喂
  //   句尾助词 —— 哦/嘛/啦/呀/喔，这是**她最明显的语音指纹**（官方语音几乎句句带）
  // 一开始只数了感叹类，于是"语气词 1/24"看起来像人设没生效 ——
  // 其实她一直在说「红茶嘛」「别迟到哦」这种，只是没被数到。
  { name: '语气词·句首感叹', re: /(哼|诶|欸|唔|唉|喂)/g },
  { name: '语气词·句尾助词', re: /[哦嘛啦呀喔](?=[。！？…，、]|$)/g },
]

/**
 * 「结尾反问」—— 单独一条，因为它和上面那个不是一回事。
 *
 * 为什么必须分开数：
 *   芙宁娜官方语音里问句**非常多**（「我的蛋糕在哪里？」「看得出来么？」
 *   「该不会是想说你从一开始就没有敬仰过我吧？」），所以"句内有问号"是**该有的**，
 *   把它当缺点去压，等于把她压平。
 *
 *   真正让人听着累的是另一种：**每条回复都用一句反问丢回给用户收尾** ——
 *   「你觉得呢？」「你说是不是？」「怎么样？」。那不是她的语气，
 *   是客服/捧哏的语气，而且会让人觉得她从不表态、只在应付。
 *
 *   一开始只有一个 `/？/` 指标，两种混在一起（56%），根本看不出问题在哪。
 */
const isQuestionTail = (text) => {
  // 去掉结尾的引号、空白、省略号之后再判 —— 「……你觉得呢？」要算反问收尾
  const t = String(text || '').trim().replace(/[」』"'）)】\]…~～\s]+$/, '')
  return /[？?]$/.test(t)
}

async function ask(userText) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: cfg.model || 'deepseek-flash',
      temperature: cfg.temperature ?? 0.8,
      max_tokens: 2600,
      messages: [...[{ role: 'system', content: SYSTEM }], ...history, { role: 'user', content: userText }],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  const raw = j.choices?.[0]?.message?.content ?? ''
  const { category, cleaned } = emotion.resolveEmotion(raw)
  return { raw, cleaned, category }
}

console.log(`角色：${CHAR_ID}（${char.name || '?'}）`)
console.log(`历史：${NO_HISTORY ? '不带（纯 prompt 测试）' : `${history.length} 条，来自 ${HISTORY_DIR}`}`)
console.log(`问题：${PROMPTS.length} 个 × ${RUNS} 轮\n`)

const rows = []
for (let r = 0; r < RUNS; r++) {
  for (const p of PROMPTS) {
    try {
      const a = await ask(p)
      rows.push({ ask: p, ...a })
    } catch (e) {
      console.log(`  ❌ ${p} → ${e.message}`)
    }
  }
}

// ---------------------------------------------------------------- 统计

console.log('=== 逐条 ===\n')
for (const r of rows) {
  const marks = TICS.map((t) => {
    const n = (r.cleaned.match(t.re) || []).length
    return n > t.maxPerReply ? `🔴${t.name}×${n}` : n ? `${t.name}×${n}` : ''
  })
    .filter(Boolean)
    .join(' ')
  console.log(`[${r.category}] ${r.ask}`)
  console.log(`   ${r.cleaned.slice(0, 70)}`)
  if (marks) console.log(`   ${marks}`)
  console.log()
}

console.log('=== 汇总 ===\n')
const total = rows.length

/**
 * 数口癖出现次数。
 *
 * 注意：不能用 `re.test(str)` —— TICS 里的正则是带 /g 的，
 * 而带 /g 的正则用 test() 会记住 lastIndex，跨次调用结果会飘
 * （第一次测出 38%、第二次汇总变成 63%，就是这么来的）。
 * 一律用 String.match，它是无状态的。
 */
const countHits = (str, re) => (str.match(re) || []).length

for (const t of TICS) {
  const withTic = rows.filter((r) => countHits(r.cleaned, t.re) > 0).length
  const over = rows.filter((r) => countHits(r.cleaned, t.re) > t.maxPerReply).length
  const rate = ((withTic / total) * 100).toFixed(0)
  console.log(`  「${t.name}」出现于 ${withTic}/${total} 条（${rate}%），超标 ${over} 条`)
}

console.log()
for (const s of STYLE) {
  const withS = rows.filter((r) => countHits(r.cleaned, s.re) > 0).length
  console.log(`  ${s.name}：${withS}/${total} 条`)
}

const qTail = rows.filter((r) => isQuestionTail(r.cleaned)).length
const qTailRate = qTail / total
console.log(`  结尾反问（拿问句收尾丢回给用户）：${qTail}/${total} 条（${(qTailRate * 100).toFixed(0)}%）`)

const lens = rows.map((r) => r.cleaned.replace(/\s/g, '').length)
const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)
console.log(`  平均长度 ${avg} 字（最长 ${Math.max(...lens)}）`)

const cats = {}
for (const r of rows) cats[r.category] = (cats[r.category] || 0) + 1
console.log(`  情绪分布 ${JSON.stringify(cats)}`)

console.log()
if (qTailRate > 0.3) {
  console.log(`  ⚠️ 结尾反问 ${(qTailRate * 100).toFixed(0)}% —— 目标是三成以下。`)
  console.log('     注意别去压「句内疑问」：官方语音里问句本来就多，压掉会变平。')
  console.log('     要压的是「用反问收尾、不表态」这种。调 characters/<id>.json 的【反应公式】段。')
} else {
  console.log(`  ✅ 结尾反问 ${(qTailRate * 100).toFixed(0)}%，三成以下。`)
}

console.log()
const shenRate = rows.filter((r) => countHits(r.cleaned, /本神/g) > 0).length / total
if (shenRate > 0.4) {
  console.log(`  ⚠️ 「本神」出现在 ${(shenRate * 100).toFixed(0)}% 的回复里 —— 目标是「偶尔」，应当明显低于这个数。`)
  console.log('     调 characters/<id>.json 的【自称】段，然后重跑这个脚本对比。')
} else {
  console.log(`  ✅ 「本神」频率 ${(shenRate * 100).toFixed(0)}%，符合「偶尔」的目标。`)
}
