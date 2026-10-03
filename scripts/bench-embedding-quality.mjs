/**
 * Embedding 检索质量基准：三个尺寸的 Qwen3-Embedding 对比
 *   node scripts/bench-embedding-quality.mjs
 *
 * 测的是**这个项目真正在意的事**：用户换了种说法问，能不能把正确的那条事实排到前面。
 * 所以查询刻意和事实文字**零字面重叠**（没有共同的关键词）——
 * 靠字面匹配能做到的，BM25 已经做了，不需要向量。
 *
 * 指标：
 *   Top1  正确事实排第一的比例（最重要）
 *   Top3  排进前三的比例
 *   MRR   平均倒数排名（1=每次第一，越低越差）
 *   干扰项平均排名  错误事实被排到多高（越低越好，说明不瞎召回）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

const KEY = grab('EMBEDDING_API_KEY')
const BASE = (grab('EMBEDDING_BASE_URL') || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')

// ---------------------------------------------------------------- 测试数据

/** 事实库（10 条，互相独立，覆盖不同主题） */
const FACTS = [
  '用户是一名前端工程师',
  '用户叫小王',
  '用户最喜欢的颜色是蓝色',
  '用户养了一只叫豆豆的橘猫，特别粘人',
  '用户的显卡是 RTX 5060，只有 8G 显存，跑本地模型比较吃力',
  '用户最喜欢的乐队是 King Crimson，尤其《红》专辑',
  '用户的女友叫小林，她不喜欢用户熬夜',
  '用户正在做一个 AI 桌宠项目，用 Electron 加 Live2D',
  '用户大学学的是数字媒体，辅修过音乐',
  '用户最近在学 Rust，觉得所有权概念有点难',
]

/** 查询：[问法, 应该命中的事实的下标] —— 刻意不用事实里的关键词 */
const QUERIES = [
  ['我家那只毛孩子最近怎么样', 3],       // 「毛孩子」≠「橘猫」「粘人」
  ['我是靠什么吃饭的', 0],               // ≠「前端工程师」
  ['给我推荐个配色呗', 2],               // ≠「颜色」「蓝色」
  ['我这台机器跑得动大模型吗', 4],       // ≠「显卡」「显存」
  ['我喜欢听什么类型的音乐', 5],         // ≠「乐队」
  ['我对象对我有什么意见', 6],           // ≠「女友」「小林」
  ['我最近在忙什么', 7],                 // ≠「桌宠项目」
  ['我大学念的什么专业', 8],             // ≠「数字媒体」（有「大学」重叠，算半字面）
  ['有个编程语言我学得挺痛苦', 9],       // ≠「Rust」「所有权」
  ['我怎么称呼来着', 1],                 // ≠「小王」
]

const MODELS = [
  'Qwen/Qwen3-Embedding-0.6B',
  'Qwen/Qwen3-Embedding-4B',
  'Qwen/Qwen3-Embedding-8B',
  'BAAI/bge-m3',
]

// ---------------------------------------------------------------- 工具

async function embed(model, texts) {
  const t = Date.now()
  const res = await fetch(`${BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
  })
  const ms = Date.now() - t
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
  const j = await res.json()
  const list = (j.data || []).sort((a, b) => a.index - b.index)
  return { vecs: list.map((d) => d.embedding), ms }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

function tokenize(s) {
  const t = String(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const out = []
  for (let i = 0; i < t.length; i++) { out.push(t[i]); if (i + 1 < t.length) out.push(t.slice(i, i + 2)) }
  return out
}
/** 看一眼查询和事实有没有字面重叠 —— 有重叠的话 BM25 就能做，不算向量的功劳 */
function overlap(q, f) {
  const A = new Set(tokenize(q).filter((x) => x.length === 2))
  const B = new Set(tokenize(f).filter((x) => x.length === 2))
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n
}

console.log(`接口: ${BASE}`)
console.log(`事实 ${FACTS.length} 条，查询 ${QUERIES.length} 个（刻意避开事实原词）\n`)

// 先看看哪些查询确实没有字面重叠
const overlaps = QUERIES.map(([q, i]) => ({ q, ov: overlap(q, FACTS[i]) }))
const pureSemantic = overlaps.filter((o) => o.ov === 0).length
console.log(`其中 ${pureSemantic}/${QUERIES.length} 个查询与目标事实**零 bigram 重叠**（纯靠语义）`)
for (const o of overlaps) if (o.ov > 0) console.log(`  · 「${o.q}」与目标有 ${o.ov} 个 bigram 重叠（BM25 也认得出）`)
console.log()

console.log('模型                         维度  Top1   Top3    MRR   干扰均排   查询延迟(中位/最慢)')
console.log('─'.repeat(92))

const results = []
for (const model of MODELS) {
  let dim = 0
  try {
    const warm = await embed(model, ['预热'])
    dim = warm.vecs[0].length

    const { vecs: factVecs } = await embed(model, FACTS)

    let top1 = 0, top3 = 0, mrr = 0, distractorSum = 0, distractorN = 0
    const lat = []

    for (const [q, expect] of QUERIES) {
      const { vecs, ms } = await embed(model, [q])
      lat.push(ms)
      const qv = vecs[0]

      const ranked = FACTS.map((f, i) => ({ i, s: cosine(qv, factVecs[i]) })).sort((a, b) => b.s - a.s)
      const rank = ranked.findIndex((r) => r.i === expect) + 1

      if (rank === 1) top1++
      if (rank <= 3) top3++
      mrr += 1 / rank

      // 干扰项：排名在正确答案之前的那些，位置越低越好
      for (let k = 0; k < rank - 1; k++) { distractorSum += k + 1; distractorN++ }
    }

    lat.sort((a, b) => a - b)
    const med = lat[Math.floor(lat.length / 2)]
    const row = {
      model, dim,
      top1: top1 / QUERIES.length,
      top3: top3 / QUERIES.length,
      mrr: mrr / QUERIES.length,
      distractor: distractorN ? distractorSum / distractorN : 0,
      med, max: lat[lat.length - 1],
    }
    results.push(row)

    console.log(
      `${model.replace('Qwen/', '').replace('BAAI/', '').padEnd(28)}` +
        `${String(dim).padStart(5)}` +
        `${(row.top1 * 100).toFixed(0).padStart(6)}%` +
        `${(row.top3 * 100).toFixed(0).padStart(6)}%` +
        `${row.mrr.toFixed(3).padStart(7)}` +
        `${row.distractor.toFixed(2).padStart(9)}` +
        `${String(med + 'ms').padStart(14)} / ${row.max}ms`
    )
  } catch (e) {
    console.log(`${model.padEnd(28)} 失败: ${e.message}`)
  }
}

// ---------------------------------------------------------------- 结论

const good = results.filter((r) => r.top1 >= 0.8)
console.log()
if (!good.length) {
  console.log('⚠️ 没有一个模型达到 80% Top1 —— 说明查询和事实差得太远，或模型不适配中文短句检索')
} else {
  // 在质量达标的前提下，选延迟最低的（尾部延迟权重更高）
  const best = good.sort((a, b) => a.med + a.max * 0.3 - (b.med + b.max * 0.3))[0]
  console.log(`建议：${best.model}`)
  console.log(`  质量 Top1 ${(best.top1 * 100).toFixed(0)}%，延迟中位 ${best.med}ms / 最慢 ${best.max}ms`)
  console.log(`  （Top1 ≥80% 的候选里，按「中位 + 0.3×最慢」选最稳的 —— 桌宠怕的是偶发卡顿）`)
}
console.log('\n注：这只是 10 个样本的小基准，够用来排除明显不行的，不足以精确排名。')
