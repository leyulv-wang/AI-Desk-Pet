/**
 * 扫描真实会话产生的音频，找客观缺陷
 *   node scripts/scan-audio.mjs [目录]
 *
 * 查这些（都是能一眼看出问题、且和「听起来不对」直接相关的）：
 *   · 削波     —— 波形被削平，会有刺耳的破音。归一化的增益过猛会造出来
 *   · 直流偏移 —— 波形整体不居中，可能有低频嗡嗡声
 *   · 首尾静音 —— 太长会导致「说完半天才出声」或「拖尾」
 *   · 中途长静音 —— 句子内部有空档，听起来像断成两截
 *   · 有效语速 —— 忽快忽慢的直接指标
 *   · 时长与字数比 —— 异常值说明合成失败/重复/吞字
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = process.argv[2] || join(ROOT, '.userdata', 'tts-cache')

function readWav(file) {
  const buf = readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
  let pos = 12, fmt = null, data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    else if (id === 'data') data = buf.subarray(body, Math.min(body + size, buf.length))
    pos = body + size + (size % 2)
  }
  if (!fmt || !data || fmt.bits !== 16) return null
  const ch = fmt.ch, n = Math.floor(data.length / 2 / ch)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * ch) / 32768
  return { sr: fmt.sr, data: out }
}

/** 逐 10ms 算峰值和 RMS 包络 */
function frames(audio, ms = 10) {
  const { sr, data } = audio
  const win = Math.max(1, Math.round((ms / 1000) * sr))
  const out = []
  for (let s = 0; s + win <= data.length; s += win) {
    let peak = 0, sum = 0
    for (let i = s; i < s + win; i++) {
      const v = data[i]
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
      sum += v * v
    }
    out.push({ t: s / sr, peak, rms: Math.sqrt(sum / win) })
  }
  return out
}

function analyze(file) {
  const audio = readWav(file)
  if (!audio) return { bad: '不是 16-bit PCM WAV' }
  const { sr, data } = audio
  const n = data.length
  let peak = 0, sum = 0, dc = 0
  let clipped = 0
  for (let i = 0; i < n; i++) {
    const v = data[i]
    dc += v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
    if (a > 0.9995) clipped++
    sum += v * v
  }
  const rms = Math.sqrt(sum / n)
  dc /= n

  const fr = frames(audio)
  const THR = Math.max(0.008, peak * 0.04) // 相对阈值，避免把安静音频全判成静音
  const voiced = fr.filter((f) => f.peak > THR)

  let head = 0, tail = 0
  for (const f of fr) { if (f.peak > THR) break; head = f.t }
  for (let i = fr.length - 1; i >= 0; i--) { const f = fr[i]; if (f.peak > THR) break; tail = fr[fr.length - 1].t - f.t }

  // 中途最长静音（只能在有声区间内部找，首尾不算）
  let longestGap = 0, gapAt = 0
  if (voiced.length) {
    const first = voiced[0].t, last = voiced[voiced.length - 1].t
    let run = 0, runStart = 0
    for (const f of fr) {
      if (f.t < first || f.t > last) continue
      if (f.peak <= THR) {
        if (run === 0) runStart = f.t
        run += 0.01
        if (run > longestGap) { longestGap = run; gapAt = runStart }
      } else run = 0
    }
  }

  const voicedSec = voiced.length * 0.01
  return {
    seconds: +(n / sr).toFixed(2),
    sr,
    peak: +peak.toFixed(4),
    rms: +rms.toFixed(4),
    crest: +(peak / (rms || 1e-9)).toFixed(2),
    dc: +dc.toFixed(5),
    clippedPct: +((clipped / n) * 100).toFixed(3),
    head: +head.toFixed(2),
    tail: +tail.toFixed(2),
    voicedSec: +voicedSec.toFixed(2),
    longestGap: +longestGap.toFixed(2),
    gapAt: +gapAt.toFixed(2),
  }
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.wav')).map((f) => join(DIR, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
if (!files.length) {
  console.log(`目录里没有 wav：${DIR}`)
  process.exit(0)
}

console.log(`扫描 ${files.length} 个文件：${DIR}\n`)
console.log('  时间      时长  峰值    RMS    波峰因数 直流     削波%   首静  尾静  最长中途静音  有声时长')
console.log('  ' + '─'.repeat(104))

const rows = []
for (const f of files) {
  const a = analyze(f)
  const st = statSync(f)
  rows.push({ f, a, mtime: st.mtime })
  const flag =
    a.clippedPct > 0.5 ? ' ⚠️削波' :
    Math.abs(a.dc) > 0.01 ? ' ⚠️直流' :
    a.head > 0.6 ? ' ⚠️首静音长' :
    a.tail > 0.8 ? ' ⚠️拖尾' :
    a.longestGap > 1.2 ? ' ⚠️中途断档' :
    a.rms < 0.02 ? ' ⚠️偏轻' : ''
  console.log(
    `  ${st.mtime.toTimeString().slice(0, 8)} ${String(a.seconds).padStart(5)}s ` +
      `${String(a.peak).padStart(6)} ${String(a.rms).padStart(6)} ${String(a.crest).padStart(7)} ` +
      `${String(a.dc).padStart(8)} ${String(a.clippedPct).padStart(6)} ${String(a.head).padStart(5)} ` +
      `${String(a.tail).padStart(5)} ${String(a.longestGap).padStart(9)}  ${String(a.voicedSec).padStart(6)}s${flag}`
  )
}

console.log()
const flagged = rows.filter((r) => r.a.clippedPct > 0.5 || Math.abs(r.a.dc) > 0.01 || r.a.head > 0.6 || r.a.tail > 0.8 || r.a.longestGap > 1.2 || r.a.rms < 0.02)
console.log(`可疑 ${flagged.length}/${rows.length} 条`)
const rmss = rows.map((r) => r.a.rms)
const mean = rmss.reduce((a, b) => a + b, 0) / rmss.length
console.log(`RMS 范围 ${Math.min(...rmss).toFixed(4)} ~ ${Math.max(...rmss).toFixed(4)}（均值 ${mean.toFixed(4)}）`)
console.log(`波峰因数范围 ${Math.min(...rows.map((r) => r.a.crest)).toFixed(1)} ~ ${Math.max(...rows.map((r) => r.a.crest)).toFixed(1)}`)
