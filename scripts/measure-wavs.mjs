/**
 * 量一组 wav 的客观指标 —— 临时对比用
 *   node scripts/measure-wavs.mjs a.wav b.wav ...
 */
import { readWav, pitchTrack, summarize, rms, voicedSeconds } from './lib/wav-prosody.mjs'
import { basename } from 'node:path'

for (const f of process.argv.slice(2)) {
  try {
    const a = readWav(f)
    const s = summarize(pitchTrack(a))
    const sec = a.data.length / a.sr
    const vs = voicedSeconds(a)
    console.log(
      `  ${basename(f).padEnd(30)} 时长 ${sec.toFixed(2)}s  有声 ${vs.toFixed(2)}s  ` +
        `F0 ${s ? s.mean.toFixed(1) : '—'}  音域 ${s ? s.range.toFixed(1) : '—'}  RMS ${rms(a).toFixed(4)}`
    )
  } catch (e) {
    console.log(`  ${basename(f)} —— ❌ ${e.message}`)
  }
}
