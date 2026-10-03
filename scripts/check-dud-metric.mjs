/**
 * 废片判据的阈值到底该设多少 —— 用真实数据量
 *   node scripts/check-dud-metric.mjs [目录]
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本
 * ────────────────────────────────────────────────────────────────────
 * 我在 src/tts.js 的废片守卫里加了三条绝对阈值，其中一条是
 *     voiceRatio < 0.5  → 判为「只有一半样本有声」的废片
 * 这个 0.5 是**拍脑袋定的** —— 参照的是另一个脚本（probe-segments.mjs）
 * 报出来的「正常 91~98% 有声」。
 *
 * 但那两个数字**根本不是同一个指标**：
 *   · probe-segments.mjs 用 voicedSeconds()：按 10ms 窗取峰值，超阈值就算「有声」→ 91~98%
 *   · tts.js 的 inspectWav 是**逐采样点**数：|v| > 0.01 才算 → 正常语音只有 30~65%
 *     （语音波形每个周期都要过零，大量采样点天然在阈值以下）
 *
 * 拿窗口级的直觉去设采样级的阈值，结果就是**好音频被判成废片**，
 * 白白重试三次 —— 云端后端还要多花三次钱。实测云端一句正常的话被连判三次废片。
 *
 * 所以这个脚本扫一批已知正常的音频，把两个指标都算出来，
 * 用**分布**而不是感觉来定阈值。
 */
import { readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readWav, rms, voicedSeconds } from './lib/wav-prosody.mjs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { parseWav } = require(join(ROOT, 'src', 'tts.js')) // 没导出，见下

const dir = process.argv[2] || join(ROOT, '.userdata-dev', 'tts-cache')

/** 逐采样点数「有声占比」—— 和 tts.js 的 inspectWav 同一套算法 */
function sampleVoiceRatio(buf) {
  const info = parse(buf)
  if (!info.ok) return null
  const { dataOff, n, channels } = info
  let loud = 0
  let sum = 0
  let peak = 0
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataOff + i * 2 * channels) / 32768
    sum += v * v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
    if (a > 0.01) loud++
  }
  return { ratio: loud / n, rms: Math.sqrt(sum / n), peak }
}

// tts.js 没导出 parseWav，这里自己写一份最小实现（只认 16-bit PCM）
function parse(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false }
  }
  let pos = 12
  let channels = 0
  let sr = 0
  let dataOff = -1
  let n = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      sr = buf.readUInt32LE(body + 4)
    } else if (id === 'data') {
      dataOff = body
      n = Math.min(size, buf.length - body) / (2 * (channels || 1))
    }
    pos = body + size + (size % 2)
  }
  return dataOff >= 0 ? { ok: true, dataOff, n: Math.floor(n), channels, sr } : { ok: false }
}

const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => join(dir, f))
if (!files.length) {
  console.error(`目录里没有 wav：${dir}`)
  process.exit(1)
}
files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)

console.log(`扫 ${files.length} 个文件：${dir}\n`)
console.log('  采样级占比   窗口级占比    RMS      峰值    文件')
console.log('  ' + '-'.repeat(70))

const sRatios = []
const wRatios = []
for (const f of files) {
  const buf = require('node:fs').readFileSync(f)
  const s = sampleVoiceRatio(buf)
  if (!s) continue
  let w = null
  try {
    const a = readWav(f)
    w = voicedSeconds(a) / (a.data.length / a.sr)
  } catch {}
  sRatios.push(s.ratio)
  if (w != null) wRatios.push(w)
  console.log(
    `  ${(s.ratio * 100).toFixed(1).padStart(6)}%      ${w != null ? (w * 100).toFixed(1).padStart(6) + '%' : '   —   '}   ` +
      `${s.rms.toFixed(4)}   ${s.peak.toFixed(4)}  ${basename(f)}`
  )
}

const q = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(a.length * p))]
}

console.log('\n=== 分布 ===\n')
for (const [name, arr] of [['采样级占比', sRatios], ['窗口级占比', wRatios]]) {
  if (!arr.length) continue
  console.log(
    `  ${name}：最小 ${(q(arr, 0) * 100).toFixed(1)}%  p10 ${(q(arr, 0.1) * 100).toFixed(1)}%  ` +
      `中位 ${(q(arr, 0.5) * 100).toFixed(1)}%  p90 ${(q(arr, 0.9) * 100).toFixed(1)}%  最大 ${(q(arr, 1) * 100).toFixed(1)}%`
  )
}

console.log('\n  判据建议：')
console.log(`    · 窗口级占比用来判「整段没出声」是靠谱的（正常都在 ${(q(wRatios, 0.1) * 100).toFixed(0)}% 以上）`)
console.log(`    · 采样级占比的**正常下限只有 ${(q(sRatios, 0.1) * 100).toFixed(0)}% 左右** —— 拿 0.5 当阈值会误杀一大片`)
console.log('    · 真要判废片，**RMS 才是主信号**（废片 RMS 0.002 量级，正常 0.09）')
