/**
 * 时效性 / 矛盾消解测试
 *   node scripts/test-temporal.mjs
 *
 * 验的是这件事：**用户改主意之后，旧事实必须退场** ——
 * 否则她会同时"记得"你喜欢蓝色和喜欢绿色，然后精神分裂。
 *
 * 加时效性之前的行为：两条都留着，召回时都注入 → 错。
 * 加之后：旧的标记失效、不进 prompt，但**不删除**（可审计、面板能看到）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Memory } = require('../src/memory.js')

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
  const p = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(p)) return null
  try {
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm'))
    return m ? m[1].replace(/^["']|["']$/g, '') : null
  } catch { return null }
}
const grab = (n) => process.env[n] || regVar(n) || dshCred(n)

let cfg = {}
try { cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')) } catch {}
const cfgEmb = cfg.embedding || {}

const CHAT_KEY = grab('DEEPSEEK_API_KEY')
const CHAT_BASE = cfg.baseUrl || 'https://api.deepseek.com/v1'
const CHAT_MODEL = cfg.extractModel || cfg.model || 'deepseek-flash'
const EMB_KEY = cfgEmb.apiKey || grab('EMBEDDING_API_KEY')
const EMB_BASE = cfgEmb.baseUrl || 'https://api.siliconflow.cn/v1'
const EMB_MODEL = cfgEmb.model || 'Qwen/Qwen3-Embedding-0.6B'

console.log(`抽取模型 ${CHAT_MODEL} · 向量模型 ${EMB_MODEL}\n`)

async function request(messages) {
  const res = await fetch(`${CHAT_BASE.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAT_KEY}` },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0.2, max_tokens: 2600 }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).choices?.[0]?.message?.content ?? ''
}
async function embed(texts) {
  const res = await fetch(`${EMB_BASE.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EMB_KEY}` },
    body: JSON.stringify({ model: EMB_MODEL, input: texts, encoding_format: 'float' }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`)
  const list = (await res.json()).data || []
  if (list.every((d) => typeof d.index === 'number')) list.sort((a, b) => a.index - b.index)
  return list.map((d) => d.embedding)
}

const dir = mkdtempSync(join(tmpdir(), 'pet-temporal-'))
const mem = new Memory({
  dir, request, embed, embedModel: EMB_MODEL,
  vecMinScore: 0.4, vecMargin: 0.1, log: (m) => console.log('   ' + m),
})

/** 跑一轮对话（入队 → 整理 → 向量化） */
async function turn(user, assistant = '好～') {
  mem.observe(user, assistant)
  return mem.consolidate()
}

function show(label) {
  console.log(`\n--- ${label} ---`)
  for (const f of mem.facts) {
    const mark = f.invalidAt ? '✗已失效' : '✓有效  '
    const sup = f.supersededBy ? ` → 被取代` : f.supersedes ? ' ← 取代了前一条' : ''
    console.log(`   ${mark} [${f.importance}] ${f.text}${sup}`)
  }
}

// ---------------------------------------------------------------- 1. 建立基线

console.log('=== 1. 建立基线事实 ===')
await turn('我叫小王，是个前端工程师，最喜欢的颜色是蓝色，最近在学 Rust')
await mem.embedMissing()
show('基线')

// ---------------------------------------------------------------- 2. 改主意（有替代）

console.log('\n=== 2. 改主意：从蓝色改成绿色 ===')
await turn('我想了想，现在最喜欢绿色了，蓝色看腻了')
await mem.embedMissing()
show('改色之后')

const blue = mem.facts.find((f) => f.text.includes('蓝色'))
const green = mem.facts.find((f) => f.text.includes('绿色'))
console.log(`\n   蓝色那条失效了吗：${blue?.invalidAt ? '✅ 是' : '❌ 否'}`)
console.log(`   绿色那条取代了它吗：${green?.supersedes ? '✅ 是' : '❌ 否'}`)
console.log(`   反向链接对吗：${blue?.supersededBy === green?.id ? '✅ 是' : '❌ 否'}`)

// ---------------------------------------------------------------- 3. 召回只出新的

