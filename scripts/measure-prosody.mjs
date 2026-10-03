/**
 * 量一下「一轮回复内部的语气漂移」
 *   node scripts/measure-prosody.mjs
 *
 * 背景：之前每句独立选参考，导致上半句/下半句语气不一样。修好「整轮锁定参考」之后，
 * 还剩多少漂移？以及「把整轮合成一次」是不是明显更好？这个脚本用音高（F0）来量。
 *
 * 为什么看 F0：语气（平静 / 上扬 / 叹息）最直接的声学表征就是基频轨迹。
 * 如果后半段的平均音高比前半段高了半音以上，耳朵就会觉得「换了个人在念」。
 *
 * 不依赖任何音频库 —— 自己解 WAV 头 + 自相关估 F0。
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

const OUT = join(ROOT, '.userdata-dev', 'prosody')

// ------------------------------------------------------------------ WAV 解析

/** 解 16-bit PCM WAV。返回 {sr, data:Float32Array} */
function readWav(file) {
  const buf = readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV')
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
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
  for (let i = 0; i < frames; i++) {
    // 多声道就取第一声道 —— 测音高单声道够了
    out[i] = data.readInt16LE(i * ch * 2) / 32768
  }
  return { sr: fmt.sr, data: out }
}

// ------------------------------------------------------------------ F0 估计

/**
 * 自相关估基频。
 * @returns {number|null} Hz，或 null（这一帧是清音/静音）
 */
function f0OfFrame(frame, sr, minHz = 70, maxHz = 420) {
  const n = frame.length
  let energy = 0
  for (let i = 0; i < n; i++) energy += frame[i] * frame[i]
  const mean = energy / n
  // 太安静就不判 —— 硬判会得到一堆假的 F0
  if (mean < 1e-5) return null

  const minLag = Math.max(2, Math.floor(sr / maxHz))
  const maxLag = Math.min(n - 2, Math.ceil(sr / minHz))

  let best = 0
  let bestLag = -1
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i < n - lag; i++) sum += frame[i] * frame[i + lag]
    const norm = sum / (n - lag)
    if (norm > best) {
      best = norm
      bestLag = lag
    }
  }
  if (bestLag < 0) return null
  // 归一化自相关峰值。低于阈值当清音，避免把摩擦音当成人声
  if (best / mean < 0.32) return null
  return sr / bestLag
}

/** 对整段音频逐帧估 F0 */
function pitchTrack(audio, { winMs = 40, hopMs = 10 } = {}) {
  const { sr, data } = audio
  const win = Math.round((winMs / 1000) * sr)
  const hop = Math.round((hopMs / 1000) * sr)
  const track = []
  for (let s = 0; s + win <= data.length; s += hop) {
    const f = f0OfFrame(data.subarray(s, s + win), sr)
    track.push({ t: s / sr, f0: f })
  }
  return track
}

const toSemitones = (hz) => 12 * Math.log2(hz / 55) // 以 A1=55Hz 为基准，只为比较相对差

/** 汇总一段音高轨迹的特征 */
function summarize(track) {
  const voiced = track.filter((x) => x.f0)
  if (!voiced.length) return null
  const st = voiced.map((x) => toSemitones(x.f0)).sort((a, b) => a - b)
  const mean = st.reduce((a, b) => a + b, 0) / st.length
  const median = st[Math.floor(st.length / 2)]
  const p10 = st[Math.floor(st.length * 0.1)]
  const p90 = st[Math.floor(st.length * 0.9)]
  const sd = Math.sqrt(st.reduce((a, b) => a + (b - mean) ** 2, 0) / st.length)
  return {
    frames: track.length,
    voicedRatio: voiced.length / track.length,
    mean: +mean.toFixed(2),
    median: +median.toFixed(2),
    range: +(p90 - p10).toFixed(2),
    sd: +sd.toFixed(2),
    seconds: +(track.length ? track[track.length - 1].t : 0).toFixed(2),
  }
}

