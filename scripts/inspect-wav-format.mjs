/**
 * 查一份 wav 的真实格式 + 我们的检测算出来的东西
 *   node scripts/inspect-wav-format.mjs <wav...>
 *
 * 为什么要单独查这个：
 *   废片守卫（src/tts.js 的 judge）假设音频是 **16-bit PCM** ——
 *   `parseWav` 读了 bits 字段，但后面一律用 `readInt16LE`。
 *   如果某个后端返回 24-bit 或 float32，算出来的「有声占比」就是垃圾，
 *   于是**好音频会被判成废片**，白白重试三次（云端还要多花钱）。
 *   实测 MiniMax 出现了「连续 3 次都是 40% 有声」，很可疑，所以查一下。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

function parse(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return { err: '不是 RIFF' }
  let pos = 12
  const chunks = []
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    chunks.push(`${id}(${size})`)
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bits: buf.readUInt16LE(body + 14),
        extra: size > 16 ? buf.subarray(body + 16, body + size).toString('hex') : null,
      }
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(size, buf.length - body)
    }
    pos = body + size + (size % 2)
  }
  return { fmt, dataOff, dataLen, chunks }
}

const FORMAT = { 1: 'PCM 整数', 3: 'IEEE float', 6: 'A-law', 7: 'μ-law', 0xfffe: 'EXTENSIBLE' }

for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f)
  const p = parse(buf)
  console.log(`\n${basename(f)}  ${(buf.length / 1024).toFixed(1)} KB`)
  if (p.err) {
    console.log(`  ❌ ${p.err}`)
    continue
  }
  const fmt = p.fmt
  console.log(`  块：${p.chunks.join(' ')}`)
  console.log(
    `  格式：${FORMAT[fmt.audioFormat] ?? fmt.audioFormat}  ${fmt.channels}ch  ${fmt.sampleRate}Hz  ${fmt.bits}bit  ` +
      `blockAlign=${fmt.blockAlign}${fmt.extra ? `  extra=${fmt.extra}` : ''}`
  )

  // 按 16-bit 算（我们现在的做法）
  const n16 = Math.floor(p.dataLen / 2)
  let peak16 = 0
  let voiced16 = 0
  for (let i = 0; i < n16; i++) {
    const v = Math.abs(buf.readInt16LE(p.dataOff + i * 2)) / 32768
    if (v > peak16) peak16 = v
    if (v > 0.01) voiced16++
  }
  console.log(`  按 16-bit 解：峰值 ${peak16.toFixed(4)}  有声占比 ${((voiced16 / n16) * 100).toFixed(1)}%`)

  // 按实际位深解
  if (fmt.bits === 24) {
    const n24 = Math.floor(p.dataLen / 3)
    let peak = 0
    let voiced = 0
    for (let i = 0; i < n24; i++) {
      const o = p.dataOff + i * 3
      let v = (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16))
      if (v & 0x800000) v -= 0x1000000
      const a = Math.abs(v) / 8388608
      if (a > peak) peak = a
      if (a > 0.01) voiced++
    }
    console.log(`  按 24-bit 解：峰值 ${peak.toFixed(4)}  有声占比 ${((voiced / n24) * 100).toFixed(1)}%`)
  } else if (fmt.audioFormat === 3) {
    const nf = Math.floor(p.dataLen / 4)
    let peak = 0
    let voiced = 0
    for (let i = 0; i < nf; i++) {
      const a = Math.abs(buf.readFloatLE(p.dataOff + i * 4))
      if (a > peak) peak = a
      if (a > 0.01) voiced++
    }
    console.log(`  按 float32 解：峰值 ${peak.toFixed(4)}  有声占比 ${((voiced / nf) * 100).toFixed(1)}%`)
  }
}
