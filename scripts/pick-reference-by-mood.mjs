/**
 * 按「语气类别」各挑一条参考音频
 *   node scripts/pick-reference-by-mood.mjs
 *
 * 芙宁娜在不同场景的语气差别很大：
 *   Fetter（好感语音）  —— 温柔、亲近，可能更适合桌宠
 *   WeatherMonologue   —— 自言自语、松弛
 *   JoinTeam / Gacha   —— 俏皮、元气
 *   Dialog             —— 戏剧腔、审判官
 *
 * 导出到 assets/voice/moods/ 供试听挑选。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.argv[2] || 'D:\\下载\\原神语音包\\Furina'
const OUT = join(process.argv[3] || 'D:\\project\\Personal_assistant\\desktop-pet\\assets\\voice', 'moods')

function readWavInfo(path) {
  const buf = readFileSync(path)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bits = buf.readUInt16LE(34)
  let off = 12, dataOff = -1, dataSize = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') { dataOff = off + 8; dataSize = size; break }
    off += 8 + size + (size % 2)
  }
  if (dataOff < 0) return null
  const n = Math.floor(dataSize / (bits / 8) / channels)
  return { channels, sampleRate, bits, n, seconds: n / sampleRate, dataOff, buf }
}

function analyse(info) {
  const { buf, dataOff, n, channels } = info
  let peak = 0, sum = 0
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataOff + i * 2 * channels) / 32768
    const a = Math.abs(v)
    if (a > peak) peak = a
    sum += v * v
  }
  // 首尾静音
  const thr = 0.01
  const win = Math.max(1, Math.floor(info.sampleRate * 0.01))
  let head = 0
  for (let i = 0; i + win <= n; i += win) {
    let p = 0
    for (let k = i; k < i + win; k++) p = Math.max(p, Math.abs(buf.readInt16LE(dataOff + k * 2 * channels) / 32768))
    if (p > thr) { head = i / info.sampleRate; break }
  }
  let tail = 0
  for (let i = n - win; i >= 0; i -= win) {
    let p = 0
    for (let k = i; k < i + win; k++) p = Math.max(p, Math.abs(buf.readInt16LE(dataOff + k * 2 * channels) / 32768))
    if (p > thr) { tail = (n - i - win) / info.sampleRate; break }
  }
  return { peak, rms: Math.sqrt(sum / n), head, tail }
}

const MOODS = [
  { key: 'Fetter', label: '温柔·好感语音', dir: 'a-warm' },
  { key: 'WeatherMonologue', label: '松弛·自言自语', dir: 'b-relaxed' },
  { key: 'JoinTeam', label: '元气·入队', dir: 'c-cheerful' },
  { key: 'Gacha', label: '俏皮·抽卡', dir: 'd-playful' },
  { key: 'Card', label: '简短·卡片', dir: 'e-short' },
]

const files = readdirSync(SRC).filter((f) => f.endsWith('.wav'))
const byTrigger = new Map()
for (const m of MOODS) byTrigger.set(m.key, [])

for (const w of files) {
  const base = w.replace(/\.wav$/, '')
  let meta
  try { meta = JSON.parse(readFileSync(join(SRC, base + '.json'), 'utf8')) } catch { continue }
  const trigger = meta.voiceConfigs?.[0]?.gameTrigger
  if (!byTrigger.has(trigger)) continue
  const text = (meta.transcription || '').trim()
  if (!text || text.length < 10) continue

  const info = readWavInfo(join(SRC, w))
  if (!info || info.channels !== 1) continue
  if (info.seconds < 4 || info.seconds > 12) continue

  const a = analyse(info)
  if (a.peak > 0.99) continue
  const score = -Math.abs(info.seconds - 6.5) * 1.2 - (a.head + a.tail) * 4 + (a.rms > 0.02 ? 1 : -2)
  byTrigger.get(trigger).push({ w, text, s: info.seconds, ...a, score })
}

mkdirSync(OUT, { recursive: true })
console.log('按语气各挑一条：\n')
for (const m of MOODS) {
  const list = byTrigger.get(m.key) || []
  list.sort((a, b) => b.score - a.score)
  if (!list.length) { console.log(`  ${m.label.padEnd(14)} —— 没有符合条件的\n`); continue }
  const c = list[0]
  const dir = join(OUT, m.dir)
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(SRC, c.w), join(dir, 'ref.wav'))
  writeFileSync(join(dir, 'ref.txt'), c.text, 'utf8')
  writeFileSync(
    join(dir, 'README.txt'),
    `${m.label}\n来源: ${c.w}\n时长: ${c.s.toFixed(2)}s\n首静音: ${c.head.toFixed(2)}s  尾静音: ${c.tail.toFixed(2)}s\n峰值: ${c.peak.toFixed(2)}  RMS: ${c.rms.toFixed(3)}\n候选总数: ${list.length}\n\n参考文本:\n${c.text}\n`,
    'utf8'
  )
  console.log(`  ${m.label.padEnd(14)} ${c.s.toFixed(1)}s  (候选 ${String(list.length).padStart(3)} 条)`)
  console.log(`      「${c.text.slice(0, 60)}${c.text.length > 60 ? '…' : ''}」`)
  console.log(`      → ${m.dir}/ref.wav\n`)
}

console.log(`全部导出到 ${OUT}`)
console.log('每个子目录里都有 ref.wav + ref.txt + README.txt，放来听挑一条。')
