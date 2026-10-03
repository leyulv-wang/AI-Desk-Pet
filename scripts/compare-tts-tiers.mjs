/**
 * 语音档位对比：MiniMax HD / MiniMax Turbo / 本地 GPT-SoVITS
 *   node scripts/compare-tts-tiers.mjs
 *   node scripts/compare-tts-tiers.mjs --models=speech-2.8-hd,speech-2.8-turbo --no-local
 *
 * 为什么要比这个：
 *   HD 是 ¥3.50/万字符，Turbo 是 ¥2.00/万字符 —— **差 43%**。
 *   对桌面宠物这种「一天几十句闲聊」的场景，差价是实打实的月度开销。
 *   但便宜的前提是「听起来没差」，这个只能靠耳朵，所以先把两边摆一起。
 *
 * 计费口径（官方）：**1 个汉字算 2 个字符**，标点/字母/空格各算 1 个。
 *   所以一句 60 汉字的回复 ≈ 125 计费字符 —— 算钱时别按字数算，会差一倍。
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
const MODELS = arg('models', 'speech-2.8-hd,speech-2.8-turbo').split(',').map((s) => s.trim()).filter(Boolean)
const WANT_LOCAL = !process.argv.includes('--no-local')
const VOICE = arg('voice', 'furinaCloneVoiceV1')
const REF = arg('ref', '7cd3e85678f2c4ef')

/** 官方单价（元/万字符），用于算账 */
const PRICE = { 'speech-2.8-hd': 3.5, 'speech-2.8-turbo': 2.0, 'speech-2.6-hd': 3.5, 'speech-2.6-turbo': 2.0, 'speech-02-hd': 3.5, 'speech-02-turbo': 2.0 }

const OUT = join(ROOT, '.userdata-dev', 'compare-tiers')
const WAV = join(OUT, 'wav')

const LINES = [
  { cat: '平静', t: '嗯，我在听，你说吧。' },
  { cat: '得意', t: '哼，这种程度的问题我一眼就看穿了。' },
  { cat: '温柔', t: '累了吧？先坐下歇一会儿，我陪你。' },
  { cat: '无奈', t: '好吧好吧，那就听你的。' },
]

const KEY = readFileSync(join(ROOT, '.userdata', 'minimax.key'), 'utf8').trim()

/** 官方计费字符数：汉字 ×2，其余 ×1 */
const billable = (t) => [...t].reduce((n, c) => n + (/[\u4e00-\u9fff]/.test(c) ? 2 : 1), 0)

async function mmSpeak(text, model) {
  const t0 = Date.now()
  const res = await fetch('https://api.minimaxi.com/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      text,
      stream: false,
      voice_setting: { voice_id: VOICE, speed: 1.0, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'wav', channel: 1 },
    }),
  })
  const j = await res.json()
  if (j.base_resp?.status_code !== 0) throw new Error(`${j.base_resp?.status_code} ${j.base_resp?.status_msg}`)
  const hex = j.data?.audio
  if (!hex) throw new Error('没有音频')
  return { buf: Buffer.from(hex, 'hex'), ms: Date.now() - t0, billed: j.extra_info?.usage_characters ?? billable(text) }
}

// ---------------------------------------------------------------- 跑

mkdirSync(WAV, { recursive: true })

const cols = MODELS.map((m) => ({ key: m, label: `MiniMax ${m.replace('speech-', '')}`, price: PRICE[m] ?? null, kind: 'mm' }))
if (WANT_LOCAL) cols.push({ key: 'local', label: '本地 GPT-SoVITS', price: 0, kind: 'local' })

let tts = null
if (WANT_LOCAL) {
  tts = createTts({
    config: { enabled: true, backend: 'gptsovits', referenceMode: 'fixed', fixedRef: REF, cache: { enabled: false } },
    root: ROOT,
    cacheDir: join(OUT, 'gs-cache'),
    log: () => {},
    resolveKey: () => null,
  })
  const p = await tts.probe()
  if (!p.ok) {
    console.log(`⚠️ 本地不可用（${p.detail}），跳过本地那一列\n`)
    cols.pop()
  }
}

console.log(`音色 ${VOICE} · 句子 ${LINES.length} 条 · 档位 ${cols.map((c) => c.label).join(' / ')}\n`)

const rows = []
for (const [i, L] of LINES.entries()) {
  const row = { ...L, cells: {} }
  const bill = billable(L.t)
  row.bill = bill

  for (const c of cols) {
    try {
      let file
      let ms
      if (c.kind === 'mm') {
        const r = await mmSpeak(L.t, c.key)
        file = join(WAV, `${c.key}-${i}.wav`)
        writeFileSync(file, r.buf)
        ms = r.ms
      } else {
        const r = await tts.speak({ text: L.t, category: L.cat, noCache: true })
        if (!r.ok) throw new Error(r.error)
        file = join(WAV, `local-${i}.wav`)
        copyFileSync(r.file, file) // tts.js 写的是哈希文件名，复制成可预测的名字
        ms = r.ms
      }
      const a = readWav(file)
      const s = summarize(pitchTrack(a))
      const vs = voicedSeconds(a)
      row.cells[c.key] = {
        file,
        ms,
        sec: +(a.data.length / a.sr).toFixed(2),
        rate: vs > 0.2 ? +(bill / 2 / vs).toFixed(2) : null, // 用「汉字数/有声秒」才是可比语速
        f0: s?.mean ?? null,
        rms: +rms(a).toFixed(4),
      }
    } catch (e) {
      row.cells[c.key] = { err: e.message }
    }
  }

  console.log(`[${L.cat}]「${L.t}」（计费 ${bill} 字符）`)
  for (const c of cols) {
    const v = row.cells[c.key]
    console.log(
      v?.err
        ? `   ${c.label.padEnd(22)} ❌ ${v.err}`
        : `   ${c.label.padEnd(22)} ${v.sec}s ${v.rate ?? '—'}字/秒 F0=${v.f0?.toFixed(1) ?? '—'}  ${v.ms}ms`
    )
  }
  console.log('')
  rows.push(row)
}

