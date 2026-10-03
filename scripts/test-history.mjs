/**
 * 分层历史测试：切块归档 → 概览 → 拼装上下文 → 块数超限时合并
 *   node scripts/test-history.mjs
 *
 * 用临时目录，不碰你真实的对话记录。
 *
 * 最核心的一条要看：**很久以前聊过的事，在只保留「最近 N 条」时会丢，
 * 有了档案还在不在。** 那才是分层压缩的意义。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { History } = require('../src/history.js')

// ---------------------------------------------------------------- Key

function regVar(name) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    })
    const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch { return null }
}

function dshCred(name) {
  const p = join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), '.credentials.yaml')
  if (!existsSync(p)) return null
  try {
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm'))
    return m ? m[1].replace(/^["']|["']$/g, '') : null
  } catch { return null }
}

const KEY = process.env.DEEPSEEK_API_KEY || regVar('DEEPSEEK_API_KEY') || dshCred('DEEPSEEK_API_KEY')
const MODEL = process.env.MEMORY_MODEL || 'deepseek-flash'
const BASE = 'https://api.deepseek.com/v1'

async function request(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 1600 }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`)
  return (await res.json()).choices?.[0]?.message?.content ?? ''
}

console.log(`摘要模型: ${MODEL}\n`)

// ---------------------------------------------------------------- 造一段"很久以前"的对话

const EPISODE = [
  ['我最喜欢的乐队是 King Crimson，尤其是红专辑', '红专辑！那可是神作'],
  ['我大学是学数字媒体的，辅修过一点音乐', '难怪你对这些这么有感觉'],
  ['我家猫叫豆豆，是一只橘猫，特别粘人', '豆豆！橘猫都很有性格'],
  ['我女朋友叫小林，她不太喜欢我熬夜', '那你要听话呀'],
]

/** 中间隔很久的闲聊（用来把上面那段挤出最近窗口） */
function filler(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push([`今天第 ${i + 1} 次来跟你打个招呼`, `你好呀，第 ${i + 1} 次～`])
  }
  return out
}

const dir = mkdtempSync(join(tmpdir(), 'pet-hist-'))
const h = new History({
  dir,
  request,
  recentCount: 6,        // 只保留最近 6 条原文，方便触发归档
  archiveAfter: 12,
  archiveChunk: 10,      // 单次最多压 10 条 → 会形成多段档案
  maxBlocks: 3,          // 故意调小，好验证「块数超限合并」
  historyMax: 500,
  log: (m) => console.log(m),
})

console.log('=== 1. 灌入对话 ===')
for (const [u, a] of EPISODE) h.append(u, a)
console.log(`  早期片段 ${EPISODE.length} 轮已写入（共 ${h.stats().entries} 条原文）`)

console.log('\n=== 2. 再灌 40 轮闲聊，分多次归档 ===')
for (const [u, a] of filler(20)) h.append(u, a)
console.log(`  现在共 ${h.stats().entries} 条原文`)
for (let i = 0; i < 8; i++) {
  const rr = await h.archiveIfNeeded()
  if (!rr.archived) break
  console.log(`  → 归档 ${rr.archived} 条，累计 ${rr.blocks} 段档案`)
}

console.log('\n=== 3. 档案内容（应该有多段，近的在后）===')
if (!h.archives.blocks.length) console.log('  ⚠️ 没有任何档案')
for (const [i, b] of h.archives.blocks.entries()) {
  console.log(`  第 ${i + 1} 段 [${b.count} 条] ${b.overview}`)
  console.log(`           一句话：${b.abstract}`)
}

console.log('\n=== 4. ⭐ 关键对比：只给最近 N 条 vs 最近 N 条 + 档案 ===')
const budget = 2200
const ctx = h.buildContext(budget)

const recentOnly = ctx.messages
  .filter((m) => m.role !== 'system')
  .map((m) => m.content)
  .join('\n')

const withArchive = ctx.messages.map((m) => m.content).join('\n')

const probes = ['King Crimson', '豆豆', '小林', '数字媒体']
console.log(
  `  （预算 ${budget} 字，实用 ${ctx.usedChars} 字：${ctx.recent} 条原文 + ${ctx.blocks}/${ctx.totalBlocks} 段档案）\n`
)
for (const p of probes) {
  const inRecent = recentOnly.includes(p)
  const inArchive = withArchive.includes(p)
  const mark = !inRecent && inArchive ? '  ← 靠档案救回来了' : inRecent ? '  （本来就在最近窗口里）' : '  ⚠️ 都没有'
  console.log(`  「${p}」  只给最近N条=${inRecent ? '有' : '无'}   加档案后=${inArchive ? '有' : '无'}${mark}`)
}

console.log('\n=== 5. 拼出来的上下文 ===')
for (const m of ctx.messages) {
  console.log(`  [${m.role}] ${m.content.slice(0, 86).replace(/\n/g, ' ⏎ ')}${m.content.length > 86 ? '…' : ''}`)
}

console.log('\n=== 6. 预算约束（档案段数应随预算递增，且绝不超预算）===')
for (const b of [200, 500, 1200, 6000]) {
  const c = h.buildContext(b)
  const ok = c.usedChars <= b
  console.log(
    `  预算 ${String(b).padStart(4)} → 实用 ${String(c.usedChars).padStart(4)} 字，` +
      `${c.recent} 条原文 + ${c.blocks} 段档案  ${ok ? '✓' : '✗ 超了！'}`
  )
}

console.log('\n=== 7. 块数超限时合并 ===')
console.log(`  合并前 ${h.archives.blocks.length} 段（上限 ${h.maxBlocks}）`)
const before = h.archives.blocks.length
await h.mergeOldest(2)
console.log(`  合并后 ${h.archives.blocks.length} 段`)
if (h.archives.blocks.length < before) {
  console.log(`  合并成的那段：${h.archives.blocks[0].overview.slice(0, 140)}…`)
}
// 合并之后，老信息还得在
const afterMerge = h.buildContext(6000).messages.map((m) => m.content).join('\n')
console.log(`  合并后 King Crimson 还在吗：${afterMerge.includes('King Crimson') ? '✅ 在' : '❌ 丢了'}`)

console.log('\n=== 8. 落盘 ===')
for (const f of ['history.json', 'archives.json']) {
  const p = join(dir, f)
  console.log(`  ${f}: ${existsSync(p) ? `${(readFileSync(p).length / 1024).toFixed(1)} KB` : '不存在'}`)
}

rmSync(dir, { recursive: true, force: true })
console.log('\n完成（临时目录已清理）')
