/**
 * 遗忘曲线 + 开环记忆测试
 *   node scripts/test-decay-loop.mjs
 *
 * 两件事分开验：
 *   遗忘曲线 —— 老而没被用到的事**降权但不删除**；被用到会"回血"
 *   开环记忆 —— "明天有面试"这种事，到点后她会主动关心后续，提够次数就不再念
 *
 * 时间相关的东西不好等，所以这里用「伪造时间」的办法：
 * 直接改事实的时间戳，然后看强度函数和召回排序怎么变。
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mem = require('../src/memory.js')
const { Memory } = mem

const DAY = 86400000
const dir = mkdtempSync(join(tmpdir(), 'pet-decay-'))
const mem0 = new Memory({ dir, request: null, embed: null, log: () => {} })

// 强度函数没导出，用一个不落盘的实例间接测
function strengthOf(fact, now = Date.now()) {
  // 复制一份逻辑做对照会失真，所以走 stats 的路子不现实 —— 直接调私有行为：
  // markRecalled + recallRanked 的排序结果才是我们真正关心的。
  // 这里为了单点验证，手动实现同一条公式。
  const HL = { 5: 180, 4: 90, 3: 30, 2: 14, 1: 7 }
  const anchor = fact.lastRecalledAt || fact.createdAt || now
  const ageDays = Math.max(0, (now - anchor) / DAY)
  const boost = 1 + Math.log1p(fact.recallCount || 0) * 0.6
  return Math.max(0.2, Math.pow(0.5, ageDays / ((HL[fact.importance] ?? 30) * boost)))
}

console.log('=== 1. 强度随时间衰减、随使用回血 ===\n')
const now = Date.now()
console.log('  同一条事实（importance=4，半衰期 90 天）在不同时间点的强度：')
const base = { importance: 4, createdAt: now, recallCount: 0, lastRecalledAt: null }
for (const d of [0, 30, 90, 180, 365, 3650]) {
  const s = strengthOf({ ...base, createdAt: now - d * DAY }, now)
  console.log(`    ${String(d).padStart(4)} 天前创建 → 强度 ${s.toFixed(3)}`)
}
console.log('\n  被用过 5 次之后（回血）：')
const used = { ...base, createdAt: now - 90 * DAY, recallCount: 5, lastRecalledAt: now - 1 * DAY }
console.log(`    90 天前创建但昨天刚用过 → 强度 ${strengthOf(used, now).toFixed(3)}`)

console.log('\n  不同重要性的半衰期差异（同样 60 天没碰）：')
for (const imp of [5, 4, 3, 2, 1]) {
  const s = strengthOf({ importance: imp, createdAt: now - 60 * DAY, recallCount: 0 }, now)
  console.log(`    importance=${imp} → 强度 ${s.toFixed(3)}`)
}

// ---------------------------------------------------------------- 召回排序

console.log('\n=== 2. ⭐ 衰减影响召回排序，但不删除 ===')
const dir2 = mkdtempSync(join(tmpdir(), 'pet-decay2-'))
const m = new Memory({ dir: dir2, request: null, embed: null, log: () => {} })

// 三条同样相关的事实，只有"新鲜度"不同
m.facts = [
  { id: 'f_new', text: '用户最喜欢的颜色是蓝色', subject: 'user', importance: 4,
    createdAt: now, validFrom: now, invalidAt: null, recallCount: 0, lastRecalledAt: null, hash: 'a' },
  { id: 'f_mid', text: '用户以前最喜欢的颜色是蓝色系', subject: 'user', importance: 4,
    createdAt: now - 120 * DAY, validFrom: now - 120 * DAY, invalidAt: null, recallCount: 0, lastRecalledAt: null, hash: 'b' },
  { id: 'f_old', text: '用户曾经最喜欢的颜色是蓝色调', subject: 'user', importance: 4,
    createdAt: now - 365 * DAY, validFrom: now - 365 * DAY, invalidAt: null, recallCount: 0, lastRecalledAt: null, hash: 'c' },
]

const picked = m.recallRanked('我喜欢什么颜色', 5)
console.log('  问「我喜欢什么颜色」的排序：')
for (const p of picked) {
  console.log(`    ${p.fact.id.padEnd(7)} 强度=${(p.strength ?? 1).toFixed(3)}  ${p.fact.text}`)
}
console.log(`  三条都还在（只是排序不同）：${m.facts.length === 3 ? '✅ 是' : '❌ 否'}`)

console.log('\n=== 3. 关掉衰减后应该等权（只看相关性）===')
const m2 = new Memory({ dir: mkdtempSync(join(tmpdir(), 'pet-decay3-')), request: null, embed: null, decayEnabled: false, log: () => {} })
m2.facts = m.facts.map((f) => ({ ...f, id: f.id + '_2' }))
const picked2 = m2.recallRanked('我喜欢什么颜色', 5)
console.log(`  衰减关闭时统计里的 avgStrength = ${m2.stats().avgStrength.toFixed(3)}（应为 1.000）`)

// ---------------------------------------------------------------- 开环

console.log('\n=== 4. ⭐ 开环记忆：到点主动关心，提够就不再念 ===')
const dir4 = mkdtempSync(join(tmpdir(), 'pet-loop-'))
const m4 = new Memory({ dir: dir4, request: null, embed: null, maxSurfaces: 2, log: () => {} })

const makeLoop = (id, text, followUpAt, extra = {}) => ({
  id, text, subject: 'user', importance: 4, createdAt: now, validFrom: now, invalidAt: null,
  recallCount: 0, lastRecalledAt: null, followUpAt, surfacedCount: 0, lastSurfacedAt: null, closedAt: null, hash: id, ...extra,
})

m4.facts = [
  makeLoop('l_future', '用户明天下午三点有面试', now + 20 * 3600000),   // 还没到
  makeLoop('l_due', '用户今天上午有体检', now - 2 * 3600000),           // 已到点
  makeLoop('l_done', '用户上周有场考试', now - 5 * DAY, { closedAt: now - 4 * DAY }), // 已了结
]

let due = m4.dueOpenLoops(5)
console.log(`  到点该提的：${due.length} 件 → ${due.map((f) => f.text).join(' / ')}`)
console.log(`  ${due.length === 1 && due[0].id === 'l_due' ? '✅ 只挑出已到点且没了结的' : '❌ 选错了'}`)

console.log('\n  第一次提：')
let surfaced = m4.dueOpenLoops(1)
m4.markSurfaced(surfaced)
console.log(`    提了「${surfaced[0]?.text}」，surfacedCount=${m4.facts.find((f) => f.id === 'l_due').surfacedCount}`)
console.log(`    还该提吗：${m4.dueOpenLoops(5).length > 0 ? '是' : '否'}`)

console.log('  第二次提：')
surfaced = m4.dueOpenLoops(1)
m4.markSurfaced(surfaced)
const loop = m4.facts.find((f) => f.id === 'l_due')
console.log(`    surfacedCount=${loop.surfacedCount}，closedAt=${loop.closedAt ? '已了结' : '未了结'}`)
console.log(`    还会再提吗：${m4.dueOpenLoops(5).length > 0 ? '⚠️ 会（不该）' : '✅ 不会 —— 提够次数自动收敛'}`)

console.log('\n=== 5. followUpAt 解析要能挡住坏值 ===')
const m5 = new Memory({ dir: mkdtempSync(join(tmpdir(), 'pet-loop2-')), request: null, embed: null, log: () => {} })

// 本地时间写法（去掉时区）—— 这是模型最可能给的格式，代码应当按本地时间理解
const localNaive = (offsetMs) => {
  const t = new Date(Date.now() + offsetMs)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

const cases = [
  ['未来 2 小时', new Date(Date.now() + 2 * 3600000).toISOString(), true],
  ['过去的时间', new Date(Date.now() - 3600000).toISOString(), false],
  ['5 分钟内（太近）', new Date(Date.now() + 60000).toISOString(), false],
  ['一年后（太远）', new Date(Date.now() + 400 * DAY).toISOString(), false],
  ['本地时间写法', localNaive(3 * 3600000), true],
  ['带中文的', `明天 ${localNaive(20 * 3600000).slice(11)}`, true],
  ['纯垃圾', '明天吧', false],
  ['空字符串', '', false],
]
for (const [label, val, expect] of cases) {
  const m = new Memory({ dir: mkdtempSync(join(tmpdir(), 'pet-fu-')), request: null, embed: null, log: () => {} })
  m.addFacts([{ text: `测试事实 ${label}`, importance: 3, followUpAt: val }])
  const got = !!m.facts[0]?.followUpAt
  console.log(`  ${label.padEnd(16)} → ${got ? '接受' : '忽略'}  ${got === expect ? '✅' : '❌ 期望' + (expect ? '接受' : '忽略')}`)
}

// ---------------------------------------------------------------- 落盘

console.log('\n=== 6. 召回计数延迟落盘（不每句话都写文件）===')
const dir6 = mkdtempSync(join(tmpdir(), 'pet-dirty-'))
const m6 = new Memory({ dir: dir6, request: null, embed: null, log: () => {} })
m6.addFacts([{ text: '用户喜欢蓝色', importance: 4 }])
const t0 = readFileSync(join(dir6, 'facts.json'), 'utf8')
m6.markRecalled(m6.facts)
const t1 = readFileSync(join(dir6, 'facts.json'), 'utf8')
console.log(`  markRecalled 之后立刻读文件，内容变了吗：${t0 === t1 ? '✅ 没变（等 5 秒才落盘）' : '❌ 立刻写了'}`)
m6.flush()
const t2 = readFileSync(join(dir6, 'facts.json'), 'utf8')
const after = JSON.parse(t2)[0]
console.log(`  flush() 之后 recallCount=${after.recallCount} ${after.recallCount === 1 ? '✅' : '❌'}`)

for (const d of [dir, dir2, dir4, dir6]) rmSync(d, { recursive: true, force: true })
rmSync(m2.dir, { recursive: true, force: true })
rmSync(m5.dir, { recursive: true, force: true })
console.log('\n完成（临时目录已清理）')