// ---------------------------------------------------------------- 算账

console.log('=== 月度开销估算 ===\n')
console.log('  假设：一句回复 60 汉字（人设上限），计费约 125 字符\n')
console.log('  每天轮数     每月计费字符     ' + cols.map((c) => c.label.padEnd(16)).join(''))
for (const perDay of [10, 30, 50]) {
  const monthly = perDay * 125 * 30
  const cells = cols.map((c) => {
    if (c.price == null || c.price === 0) return '免费（占显存）'.padEnd(16)
    return `¥${((monthly / 10000) * c.price).toFixed(1)}`.padEnd(16)
  })
  console.log(`  ${String(perDay).padEnd(12)} ${String(monthly).padEnd(15)} ${cells.join('')}`)
}
console.log('\n  注：磁盘缓存会挡掉重复句，实际比这个低一些；但每轮回复可能拆成多句，')
console.log('      字符总数不变，所以拆分不影响费用。')

// ---------------------------------------------------------------- 页面

const rel = (f) => `wav/${f.split(/[\\/]/).pop()}`
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>语音档位对比</title>
<style>
 body{background:#141419;color:#e6e6ee;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:1200px;margin:0 auto;padding:28px}
 h1{font-size:19px;margin:0 0 6px}
 .meta{color:#8f93a8;font-size:12.5px;margin-bottom:20px}
 .meta code{background:#22222c;padding:1px 5px;border-radius:4px}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #2c2c36;padding:9px 11px;vertical-align:top;text-align:left}
 th{background:#1e1e24;font-weight:400;color:#a9adc0;font-size:12.5px}
 .price{color:#7fd8a0;font-size:11.5px}
 .line{color:#cfd3e6}
 .cat{color:#7f8bb5;font-size:12px}
 audio{width:100%;height:34px;margin-top:5px}
 .num{font-size:11.5px;color:#8f93a8;font-variant-numeric:tabular-nums}
 .fail{color:#ff9a9a}
 .cost{margin-top:22px;border:1px solid #2c2c36;border-radius:8px;padding:14px 18px;background:#191920}
 .cost table{width:auto}
 .cost th,.cost td{padding:6px 14px;font-variant-numeric:tabular-nums}
</style>
<h1>语音档位对比</h1>
<div class="meta">
 音色 <code>${esc(VOICE)}</code>（MiniMax 克隆）· 本地参考 <code>${esc(REF)}</code><br>
 计费口径：<b>1 个汉字算 2 个字符</b>，标点/字母/空格各算 1 个 —— 所以一句 60 字的回复约 125 计费字符
</div>
<table>
<tr><th style="width:26%">句子</th>${cols.map((c) => `<th>${esc(c.label)}${c.price ? `<div class="price">¥${c.price}/万字符</div>` : '<div class="price">免费 · 占 2.9G 显存</div>'}</th>`).join('')}</tr>
${rows
  .map((r) => {
    const cells = cols
      .map((c) => {
        const v = r.cells[c.key]
        if (!v) return '<td></td>'
        if (v.err) return `<td class="fail">失败：${esc(v.err)}</td>`
        return `<td><audio controls preload="none" src="${rel(v.file)}"></audio>
          <div class="num">${v.sec}s · ${v.rate ?? '—'} 字/秒 · F0 ${v.f0?.toFixed(1) ?? '—'} · 合成 ${v.ms}ms</div></td>`
      })
      .join('')
    return `<tr><td class="line">${esc(r.t)}<div class="cat">[${esc(r.cat)}] · 计费 ${r.bill} 字符</div></td>${cells}</tr>`
  })
  .join('\n')}
</table>
<div class="cost">
<b>月度开销估算</b>（按一句回复 60 汉字 ≈ 125 计费字符）
<table>
<tr><th>每天轮数</th><th>每月计费字符</th>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>
${[10, 30, 50]
  .map((perDay) => {
    const monthly = perDay * 125 * 30
    const cells = cols
      .map((c) => `<td>${c.price ? `¥${((monthly / 10000) * c.price).toFixed(1)}` : '免费'}</td>`)
      .join('')
    return `<tr><td>${perDay}</td><td>${monthly.toLocaleString()}</td>${cells}</tr>`
  })
  .join('')}
</table>
<div class="num" style="margin-top:10px">
 资源包（¥630 / 200 万字符 / <b>1 个月有效</b>）对个人不划算 ——
 中度使用一个月才 11 万字符，2 百万字符的有效期只有一个月，会用掉不到 6%。
</div>
</div>
</html>`

writeFileSync(join(OUT, 'index.html'), html)
console.log(`\n✅ 试听页：${join(OUT, 'index.html')}`)
