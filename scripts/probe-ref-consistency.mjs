/**
 * 验证一个假设：参考音频**自己**的音高/语速，能不能预测合成结果的音高/语速？
 *   node scripts/probe-ref-consistency.mjs
 *
 * 为什么问这个：
 *   诊断脚本量出「换一条参考 = 音高差 4.6 半音、语速差 1.9 倍、响度差 2.6 倍」。
 *   如果合成结果的音高就是跟着参考音频走的，那我们**不需要真去合成**就能筛选 ——
 *   直接量每条参考 wav 自己的基频和语速，挑出内部一致的一组即可。建库成本几乎为零。
 *
 *   如果相关性很弱，那说明输出音高另有来源（模型采样、文本内容），
 *   就只能用「探针句合成后再筛」这种贵办法。
 */
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav, pitchTrack, summarize, voicedSeconds, rms } from './lib/wav-prosody.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

const OUT = join(ROOT, '.userdata-dev', 'diag-ref')
mkdirSync(OUT, { recursive: true })
const lib = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))

const CHAR_RE = /[\s，。！？、…—「」（）【】·~～!?.,:;"']/g

/** 量一条 wav 的声学特征 */
function probe(file, chars) {
  const audio = readWav(file)
  const s = summarize(pitchTrack(audio))
  const vs = voicedSeconds(audio)
  return {
    f0: s?.mean ?? NaN,
    range: s?.range ?? NaN,
    rate: vs > 0.2 && chars ? +(chars / vs).toFixed(2) : NaN,
    rms: +rms(audio).toFixed(4),
  }
}

function pearson(xs, ys) {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN
}

const TEXT = '我今天有点累，想早点休息。'
const tts = createTts({
  config: { enabled: true, backend: 'gptsovits', gptsovits: { sampleSteps: 24, speedFactor: 1.05, seedLock: true }, cache: { enabled: false } },
  root: ROOT,
  cacheDir: join(OUT, 's'),
  resolveKey: () => null,
})

// 用两条类别各 5 条参考，交叉验证
for (const category of ['平静', '得意']) {
  const clips = lib.clips.filter((c) => c.category === category)
  console.log(`\n=== ${category}（${clips.length} 条参考）===\n`)
  console.log('  参考自己的特征                        合成结果的特征')
  console.log('  id        F0    音域  语速  响度  →   F0    音域  语速  |  参考原文')
  console.log('  ' + '─'.repeat(100))

  const refF0 = [], outF0 = [], refRate = [], outRate = []
  for (const c of clips) {
    const refFile = join(ROOT, 'assets', 'voice', c.file)
    const rp = probe(refFile, c.text.replace(CHAR_RE, '').length)
    const r = await tts.speak({ text: TEXT, category, refId: c.id, noCache: true })
    if (!r.ok) { console.log(`  ${c.id.slice(0, 8)}  合成失败：${r.error}`); continue }
    const op = probe(r.file, TEXT.replace(CHAR_RE, '').length)

    refF0.push(rp.f0); outF0.push(op.f0)
    refRate.push(rp.rate); outRate.push(op.rate)

    console.log(
      `  ${c.id.slice(0, 8)}  ${String(rp.f0).padStart(6)} ${String(rp.range).padStart(5)} ${String(rp.rate).padStart(5)} ${String(rp.rms).padStart(6)}  →  ` +
        `${String(op.f0).padStart(6)} ${String(op.range).padStart(5)} ${String(op.rate).padStart(5)}  |  ${c.text.slice(0, 20)}…`
    )
  }

  console.log()
  const cF0 = pearson(refF0, outF0)
  const cRate = pearson(refRate, outRate)
  console.log(`  相关性：参考F0 ↔ 输出F0 = ${cF0.toFixed(2)}    参考语速 ↔ 输出语速 = ${cRate.toFixed(2)}`)
  console.log(`  （1.0 = 完全跟随，0 = 无关。样本只有 ${refF0.length} 条，看趋势别当精确值）`)
}

console.log(`
=== 判读 ===
  如果参考 F0 ↔ 输出 F0 相关性高（> 0.6）：
     → 建库时可以**只量参考 wav 自己**就筛出音色一致的一组，不用真合成。成本约等于 0。
  如果相关性低：
     → 输出音高另有来源，得用「探针句合成后再筛」的贵办法（每类 N 次合成）。
`)
