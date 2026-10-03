/** 验证用户新配的 Embedding 三件套 */
import { execFileSync } from 'node:child_process'

function regVar(name) {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    })
    const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch { return null }
}

const KEY = process.env.EMBEDDING_API_KEY || regVar('EMBEDDING_API_KEY')
const BASE = process.env.EMBEDDING_BASE_URL || regVar('EMBEDDING_BASE_URL')
const MODEL = process.env.EMBEDDING_MODEL || regVar('EMBEDDING_MODEL')

console.log('baseUrl:', BASE)
console.log('model  :', MODEL)
console.log('key    :', KEY ? KEY.slice(0, 7) + '…' + KEY.slice(-4) : '（无）')
console.log()

if (!KEY || !BASE || !MODEL) {
  console.log('❌ 三件套不齐')
  process.exit(1)
}

const texts = [
  '用户养了一只叫豆豆的猫，很粘人',
  '用户最喜欢的乐队是 King Crimson',
  '用户是个前端工程师',
  '我家那只毛孩子最近怎么样',      // 和第一条语义相关但零字面重叠
  '今天天气不错',                  // 跟谁都不相关
]

const t0 = Date.now()
const res = await fetch(`${BASE.replace(/\/+$/, '')}/embeddings`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: MODEL, input: texts, encoding_format: 'float' }),
})
const ms = Date.now() - t0

if (!res.ok) {
  console.log('❌ HTTP', res.status, (await res.text()).slice(0, 300))
  process.exit(1)
}

const j = await res.json()
const vecs = (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding)
console.log(`✅ HTTP 200  ${ms}ms  ${vecs.length} 条  维度=${vecs[0].length}`)
console.log('   usage:', JSON.stringify(j.usage || {}))
console.log()

const cos = (a, b) => {
  let s = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return s / (Math.sqrt(na) * Math.sqrt(nb))
}

console.log('语义相似度矩阵（挑几对看是否合理）：')
const pairs = [
  [3, 0, '「我家那只毛孩子」↔「养了只叫豆豆的猫」  应该很高'],
  [3, 4, '「我家那只毛孩子」↔「今天天气不错」      应该很低'],
  [0, 1, '「豆豆的猫」↔「King Crimson」            应该中等偏低'],
  [2, 4, '「前端工程师」↔「今天天气不错」          应该低'],
]
for (const [i, k, note] of pairs) {
  console.log(`  ${cos(vecs[i], vecs[k]).toFixed(3)}   ${note}`)
}

console.log('\n单条查询延迟（对话时每次都要算一次）：')
const singles = []
for (let i = 0; i < 3; i++) {
  const s = Date.now()
  await fetch(`${BASE.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: ['今天想聊点什么好呢'], encoding_format: 'float' }),
  })
  singles.push(Date.now() - s)
}
console.log(`  ${singles.join('ms / ')}ms  → 平均 ${Math.round(singles.reduce((a, b) => a + b) / singles.length)}ms`)
