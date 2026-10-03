/**
 * WAV 解析 + 基频（F0）估计 —— 给测量脚本共用
 *
 * 不依赖任何音频库。自己解 WAV 头，用自相关估基频。
 *
 * 为什么用 F0 而不是「听起来像不像」：
 *   语气（平静 / 上扬 / 叹息）最直接的声学表征就是基频轨迹。
 *   前后两段平均音高差超过半音，耳朵就会觉得「换了个语气/换了个在念」。
 */

import { readFileSync } from 'node:fs'

/** 解 16-bit PCM WAV。返回 {sr, data:Float32Array} */
export function readWav(file) {
  const buf = readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`不是 WAV：${file}`)
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sr: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt 或 data 块')
  if (fmt.bits !== 16) throw new Error(`只支持 16-bit，拿到 ${fmt.bits}`)

  const ch = fmt.channels
  const frames = Math.floor(data.length / 2 / ch)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = data.readInt16LE(i * 2 * ch) / 32768
  return { sr: fmt.sr, data: out }
}

/**
 * 自相关估一帧的基频。返回 Hz，或 null（清音/静音）
 *
 * 两个容易写错的地方（都踩过）：
 *
 * ① **归一化方式**。第一版写的是 `sum / (n - lag)`，想让不同 lag 可比 ——
 *    结果恰好相反：lag 越大，除的数越小，分数越大，于是**系统性偏向长 lag**，
 *    也就是把基频估成一半（低八度）。自检里 ±1 半音的摆动被估成 13.6 半音就是这么来的。
 *    正确做法是归一化互相关：
 *        r(lag) = Σ x[i]·x[i+lag] / sqrt( Σx[i]² · Σx[i+lag]² )
 *    用平方前缀和在 O(1) 内拿到两个分母。
 *
 * ② **取哪个峰**。纯周期信号在 lag = T、2T、3T… 处都是峰，值都接近 1。
 *    取全局最大会随机落到 2T 上（低八度）。所以取**第一个足够强的峰** ——
 *    它对应最短周期，也就是真正的基频。
 */
export function f0OfFrame(frame, sr, minHz = 70, maxHz = 420) {
  const n = frame.length
  let energy = 0
  for (let i = 0; i < n; i++) energy += frame[i] * frame[i]
  const mean = energy / n
  if (mean < 1e-5) return null // 太安静不判，硬判会得到一堆假 F0

  // 去掉直流，否则低频漂移会干扰自相关
  let dc = 0
  for (let i = 0; i < n; i++) dc += frame[i]
  dc /= n
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = frame[i] - dc

  // x² 的前缀和，用来 O(1) 拿任意区间的能量
  const ps = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + x[i] * x[i]
  const segEnergy = (a, b) => ps[b] - ps[a] // [a, b)

  const minLag = Math.max(2, Math.floor(sr / maxHz))
  const maxLag = Math.min(n - 2, Math.ceil(sr / minHz))
  if (maxLag <= minLag) return null

  const r = new Float64Array(maxLag + 2)
  for (let lag = minLag; lag <= maxLag; lag++) {
    const m = n - lag
    let num = 0
    for (let i = 0; i < m; i++) num += x[i] * x[i + lag]
    const d = Math.sqrt(segEnergy(0, m) * segEnergy(lag, n))
    r[lag] = d > 1e-12 ? num / d : 0
  }

  // 找局部极大，取第一个足够强的
  let globalMax = 0
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > globalMax) globalMax = r[lag]
  if (globalMax < 0.3) return null // 整帧都不周期 → 清音
  const accept = globalMax * 0.85

  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (r[lag] >= accept && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      // 抛物线插值，让基频估得比整数 lag 更准（音域测量对这点敏感）
      const a = r[lag - 1]
      const b = r[lag]
      const c = r[lag + 1]
      const denom = a - 2 * b + c
      const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0
      const refined = lag + Math.max(-0.5, Math.min(0.5, shift))
      return sr / refined
    }
  }
  return sr / minLag
}

/**
 * 逐帧基频轨迹。
 *
 * 默认开启倍频纠正 —— 见 correctOctaves 的说明。
 */
export function pitchTrack(audio, { winMs = 40, hopMs = 10, octaveCorrect = true } = {}) {
  const { sr, data } = audio
  const win = Math.round((winMs / 1000) * sr)
  const hop = Math.round((hopMs / 1000) * sr)
  const track = []
  for (let s = 0; s + win <= data.length; s += hop) {
    const f = f0OfFrame(data.subarray(s, s + win), sr)
    track.push({ t: s / sr, f0: f })
  }
  return octaveCorrect ? correctOctaves(track) : track
}