console.log('\n=== 3. ⭐ 召回不能同时出现新旧两条 ===')
for (const q of ['我喜欢什么颜色', '推荐个颜色给我']) {
  const picked = mem.recallRanked(q, 5)
  const texts = picked.map((p) => p.fact.text)
  const hasBlue = texts.some((t) => t.includes('蓝色'))
  const hasGreen = texts.some((t) => t.includes('绿色'))
  console.log(`   问「${q}」`)
  for (const t of texts) console.log(`      → ${t}`)
  console.log(`      含蓝色=${hasBlue ? '⚠️ 是（不该）' : '否 ✓'}  含绿色=${hasGreen ? '是 ✓' : '否'}`)
}

// ---------------------------------------------------------------- 4. 否定式修正（没有替代）

console.log('\n=== 4. 否定式修正：不再学 Rust（没给新的） ===')
// 先记下修正前那条的 id —— 断言要盯住「这一条」，不能只看「还有没有含 Rust 的事实」
// （新事实文字里通常也含 Rust）
const oldRust = mem.facts.find((f) => f.text.includes('Rust') && !f.invalidAt)
console.log(`   修正前那条：${oldRust?.text ?? '（没找到）'}`)

await turn('Rust 我放弃了，不学了')
await mem.embedMissing()

for (const f of mem.facts.filter((f) => f.text.includes('Rust'))) {
  console.log(`   ${f.invalidAt ? '✗已失效' : '✓有效  '} ${f.text}`)
}
const oldGone = !!oldRust && !!mem.facts.find((f) => f.id === oldRust.id)?.invalidAt
console.log(`   原来那条退场了吗：${oldGone ? '✅ 是' : '❌ 否'}`)
console.log('   召回「我在学什么编程语言」：')
for (const p of mem.recallRanked('我在学什么编程语言', 5)) console.log(`      → ${p.fact.text}`)

// ---------------------------------------------------------------- 5. 不删数据 + 落盘

console.log('\n=== 5. 失效的事实不能删 —— 要可审计 ===')
const onDisk = JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf8'))
const invalidOnDisk = onDisk.filter((f) => f.invalidAt)
console.log(`   磁盘上共 ${onDisk.length} 条，其中失效的 ${invalidOnDisk.length} 条（应该 > 0）`)
console.log(`   失效条目保留了有效区间：${invalidOnDisk.every((f) => f.validFrom && f.invalidAt) ? '✅ 是' : '❌ 否'}`)
for (const f of invalidOnDisk) {
  console.log(`      · ${f.text}  [${new Date(f.validFrom).toLocaleTimeString()} → ${new Date(f.invalidAt).toLocaleTimeString()}]`)
}

// ---------------------------------------------------------------- 6. 统计

console.log('\n=== 6. 统计口径 ===')
const s = mem.stats()
console.log(`   facts=${s.facts} valid=${s.valid} invalid=${s.invalid}  (facts 应 = valid + invalid)`)

// ---------------------------------------------------------------- 7. 老数据迁移

console.log('\n=== 7. 老数据（没有时效字段）能自动迁移 ===')
const dir2 = mkdtempSync(join(tmpdir(), 'pet-old-'))
const { writeFileSync } = await import('node:fs')
writeFileSync(join(dir2, 'facts.json'), JSON.stringify([
  { id: 'f_old_1', text: '用户喜欢猫', subject: 'user', importance: 4, createdAt: 1000, sourceAt: 1000, hash: 'x' },
]))
const logs = []
const mem2 = new Memory({ dir: dir2, request: null, embed: null, log: (m) => { logs.push(m); console.log('   ' + m) } })
const migrated = JSON.parse(readFileSync(join(dir2, 'facts.json'), 'utf8'))[0]
console.log(`   invalidAt=${JSON.stringify(migrated.invalidAt)} validFrom=${migrated.validFrom} ${migrated.invalidAt === null ? '✅ 迁移成功' : '❌'}`)
console.log(`   迁移后仍算有效：${mem2.stats().valid === 1 ? '✅ 是' : '❌ 否'}`)

rmSync(dir, { recursive: true, force: true })
rmSync(dir2, { recursive: true, force: true })
console.log('\n完成（临时目录已清理）')
