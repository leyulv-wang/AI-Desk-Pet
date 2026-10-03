/**
 * 记忆模块测试：抽取 → 向量化 → 混合召回
 *   node scripts/test-memory.mjs
 *
 * 用临时目录，不碰你真实的记忆。
 * 重点看最后一节：同一个查询在「纯 BM25」和「BM25 ⊕ 向量」下结果有什么区别。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Memory, similarity, cosine, rrf } = require('../src/memory.js')

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
  const p = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(p)) return null
  try {
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm'))
    return m ? m[1].replace(/^["']|["']$/g, '') : null
  } catch { return null }
}

const grab = (n) => process.env[n] || regVar(n) || dshCred(n)

// 和 app 一样：config.json 优先，其次才是环境变量三件套
let cfg = {}
try {
  cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
} catch { /* 没有就用默认 */ }
const cfgEmb = cfg.embedding || {}

const CHAT_KEY = grab('DEEPSEEK_API_KEY')
const CHAT_BASE = cfg.baseUrl || 'https://api.deepseek.com/v1'
const CHAT_MODEL = process.env.MEMORY_MODEL || cfg.extractModel || cfg.model || 'deepseek-flash'

const EMB_KEY = cfgEmb.apiKey || grab('EMBEDDING_API_KEY') || grab('DASHSCOPE_API_KEY') || grab('ALIYUN_API_KEY')
const EMB_BASE = cfgEmb.baseUrl || grab('EMBEDDING_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const EMB_MODEL = cfgEmb.model || grab('EMBEDDING_MODEL') || 'text-embedding-v4'

console.log(`抽取模型 : ${CHAT_MODEL}`)
console.log(`向量模型 : ${EMB_MODEL} @ ${EMB_BASE}`)
console.log(`           (Key ${EMB_KEY ? '有' : '无 —— 会降级为纯 BM25'})`)
const envModel = grab('EMBEDDING_MODEL')
if (envModel && envModel !== EMB_MODEL) {
  console.log(`           ⚠️ 环境变量 EMBEDDING_MODEL=${envModel}，被 config.json 覆盖了`)
}
console.log()

async function request(messages) {
  const res = await fetch(`${CHAT_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAT_KEY}` },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0.2, max_tokens: 2600 }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).choices?.[0]?.message?.content ?? ''
}

