/**
 * 拼一段「克隆用」的源音频
 *   node scripts/prepare-clone-audio.mjs [--seconds=40] [--category=温柔]
 *
 * MiniMax 的克隆要求：mp3/m4a/wav，**10 秒 ~ 5 分钟**，≤20MB。
 * 我们 assets/voice/clips/ 里每条只有 6 秒左右，单条不够，所以拼几条。
 *
 * 为什么按「同一个情绪类别」拼、而不是随便凑：
 *   克隆是拿这段音频去推断音色，**情绪越统一，推出来的音色越干净**。
 *   把温柔和生气拼在一起，等于告诉模型「这个人有时这样有时那样」，
 *   它只能取平均，反而糊。
 *
 * 为什么不是越长越好：
 *   官方给的上限是 5 分钟，但音色克隆只需要「稳定的音色样本」，
 *   30~60 秒足够。再长只是把不同语句的差异也喂进去。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`))
  return a ? a.split('=')[1] : dflt
}

const WANT_SECONDS = Number(arg('seconds', 40))
const CATEGORY = arg('category', '温柔')

// ---------------------------------------------------------------- 读 wav

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE')
  }
  let pos = 12
  let fmt = null
  let dataOff = -1
  let dataLen = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(size, buf.length - body)
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || dataOff < 0) throw new Error('缺 fmt 或 data 块')
  return { ...fmt, dataOff, dataLen, seconds: dataLen / (fmt.sampleRate * fmt.channels * (fmt.bits / 8)) }
}

/** 拼 wav：要求采样率/声道/位深一致，不一致的直接跳过（不重采样，免得引入伪影） */
function concat(files) {
  const parts = files.map((f) => ({ f, info: parseWav(readFileSync(f)) }))
  const ref = parts[0].info
  const same = parts.filter(
    (p) => p.info.sampleRate === ref.sampleRate && p.info.channels === ref.channels && p.info.bits === ref.bits
  )
  if (same.length !== parts.length) {
    console.log(`  ⚠️ 有 ${parts.length - same.length} 条格式不一致，已跳过`)
  }

  const pcm = Buffer.concat(same.map((p) => readFileSync(p.f).subarray(p.info.dataOff, p.info.dataOff + p.info.dataLen)))

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(ref.channels, 22)
  header.writeUInt32LE(ref.sampleRate, 24)
  header.writeUInt32LE(ref.sampleRate * ref.channels * 2, 28)
  header.writeUInt16LE(ref.channels * 2, 32)
  header.writeUInt16LE(ref.bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)

  // ⚠️ 时长要用**拼接后**的 pcm 长度算。
  // 一开始写的是 `ref.dataLen`（第一段的长度），于是 33.3 秒的文件报成 6.7 秒 ——
  // 文件本身是对的，只有这个数字错，但足够让人以为拼接失败了。
  const bytesPerSec = ref.sampleRate * ref.channels * (ref.bits / 8)
  return {
    buf: Buffer.concat([header, pcm]),
    info: ref,
    seconds: pcm.length / bytesPerSec,
    used: same.map((p) => p.f),
  }
}

// ---------------------------------------------------------------- 挑素材

const LIB = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))
const CLIPS = join(ROOT, 'assets', 'voice', 'clips')

const pool = LIB.clips.filter((c) => c.category === CATEGORY)
if (!pool.length) {
  console.error(`参考库里没有「${CATEGORY}」这个类别。有的是：${[...new Set(LIB.clips.map((c) => c.category))].join('、')}`)
  process.exit(1)
}

// 短的先拼进去凑时长，但优先用较长的（少几个拼接点 = 少几处音色跳变）
pool.sort((a, b) => b.seconds - a.seconds)

const picked = []
let total = 0
for (const c of pool) {
  if (total >= WANT_SECONDS) break
  const p = join(CLIPS, c.id + '.wav')
  if (!existsSync(p)) continue
  picked.push({ clip: c, path: p })
  total += c.seconds
}

console.log(`类别「${CATEGORY}」共 ${pool.length} 条，挑了 ${picked.length} 条，合计 ${total.toFixed(1)} 秒：\n`)
for (const p of picked) console.log(`  ${p.clip.id.slice(0, 8)}  ${p.clip.seconds.toFixed(2)}s  「${p.clip.text.slice(0, 26)}」`)

// 按 id 排序再拼 —— 让结果可复现（不然每次跑出来的文件都不一样，没法对比）
picked.sort((a, b) => a.clip.id.localeCompare(b.clip.id))

const out = concat(picked.map((p) => p.path))
const dest = join(ROOT, '.userdata', 'clone-source.wav')
writeFileSync(dest, out.buf)

console.log(`\n✅ 写入 ${dest}`)
console.log(
  `   ${out.info.sampleRate}Hz ${out.info.channels}ch ${out.info.bits}bit  ` +
    `${(out.buf.length / 1024 / 1024).toFixed(2)} MB  ${out.seconds.toFixed(1)} 秒`
)
const okLen = out.seconds >= 10 && out.seconds <= 300
console.log(`   MiniMax 要求：10 秒 ~ 5 分钟，≤20MB，mp3/m4a/wav → ${okLen ? '✅ 符合' : '❌ 时长不符'}`)
