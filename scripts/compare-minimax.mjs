/**
 * MiniMax 克隆音色 vs 本地 GPT-SoVITS —— 并排试听
 *   node scripts/compare-minimax.mjs
 *   node scripts/compare-minimax.mjs --voice=furinaCloneVoiceV1 --ref=7cd3e85678f2c4ef
 *
 * 干什么：
 *   同一批句子，两边各合成一遍，生成一个并排的试听页 + 客观指标。
 *
 * 为什么要生成页面而不是直接下结论：
 *   「像不像」这件事**只能靠耳朵**。基频、语速这些指标能量出「稳不稳」，
 *   但量不出「像不像本人」—— 那是主观判断，得你来听。
 *   所以这个脚本只负责把两边摆在一起，尽量消除其它变量（同一句话、同一采样率）。
 *
 * 前提：
 *   · MiniMax 的 key 在 .userdata/minimax.key（已克隆出 voice_id）
 *   · 本地 GPT-SoVITS 服务在跑（npm run voice）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
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
const VOICE = arg('voice', 'furinaCloneVoiceV1')
const REF = arg('ref', '7cd3e85678f2c4ef')
const MM_MODEL = arg('model', 'speech-02-hd')

const OUT = join(ROOT, '.userdata-dev', 'compare-minimax')
const WAV = join(OUT, 'wav')

/** 和 scripts/compare-refs.mjs 用同一批句子 —— 换对比方式时结论还能对上 */
const LINES = [
  { cat: '平静', t: '嗯，我在听，你说吧。' },
  { cat: '平静', t: '今天天气还不错，要不要出去走走？' },
  { cat: '开心', t: '太好了，你终于回来啦！' },
  { cat: '得意', t: '哼，这种程度的问题我一眼就看穿了。' },
  { cat: '无奈', t: '好吧好吧，那就听你的。' },
  { cat: '温柔', t: '累了吧？先坐下歇一会儿，我陪你。' },
]

// ---------------------------------------------------------------- MiniMax

const keyFile = join(ROOT, '.userdata', 'minimax.key')
if (!existsSync(keyFile)) {
  console.error(`没有 ${keyFile} —— 把 MiniMax 的 key 放进去（.userdata/ 不入库）`)
  process.exit(1)
}
const KEY = readFileSync(keyFile, 'utf8').trim()
const MM_BASE = 'https://api.minimaxi.com/v1'

