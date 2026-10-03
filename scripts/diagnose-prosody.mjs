/**
 * 诊断「情绪不连贯」到底是哪来的
 *   node scripts/diagnose-prosody.mjs
 *
 * 背景：用户反复反馈「语气不连贯」。已修过的：一轮内换参考、参考库情绪混、
 * 句式覆盖缺口。但感觉还有问题，所以这次不猜了，直接量。
 *
 * 把「不连贯」拆成两个可测的来源：
 *
 *   A. 换参考造成的漂移 —— 同一句话、同一个情绪类别，换用该类里不同的参考音频，
 *      输出会有多大差别？（GPT-SoVITS 的音色和语气都跟着参考走）
 *
 *   B. 重跑造成的噪声 —— 同一句话、同一条参考，重复合成的差别有多大？
 *      （这是「自然抖动」的下限，A 必须明显大于 B 才算「换参考有害」）
 *
 * 如果 A ≈ B：轮换参考是无害的，不连贯另有原因（比如句子之间的拼接）。
 * 如果 A >> B：每类放 5 条参考 + 冷却强制轮换 = 每次回复都换个嗓子，这才是病根。
 *
 * 量四个量：平均音高、音域、语速（字/秒）、响度。
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav, pitchTrack, summarize, rms, voicedSeconds, stats, toSemitones } from './lib/wav-prosody.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

const OUT = join(ROOT, '.userdata-dev', 'diag')
mkdirSync(OUT, { recursive: true })

const lib = JSON.parse(require('node:fs').readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))

function mk(tag, extra = {}) {
  return createTts({
    config: {
      enabled: true,
      backend: 'gptsovits',
      gptsovits: { sampleSteps: 24, speedFactor: 1.05, seedLock: true, ...extra },
      cache: { enabled: false },
    },
    root: ROOT,
    cacheDir: join(OUT, tag),
    resolveKey: () => null,
  })
}

const TEXT = '我今天有点累，想早点休息。'
const CATEGORY = '平静'

/** 合成一条，抽出四个声学量 */
async function measure(tts, text, refId, tag) {
  const r = await tts.speak({ text, category: CATEGORY, refId, noCache: true })
  if (!r.ok) throw new Error(r.error)
  return { ...acoustics(r.file, text), tag, refId, ms: r.ms }
}

/** 合成一条（带情绪类别），抽出声学量 —— 模拟真实对话用 */
async function measure2(tts, text, category, refId) {
  const r = await tts.speak({ text, category, refId, noCache: true })
  if (!r.ok) throw new Error(r.error)
  return { ...acoustics(r.file, text), ms: r.ms }
}

/** 从一个 wav 文件抽声学特征 */
function acoustics(file, text) {
  const audio = readWav(file)
  const sum = summarize(pitchTrack(audio))
  const vs = voicedSeconds(audio)
  const chars = text.replace(/[\s，。！？、…—「」]/g, '').length
  return {
    f0: sum?.mean ?? NaN,
    range: sum?.range ?? NaN,
    rate: vs > 0.2 ? +(chars / vs).toFixed(2) : NaN,
    rms: +rms(audio).toFixed(4),
    seconds: +(audio.data.length / audio.sr).toFixed(2),
  }
}

const clips = lib.clips.filter((c) => c.category === CATEGORY)
console.log(`用例：${CATEGORY} 类，共 ${clips.length} 条参考`)
console.log(`固定文本：「${TEXT}」\n`)

const tts = mk('a')

console.log('=== A. 换参考（同一句话，逐条参考各合成一次）===')
const acrossRefs = []
for (const c of clips) {
  const m = await measure(tts, TEXT, c.id, c.id.slice(0, 8))
  acrossRefs.push(m)
  console.log(`  ${m.refId.slice(0, 8)}  F0 ${String(m.f0).padStart(6)}  音域 ${String(m.range).padStart(5)}  语速 ${String(m.rate).padStart(5)} 字/秒  响度 ${m.rms}  ${m.ms}ms`)
}

console.log('\n=== B. 重跑（同一条参考，合成 3 次）===')
const sameRef = clips[0].id
const repeats = []
for (let i = 0; i < 3; i++) {
  const m = await measure(tts, TEXT, sameRef, `rep${i}`)
  repeats.push(m)
  console.log(`  第${i + 1}次  F0 ${String(m.f0).padStart(6)}  音域 ${String(m.range).padStart(5)}  语速 ${String(m.rate).padStart(5)} 字/秒  响度 ${m.rms}  ${m.ms}ms`)
}

