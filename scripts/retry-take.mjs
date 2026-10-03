/**
 * 给「某条生成音频有问题」做诊断 + 重录
 *   node scripts/retry-take.mjs <wav...> [--retry=5] [--line="要念的文本"]
 *
 * 语音生成是非确定性的 —— 同一句话同配置，每条都不一样。
 * 所以「这条不好」的正解不是调参，是**多录几条挑一条**。
 * 这个脚本就是干这个：
 *   ① 先量出已有那条哪儿不对（截断 / 爆音 / 长静音 / 尾巴掉）
 *   ② 重录 N 条，量同样的指标
 *   ③ 生成一个页面，让你听着挑
 *
 * 指标只能排掉明显坏的（截断、爆音、静音）——
 * 像不像、好不好听，只有你能判断。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav, pitchTrack, summarize, voicedSeconds, rms } from './lib/wav-prosody.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`))
  return a ? a.split('=')[1] : d
}
const NRETRY = Number(arg('retry', 5))
const LINE = arg('line', '哼，这种程度的问题我一眼就看穿了。')
const INST = arg('inst', '语调起伏大一些，抑扬顿挫。') // B2-inst-yyy 的指令
const TAG = arg('tag', '')
const SAMPLE = join(ROOT, arg('sample', '.userdata/clone-source.wav'))
const OUT = join(ROOT, '.userdata-dev', 'retry-take')
const WAV = join(OUT, 'wav')
const existing = process.argv.slice(2).filter((a) => !a.startsWith('--') && /\.wav$/i.test(a))

// ---------------------------------------------------------------- 诊断

/**
 * 波形体检。这些是「听起来有问题」在数据上的样子：
 *   · 头尾长静音 → 感觉是「顿一下才开口 / 尾巴被掐了」
 *   · 首尾是满幅度方波状 → 爆音（DC 冲击）
 *   · 最后 10% 掉到静音 → 被截断
 *   · 全段 RMS 极低 → 音量太小
 */
function diagnose(f) {
  const buf = readFileSync(f)
  const a = readWav(f)
  const { sr, data } = a
  const n = data.length
  const sec = n / sr

  let peak = 0
  for (const v of data) peak = Math.max(peak, Math.abs(v) / 32768)

  // 20ms 窗的 RMS 包络
  const win = Math.round(0.02 * sr)
  const env = []
  for (let s = 0; s + win <= n; s += win) {
    let sum = 0
    for (let i = s; i < s + win; i++) {
      const v = data[i] / 32768
      sum += v * v
    }
    env.push(Math.sqrt(sum / win))
  }
  const envMax = Math.max(...env) || 1
  const voiced = env.map((v) => v > envMax * 0.08) // 相对阈值 8%

  let lead = 0
  while (lead < voiced.length && !voiced[lead]) lead++
  let tail = 0
  while (tail < voiced.length - lead && !voiced[voiced.length - 1 - tail]) tail++
  const leadMs = lead * 20
  const tailMs = tail * 20

  // 尾巴截断：最后 150ms 还在响 = 正常收尾；完全静音 = 可能掐了
  const lastWindow = env.slice(-8)
  const lastPeak = Math.max(...lastWindow) || 0
  const tailClipped = lastPeak > envMax * 0.5

  // 爆音：首尾 20ms 的峰值异常高（DC 冲击）
  const edgePeak = Math.max(...[...data.slice(0, win), ...data.slice(-win)].map((v) => Math.abs(v) / 32768))

  const st = summarize(pitchTrack(a))
  return {
    f,
    sec: +sec.toFixed(2),
    peak: +peak.toFixed(3),
    rmsOverall: +rms(a).toFixed(4),
    leadMs,
    tailMs,
    f0: st?.mean ?? null,
    range: st?.range ?? null,
    vs: voicedSeconds(a),
    flags: [
      leadMs > 500 ? `开头 ${leadMs}ms 静音` : null,
      tailMs > 600 ? `结尾 ${tailMs}ms 静音` : null,
      tailClipped ? '结尾可能被截断' : null,
      edgePeak > 0.5 && peak > 0.99 ? '首尾可能有爆音' : null,
      peak < 0.05 ? '整体太小声' : null,
    ].filter(Boolean),
  }
}

console.log('=== ① 已有音频的体检 ===\n')
if (!existing.length) {
  console.log('  （没传入已有文件，跳过体检）')
} else {
  for (const f of existing) {
    if (!existsSync(f)) {
      console.log(`  ${basename(f)} —— 文件不存在`)
      continue
    }
    const d = diagnose(f)
    console.log(`  ${basename(d.f)}`)
    console.log(`     ${d.sec}s  峰值 ${d.peak}  RMS ${d.rmsOverall}  F0 ${d.f0?.toFixed(1) ?? '—'}  音域 ${d.range?.toFixed(1) ?? '—'}`)
    console.log(`     开头 ${d.leadMs}ms / 结尾 ${d.tailMs}ms 静音`)
    console.log(d.flags.length ? `     ⚠️ ${d.flags.join('、')}` : '     ✅ 没发现波形层面的问题')
  }
}

