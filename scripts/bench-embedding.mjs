/**
 * 量一下查询向量化的延迟 —— 这个数直接加在「用户按下回车」到「她开始说话」之间。
 *   node scripts/bench-embedding.mjs [次数]
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
const BASE = grab('EMBEDDING_BASE_URL') || 'https://api.siliconflow.cn/v1'
const N = Number(process.argv[2]) || 12

const MODELS = [
  grab('EMBEDDING_MODEL') || 'Qwen/Qwen3-Embedding-8B',
  'Qwen/Qwen3-Embedding-4B',
  'Qwen/Qwen3-Embedding-0.6B',
  'BAAI/bge-m3',
]

// 模拟真实查询：一句中文短句
const QUERIES = [
  '我家那只毛孩子最近怎么样',
  '我这台电脑跑得动大模型吗',
  '我是个做什么工作的',
  '有没有推荐的颜色',
  '今天想聊点什么好呢',
]

async function one(model, text) {
  const t = Date.now()
  const res = await fetch(`${BASE.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, input: [text], encoding_format: 'float' }),
  })
  const ms = Date.now() - t
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 100)}`)
  const j = await res.json()
  return { ms, dim: j.data?.[0]?.embedding?.length }
}

console.log(`接口: ${BASE}\n每档测 ${N} 次单条中文查询\n`)
console.log('模型                          维度   中位   平均    最慢   最快')
console.log('─'.repeat(72))

for (const m of MODELS) {
  const times = []
  let dim = 0
  let err = null
  try {
    // 先热一次，排除冷启动
    await one(m, '预热').catch(() => {})
    for (let i = 0; i < N; i++) {
      const r = await one(m, QUERIES[i % QUERIES.length])
      times.push(r.ms)
      dim = r.dim
    }
  } catch (e) {
    err = e.message
  }
  if (err || !times.length) {
    console.log(`${m.padEnd(30)} ——  ${err || '无数据'}`)
    continue
  }
  times.sort((a, b) => a - b)
  const mid = times[Math.floor(times.length / 2)]
  const avg = Math.round(times.reduce((a, b) => a + b) / times.length)
  console.log(
    `${m.padEnd(30)}${String(dim).padStart(5)}${String(mid).padStart(7)}ms` +
      `${String(avg).padStart(7)}ms${String(times[times.length - 1]).padStart(8)}ms${String(times[0]).padStart(7)}ms`
  )
}

console.log('\n注：这个延迟会直接加在「回车 → 她开始说话」之间。')
console.log('    >500ms 就明显能感觉到卡顿了，值得换个更小的模型。')