async function mmSpeak(text) {
  const t0 = Date.now()
  const res = await fetch(`${MM_BASE}/t2a_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MM_MODEL,
      text,
      stream: false,
      voice_setting: { voice_id: VOICE, speed: 1.0, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'wav', channel: 1 },
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  if (j.base_resp?.status_code !== 0) throw new Error(`${j.base_resp?.status_code} ${j.base_resp?.status_msg}`)
  const ms = Date.now() - t0
  const hex = j.data?.audio || ''
  if (!hex) throw new Error('返回里没有音频')
  return { buf: Buffer.from(hex, 'hex'), ms, chars: j.extra_info?.usage_characters ?? null }
}

// ---------------------------------------------------------------- GPT-SoVITS

const tts = createTts({
  config: {
    enabled: true,
    backend: 'gptsovits',
    referenceMode: 'fixed',
    fixedRef: REF,
    trimSilence: true,
    normalizeLoudness: true,
    cache: { enabled: false },
  },
  root: ROOT,
  cacheDir: join(OUT, 'gs-cache'),
  log: () => {},
  resolveKey: () => null,
})

// ---------------------------------------------------------------- 跑

mkdirSync(WAV, { recursive: true })

const probe = await tts.probe()
if (!probe.ok) {
  console.error(`\n本地 GPT-SoVITS 不可用：${probe.detail}`)
  console.error('先跑 npm run voice 把服务起起来')
  process.exit(1)
}

console.log(`MiniMax  模型=${MM_MODEL}  音色=${VOICE}`)
console.log(`本地     参考=${REF.slice(0, 8)}（fixed）`)
console.log(`句子 ${LINES.length} 条\n`)

const rows = []
for (const [i, L] of LINES.entries()) {
  const row = { ...L, i }

  try {
    const mm = await mmSpeak(L.t)
    row.mmFile = join(WAV, `mm-${i}.wav`)
    writeFileSync(row.mmFile, mm.buf)
    row.mmMs = mm.ms
  } catch (e) {
    row.mmErr = e.message
  }

  try {
    const gs = await tts.speak({ text: L.t, category: L.cat, noCache: true })
    if (gs.ok) {
      // 必须**复制**到 wav/ 下统一命名。
      // tts.js 把结果写在自己的 cacheDir 里，文件名是内容哈希（比如 97c74f29….wav），
      // 而页面按 `wav/gs-<i>.wav` 引用 —— 不复制的话右半边播放器全是死的（踩过）。
      row.gsFile = join(WAV, `gs-${i}.wav`)
      copyFileSync(gs.file, row.gsFile)
      row.gsMs = gs.ms
    } else {
      row.gsErr = gs.error
    }
  } catch (e) {
    row.gsErr = e.message
  }

  // 客观指标：时长 / 有声占比 / 语速 / 音高
  const stat = (f) => {
    if (!f || !existsSync(f)) return null
    try {
      const a = readWav(f)
      const vs = voicedSeconds(a)
      const s = summarize(pitchTrack(a))
      const chars = L.t.replace(/[\s，。！？、…—「」（）【】·~～!?.,:;]/g, '').length
      return {
        sec: +(a.data.length / a.sr).toFixed(2),
        rms: +rms(a).toFixed(4),
        rate: vs > 0.2 ? +(chars / vs).toFixed(2) : null,
        f0: s ? s.mean : null,
        range: s ? s.range : null,
      }
    } catch {
      return null
    }
  }
  row.mm = stat(row.mmFile)
  row.gs = stat(row.gsFile)

  const fmt = (s) => (s ? `${s.sec}s ${s.rate ?? '—'}字/秒 F0=${s.f0?.toFixed(1) ?? '—'}` : '失败')
  console.log(`[${L.cat}]「${L.t}」`)
  console.log(`   MiniMax  ${fmt(row.mm)}  ${row.mmMs ?? '—'}ms`)
  console.log(`   本地     ${fmt(row.gs)}  ${row.gsMs ?? '—'}ms\n`)

  rows.push(row)
}

// ---------------------------------------------------------------- 页面

const rel = (f) => (f ? `wav/${f.split(/[\\/]/).pop()}` : '')
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>MiniMax 克隆音色 vs 本地 GPT-SoVITS</title>
<style>
 body{background:#141419;color:#e6e6ee;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:1080px;margin:0 auto;padding:28px}
 h1{font-size:19px;margin:0 0 6px}
 .meta{color:#8f93a8;font-size:12.5px;margin-bottom:22px}
 .meta code{background:#22222c;padding:1px 5px;border-radius:4px}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #2c2c36;padding:9px 11px;vertical-align:top;text-align:left}
 th{background:#1e1e24;font-weight:400;color:#a9adc0;font-size:12.5px}
 .line{color:#cfd3e6}
 .cat{color:#7f8bb5;font-size:12px}
 audio{width:100%;height:34px;margin-top:5px}
 .num{font-size:12px;color:#8f93a8;font-variant-numeric:tabular-nums}
 .fail{color:#ff9a9a}
 .hint{color:#8f93a8;font-size:12.5px;margin-top:20px;border-left:2px solid #34344a;padding-left:12px}
</style>
<h1>MiniMax 克隆音色 &nbsp;vs&nbsp; 本地 GPT-SoVITS</h1>
<div class="meta">
 MiniMax：<code>${esc(MM_MODEL)}</code> · 克隆音色 <code>${esc(VOICE)}</code>（源音频 33.3 秒，5 条温柔参考拼成）<br>
 本地：GPT-SoVITS v4 · 固定参考 <code>${esc(REF)}</code>（温柔，6.16 秒）
</div>
<table>
<tr><th style="width:30%">句子</th><th style="width:35%">MiniMax（云端克隆）</th><th style="width:35%">本地 GPT-SoVITS</th></tr>
${rows
  .map((r) => {
    const cell = (f, s, ms, err) =>
      err
        ? `<div class="fail">失败：${esc(err)}</div>`
        : `<audio controls preload="none" src="${rel(f)}"></audio>
           <div class="num">${s ? `${s.sec}s · ${s.rate ?? '—'} 字/秒 · F0 ${s.f0?.toFixed(1) ?? '—'} · 音域 ${s.range?.toFixed(1) ?? '—'}` : ''} · 合成 ${ms ?? '—'}ms</div>`
    return `<tr>
      <td class="line">${esc(r.t)}<div class="cat">[${esc(r.cat)}]</div></td>
      <td>${cell(r.mmFile, r.mm, r.mmMs, r.mmErr)}</td>
      <td>${cell(r.gsFile, r.gs, r.gsMs, r.gsErr)}</td>
    </tr>`
  })
  .join('\n')}
</table>
<div class="hint">
 听的时候可以留意三件事：<br>
 ① <b>音色像不像</b> —— 这个只有你能判断，指标量不出来<br>
 ② <b>调子对不对</b> —— 她是大明星，句子该有起伏和舞台感；太平就是丢了魂<br>
 ③ <b>稳不稳</b> —— 换句子时音色会不会飘（F0 那一列差得多就说明飘）
</div>
</html>`

const page = join(OUT, 'index.html')
writeFileSync(page, html)
console.log(`✅ 试听页：${page}`)
console.log(`   直接打开就能听（音频在 ${WAV}）`)
