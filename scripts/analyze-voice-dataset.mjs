/**
 * 分析 <语音包目录>\Furina 里的数据集
 *   node scripts/analyze-voice-dataset.mjs "<语音包目录>\Furina"
 *
 * 目的：
 *   1. 看 JSON 里到底存了什么（有没有文本转写、情绪、语言标签）
 *   2. 算总时长 —— 这决定"能不能拿来训模型"，也决定够不够当参考音频
 *   3. 看音频格式（采样率、声道、位深）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || 'D:\\下载\\原神语音包\\Furina'
const files = readdirSync(dir)
const wavs = files.filter((f) => f.toLowerCase().endsWith('.wav'))
const jsons = files.filter((f) => f.toLowerCase().endsWith('.json'))

console.log(`目录: ${dir}`)
console.log(`共 ${files.length} 个文件：${wavs.length} 个 wav + ${jsons.length} 个 json\n`)

// ---------------------------------------------------------------- JSON 结构
console.log('=== 1. JSON 内容（前 3 个）===')
for (const j of jsons.slice(0, 3)) {
  console.log(`\n--- ${j} ---`)
  try {
    const raw = readFileSync(join(dir, j), 'utf8')
    const obj = JSON.parse(raw)
    console.log(JSON.stringify(obj, null, 2).slice(0, 700))
  } catch (e) {
    console.log('  解析失败:', e.message)
    console.log('  原文前 200 字:', readFileSync(join(dir, j), 'utf8').slice(0, 200))
  }
}

// ---------------------------------------------------------------- 音频格式 + 总时长
console.log('\n\n=== 2. 音频格式与总时长 ===')

/** 读 WAV 头拿采样率/声道/位深，并用 data chunk 大小算精确时长 */
function wavInfo(path) {
  const fd = readFileSync(path)
  if (fd.length < 44 || fd.toString('ascii', 0, 4) !== 'RIFF') return null
  const channels = fd.readUInt16LE(22)
  const sampleRate = fd.readUInt32LE(24)
  const bitsPerSample = fd.readUInt16LE(34)
  // 找 data chunk
  let off = 12
  let dataSize = 0
  while (off + 8 <= fd.length) {
    const id = fd.toString('ascii', off, off + 4)
    const size = fd.readUInt32LE(off + 4)
    if (id === 'data') { dataSize = size; break }
    off += 8 + size + (size % 2)
  }
  const bytesPerSec = sampleRate * channels * (bitsPerSample / 8)
  return {
    channels, sampleRate, bitsPerSample,
    seconds: bytesPerSec ? dataSize / bytesPerSec : 0,
    sizeKB: fd.length / 1024,
  }
}

let totalSec = 0
const dur = []
const formats = new Map()
let bad = 0

for (const w of wavs) {
  try {
    const info = wavInfo(join(dir, w))
    if (!info) { bad++; continue }
    totalSec += info.seconds
    dur.push({ name: w, s: info.seconds, kb: info.sizeKB })
    const key = `${info.sampleRate}Hz ${info.channels}ch ${info.bitsPerSample}bit`
    formats.set(key, (formats.get(key) || 0) + 1)
  } catch { bad++ }
}

console.log(`  读取成功 ${dur.length} 个${bad ? `，失败 ${bad} 个` : ''}`)
console.log(`  **总时长 ${(totalSec / 60).toFixed(1)} 分钟**（${Math.round(totalSec)} 秒）`)
console.log(`  平均每条 ${(totalSec / dur.length).toFixed(2)} 秒`)
console.log('  格式分布：')
for (const [k, v] of [...formats.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(22)} ${v} 个`)
}

// ---------------------------------------------------------------- 时长分布
console.log('\n=== 3. 时长分布（参考音频要 5–10 秒）===')
const buckets = [
  ['<1 秒', (s) => s < 1],
  ['1–3 秒', (s) => s >= 1 && s < 3],
  ['3–5 秒', (s) => s >= 3 && s < 5],
  ['5–10 秒', (s) => s >= 5 && s < 10],
  ['10–20 秒', (s) => s >= 10 && s < 20],
  ['≥20 秒', (s) => s >= 20],
]
for (const [label, test] of buckets) {
  const n = dur.filter((d) => test(d.s)).length
  const bar = '█'.repeat(Math.round((n / dur.length) * 40))
  console.log(`  ${label.padEnd(10)} ${String(n).padStart(5)} 条  ${bar}`)
}

console.log('\n=== 4. 适合当参考音频的候选（5–10 秒，文件别太大）===')
const good = dur
  .filter((d) => d.s >= 5 && d.s <= 10)
  .sort((a, b) => a.kb - b.kb)
  .slice(0, 8)
if (!good.length) {
  console.log('  没有 5–10 秒的片段。可以放宽到 3–5 秒，或把长音频剪一段。')
  const alt = dur.filter((d) => d.s >= 3 && d.s < 5).sort((a, b) => a.kb - b.kb).slice(0, 5)
  for (const d of alt) console.log(`    ${d.name}  ${d.s.toFixed(2)}s  ${d.kb.toFixed(0)}KB`)
} else {
  for (const d of good) console.log(`    ${d.name}  ${d.s.toFixed(2)}s  ${d.kb.toFixed(0)}KB`)
}

console.log('\n=== 5. 最长 / 最短 ===')
const sorted = [...dur].sort((a, b) => b.s - a.s)
console.log('  最长 3 个：')
for (const d of sorted.slice(0, 3)) console.log(`    ${d.name}  ${d.s.toFixed(1)}s`)
console.log('  最短 3 个：')
for (const d of sorted.slice(-3)) console.log(`    ${d.name}  ${d.s.toFixed(2)}s`)