console.log('\n=== 对比 ===\n')
const metrics = [
  ['平均音高 F0（半音）', 'f0'],
  ['音域（半音）', 'range'],
  ['语速（字/秒）', 'rate'],
  ['响度 RMS', 'rms'],
]

let verdict = null
for (const [label, key] of metrics) {
  const a = stats(acrossRefs.map((m) => m[key]))
  const b = stats(repeats.map((m) => m[key]))
  const ratio = b.sd > 0.001 ? a.sd / b.sd : a.sd > 0.001 ? Infinity : 1
  console.log(`  ${label}`)
  console.log(`     换参考：均值 ${a.mean}  标准差 ${a.sd}  极差 ${a.spread}   ${JSON.stringify(a.values)}`)
  console.log(`     重  跑：均值 ${b.mean}  标准差 ${b.sd}  极差 ${b.spread}   ${JSON.stringify(b.values)}`)
  console.log(`     → 换参考的波动是重跑噪声的 ${Number.isFinite(ratio) ? ratio.toFixed(1) : '∞'} 倍`)
  if (key === 'f0') verdict = { a, b, ratio }
  console.log()
}

console.log('=== 判读 ===\n')
if (verdict) {
  const { a, b, ratio } = verdict
  console.log(`  平均音高的「换参考波动」${a.sd} vs 「重跑噪声」${b.sd}，比值 ${Number.isFinite(ratio) ? ratio.toFixed(1) : '∞'}`)
  console.log('  参考：人说话时句间的自然音高差约 1~2 半音；')
  console.log('        超过 2 半音，听感上就是「换了个语气」。')
  console.log()
  if (a.sd > 1.2 && ratio >= 2) {
    console.log('  ⚠️ 换参考带来的音高波动很大，而且明显大于重跑噪声。')
    console.log('     结论：每类放多条参考 + 冷却强制轮换 = 每次回复换一个嗓子。')
    console.log('     这一项很可能就是「情绪不连贯」的来源。可选的修法：')
    console.log('       1. 缩小 recentRefMemory，或干脆去掉冷却（同类别固定用一条参考，音色最稳）')
    console.log('       2. 每类只留 2~3 条参考，且**只在类别切换时才换**（同类别连续回复复用同一条）')
    console.log('       3. 把「长度接近」权重调高，让参考时长也更稳定')
  } else if (a.sd > 1.2) {
    console.log('  ⚠️ 换参考的音高波动不小，但和重跑噪声同量级 ——')
    console.log('     说明这个类别的参考本身音色就不太统一，不完全是轮换的锅。')
  } else {
    console.log('  ✅ 换参考的音高波动在自然范围内。')
    console.log('     「不连贯」多半来自别处 —— 去看句子之间的拼接（voice.js 的 GAP_MS）。')
  }
}

console.log(`\n=== C. 模拟真实连续对话（这才是用户实际体验到的波动）===`)
console.log('  一串回复，每句带自己的情绪类别；看实际用到的参考造成了多大的音色跳变\n')

// 一串有代表性的回复：情绪在类别之间跳，也有连续同类
const CONVO = [
  { cat: '平静', text: '嗯，我在听，你说吧。' },
  { cat: '平静', text: '原来是这样，我明白了。' },
  { cat: '得意', text: '哼，这种程度的问题我一眼就看穿了。' },
  { cat: '平静', text: '你先忙吧，我在这儿等着。' },
  { cat: '温柔', text: '别太累了，歇一会儿吧。' },
  { cat: '无奈', text: '好吧好吧，那就听你的。' },
  { cat: '平静', text: '这个功能明天再继续弄。' },
  { cat: '开心', text: '太好了，终于搞定了！' },
]

/** 用哪个模式跑：默认跟随 config（sticky），可以用 --rotate 强制旧的轮换行为做对比 */
const MODE = process.argv.includes('--rotate') ? 'rotate' : 'sticky'
console.log(`  模式：${MODE}${MODE === 'rotate' ? '（旧的轮换行为，做对照）' : '（默认）'}\n`)