/** 取轨迹中「前 40%」和「后 40%」作对比 —— 避开首尾的起音和收音 */
function halves(track) {
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

// ------------------------------------------------------------------ 合成

mkdirSync(OUT, { recursive: true })

function mk(tag) {
  return createTts({
    config: { enabled: true, backend: 'gptsovits', gptsovits: { sampleSteps: 24, speedFactor: 1.05 }, cache: { enabled: false } },
    root: ROOT,
    cacheDir: join(OUT, tag),
    resolveKey: () => null,
  })
}

const CASES = [
  { cat: '温柔', a: '阿远？唔，本神记住这个名字了。', b: '不过美式那种苦水，怎么比得上配马卡龙的下午茶呀。' },
  { cat: '开心', a: '真的吗？那太好了！', b: '本神早就想去看看了，你什么时候有空？' },
  { cat: '平静', a: '嗯，我知道了。', b: '你先忙吧，我在这儿等着。' },
]

console.log('=== 音高（F0）漂移测量 ===')
console.log('  看两件事：① 前后半段的平均音高差（半音）② 各自的音域宽度')
console.log('  前后半段差得越多 = 越像换了个人在念\n')

const rows = []

for (const c of CASES) {
  const tts = mk('p')
  const locked = tts.pick(c.a, c.cat)
  const refId = locked.clip.id

  // --- A：分开合成（旧结构，但参考已锁定 —— 这是修好之后的现状）
  const ra = await tts.speak({ text: c.a, category: c.cat, refId, noCache: true })
  const rb = await tts.speak({ text: c.b, category: c.cat, refId, noCache: true })
  const ta = summarize(pitchTrack(readWav(ra.file)))
  const tb = summarize(pitchTrack(readWav(rb.file)))
  const splitShift = ta && tb ? tb.mean - ta.mean : null

  // --- B：一次合成整轮（让 GPT-SoVITS 自己切）
  const rj = await tts.speak({ text: `${c.a}${c.b}`, category: c.cat, refId, noCache: true })
  const tj = summarize(pitchTrack(readWav(rj.file)))
  const hj = halves(pitchTrack(readWav(rj.file)))

  rows.push({ c, ta, tb, splitShift, tj, jointShift: hj?.shift ?? null })

  console.log(`【${c.cat}】参考 ${locked.clip.id.slice(0, 8)}（${locked.clip.endsWith}）`)
  console.log(`  分开合成：前半 均值 ${ta?.mean} 半音 / 音域 ${ta?.range}  后半 均值 ${tb?.mean} 半音 / 音域 ${tb?.range}`)
  console.log(`            → 前后差 ${splitShift?.toFixed(2)} 半音`)
  console.log(`  一次合成：整体 均值 ${tj?.mean} / 音域 ${tj?.range}；内部前后差 ${hj?.shift?.toFixed(2)} 半音`)
  console.log()
}

// ------------------------------------------------------------------ 结论

const valid = rows.filter((r) => r.splitShift !== null)
if (valid.length) {
  const avgSplit = valid.reduce((a, r) => a + Math.abs(r.splitShift), 0) / valid.length
  const jvalid = rows.filter((r) => r.jointShift !== null)
  const avgJoint = jvalid.length ? jvalid.reduce((a, r) => a + Math.abs(r.jointShift), 0) / jvalid.length : null

  console.log('=== 汇总 ===')
  console.log(`  分开合成（参考已锁定）前后半段平均音高差：${avgSplit.toFixed(2)} 半音`)
  if (avgJoint !== null) console.log(`  一次合成内部前后平均音高差：        ${avgJoint.toFixed(2)} 半音`)
  console.log()
  console.log('  参考：人正常说话时句内的自然音高起伏约 2~4 个半音；')
  console.log('        前后半段差 < 1 半音基本听不出「换人」，> 2 半音就会明显觉得语气断了。')
  console.log()
  if (avgJoint !== null && avgSplit - avgJoint > 0.6) {
    console.log(`  → 一次合成明显更连贯（差 ${(avgSplit - avgJoint).toFixed(2)} 半音）。`)
    console.log('     值得把「第一句单独合成、其余合成一次」做成流水线。')
  } else {
    console.log('  → 锁定参考之后，分开合成和一次合成的差别不大。')
    console.log('     那就不必为了连贯性牺牲「边生成边合成」的低延迟。')
  }
}
console.log(`\n音频在 ${OUT}，可以直接听 A/B 对比。`)
