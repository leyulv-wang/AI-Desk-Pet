/**
 * 「像不像」的正确度量：音色相似度（LTAS），对照真实语音
 *   node scripts/timbre-vs-real.mjs <真实语音目录> <候选wav...>
 *   node scripts/timbre-vs-real.mjs --refs=8 <真实语音目录> <候选wav...>
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本
 * ────────────────────────────────────────────────────────────────────
 * 之前我用「F0 + 音域」当相似度（scripts/tune-mimo-vs-real.mjs），
 * 算出一个 MiMo 配置比 MiniMax 更像（0.40 vs 0.44）。
 * **用户听完直接否了：MiniMax 明显更像。**
 *
 * 错在哪：F0 和音域量的是**语调起伏**，而「像不像本人」的主体是**音色** ——
 * 语调可以调（一条指令的事），音色调不了（那是模型学出来的）。
 * 拿语调指标当相似度，等于用身高去判断双胞胎。
 *
 * 音色的正确度量是**长时平均频谱（LTAS）**：
 * 把整段音频按频段统计平均能量，得到一个和内容无关、只反映音色的向量，
 * 再和真实语音的 LTAS 做余弦相似度。同一个人念不同的句子这个向量很稳，
 * 换个人念同样的句子差别很明显。
 *
 * 参考不是单条真实语音 —— 取 N 条的 LTAS 平均，免得某条的环境/情绪带偏。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readWav } from './lib/wav-prosody.mjs'

const argv = process.argv.slice(2)
const NREFS = Number((argv.find((a) => a.startsWith('--refs=')) || '').split('=')[1]) || 30
const paths = argv.filter((a) => !a.startsWith('--'))
if (paths.length < 2) {
  console.error('用法：node scripts/timbre-vs-real.mjs <真实语音目录> <候选wav...>')
  process.exit(1)
}
const realDir = paths[0]
const cands = paths.slice(1)

// ================================================================ LTAS

const BANDS = Array.from({ length: 24 }, (_, i) => 100 * Math.pow(8000 / 100, i / 23))

/** 单频点能量（Goertzel）—— 只要二十几个频点，比写 FFT 短且够准 */
function goertzel(samples, sr, freq) {
  const w = (2 * Math.PI * freq) / sr
  const cw = Math.cos(w)
  const coeff = 2 * cw
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/** 长时平均频谱：40ms 窗、20ms 跳步，每帧归一化后求平均 */
function ltas(audio) {
  const { sr, data } = audio
  const win = Math.round(0.04 * sr)
  const hop = Math.round(0.02 * sr)
  const acc = new Array(BANDS.length).fill(0)
  let frames = 0
  for (let s = 0; s + win <= data.length; s += hop) {
    const frame = data.subarray(s, s + win)
    let peak = 0
    for (const v of frame) peak = Math.max(peak, Math.abs(v))
    if (peak < 0.02) continue // 跳过静音帧，否则频谱被拉平
    const e = BANDS.map((f) => goertzel(frame, sr, f))
    const sum = e.reduce((x, y) => x + y, 0) || 1
    for (let i = 0; i < e.length; i++) acc[i] += e[i] / sum
    frames++
  }
  return frames ? acc.map((v) => v / frames) : null
}

function cosine(a, b) {
  let d = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// ================================================================ 参考

if (!existsSync(realDir)) {
  console.error(`找不到真实语音目录：${realDir}`)
  process.exit(1)
}
const allReal = readdirSync(realDir).filter((f) => /\.wav$/i.test(f)).sort()
const step = Math.max(1, Math.floor(allReal.length / NREFS))
const picked = allReal.filter((_, i) => i % step === 0).slice(0, NREFS)
const refVecs = []
for (const f of picked) {
  try {
    const v = ltas(readWav(join(realDir, f)))
    if (v) refVecs.push(v)
  } catch {
    /* 单条坏了跳过 */
  }
}
if (!refVecs.length) {
  console.error('真实语音一条都算不出 LTAS')
  process.exit(1)
}
const ref = refVecs[0].map((_, i) => refVecs.reduce((a, v) => a + v[i], 0) / refVecs.length)

console.log(`参考：${refVecs.length}/${picked.length} 条真实语音的 LTAS 平均（来自 ${basename(realDir)}）\n`)

// ================================================================ 候选

console.log('  候选                              音色相似度   差距')
console.log('  ' + '-'.repeat(62))
const rows = cands.map((f) => {
  if (!existsSync(f)) return { f, err: '文件不存在' }
  try {
    const v = ltas(readWav(f))
    return { f, score: v ? cosine(ref, v) : NaN }
  } catch (e) {
    return { f, err: e.message }
  }
})
const good = rows.filter((r) => isFinite(r.score))
const best = good.length ? Math.max(...good.map((r) => r.score)) : 0
for (const r of rows) {
  if (r.err) console.log(`  ${basename(r.f).padEnd(32)} ❌ ${r.err}`)
  else console.log(`  ${basename(r.f).padEnd(32)} ${r.score.toFixed(4)}     ${(r.score - best >= 0 ? '+' : '') + (r.score - best).toFixed(4)}`)
}

console.log('\n  读法：')
console.log('    · 数值是「音色相似度」（0~1），越高越像真实语音')
console.log('    · **和语调指标（F0/音域）不是一回事** —— 语调可以调，音色调不了')
console.log('    · 差距 0.01 以上就有意义；差 0.05 以上人耳能听出来')
console.log('    · 这是「像不像」的主体判断，但**最终裁判还是你的耳朵**')
