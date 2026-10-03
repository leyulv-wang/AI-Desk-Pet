/**
 * 量参考音频自己的「戏剧化程度」—— 音域（F0 的 10%~90% 跨度）
 *   node scripts/measure-ref-calmness.mjs [粗类别]
 *
 * 为什么关心：GPT-SoVITS 会把参考音频的语调轮廓搬到合成结果上。
 * 如果参考本身"在演"，日常闲聊也会被念成舞台念白。
 *
 * 自然人平静说话的音域约 3~6 半音；朗读/表演可达 8~12 半音。
 *
 * 估音器用 scripts/lib/wav-prosody.mjs 里那份共用的（它通过了已知音高的自检）。
 * **千万别在这个脚本里另写一份** —— 这里曾经复制过一份，带着
 * 「归一化偏向长 lag」的倍频 bug，把参考音频的音域虚报了一倍。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pitchTrack, summarize } from './lib/wav-prosody.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.PET_VOICE_SRC || 'D:\\下载\\原神语音包\\Furina'
const WANT = process.argv[2] || '平静'

const PURE = {
  开心: ['开心'], 得意: ['得意'], 温柔: ['温柔'], 平静: ['平静'],
  无奈: ['无奈'], 生气: ['生气'], 难过: ['悲伤'], 惊讶: ['惊讶'],
}

const cache = JSON.parse(readFileSync(join(ROOT, '.cache', 'emotion-labels.json'), 'utf8'))

/** 读 WAV 并降采样（4 点平均当低通），这样量 100+ 条才跑得动 */
function readWavDecimated(file, decim = 4) {
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
  const ch = fmt.ch
  const total = Math.floor(data.length / 2 / ch)
  const n = Math.floor(total / decim)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let k = 0; k < decim; k++) acc += data.readInt16LE((i * decim + k) * 2 * ch) / 32768
    out[i] = acc / decim
  }
  return { sr: fmt.sr / decim, data: out, seconds: total / fmt.sr }
}

const charCount = (t) => t.replace(/[\s，。！？、…—「」（）【】·~～!?.,:;"'#{}A-Za-z0-9]/g, '').length

const allowed = PURE[WANT]
const ids = readdirSync(SRC).filter((f) => f.endsWith('.wav')).map((f) => f.replace(/\.wav$/, ''))
const cands = []
for (const id of ids) {
  const lab = cache[id]
  if (!lab || !allowed.includes(lab.e)) continue
  let meta
  try { meta = JSON.parse(readFileSync(join(SRC, id + '.json'), 'utf8')) } catch { continue }
  const text = (meta.transcription || '').trim()
  if (!text || text.length < 8) continue
  cands.push({ id, text, e: lab.e, v: lab.v })
}

console.log(`「${WANT}」池共 ${cands.length} 条候选，逐条量音域…\n`)

const rows = []
for (const c of cands) {
  const audio = readWavDecimated(join(SRC, c.id + '.wav'))
  if (!audio) continue
  const s = summarize(pitchTrack(audio))
  if (!s) continue
  const chars = charCount(c.text)
  rows.push({ ...c, range: s.range, mean: s.mean, seconds: +audio.seconds.toFixed(2), chars, rate: +(chars / audio.seconds).toFixed(2) })
}

rows.sort((a, b) => a.range - b.range)

console.log('  按音域从窄到宽排序（窄 = 平淡，宽 = 戏剧化）\n')
console.log('  音域  平均F0  时长  字数  语速  强度  台词')
console.log('  ' + '─'.repeat(96))
for (const r of rows.slice(0, 24)) {
  console.log(
    `  ${String(r.range).padStart(5)} ${String(r.mean).padStart(6)} ${String(r.seconds).padStart(5)}s ${String(r.chars).padStart(4)}  ${String(r.rate).padStart(5)}  v${r.v}   ${r.text.slice(0, 34)}`
  )
}

const ranges = rows.map((r) => r.range).sort((a, b) => a - b)
const mean = ranges.reduce((a, b) => a + b, 0) / ranges.length
console.log()
console.log(`  共 ${rows.length} 条：最小 ${ranges[0]} / 中位 ${ranges[Math.floor(ranges.length / 2)]} / 最大 ${ranges[ranges.length - 1]}，均值 ${mean.toFixed(2)}`)
console.log(`  音域 ≤6 半音（接近自然人平静说话）：${rows.filter((r) => r.range <= 6).length} 条`)
console.log(`  音域 ≤8 半音：${rows.filter((r) => r.range <= 8).length} 条`)
console.log()
console.log('  参考：自然人平静说话 3~6 半音；朗读/表演 8~12 半音。')
