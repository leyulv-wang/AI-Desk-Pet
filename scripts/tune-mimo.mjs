/**
 * 给 MiMo 克隆音色调参 —— 拿「音域」当客观指标
 *   node scripts/tune-mimo.mjs
 *   node scripts/tune-mimo.mjs --lines=2
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么是「音域」这个指标
 * ────────────────────────────────────────────────────────────────────
 * 用户听完两家的对比说「MiniMax 更像」，翻数据发现**音域**是两家最大的客观差异：
 *   MiniMax 音域平均 7.68 半音
 *   MiMo     音域平均 5.46 半音
 * 音域（p90-p10 的基频跨度）量的是**语调起伏**。芙宁娜是大明星、舞台腔、爱演，
 * 起伏小就是「平」—— 用户说的「没有那种爱演的劲」大概率就是这个。
 *
 * 所以这个脚本的任务很明确：**把 MiMo 的音域推上去，别推得太离谱。**
 *
 * ────────────────────────────────────────────────────────────────────
 * MiMo 有三套调法（MiniMax 只有一个粗粒度 emotion，这是 MiMo 的优势）
 * ────────────────────────────────────────────────────────────────────
 *   ① `(风格)` 标签 —— 放在 assistant 消息的**文本开头**
 *      官方列出：温柔/高冷/活泼/严肃/慵懒/俏皮/深沉/干练/凌厉 + 情绪 + 音色 + 口音
 *      文档明说「也支持使用未在列表中的自定义风格」，所以舞台腔这类可以试
 *   ② `[音频标签]` —— 放在文本**任意位置**，细粒度（[叹气][轻笑][颤抖]…）
 *   ③ 自然语言指令 —— 放在 user 消息里，像给演员说戏
 *      还有更精细的**导演模式**：角色 / 场景 / 指导 三段式
 *
 * 现在 MiMo 三个 TTS 模型**限时免费**，所以可以放开跑。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav, rms, voicedSeconds, pitchTrack, summarize } from './lib/wav-prosody.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`))
  return a ? a.split('=')[1] : d
}
const SAMPLE = join(ROOT, arg('sample', '.userdata/clone-source.wav'))
const MODEL = arg('model', 'mimo-v2.5-tts-voiceclone')
const OUT = join(ROOT, '.userdata-dev', 'tune-mimo')
const WAV = join(OUT, 'wav')
const N_LINES = Number(arg('lines', 2))

const LINES = [
  { cat: '得意', t: '哼，这种程度的问题我一眼就看穿了。' },
  { cat: '无奈', t: '好吧好吧，那就听你的。' },
].slice(0, N_LINES)

/** 音域目标区间：MiniMax 实测 6.0~9.0，均值 7.68。低于 5 就是「平」 */
const TARGET_RANGE = [6.5, 9.5]

/**
 * 要试的配置组合。
 *
 * `tag` 会包在文本开头（官方格式：`(风格)文本`），
 * `inst` 走 user 消息（自然语言指令），
 * `prefix` 是直接插在文本里的句中音频标签。
 */
const CONFIGS = [
  { id: '00-baseline', tag: '', inst: '', note: '基线（什么都不给）' },
  { id: '01-tag-qiao', tag: '俏皮', inst: '', note: '(俏皮)' },
  { id: '02-tag-huopo', tag: '活泼', inst: '', note: '(活泼)' },
  { id: '03-tag-lingli', tag: '凌厉', inst: '', note: '(凌厉)' },
  { id: '04-tag-wutai', tag: '舞台腔', inst: '', note: '(舞台腔) —— 自定义风格，官方说支持' },
  { id: '05-tag-shenqiang', tag: '深沉', inst: '', note: '(深沉)' },
  { id: '06-inst-yyy', tag: '', inst: '语调起伏大一些，抑扬顿挫，句尾要有收势。', note: '指令：起伏大 + 抑扬顿挫' },
  { id: '07-inst-wutai', tag: '', inst: '像在舞台上念白：高傲、戏剧化、爱演。语调起伏要大，抑扬顿挫，句尾微微上扬，带着一点得意的腔调。', note: '指令：舞台念白' },
  {
    id: '08-inst-daoxian',
    tag: '',
    inst: [
      '角色：枫丹的大明星，骄傲、戏剧化、爱面子，说话像在念白，偶尔嘴硬心软。',
      '场景：和熟悉的人闲聊，心情不错，想显摆两句。',
      '指导：',
      '- 语速与顿挫：语速稍慢，句中要有明显的抑扬顿挫，重音落在关键的字上。',
      '- 声调与韵律：语调起伏要大，开头起势、中间推进、句尾收势或上扬。',
      '- 气息：句首可以带一点吸气，句尾微微拖长。',
    ].join('\n'),
    note: '导演模式（角色/场景/指导）',
  },
  { id: '09-both', tag: '俏皮', inst: '像在舞台上念白，语调起伏大，抑扬顿挫，带着得意的腔调。', note: '(俏皮) + 指令' },
  { id: '10-tag-jingya', tag: '惊讶', inst: '', note: '(惊讶) —— 看看情绪标签的幅度' },
]

