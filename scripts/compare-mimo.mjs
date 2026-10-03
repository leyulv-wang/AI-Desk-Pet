/**
 * 小米 MiMo 克隆音色 vs MiniMax 克隆音色 —— 并排试听
 *   node scripts/compare-mimo.mjs
 *   node scripts/compare-mimo.mjs --sample=../.userdata/clone-source.wav
 *
 * 为什么要单独一个脚本（而不是塞进 compare-tts-tiers）：
 *   MiMo 的接口是**对话式**的（文本在 role:assistant 的 message 里，音色在 audio.voice
 *   里内联 base64），MiniMax 是传统的 /t2a_v2（voiceId 只是个名字）。两边结构差太多，
 *   硬塞进一个脚本里会让两套请求逻辑互相污染。
 *
 * 两边用**同一份克隆样本**（.userdata/clone-source.wav，5 条温柔参考拼的 33.3 秒），
 * 这样比的才是「模型克隆得像不像」，而不是「素材不一样」。
 *
 * 不改 config.json —— 只生成试听页，等听完再决定切哪个。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readWav, rms, voicedSeconds, pitchTrack, summarize } from './lib/wav-prosody.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`))
  return a ? a.split('=')[1] : d
}
const SAMPLE = join(ROOT, arg('sample', '.userdata/clone-source.wav'))
const MIMO_MODEL = arg('model', 'mimo-v2.5-tts-voiceclone')
const MM_MODEL = arg('mm-model', 'speech-2.8-turbo')
const MM_VOICE = arg('mm-voice', 'furinaCloneVoiceV1')

const OUT = join(ROOT, '.userdata-dev', 'compare-mimo')
const WAV = join(OUT, 'wav')

const LINES = [
  { cat: '平静', t: '嗯，我在听，你说吧。' },
  { cat: '得意', t: '哼，这种程度的问题我一眼就看穿了。' },
  { cat: '温柔', t: '累了吧？先坐下歇一会儿，我陪你。' },
  { cat: '无奈', t: '好吧好吧，那就听你的。' },
  { cat: '开心', t: '太好了，你终于回来啦！' },
]

// ---------------------------------------------------------------- 凭据

const mmKey = readFileSync(join(ROOT, '.userdata', 'minimax.key'), 'utf8').trim()
const mimoKey = readFileSync(join(ROOT, '.userdata', 'mimo.key'), 'utf8').trim()
if (!existsSync(SAMPLE)) {
  console.error(`找不到克隆样本：${SAMPLE}`)
  console.error('先跑 node scripts/prepare-clone-audio.mjs')
  process.exit(1)
}
const sampleDataUrl = `data:audio/wav;base64,${readFileSync(SAMPLE).toString('base64')}`
console.log(`克隆样本：${basename(SAMPLE)}（${(readFileSync(SAMPLE).length / 1024 / 1024).toFixed(2)} MB）\n`)

// ---------------------------------------------------------------- MiMo

async function mimoSpeak(text) {
  const t0 = Date.now()
  const res = await fetch('https://token-plan-cn.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mimoKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MIMO_MODEL,
      // 官方要求：文本放 assistant，指令放 user
      messages: [{ role: 'user', content: '' }, { role: 'assistant', content: text }],
      audio: { format: 'wav', voice: sampleDataUrl },
    }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 150)}`)
  const j = JSON.parse(raw)
  const b64 = j.choices?.[0]?.message?.audio?.data
  if (!b64) throw new Error('返回里没有音频')
  return { buf: Buffer.from(b64, 'base64'), ms: Date.now() - t0 }
}

// ---------------------------------------------------------------- MiniMax

async function mmSpeak(text) {
  const t0 = Date.now()
  const res = await fetch('https://api.minimaxi.com/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mmKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MM_MODEL,
      text,
      stream: false,
      voice_setting: { voice_id: MM_VOICE, speed: 1.0, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'wav', channel: 1 },
    }),
  })
  const j = await res.json()
  if (j.base_resp?.status_code !== 0) throw new Error(`${j.base_resp?.status_code} ${j.base_resp?.status_msg}`)
  return { buf: Buffer.from(j.data.audio, 'hex'), ms: Date.now() - t0, billed: j.extra_info?.usage_characters }
}

// ---------------------------------------------------------------- 跑

mkdirSync(WAV, { recursive: true })

const rows = []
for (const [i, L] of LINES.entries()) {
  const row = { ...L, i }
  for (const [key, fn] of [['mimo', mimoSpeak], ['mm', mmSpeak]]) {
    try {
      const r = await fn(L.t)
      row[`${key}File`] = join(WAV, `${key}-${i}.wav`)
      writeFileSync(row[`${key}File`], r.buf)
      row[`${key}Ms`] = r.ms
      row[`${key}Billed`] = r.billed ?? null
    } catch (e) {
      row[`${key}Err`] = e.message
    }
  }
  const stat = (f) => {
    if (!f) return null
    const a = readWav(f)
    const s = summarize(pitchTrack(a))
    const vs = voicedSeconds(a)
    const chars = L.t.replace(/[\s，。！？、…—「」（）【】·~～!?.,:;]/g, '').length
    return { sec: +(a.data.length / a.sr).toFixed(2), rms: +rms(a).toFixed(4), rate: vs > 0.2 ? +(chars / vs).toFixed(2) : null, f0: s?.mean ?? null, range: s?.range ?? null }
  }
  row.mimo = stat(row.mimoFile)
  row.mm = stat(row.mmFile)

  console.log(`[${L.cat}]「${L.t}」`)
  console.log(`   MiMo   ${row.mimo ? `${row.mimo.sec}s ${row.mimo.rate ?? '—'}字/秒 F0=${row.mimo.f0?.toFixed(1) ?? '—'} 音域=${row.mimo.range?.toFixed(1) ?? '—'}` : '失败 ' + row.mimoErr}  ${row.mimoMs ?? '—'}ms`)
  console.log(`   MiniMax ${row.mm ? `${row.mm.sec}s ${row.mm.rate ?? '—'}字/秒 F0=${row.mm.f0?.toFixed(1) ?? '—'} 音域=${row.mm.range?.toFixed(1) ?? '—'}` : '失败 ' + row.mmErr}  ${row.mmMs ?? '—'}ms\n`)
  rows.push(row)
}

// ---------------------------------------------------------------- 页面

const rel = (f) => `wav/${f.split(/[\\/]/).pop()}`
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const cell = (r, k, label) => {
  const v = r[k]
  const err = r[`${k}Err`]
  if (err) return `<td class="fail">失败：${esc(err)}</td>`
  return `<td><audio controls preload="none" src="${rel(r[`${k}File`])}"></audio>
    <div class="num">${v ? `${v.sec}s · ${v.rate ?? '—'} 字/秒 · F0 ${v.f0?.toFixed(1) ?? '—'} · 音域 ${v.range?.toFixed(1) ?? '—'} · 合成 ${r[`${k}Ms`] ?? '—'}ms` : ''}</div></td>`
}

const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>小米 MiMo vs MiniMax 声音克隆</title>
<style>
 body{background:#141419;color:#e6e6ee;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:1080px;margin:0 auto;padding:28px}
 h1{font-size:19px;margin:0 0 6px}
 .meta{color:#8f93a8;font-size:12.5px;margin-bottom:20px}
 .meta code{background:#22222c;padding:1px 5px;border-radius:4px}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #2c2c36;padding:9px 11px;vertical-align:top;text-align:left}
 th{background:#1e1e24;font-weight:400;color:#a9adc0;font-size:12.5px}
 .line{color:#cfd3e6}
 .cat{color:#7f8bb5;font-size:12px}
 audio{width:100%;height:34px;margin-top:5px}
 .num{font-size:11.5px;color:#8f93a8;font-variant-numeric:tabular-nums}
 .fail{color:#ff9a9a}
 .hint{color:#8f93a8;font-size:12.5px;margin-top:20px;border-left:2px solid #34344a;padding-left:12px}
</style>
<h1>小米 MiMo &nbsp;vs&nbsp; MiniMax &nbsp;—&nbsp; 声音克隆对比</h1>
<div class="meta">
 两边用<b>同一份克隆样本</b>：<code>${esc(basename(SAMPLE))}</code>（5 条温柔参考拼成的 33.3 秒）<br>
 左：<code>${esc(MIMO_MODEL)}</code>（限时免费） · 右：<code>${esc(MM_MODEL)}</code>（¥2.0/万字符）
</div>
<table>
<tr><th style="width:26%">句子</th><th style="width:37%">小米 MiMo</th><th style="width:37%">MiniMax</th></tr>
${rows.map((r) => `<tr><td class="line">${esc(r.t)}<div class="cat">[${esc(r.cat)}]</div></td>${cell(r, 'mimo')}${cell(r, 'mm')}</tr>`).join('\n')}
</table>
<div class="hint">
 听的时候留意三件事：<br>
 ① <b>音色像不像</b> —— 两边用同一份素材，听哪边更接近芙宁娜<br>
 ② <b>调子对不对</b> —— 她是大明星，句子该有起伏和舞台感；太平就是丢了魂<br>
 ③ <b>稳不稳</b> —— 换句子时音色会不会飘（F0 和音域那两列差得多就说明飘）
</div>
</html>`

const page = join(OUT, 'index.html')
writeFileSync(page, html)
console.log(`✅ 试听页：${page}`)
