/**
 * 验证「换 embedding 模型时旧向量会作废」这条保护。
 *   node scripts/test-embedding-switch.mjs
 *
 * 为什么必须验：不同模型的向量空间不通用，拿旧向量算余弦不会报错，
 * 只会悄悄召回错东西 —— 这种 bug 最难发现。
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Memory } = require('../src/memory.js')

const dir = mkdtempSync(join(tmpdir(), 'pet-embswitch-'))
const logs = []
const log = (m) => { logs.push(m); console.log('   ' + m) }

// 造一批假向量，假装是「模型 A」算出来的
const fakeEmbedA = async (texts) => texts.map(() => Array.from({ length: 8 }, () => Math.random()))

console.log('=== 1. 用模型 A 生成向量 ===')
const m1 = new Memory({
  dir,
  request: null,
  embed: fakeEmbedA,
  embedModel: 'model-A',
  log,
})
m1.addFacts([
  { text: '用户是一名前端工程师', importance: 5 },
  { text: '用户最喜欢蓝色', importance: 4 },
])
await m1.embedMissing()
console.log(`   向量 ${Object.keys(m1.embeddings).length} 条，维度 ${m1.embDim}`)

const file = join(dir, 'embeddings.json')
const saved = JSON.parse(readFileSync(file, 'utf8'))
console.log(`   落盘格式: ${JSON.stringify({ model: saved.model, dim: saved.dim, count: Object.keys(saved.vectors || {}).length })}`)

console.log('\n=== 2. 换成模型 B 重新载入（维度也不同）===')
logs.length = 0
const fakeEmbedB = async (texts) => texts.map(() => Array.from({ length: 16 }, () => Math.random()))
const m2 = new Memory({
  dir,
  request: null,
  embed: fakeEmbedB,
  embedModel: 'model-B',
  log,
})
const invalidated = logs.some((l) => l.includes('向量模型变了'))
console.log(`   旧向量被作废：${invalidated ? '✅ 是' : '❌ 否 —— 这是 bug！'}`)
console.log(`   载入后向量数：${Object.keys(m2.embeddings).length}（应为 0）`)

console.log('\n=== 3. 补算后维度应该变成 B 的 ===')
await m2.embedMissing()
console.log(`   向量 ${Object.keys(m2.embeddings).length} 条，维度 ${m2.embDim}（应为 16）`)
const saved2 = JSON.parse(readFileSync(file, 'utf8'))
console.log(`   落盘 model=${saved2.model} dim=${saved2.dim}`)

console.log('\n=== 4. 同模型重载不应作废 ===')
logs.length = 0
const m3 = new Memory({ dir, request: null, embed: fakeEmbedB, embedModel: 'model-B', log })
const kept = logs.some((l) => l.includes('向量模型变了'))
console.log(`   误判作废：${kept ? '❌ 是（不该）' : '✅ 否'}`)
console.log(`   保留向量 ${Object.keys(m3.embeddings).length} 条（应为 2）`)

console.log('\n=== 5. 旧格式（没有模型标记）也要作废 ===')
const dir2 = mkdtempSync(join(tmpdir(), 'pet-embold-'))
writeFileSync(join(dir2, 'embeddings.json'), JSON.stringify({ f_1: [0.1, 0.2], f_2: [0.3, 0.4] }))
writeFileSync(join(dir2, 'facts.json'), JSON.stringify([
  { id: 'f_1', text: '用户喜欢蓝色', importance: 4, createdAt: 1, hash: 'a' },
]))
const logs2 = []
const m4 = new Memory({ dir: dir2, request: null, embed: fakeEmbedB, embedModel: 'model-B', log: (m) => { logs2.push(m); console.log('   ' + m) } })
console.log(`   旧格式被作废：${logs2.some((l) => l.includes('旧格式')) ? '✅ 是' : '❌ 否'}`)

rmSync(dir, { recursive: true, force: true })
rmSync(dir2, { recursive: true, force: true })
console.log('\n完成（临时目录已清理）')