let embedCalls = 0
async function embed(texts) {
  if (!EMB_KEY) throw new Error('没有向量化 Key')
  embedCalls++
  const res = await fetch(`${EMB_BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EMB_KEY}` },
    body: JSON.stringify({ model: EMB_MODEL, input: texts, encoding_format: 'float' }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`)
  const list = (await res.json()).data || []
  if (list.every((d) => typeof d.index === 'number')) list.sort((a, b) => a.index - b.index)
  return list.map((d) => d.embedding)
}

// ---------------------------------------------------------------- 跑

const dir = mkdtempSync(join(tmpdir(), 'pet-mem-'))
const mem = new Memory({
  dir,
  request,
  embed,
  embedModel: EMB_MODEL,
  // 不同 embedding 模型的相似度基线差很多，这两个值跟着模型走
  vecMinScore: EMB_MODEL.includes('Qwen3') ? 0.5 : 0.35,
  vecMargin: 0.12,
  log: (m) => console.log(m),
})

console.log('=== 1. 抽取 + 向量化 ===')
const turns = [
  ['我叫小王，是个前端工程师，最近在做一个 AI 桌宠项目', '前端工程师做桌宠，听着就很搭！'],
  ['我最喜欢的颜色是蓝色，你别记错了', '记住啦，蓝色～'],
  ['今天加班到十一点，累死了', '辛苦啦，早点休息'],
  ['我家养了只猫叫豆豆，它特别粘人', '豆豆！听起来好可爱'],
  ['我显卡是 RTX 5060，只有 8G 显存，跑本地模型有点吃力', '8G 确实紧张，可以考虑走 API'],
]
for (const [u, a] of turns) mem.observe(u, a)
const r1 = await mem.consolidate()
await mem.embedMissing()
console.log(`\n  抽取 ${r1.added} 条，向量 ${mem.stats().embedded}/${mem.facts.length} 条，embedding 调用 ${embedCalls} 次\n`)
for (const f of mem.facts) console.log(`  [${f.importance}] ${f.text}`)

const v = (t) => {
  const f = mem.facts.find((x) => x.text.includes(t))
  return f ? mem.embeddings[f.id] : null
}
const catVec = v('豆豆')
const gpuVec = v('5060')
if (catVec && gpuVec) {
  console.log(`\n  语义合理性抽查（余弦，越低越不相关）：`)
  console.log(`    猫 vs 显卡  = ${cosine(catVec, gpuVec).toFixed(3)}`)
}

console.log('\n=== 2. 去重（bigram + 语义）===')
const beforeCount = mem.facts.length
for (const [u, a] of turns) mem.observe(u, a)
const r2 = await mem.consolidate()
await mem.embedMissing()
console.log(
  `  重复喂一遍 → 抽取阶段拦掉一部分，新增 ${r2.added} 条；` +
    `向量化后再语义去重，最终 ${mem.facts.length} 条（去重前 ${beforeCount} 条）`
)
for (const f of mem.facts) console.log(`    · ${f.text}`)

console.log('\n=== 2b. 事实两两余弦 —— 用来看去重阈值该定在哪 ===')
const pairs = []
for (let i = 0; i < mem.facts.length; i++) {
  for (let j = i + 1; j < mem.facts.length; j++) {
    const a = mem.facts[i], b = mem.facts[j]
    const c = cosine(mem.embeddings[a.id], mem.embeddings[b.id])
    if (c > 0.5) pairs.push({ c, a: a.text, b: b.text })
  }
}
pairs.sort((x, y) => y.c - x.c)
if (!pairs.length) console.log('  （没有余弦 > 0.5 的事实对）')
for (const p of pairs.slice(0, 8)) {
  console.log(`  ${p.c.toFixed(3)}  「${p.a.slice(0, 24)}」 ⇄ 「${p.b.slice(0, 24)}」`)
}
console.log(`  最高的一对 = ${pairs.length ? pairs[0].c.toFixed(3) : '—'}（当前阈值 0.94 / 包含 0.85）`)

console.log('\n=== 3. ⭐ 纯 BM25 vs BM25 ⊕ 向量 ===')
const probes = [
  ['我家那只毛孩子最近怎么样', '豆豆（猫）'],
  ['我这台电脑跑得动大模型吗', '显卡 / 8G 显存'],
  ['我是个做什么工作的', '前端工程师'],
  ['有没有推荐的颜色', '蓝色'],
]
for (const [q, expect] of probes) {
  const bm25 = mem.recallRanked(q, 3)
  const qv = await embed([q]).then((r) => r[0]).catch(() => null)
  const hybrid = mem.recallRanked(q, 3, qv)

  console.log(`\n  问「${q}」   期望命中：${expect}`)
  console.log(`    纯 BM25 : ${bm25.length ? bm25.map((x) => x.fact.text.slice(0, 22)).join(' | ') : '（无命中，走重要性兜底）'}`)
  console.log(`    混合    : ${hybrid.map((x) => `${x.fact.text.slice(0, 22)}${x.vecRank ? `(向量#${x.vecRank})` : ''}${x.bm25Rank ? `(BM25#${x.bm25Rank})` : ''}`).join(' | ')}`)
}

console.log('\n=== 4. 容错 ===')
const mem2 = new Memory({
  dir: mkdtempSync(join(tmpdir(), 'pet-mem2-')),
  request: async () => '这不是 JSON',
  embed: async () => { throw new Error('模拟向量服务挂了') },
  embedModel: 'x',
  log: () => {},
})
mem2.observe('我喜欢蓝色', '好的')
const r3 = await mem2.consolidate()
await mem2.embedMissing()
console.log(`  模型返回垃圾 → 新增 ${r3.added} 条（期望 0）`)
mem2.addFacts([{ text: '用户喜欢蓝色', importance: 4 }])
const fallback = mem2.recallRanked('蓝色', 3)
console.log(`  向量服务挂了 → 仍能召回 ${fallback.length} 条（纯 BM25 兜底）✓`)

console.log('\n=== 5. RRF 单元验证 ===')
// 故意构造成不对称：条目 1 在两个列表里都是靠前的，应该胜出
const fused = rrf([[0, 1, 2], [1, 2, 0]])
console.log(`  rrf([[0,1,2],[1,2,0]]) = ${JSON.stringify(fused)}   （期望首项是 1：它在两个榜里都靠前）`)
// 完全对称的情形是平局，顺序无所谓
console.log(`  rrf([[0,1,2],[2,1,0]]) = ${JSON.stringify(rrf([[0, 1, 2], [2, 1, 0]]))}   （对称 → 三者平局）`)

console.log('\n=== 6. 落盘 ===')
for (const [name, file] of [['facts.json', 'facts.json'], ['embeddings.json', 'embeddings.json']]) {
  const p = join(dir, file)
  console.log(`  ${name}: ${existsSync(p) ? `${(readFileSync(p).length / 1024).toFixed(1)} KB` : '不存在'}`)
}
const embFile = JSON.parse(readFileSync(join(dir, 'embeddings.json'), 'utf8'))
const vecKeys = Object.keys(embFile.vectors || {})
const dims = new Set(vecKeys.map((k) => embFile.vectors[k].length))
console.log(`  落盘格式: model=${embFile.model} dim=${embFile.dim}`)
console.log(`  向量 ${vecKeys.length} 条，维度 ${[...dims].join('/')}`)
console.log(`  每条约 ${vecKeys.length ? Math.round(readFileSync(join(dir, 'embeddings.json')).length / vecKeys.length / 1024 * 10) / 10 : 0} KB（紧凑格式，不缩进）`)

rmSync(dir, { recursive: true, force: true })
rmSync(mem2.dir, { recursive: true, force: true })
console.log('\n完成（临时目录已清理）')