/**
 * 倍频纠正。
 *
 * 自相关估基频有个经典毛病：某一帧既可能在 lag=T 取到峰（正确），
 * 也可能在 lag=2T 取到更大的峰（把基频估成一半，即低八度）。
 * 结果就是音高轨迹上出现零星的低八度跳点，**把音域虚报得很大** ——
 * 而「音域」正是我用来判断语气够不够平淡的核心指标，所以必须纠正。
 *
 * 做法：以整段的中位基频为锚，每帧如果离「锚的 1/2 或 2 倍」更近，就折叠回去。
 * 只做八度（±1 个倍频），不做更激进的平滑 —— 免得把真实的语调起伏抹掉。
 */
export function correctOctaves(track) {
  const voiced = track.filter((x) => x.f0).map((x) => x.f0)
  if (voiced.length < 5) return track
  const sorted = [...voiced].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  return track.map((p) => {
    if (!p.f0) return p
    let best = p.f0
    let bestDist = Math.abs(Math.log2(p.f0 / median))
    for (const factor of [0.5, 2]) {
      const cand = p.f0 * factor
      const d = Math.abs(Math.log2(cand / median))
      if (d < bestDist) {
        bestDist = d
        best = cand
      }
    }
    return { t: p.t, f0: best }
  })
}

/** 转半音（只为比较相对差，基准随意） */
export const toSemitones = (hz) => 12 * Math.log2(hz / 55)

/** 整体响度（RMS） */
export function rms(audio) {
  const d = audio.data
  let sum = 0
  for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
  return Math.sqrt(sum / Math.max(1, d.length))
}

/** 有声音的总时长（排除首尾静音）—— 用来算语速 */
export function voicedSeconds(audio, thr = 0.012) {
  const { sr, data } = audio
  const win = Math.max(1, Math.floor(sr * 0.01))
  let first = -1
  let last = -1
  for (let i = 0; i + win <= data.length; i += win) {
    let p = 0
    for (let k = i; k < i + win; k++) {
      const a = Math.abs(data[k])
      if (a > p) p = a
    }
    if (p > thr) {
      if (first < 0) first = i
      last = i + win
    }
  }
  return first < 0 ? 0 : (last - first) / sr
}

/** 汇总一段音高轨迹 */
export function summarize(track) {
  const voiced = track.filter((x) => x.f0)
  if (!voiced.length) return null
  const st = voiced.map((x) => toSemitones(x.f0)).sort((a, b) => a - b)
  const mean = st.reduce((a, b) => a + b, 0) / st.length
  const p10 = st[Math.floor(st.length * 0.1)]
  const p90 = st[Math.floor(st.length * 0.9)]
  const sd = Math.sqrt(st.reduce((a, b) => a + (b - mean) ** 2, 0) / st.length)
  return {
    frames: track.length,
    voicedRatio: voiced.length / track.length,
    mean: +mean.toFixed(2),
    range: +(p90 - p10).toFixed(2),
    sd: +sd.toFixed(2),
    seconds: +(track.length ? track[track.length - 1].t : 0).toFixed(2),
  }
}

/** 取轨迹前 40% / 后 40% 对比（避开首尾起收音） */
export function halves(track) {
  const voiced = track.filter((x) => x.f0)
  if (voiced.length < 10) return null
  const a = voiced.slice(0, Math.floor(voiced.length * 0.4))
  const b = voiced.slice(Math.floor(voiced.length * 0.6))
  const m = (arr) => {
    const st = arr.map((x) => toSemitones(x.f0))
    return st.reduce((x, y) => x + y, 0) / st.length
  }
  return { first: m(a), last: m(b), shift: m(b) - m(a) }
}

/** 一组数的均值 / 标准差 / 极差 */
export function stats(nums) {
  const arr = nums.filter((n) => Number.isFinite(n))
  if (!arr.length) return { n: 0, mean: NaN, sd: NaN, spread: NaN }
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length)
  return {
    n: arr.length,
    mean: +mean.toFixed(2),
    sd: +sd.toFixed(2),
    spread: +(Math.max(...arr) - Math.min(...arr)).toFixed(2),
    values: arr.map((x) => +x.toFixed(2)),
  }
}
