/**
 * 从芙宁娜语音库里挑最合适的「参考音频」
 *   node scripts/pick-reference-audio.mjs [数据集目录] [输出目录]
 *
 * GPT-SoVITS 的参考音频要求：
 *   - 5–10 秒（太短语气不足，太长会拖慢每次合成）
 *   - 干净、无背景音乐（游戏对话语音通常满足）
 *   - 首尾没有长静音
 *   - 有准确的逐字文本
 *   - 音量不过小、不削波
 *
 * 这个脚本会在所有片段里按这些标准打分排序。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.argv[2] || 'D:\\下载\\原神语音包\\Furina'
const OUT = process.argv[3] || 'D:\\project\\Personal_assistant\\desktop-pet\\assets\\voice'

/** 读 WAV：返回 {sampleRate, channels, bits, samples: Float32Array, seconds} */
function readWav(path) {
  const buf = readFileSync(path)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bits = buf.readUInt16LE(34)

  let off = 12
  let dataOff = -1
  let dataSize = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') { dataOff = off + 8; dataSize = size; break }
    off += 8 + size + (size % 2)
  }
  if (dataOff < 0) return null

  const n = Math.floor(dataSize / (bits / 8) / channels)
  const out = new Float32Array(n)
  if (bits === 16) {
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * 2 * channels) / 32768
  } else if (bits === 8) {
    for (let i = 0; i < n; i++) out[i] = (buf.readUInt8(dataOff + i) - 128) / 128
  } else if (bits === 32) {
    for (let i = 0; i < n; i++) out[i] = buf.readInt32LE(dataOff + i * 4 * channels) / 2147483648
  } else return null

  return { sampleRate, channels, bits, samples: out, seconds: n / sampleRate }
}

/** 找首尾的静音长度（阈值 -40dBFS） */
function silenceEdges(samples, sampleRate) {
  const thr = 0.01
  const win = Math.floor(sampleRate * 0.01) // 10ms
  let head = 0
  for (let i = 0; i + win <= samples.length; i += win) {
    let peak = 0
    for (let k = i; k < i + win; k++) peak = Math.max(peak, Math.abs(samples[k]))
    if (peak > thr) { head = i / sampleRate; break }
  }
  let tail = 0
  for (let i = samples.length - win; i >= 0; i -= win) {
    let peak = 0
    for (let k = i; k < i + win; k++) peak = Math.max(peak, Math.abs(samples[k]))
    if (peak > thr) { tail = (samples.length - i - win) / sampleRate; break }
  }
  return { head, tail }
}

function stats(samples) {
  let peak = 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
    sum += samples[i] * samples[i]
  }
  return { peak, rms: Math.sqrt(sum / samples.length) }
}

// ---------------------------------------------------------------- 打分

const files = readdirSync(SRC)
const wavs = files.filter((f) => f.endsWith('.wav'))

console.log(`扫描 ${wavs.length} 个片段…\n`)

const cands = []
for (const w of wavs) {
  const base = w.replace(/\.wav$/, '')
  const jPath = join(SRC, base + '.json')
  let meta
  try { meta = JSON.parse(readFileSync(jPath, 'utf8')) } catch { continue }

  const text = (meta.transcription || '').trim()
  if (!text || text.length < 12) continue   // 文本太短，语气不足

  let info
  try { info = readWav(join(SRC, w)) } catch { continue }
  if (!info) continue

  const s = info.seconds
  if (s < 4.5 || s > 9) continue             // 甜区 5–9 秒
  if (info.channels !== 1) continue           // 参考音频要单声道

  const { head, tail } = silenceEdges(info.samples, info.sampleRate)
  const { peak, rms } = stats(info.samples)

  // 打分：静音少、音量合适、时长在 6 秒附近最好
  const silPenalty = (head + tail) * 4
  const durScore = -Math.abs(s - 6) * 1.2
  const loudScore = rms > 0.02 && rms < 0.25 ? 1 : -3
  const peakPenalty = peak > 0.99 ? -3 : 0        // 削波
  const textScore = text.length >= 15 && text.length <= 45 ? 1 : -0.5
  const score = durScore + loudScore + textScore + peakPenalty - silPenalty

  cands.push({ w, text, s, head, tail, peak, rms, score, trigger: (meta.voiceConfigs?.[0]?.gameTrigger) || '' })
}

cands.sort((a, b) => b.score - a.score)

console.log(`符合条件的有 ${cands.length} 条。前 10 名：\n`)
console.log('  排名  文件                          时长   首静音 尾静音  峰值   RMS    场景')
console.log('  ' + '─'.repeat(96))
for (const [i, c] of cands.slice(0, 10).entries()) {
  console.log(
    `  ${String(i + 1).padStart(3)}   ${c.w.padEnd(30)} ${c.s.toFixed(2)}s  ` +
      `${c.head.toFixed(2)}   ${c.tail.toFixed(2)}   ${c.peak.toFixed(2)}  ${c.rms.toFixed(3)}  ${c.trigger}`
  )
  console.log(`        「${c.text.slice(0, 56)}${c.text.length > 56 ? '…' : ''}」`)
}

// ---------------------------------------------------------------- 导出前 3 个

mkdirSync(OUT, { recursive: true })
console.log(`\n导出前 3 名到 ${OUT}\n`)
for (const [i, c] of cands.slice(0, 3).entries()) {
  const base = c.w.replace(/\.wav$/, '')
  const outWav = join(OUT, `ref${i + 1}.wav`)
  copyFileSync(join(SRC, c.w), outWav)
  writeFileSync(
    join(OUT, `ref${i + 1}.txt`),
    c.text,
    'utf8'
  )
  console.log(`  ref${i + 1}.wav  ${c.s.toFixed(2)}s   ← ${base}.wav`)
  console.log(`  ref${i + 1}.txt  「${c.text}」`)
  console.log()
}

console.log('用法：GPT-SoVITS 里把 ref1.wav 当参考音频、ref1.txt 的内容当参考文本。')
console.log('建议先听 ref1 / ref2 / ref3，挑语气最像你想要的芙宁娜的那条。')