// ---------------------------------------------------------------- 凭据

const KEY = readFileSync(join(ROOT, '.userdata', 'mimo.key'), 'utf8').trim()
if (!existsSync(SAMPLE)) {
  console.error(`找不到克隆样本：${SAMPLE}`)
  process.exit(1)
}
const sampleDataUrl = `data:audio/wav;base64,${readFileSync(SAMPLE).toString('base64')}`

// ---------------------------------------------------------------- 合成

async function speak(text, { tag, inst }) {
  const body = {
    model: MODEL,
    // user 放指令，assistant 放要念的文本 —— 官方要求的排布
    messages: [{ role: 'user', content: inst || '' }, { role: 'assistant', content: tag ? `(${tag})${text}` : text }],
    audio: { format: 'wav', voice: sampleDataUrl },
  }
  const t0 = Date.now()
  const res = await fetch('https://token-plan-cn.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${raw.slice(0, 120)}`)
  const j = JSON.parse(raw)
  const b64 = j.choices?.[0]?.message?.audio?.data
  if (!b64) throw new Error('返回里没有音频')
  return { buf: Buffer.from(b64, 'base64'), ms: Date.now() - t0 }
}

// ---------------------------------------------------------------- 跑

mkdirSync(WAV, { recursive: true })
console.log(`克隆样本 ${basename(SAMPLE)} · 模型 ${MODEL} · ${LINES.length} 句 × ${CONFIGS.length} 种配置\n`)
console.log('  配置                          句子              F0     音域    语速     延迟')
console.log('  ' + '-'.repeat(78))

const results = []
for (const cfg of CONFIGS) {
  for (const [li, L] of LINES.entries()) {
    let r = { cfg: cfg.id, note: cfg.note, cat: L.cat, text: L.t, lineIdx: li }
    try {
      const s = await speak(L.t, cfg)
      r.file = join(WAV, `${cfg.id}-L${li}.wav`)
      writeFileSync(r.file, s.buf)
      r.ms = s.ms
      const a = readWav(r.file)
      const st = summarize(pitchTrack(a))
      const vs = voicedSeconds(a)
      const chars = L.t.replace(/[\s，。！？、…—「」（）【】·~～!?.,:;]/g, '').length
      r.sec = +(a.data.length / a.sr).toFixed(2)
      r.f0 = st?.mean ?? null
      r.range = st?.range ?? null
      r.rate = vs > 0.2 ? +(chars / vs).toFixed(2) : null
    } catch (e) {
      r.err = e.message
    }
    results.push(r)
    const flag = r.range != null && r.range >= TARGET_RANGE[0] && r.range <= TARGET_RANGE[1] ? '★' : r.range < TARGET_RANGE[0] ? '△' : ' '
    console.log(
      `  ${cfg.id.padEnd(28)} ${`L${li}[${L.cat}]`.padEnd(17)} ${(r.f0 ?? NaN).toFixed(1).padStart(5)} ${(r.range ?? NaN).toFixed(1).padStart(6)}${flag} ${String(r.rate ?? '—').padStart(5)}  ${String(r.ms ?? '—').padStart(5)}ms`
    )
  }
}

// ---------------------------------------------------------------- 按配置汇总

const byCfg = new Map()
for (const r of results) {
  if (!byCfg.has(r.cfg)) byCfg.set(r.cfg, { note: r.note, ranges: [], f0s: [], ms: [], rows: [] })
  const g = byCfg.get(r.cfg)
  if (r.range != null) g.ranges.push(r.range)
  if (r.f0 != null) g.f0s.push(r.f0)
  if (r.ms != null) g.ms.push(r.ms)
  g.rows.push(r)
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)

console.log(`\n=== 按配置汇总（按音域均值排序，目标 ${TARGET_RANGE[0]}~${TARGET_RANGE[1]} 半音）===\n`)
const sorted = [...byCfg.entries()].sort((x, y) => avg(y[1].ranges) - avg(x[1].ranges))
console.log('  配置                          音域均值   音域范围    F0     延迟')
for (const [id, g] of sorted) {
  const r = avg(g.ranges)
  const flag = r >= TARGET_RANGE[0] && r <= TARGET_RANGE[1] ? ' ★' : r < TARGET_RANGE[0] ? ' △偏平' : ' !'
  console.log(
    `  ${id.padEnd(28)} ${r.toFixed(2).padStart(6)}${flag}  ${Math.min(...g.ranges).toFixed(1)}~${Math.max(...g.ranges).toFixed(1).padEnd(6)} ${avg(g.f0s).toFixed(1).padStart(6)} ${avg(g.ms).toFixed(0).padStart(5)}ms`
  )
}

// ---------------------------------------------------------------- 页面

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const rel = (f) => `wav/${f.split(/[\\/]/).pop()}`

const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>MiMo 调参 —— 语调起伏</title>
<style>
 body{background:#141419;color:#e6e6ee;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:1180px;margin:0 auto;padding:28px}
 h1{font-size:19px;margin:0 0 6px}
 .meta{color:#8f93a8;font-size:12.5px;margin-bottom:18px}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #2c2c36;padding:8px 10px;vertical-align:top;text-align:left}
 th{background:#1e1e24;font-weight:400;color:#a9adc0;font-size:12.5px}
 .cfg{color:#9fd8ff;font-family:ui-monospace,Consolas,monospace;font-size:12px}
 .note{color:#8f93a8;font-size:11.5px}
 .line{color:#cfd3e6}
 .cat{color:#7f8bb5;font-size:11.5px}
 audio{width:100%;height:32px;margin-top:4px}
 .num{font-size:11px;color:#8f93a8;font-variant-numeric:tabular-nums}
 .good{color:#7fd8a0}
 .flat{color:#ffce7a}
 .fail{color:#ff9a9a}
 .hint{color:#8f93a8;font-size:12.5px;margin-top:20px;border-left:2px solid #34344a;padding-left:12px}
</style>
<h1>MiMo 克隆音色调参</h1>
<div class="meta">
 目标：<b>把「音域」（语调起伏）推到 ${TARGET_RANGE[0]}~${TARGET_RANGE[1]} 半音</b> ——
 MiniMax 实测均值 7.68，MiMo 基线只有 5.46，差距就出在这。<br>
 ★ = 落在目标区间 &nbsp; △ = 偏平 &nbsp; ! = 过头
</div>
<table>
<tr><th style="width:20%">配置</th><th style="width:18%">句子</th><th style="width:62%">试听</th></tr>
${sorted
  .map(
    ([id, g]) => g.rows
      .map((r, i) => {
        const cell = r.err
          ? `<td class="fail">失败：${esc(r.err)}</td>`
          : `<td><audio controls preload="none" src="${rel(r.file)}"></audio>
              <div class="num">音域 <b>${r.range?.toFixed(1) ?? '—'}</b> · F0 ${r.f0?.toFixed(1) ?? '—'} · ${r.rate ?? '—'} 字/秒 · ${r.sec}s · ${r.ms}ms</div></td>`
        const label = i === 0 ? `<td rowspan="${g.rows.length}"><div class="cfg">${esc(id)}</div><div class="note">${esc(g.note)}</div></td>` : ''
        return `<tr>${label}<td class="line">${esc(r.text.slice(0, 14))}…<div class="cat">[${esc(r.cat)}]</div></td>${cell}</tr>`
      })
      .join('')
  )
  .join('')}
</table>
<div class="hint">
 音域是<b>语调起伏</b>的量化（基频 p90-p10 的跨度，单位半音）。<br>
 芙宁娜是大明星、舞台腔、爱演 —— 起伏太小听起来就是「平」，那就是「丢了魂」。<br>
 但也不是越大越好：超过 10 半音会听起来一惊一乍、不自然。<br>
 所以目标区间定在 <b>${TARGET_RANGE[0]}~${TARGET_RANGE[1]}</b>，正好贴着 MiniMax 的实测范围（6.0~9.0）。
</div>
</html>`

writeFileSync(join(OUT, 'index.html'), html)
console.log(`\n✅ 试听页：${join(OUT, 'index.html')}`)
