/**
 * 验证 + 找解法
 *   node scripts/validate-pitch-and-levers.mjs
 *
 * 两件事：
 *
 * 1) **验证估音器本身**。自相关估基频容易出倍频错误（把 200Hz 看成 100Hz），
 *    那会把音域虚假地拉大。先用已知音高轮廓的合成信号测一遍 ——
 *    如果估出来和设定的对不上，那前面所有关于「音域」的结论都要作废。
 *
 * 2) **试几个能把语气压平的旋钮**，看哪个真的有用：
 *    · temperature（采样温度）—— 越低越保守，理论上有用
 *    · 参考音频的音域宽窄 —— 用最平的 vs 最戏剧化的参考对比
 *    · sample_steps —— 影响音质，试一下会不会顺带影响音域
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav, pitchTrack, summarize, voicedSeconds } from './lib/wav-prosody.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))
const OUT = join(ROOT, '.userdata-dev', 'levers')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------- 1. 自检

/** 写一个 16-bit PCM WAV（纯正弦，F0 按半音摆动） */
function writeToneWav(file, { sr = 16000, seconds = 3, baseHz = 200, swaySemitones = 2, period = 1.5 }) {
  const n = Math.floor(sr * seconds)
  const pcm = Buffer.alloc(n * 2)
  /**
   * 关键：变频信号必须**累加相位**，不能写成 sin(2π·f(t)·t)。
   * 后者的瞬时频率是 d/dt[f(t)·t] = f(t) + t·f'(t)，
   * 那个 t·f'(t) 项会随着 t 增大而失控 —— 生成出来的根本不是想要的音高轮廓。
   * （第一版就是这么写错的，结果自检里 ±1 半音的摆动被估成了 20 半音，
   *   差点让我误判「所有参考音频都很戏剧化」。）
   */
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const semis = swaySemitones * Math.sin((2 * Math.PI * t) / period)
    const f = baseHz * Math.pow(2, semis / 12)
    phase += (2 * Math.PI * f) / sr
    pcm.writeInt16LE(Math.round(Math.sin(phase) * 0.5 * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sr, 24)
  header.writeUInt32LE(sr * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  writeFileSync(file, Buffer.concat([header, pcm]))
}

console.log('=== 1. 估音器自检（用已知音高轮廓的合成信号）===')
console.log('   设定音域 = p90-p10 的理论值 ≈ sway × 1.902（反正弦分布的 80% 区间）')
console.log('   同时对比「关掉倍频纠正」的结果，看纠正有没有起作用\n')

let selfTestOk = true
for (const sway of [0, 1, 2, 4, 6]) {
  const f = join(OUT, `tone-${sway}.wav`)
  writeToneWav(f, { swaySemitones: sway })
  const audio = readWav(f)
  const withFix = summarize(pitchTrack(audio, { octaveCorrect: true }))
  const raw = summarize(pitchTrack(audio, { octaveCorrect: false }))
  const expected = sway * 1.902
  const ok = Math.abs(withFix.range - expected) < 1.2
  if (!ok) selfTestOk = false
  console.log(
    `   摆动 ±${sway} 半音：纠正后 ${String(withFix.range).padStart(5)} / 未纠正 ${String(raw.range).padStart(5)}` +
      `（理论约 ${expected.toFixed(1)}）${ok ? ' ✅' : ' ❌'}   平均F0 ${withFix.mean}`
  )
}

if (!selfTestOk) {
  console.log('\n   ❌ 自检没过 —— 下面所有基于「音域」的结论都不能用，先修估音器。')
  process.exit(1)
}
console.log('   ✅ 估音器通过自检，后面关于音域的数字可信。\n')

// ---------------------------------------------------------------- 2. 旋钮

const lib = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))
const calmCat = '平静'
const clips = lib.clips.filter((c) => c.category === calmCat)

// 从前面 measure-ref-calmness 的结果里挑最平/最戏剧化的
const FLATTEST = process.env.FLATTEST_ID || null
const WIDEST = process.env.WIDEST_ID || null

function mk(tag, g = {}) {
  return createTts({
    config: {
      enabled: true,
      backend: 'gptsovits',
      referenceMode: 'rotate',
      normalizeLoudness: false, // 别让归一化干扰音域
      gptsovits: { sampleSteps: 24, speedFactor: 1.05, seedLock: true, ...g },
      cache: { enabled: false },
    },
    root: ROOT,
    cacheDir: join(OUT, tag),
    resolveKey: () => null,
  })
}

const TEXT = '水果当然喜欢，尤其是酸酸甜甜那种。'
const CHAR_N = TEXT.replace(/[，。！？、…—]/g, '').length
const refId = FLATTEST || clips[0].id

function out(file) {
  const audio = readWav(file)
  const s = summarize(pitchTrack(audio))
  const vs = voicedSeconds(audio)
  return { range: s.range, f0: s.mean, rate: +(CHAR_N / vs).toFixed(2), seconds: +(audio.data.length / audio.sr).toFixed(2) }
}

console.log('=== 2. temperature 对语气「戏剧化程度」的影响 ===')
console.log(`   固定文本：「${TEXT}」  固定参考：${refId.slice(0, 8)}\n`)
for (const temp of [1.0, 0.8, 0.6, 0.4]) {
  const tts = mk(`t${temp}`, { temperature: temp })
  const r = await tts.speak({ text: TEXT, category: calmCat, refId, noCache: true })
  if (!r.ok) { console.log(`   temperature=${temp} 失败：${r.error}`); continue }
  const o = out(r.file)
  console.log(`   temperature=${temp}  →  音域 ${String(o.range).padStart(5)}  平均F0 ${String(o.f0).padStart(6)}  语速 ${String(o.rate).padStart(5)}  时长 ${o.seconds}s`)
}

console.log('\n=== 3. sample_steps 的影响（顺带看看，预期只影响音质）===')
for (const steps of [16, 24, 32]) {
  const tts = mk(`s${steps}`, { sampleSteps: steps })
  const r = await tts.speak({ text: TEXT, category: calmCat, refId, noCache: true })
  if (!r.ok) { console.log(`   steps=${steps} 失败：${r.error}`); continue }
  const o = out(r.file)
  console.log(`   sample_steps=${steps}  →  音域 ${String(o.range).padStart(5)}  平均F0 ${String(o.f0).padStart(6)}  语速 ${String(o.rate).padStart(5)}  时长 ${o.seconds}s`)
}

console.log('\n=== 4. 同一句话，参考音频音域宽窄的对比 ===')
if (!FLATTEST || !WIDEST) {
  console.log('   （要真正对比，先跑 measure-ref-calmness 拿到最平/最宽的 id，')
  console.log('     再用 FLATTEST_ID=xxx WIDEST_ID=yyy 环境变量跑这个脚本）')
  console.log(`   现在只能用库里已有的 ${clips.length} 条，逐条看：\n`)
  for (const c of clips.slice(0, 5)) {
    const tts = mk('cmp', { temperature: 1.0 })
    const r = await tts.speak({ text: TEXT, category: calmCat, refId: c.id, noCache: true })
    if (!r.ok) continue
    const o = out(r.file)
    const refAudio = readWav(join(ROOT, 'assets', 'voice', c.file))
    const refS = summarize(pitchTrack(refAudio))
    console.log(
      `   参考 ${c.id.slice(0, 8)}（自身音域 ${String(refS.range).padStart(5)}） →  输出音域 ${String(o.range).padStart(5)}  语速 ${String(o.rate).padStart(5)}`
    )
  }
}

console.log(`\n音频在 ${OUT}`)
