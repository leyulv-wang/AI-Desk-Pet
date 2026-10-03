/**
 * 体检一批合成出来的 wav：哪一段是「废片」
 *   node scripts/probe-segments.mjs .userdata-dev/tts-cache
 *   node scripts/probe-segments.mjs a.wav b.wav
 *   node scripts/probe-segments.mjs .userdata-dev/tts-cache --last=6
 *
 * 为什么需要它：
 *   合成流水线里已经有一道「废片守卫」（src/tts.js 的 MAX_RATE），
 *   但它只抓**太短**（15 个字合成成 0.39 秒那种）。它抓不到**太安静** ——
 *   一段近乎全零的音频时长是「正常」的，语速算出来也正常，守卫会放它过去。
 *   实测抓到过一段 0.40s、只有 0.06s 出声、RMS 0.0023（正常 0.09）的片子，
 *   就混在回复的第一句里 —— 听起来是她张嘴先哑一下。
 *
 * 判据（三条都要过）：
 *   ① RMS  ≥ MIN_RMS      —— 响度。trimSilence + normalizeLoudness 之后应该贴着 targetRms
 *   ② 有声占比 ≥ MIN_VOICED —— 裁过首尾静音之后，剩下的应该几乎全是有声的
 *   ③ 时长 ≥ MIN_SECONDS  —— 短于 0.3s 基本是废片
 *
 * 为什么用「有声占比」而不是「峰值」：
 *   峰值只在**一个样本**上成立，一段爆音+全静音也能骗过它。
 *   占比看的是整段有多少时间在出声，骗不过去。
 *
 * ⚠️ 这个脚本自己踩过一次坑，记在这儿免得再犯：
 *   第一版写的是 `vs > 0.2 && vs < sec*0.35`，结果那段 0.06s 有声的片子
 *   因为 `0.06 > 0.2` 不成立**直接被跳过**，脚本还报「全部正常」。
 *   阈值条件里的「防止误报」分支，正好放过了最该抓的那个样本。
 *   教训：判据要写成「必须满足什么」，不要写成「排除什么」。
 */
import { readdirSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { readWav, rms, voicedSeconds, pitchTrack, summarize } from './lib/wav-prosody.mjs'

const argv = process.argv.slice(2)
const lastN = Number((argv.find((a) => a.startsWith('--last=')) || '').split('=')[1]) || 0
const targets = argv.filter((a) => !a.startsWith('--'))

let files = []
for (const t of targets.length ? targets : ['.userdata-dev/tts-cache']) {
  const p = resolve(t)
  if (statSync(p).isDirectory()) {
    const inDir = readdirSync(p).filter((f) => f.endsWith('.wav')).map((f) => join(p, f))
    inDir.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    files.push(...(lastN ? inDir.slice(-lastN) : inDir))
  } else {
    files.push(p)
  }
}

if (!files.length) {
  console.error('没有 wav 可查')
  process.exit(1)
}

/** 响度下限。normalizeLoudness 的目标是 0.09，给足余量 —— 只抓「几乎没声」 */
const MIN_RMS = 0.02
/** 有声占比下限。裁过首尾静音后，正常段应该在 0.9 以上 */
const MIN_VOICED = 0.6
const MIN_SECONDS = 0.3

console.log(`查 ${files.length} 个文件\n`)
console.log('  时长     有声    占比    峰值     RMS       音高   文件')
console.log('  ' + '-'.repeat(70))

const bad = []
for (const f of files) {
  const a = readWav(f)
  const sec = a.data.length / a.sr
  const r = rms(a)
  const vs = voicedSeconds(a)
  let peak = 0
  for (const v of a.data) if (Math.abs(v) > peak) peak = Math.abs(v)
  const st = summarize(pitchTrack(a))
  const ratio = sec > 0 ? vs / sec : 0

  const problems = []
  if (r < MIN_RMS) problems.push(`响度太低 RMS=${r.toFixed(4)}`)
  if (ratio < MIN_VOICED) problems.push(`只有 ${(ratio * 100).toFixed(0)}% 有声`)
  if (sec < MIN_SECONDS) problems.push(`太短 ${sec.toFixed(2)}s`)
  if (problems.length) bad.push({ f, problems })

  console.log(
    `  ${sec.toFixed(2)}s`.padEnd(10) +
      `${vs.toFixed(2)}s`.padEnd(8) +
      `${(ratio * 100).toFixed(0)}%`.padEnd(8) +
      `${peak.toFixed(4)}`.padEnd(8) +
      `${r.toFixed(4)}`.padEnd(10) +
      `${st ? st.mean.toFixed(1) : '—'}`.padEnd(7) +
      `${problems.length ? '❌' : '  '} ${basename(f)}`
  )
}

console.log('\n=== 结论 ===\n')
if (!bad.length) {
  console.log(`  ✅ ${files.length} 段全部正常：响度、有声占比、时长都在范围内`)
} else {
  console.log(`  ❌ ${bad.length}/${files.length} 段是废片：`)
  for (const b of bad) console.log(`     ${basename(b.f)} —— ${b.problems.join('、')}`)
  console.log('\n  注意：这一类**src/tts.js 现有的废片守卫抓不到**（它只看语速）。')
}
process.exitCode = bad.length ? 1 : 0