// ---------------------------------------------------------------- 重录

if (!NRETRY) process.exit(0)

const KEY = readFileSync(join(ROOT, '.userdata', 'mimo.key'), 'utf8').trim()
if (!existsSync(SAMPLE)) {
  console.error(`找不到克隆样本：${SAMPLE}`)
  process.exit(1)
}
const sampleDataUrl = `data:audio/wav;base64,${readFileSync(SAMPLE).toString('base64')}`

async function speak(text) {
  const body = {
    model: 'mimo-v2.5-tts-voiceclone',
    messages: [{ role: 'user', content: INST }, { role: 'assistant', content: TAG ? `(${TAG})${text}` : text }],
    audio: { format: 'wav', voice: sampleDataUrl },
  }
  const t0 = Date.now()
  const res = await fetch('https://token-plan-cn.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const b64 = JSON.parse(raw).choices?.[0]?.message?.audio?.data
  return { buf: Buffer.from(b64, 'base64'), ms: Date.now() - t0 }
}

mkdirSync(WAV, { recursive: true })
console.log(`\n=== ② 重录 ${NRETRY} 条「${LINE}」===\n`)
console.log(`  指令：${INST}`)

const takes = []
for (let i = 0; i < NRETRY; i++) {
  try {
    const s = await speak(LINE)
    const f = join(WAV, `take-${i + 1}.wav`)
    writeFileSync(f, s.buf)
    const d = diagnose(f)
    d.ms = s.ms
    takes.push(d)
    console.log(
      `  take-${i + 1}  ${d.sec}s  F0 ${d.f0?.toFixed(1) ?? '—'}  音域 ${d.range?.toFixed(1) ?? '—'}  峰值 ${d.peak}  ${s.ms}ms` +
        (d.flags.length ? `  ⚠️ ${d.flags.join('、')}` : '  ✅')
    )
  } catch (e) {
    console.log(`  take-${i + 1}  ❌ ${e.message}`)
  }
}

// ---------------------------------------------------------------- 页面

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const rel = (f) => `wav/${f.split(/[\\/]/).pop()}`

const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>重录挑选</title>
<style>
 body{background:#141419;color:#e6e6ee;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:1000px;margin:0 auto;padding:28px}
 h1{font-size:18px;margin:0 0 6px}
 .meta{color:#8f93a8;font-size:12.5px;margin-bottom:18px}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #2c2c36;padding:9px 11px;vertical-align:top;text-align:left}
 th{background:#1e1e24;font-weight:400;color:#a9adc0;font-size:12.5px}
 audio{width:100%;height:34px;margin-top:4px}
 .num{font-size:11.5px;color:#8f93a8;font-variant-numeric:tabular-nums}
 .ok{color:#7fd8a0}
 .warn{color:#ffce7a}
 .fail{color:#ff9a9a}
</style>
<h1>重录挑选 —— 「${esc(LINE)}」</h1>
<div class="meta">
 指令：<code>${esc(INST)}</code>${TAG ? ` · 标签：<code>(${esc(TAG)})</code>` : ''}<br>
 语音生成是非确定性的 —— 同一句话每次都不一样。<b>挑一条最好的用</b>。
</div>
<table>
<tr><th style="width:18%">文件</th><th style="width:34%">体检</th><th style="width:48%">试听</th></tr>
${
  existing
    .map((f) => {
      const d = diagnose(f)
      return `<tr><td class="fail">${esc(basename(f))}<div class="num">（原片，你报的那个）</div></td>
       <td class="num">${d.sec}s · F0 ${d.f0?.toFixed(1) ?? '—'} · 音域 ${d.range?.toFixed(1) ?? '—'} · 峰值 ${d.peak}<br>开头 ${d.leadMs}ms / 结尾 ${d.tailMs}ms 静音
       ${d.flags.length ? `<br><b class="warn">⚠️ ${esc(d.flags.join('、'))}</b>` : '<br><span class="ok">波形层面正常</span>'}</td>
       <td><audio controls preload="none" src="${f.replace(/\\/g, '/')}"></audio></td></tr>`
    })
    .join('')
}
${takes
  .map(
    (d, i) => `<tr><td>take-${i + 1}<div class="num">${d.ms}ms</div></td>
     <td class="num">${d.sec}s · F0 ${d.f0?.toFixed(1) ?? '—'} · 音域 ${d.range?.toFixed(1) ?? '—'} · 峰值 ${d.peak}<br>开头 ${d.leadMs}ms / 结尾 ${d.tailMs}ms 静音
     ${d.flags.length ? `<br><b class="warn">⚠️ ${esc(d.flags.join('、'))}</b>` : '<br><span class="ok">波形层面正常</span>'}</td>
     <td><audio controls preload="none" src="${rel(d.file ?? d.f)}"></audio></td></tr>`
  )
  .join('')}
</table>
</html>`

writeFileSync(join(OUT, 'index.html'), html)
console.log(`\n✅ 试听页：${join(OUT, 'index.html')}`)