const convoTts = mk('convo', { referenceMode: MODE })
const convoRows = []
for (const turn of CONVO) {
  const picked = convoTts.pick(turn.text, turn.cat, { lock: true })
  const m = await measure2(convoTts, turn.text, turn.cat, picked.clip.id)
  const row = { ...turn, ...m, ref: picked.clip.id.slice(0, 8) }
  convoRows.push(row)
  console.log(
    `  [${turn.cat}] ${row.ref}  F0 ${String(row.f0).padStart(6)}  语速 ${String(row.rate).padStart(5)}  响度 ${String(row.rms).padStart(6)}  「${turn.text.slice(0, 16)}」`
  )
}

// 同类别内部 vs 全体
const byCat = {}
for (const r of convoRows) (byCat[r.cat] = byCat[r.cat] || []).push(r)

console.log('\n  同一类别内部（同一种情绪就该是同一条参考）：')
for (const [cat, rows] of Object.entries(byCat)) {
  const refs = new Set(rows.map((r) => r.ref))
  const s = stats(rows.map((r) => r.f0))
  const rateS = stats(rows.map((r) => r.rate))
  console.log(
    `     ${cat}：${rows.length} 条，用了 ${refs.size} 条参考 ${refs.size === 1 ? '✅' : '❌'}  ` +
      `F0 极差 ${s.spread} 半音（这是不同句子的自然语调，不是音色漂）  语速极差 ${rateS.spread}`
  )
}

const allF0 = stats(convoRows.map((r) => r.f0))
console.log(`\n  全体 F0 极差 ${allF0.spread} 半音 —— 这部分来自情绪类别变化，是**该有的**`)

const multiRefCats = Object.entries(byCat).filter(([, rows]) => new Set(rows.map((r) => r.ref)).size > 1)
const refTotal = Object.values(byCat).reduce((a, rows) => a + new Set(rows.map((r) => r.ref)).size, 0)
const catTotal = Object.keys(byCat).length
console.log(`\n  ${catTotal} 个类别共用了 ${refTotal} 条参考 ${refTotal === catTotal ? '✅ 一类一条，声音只随情绪变' : '⚠️ 有类别在内部换参考'}`)

// ---------------------------------------------------------------- D. 一句话内部的拼接

console.log('\n=== D. 一句话拆成多段合成，段与段之间连贯吗 ===')
console.log('  真实管线是「按句切开、逐句合成、中间 70ms 间隔」。这里量段间的跳变。\n')

const REPLY = '诶？你今天来得挺早嘛。我还没准备好呢，先等我一下下。对了，桌上那块蛋糕是给我的吗？'
const sentences = (() => {
  const s = new (require(join(ROOT, 'src', 'sentence.js')).createSplitter)()
  return [...s.feed(REPLY), ...s.flush()]
})()

console.log(`  回复切成 ${sentences.length} 段：`)
for (const s of sentences) console.log(`     「${s}」`)

const convoPick = convoTts.pick(REPLY, '平静', { lock: true })
const refForReply = convoPick?.clip?.id
const segs = []
for (const s of sentences) {
  const m = await measure2(convoTts, s, '平静', refForReply)
  segs.push({ text: s, ...m })
  console.log(`     F0 ${String(m.f0).padStart(6)}  音域 ${String(m.range).padStart(5)}  语速 ${String(m.rate).padStart(5)}  时长 ${m.seconds}s`)
}

const f0s = segs.map((s) => s.f0)
const rates = segs.map((s) => s.rate)
let maxJump = 0
for (let i = 1; i < f0s.length; i++) maxJump = Math.max(maxJump, Math.abs(f0s[i] - f0s[i - 1]))
console.log(`\n  段间平均音高：极差 ${stats(f0s).spread} 半音，最大相邻跳变 ${maxJump.toFixed(2)} 半音`)
console.log(`  段间语速：极差 ${stats(rates).spread} 字/秒`)

console.log()
if (maxJump > 2) {
  console.log(`  ⚠️ 相邻两段之间音高跳了 ${maxJump.toFixed(2)} 半音 —— 这听起来就是「一句话念到一半换了个语气」。`)
  console.log('     来源：每段是**独立的一次推理**，段与段之间没有上下文衔接。')
  console.log('     可选修法：把整轮回复合成一次（text_split_method 让 GPT-SoVITS 自己切），')
  console.log('     代价是第一句要多等一轮 —— 但至少段间是同一口气。')
} else {
  console.log(`  ✅ 段间最大跳变 ${maxJump.toFixed(2)} 半音，在自然语调范围内。`)
}

console.log(`\n音频在 ${OUT}，可以逐条听 A 组对比。`)
