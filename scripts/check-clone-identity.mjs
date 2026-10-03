/**
 * 「这个音色到底像不像参考音频」—— 用长时平均频谱（LTAS）比
 *   node scripts/check-clone-identity.mjs <参考音频> <候选1> <候选2> ...
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么不能只看基频（F0）
 * ────────────────────────────────────────────────────────────────────
 * 基频只说明「声音多高」，**和音色是两回事**。
 * 两个完全不同的女声可以 F0 一模一样 —— 实测过：
 *   克隆音色 F0=27.0，系统女声 F0=26.1，看着几乎相同，但听感差得远。
 * 用 F0 判断「克隆生效了吗」会得出错误结论。
 *
 * ────────────────────────────────────────────────────────────────────
 * LTAS 为什么能判
 * ────────────────────────────────────────────────────────────────────
 * 音色主要由**频谱包络**决定（共振峰的位置和强度），也就是「哪些频段有多少能量」。
 * 把整段音频按频段统计平均能量，就得到一个和内容无关、只反映音色的向量。
 * 同一句话用不同音色念，这个向量差别很明显；同一个人念不同的句子，它反而很稳。
 *
 * 判据：候选音频的 LTAS 和参考音频的 LTAS 做余弦相似度。
 *   · 克隆成功 → 明显高于「随便一个系统音色」
 *   · 克隆没生效（悄悄回落到默认音色）→ 和系统音色差不多
 *
 * 这不是「像不像本人」的最终裁判（那只能靠耳朵），
 * 而是**先排掉「根本没克隆上」这个可能**，免得白听一轮。
 */
import { readWav } from './lib/wav-prosody.mjs'
import { basename } from 'node:path'
import { existsSync } from 'node:fs'

/** 频段中心（Hz）—— 100Hz 到 8kHz 对数分布，覆盖语音的主要共振峰区间 */
const BANDS = Array.from({ length: 24 }, (_, i) => 100 * Math.pow(8000 / 100, i / 23))

/**
 * 单频点能量（Goertzel）。
 * 用它而不是 FFT：只需要二十几个频点，Goertzel 比写一个 FFT 短得多也够准。
 */
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

/** 长时平均频谱：按 40ms 窗、20ms 跳步，对每帧归一化后求平均 */
function ltas(audio, { winMs = 40, hopMs = 20 } = {}) {
  const { sr, data } = audio
  const win = Math.round((winMs / 1000) * sr)
  const hop = Math.round((hopMs / 1000) * sr)
  const acc = new Array(BANDS.length).fill(0)
  let frames = 0

  for (let s = 0; s + win <= data.length; s += hop) {
    const frame = data.subarray(s, s + win)
    // 跳过静音帧 —— 它们会把频谱拉平，掩盖音色差异
    let peak = 0
    for (const v of frame) peak = Math.max(peak, Math.abs(v))
    if (peak < 0.02) continue

    const e = BANDS.map((f) => goertzel(frame, sr, f))
    const sum = e.reduce((x, y) => x + y, 0) || 1
    for (let i = 0; i < e.length; i++) acc[i] += e[i] / sum // 每帧先归一化，去掉音量影响
    frames++
  }
  if (!frames) return null
  return acc.map((v) => v / frames)
}

/** 余弦相似度 —— 对整体缩放不敏感，正好适合比「形状」 */
function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

const [refPath, ...cands] = process.argv.slice(2)
if (!refPath || !cands.length) {
  console.error('用法：node scripts/check-clone-identity.mjs <参考音频> <候选1> [候选2 ...]')
  process.exit(1)
}

const ref = ltas(readWav(refPath))
if (!ref) {
  console.error('参考音频里没有可用的人声帧')
  process.exit(1)
}
console.log(`参考（克隆源）：${basename(refPath)}\n`)

// 缺文件直接跳过，别整个脚本崩掉 —— 对比时少一个候选是常事
const usable = cands.filter((f) => {
  if (existsSync(f)) return true
  console.log(`  （跳过，文件不存在：${f}）`)
  return false
})
if (!usable.length) {
  console.error('没有可用的候选音频')
  process.exit(1)
}

console.log('  候选音频                         LTAS 相似度   相对最低')
console.log('  ' + '-'.repeat(62))

const scored = usable.map((f) => ({ f, score: cosine(ref, ltas(readWav(f)) || ref.map(() => 0)) }))
const baseline = Math.min(...scored.map((s) => s.score))

for (const s of scored) {
  const delta = s.score - baseline
  console.log(
    `  ${basename(s.f).padEnd(32)} ${s.score.toFixed(4)}      ${delta > 0.001 ? '+' : ''}${delta.toFixed(4)}`
  )
}

console.log('\n  读法：')
console.log('    · 克隆音色的相似度应该**明显高于**系统音色（差 0.01 以上就有意义）')
console.log('    · 如果两者差不多 → 克隆没生效，在偷偷用默认音色，那就不用听了')
console.log('    · 这只是「排掉没克隆上」，**像不像本人还得靠耳朵**')
