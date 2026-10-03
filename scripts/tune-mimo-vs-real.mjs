/**
 * 拿芙宁娜真实语音当靶子，扫一遍 MiMo 的配置
 *   node scripts/tune-mimo-vs-real.mjs
 *   node scripts/tune-mimo-vs-real.mjs --sample-per=120 --clips=3
 *
 * ────────────────────────────────────────────────────────────────────
 * 为什么换这个思路
 * ────────────────────────────────────────────────────────────────────
 * 上一轮我拿「音域」当目标，但目标区间（6.5~9.5）是我**拍脑袋定的**。
 * 而本机就躺着 **1139 条芙宁娜真实语音**——
 * 「她应该长什么样」的答案本来就有，不用猜。
 *
 * 这一轮改成：
 *   ① 从真实数据里量出**目标特征**（音高、音域、语速）
 *   ② 扫一圈配置（指令 / 风格标签）
 *   ③ 每个配置**和目标打分**，找最接近的
 *   ④ 页面上把**真实片段**和生成片段摆一起，直接对照着听
 *
 * 这就是「多参考」的正确用法：数据集不是拿去喂克隆的（克隆只需要几秒），
 * 是拿来做**标尺**的。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav, pitchTrack, summarize, voicedSeconds, rms } from './lib/wav-prosody.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`))
  return a ? a.split('=')[1] : d
}

const DATASET = arg('dataset', 'D:\\下载\\原神语音包\\Furina')
const SAMPLE = join(ROOT, arg('sample', '.userdata/clone-source.wav'))
const MODEL = arg('model', 'mimo-v2.5-tts-voiceclone')
const OUT = join(ROOT, '.userdata-dev', 'tune-vs-real')
const WAV = join(OUT, 'wav')
const PER_CFG = Number(arg('clips', 2)) // 每个配置合成几句
const SAMPLE_PER = Number(arg('sample-per', 120)) // 从真实数据里随机抽多少条量特征

const TEXTS = [
  { cat: '得意', t: '哼，这种程度的问题我一眼就看穿了。' },
  { cat: '温柔', t: '累了吧？先坐下歇一会儿，我陪你。' },
].slice(0, PER_CFG)

/** 要跟真实数据比的三个维度 */
const METRICS = [
  { key: 'f0', name: '音高', unit: '半音', weight: 1.0 },
  { key: 'range', name: '音域', unit: '半音', weight: 1.5 }, // 音域权重最大 —— 「平」就是它
  { key: 'rate', name: '语速', unit: '字/秒', weight: 1.0 },
]

// ================================================================ ① 真实目标

console.log('=== ① 从真实数据里量目标特征 ===\n')
if (!existsSync(DATASET)) {
  console.error(`找不到数据集：${DATASET}`)
  process.exit(1)
}
const allWav = readdirSync(DATASET).filter((f) => /\.wav$/i.test(f))
console.log(`  数据集：${DATASET}`)
console.log(`  共 ${allWav.length} 条 wav`)

// 均匀抽样（按文件名排序后每隔几个取一个，比随机更可复现）
const step = Math.max(1, Math.floor(allWav.length / SAMPLE_PER))
const picked = allWav.sort().filter((_, i) => i % step === 0).slice(0, SAMPLE_PER)

const real = []
for (const f of picked) {
  try {
    const a = readWav(join(DATASET, f))
    const st = summarize(pitchTrack(a))
    const vs = voicedSeconds(a)
    // 真实语音的字符数拿不到（没配 transcript），改用「有声秒」本身当节奏指标
    if (!st) continue
    // 只取可信的：音域为 NaN 的丢掉，音域 > 25 的是八度跳变误检，也丢掉
    if (!isFinite(st.range) || st.range > 25 || vs < 0.3) continue
    real.push({ f, f0: st.mean, range: st.range, sec: a.data.length / a.sr, vs })
  } catch {
    /* 单条坏了不影响整体 */
  }
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const TARGET = {
  f0: avg(real.map((r) => r.f0)),
  range: avg(real.map((r) => r.range)),
  // 真实语音没有字符数，用「音节近似」—— 汉语音节≈音节数不好算，
  // 改用「有声秒占比」当节奏指标不好跨样本比，所以语速这一项对真实数据用
  // 「平均时长」做参照，在下面单独处理
  sec: avg(real.map((r) => r.sec)),
}
console.log(`  可用样本 ${real.length} 条`)
console.log(`  音高 F0   平均 ${TARGET.f0.toFixed(1)}  p10 ${pct(real.map((r) => r.f0), 0.1).toFixed(1)}  p90 ${pct(real.map((r) => r.f0), 0.9).toFixed(1)}`)
console.log(`  音域      平均 ${TARGET.range.toFixed(2)}  p10 ${pct(real.map((r) => r.range), 0.1).toFixed(2)}  p90 ${pct(real.map((r) => r.range), 0.9).toFixed(2)}`)
console.log(`  时长      平均 ${TARGET.sec.toFixed(2)}s`)

// ================================================================ ② 配置扫描

const KEY = readFileSync(join(ROOT, '.userdata', 'mimo.key'), 'utf8').trim()
const MM_KEY = readFileSync(join(ROOT, '.userdata', 'minimax.key'), 'utf8').trim()
if (!existsSync(SAMPLE)) {
  console.error(`找不到克隆样本：${SAMPLE}（先跑 node scripts/prepare-clone-audio.mjs）`)
  process.exit(1)
}
const sampleDataUrl = `data:audio/wav;base64,${readFileSync(SAMPLE).toString('base64')}`

/**
 * 扫的配置。重点在**指令的措辞** —— 上一轮证明指令比标签管用
 * （07 的指令把音域从 6.89 推到 9.60，标签推不动）。
 *
 * 目标是「像芙宁娜」：高傲、舞台腔、爱演、起伏大，但**别一惊一乍**。
 */
const CONFIGS = [
  { id: 'A0-real-target', tag: '', inst: '', note: '（占位：真实语音，见页面顶部）' },
  { id: 'B0-baseline', tag: '', inst: '', note: '基线：无指令无标签' },
  { id: 'B1-tag-huopo', tag: '活泼', inst: '', note: '(活泼)' },
  { id: 'B2-inst-yyy', tag: '', inst: '语调起伏大一些，抑扬顿挫。', note: '指令：起伏大' },
  { id: 'C1-inst-wutai', tag: '', inst: '像在舞台上念白：高傲、戏剧化、爱演。语调起伏要大，抑扬顿挫。', note: '指令：舞台念白' },
  { id: 'C2-inst-wutai-shou', tag: '', inst: '像在舞台上念白：高傲、戏剧化、爱演。语调起伏要大，抑扬顿挫，句尾要有收势。', note: '指令：舞台念白 + 句尾收势' },
  { id: 'C3-inst-wutai-yang', tag: '', inst: '像在舞台上念白：高傲、戏剧化、爱演。语调起伏要大，抑扬顿挫，句尾微微上扬，带着一点得意的腔调。', note: '指令：舞台念白 + 句尾上扬' },
  {
    id: 'D1-inst-miaoxie',
    tag: '',
    inst: '用高傲又戏剧化的腔调说话，像大明星在念白。起伏要大：开头起势、中间推进、句尾收住。不要平铺直叙，要抑扬顿挫。',
    note: '指令：详细描述起伏节奏',
  },
  {
    id: 'D2-inst-bijiao',
    tag: '',
    inst: '音调要有明显的抑扬顿挫，像老上海的舞台演员说话：起句高昂、中段沉稳、收句利落。切忌平淡。',
    note: '指令：用比喻定调',
  },
  {
    id: 'E1-daoxian-short',
    tag: '',
    inst: ['角色：傲慢的大明星，说话有舞台腔。', '场景：闲聊，心情好，想显摆。', '指导：语调起伏大，抑扬顿挫，句尾收势。'].join('\n'),
    note: '导演模式（精简）',
  },
  {
    id: 'E2-daoxian-full',
    tag: '',
    inst: [
      '角色：枫丹的大明星。骄傲、戏剧化、爱面子，说话像念白，偶尔嘴硬心软。',
      '场景：和熟人闲聊，心情不错，想显摆两句。',
      '指导：',
      '- 语速与顿挫：语速稍慢，句中要有明显抑扬顿挫，重音落在关键的字上。',
      '- 声调与韵律：语调起伏要大 —— 开头起势、中间推进、句尾收势。',
      '- 气息：句首可以带一点吸气，句尾微微拖长。',
    ].join('\n'),
    note: '导演模式（完整）',
  },
  { id: 'F1-both', tag: '活泼', inst: '像在舞台上念白，高傲、戏剧化。语调起伏要大，抑扬顿挫。', note: '(活泼) + 指令' },
  { id: 'F2-both2', tag: '凌厉', inst: '像在舞台上念白，高傲、戏剧化。语调起伏要大，抑扬顿挫，句尾收势。', note: '(凌厉) + 指令' },
]

async function mimoSpeak(text, { tag, inst }) {
  const body = {
    model: MODEL,
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
  const b64 = JSON.parse(raw).choices?.[0]?.message?.audio?.data
  if (!b64) throw new Error('返回里没有音频')
  return { buf: Buffer.from(b64, 'base64'), ms: Date.now() - t0 }
}

async function mmSpeak(text) {
  const res = await fetch('https://api.minimaxi.com/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MM_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'speech-2.8-turbo',
      text,
      stream: false,
      voice_setting: { voice_id: 'furinaCloneVoiceV1', speed: 1.0, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'wav', channel: 1 },
    }),
  })
  const j = await res.json()
  if (j.base_resp?.status_code !== 0) throw new Error(`${j.base_resp.status_code} ${j.base_resp.status_msg}`)
  return { buf: Buffer.from(j.data.audio, 'hex'), ms: 0 }
}

mkdirSync(WAV, { recursive: true })

/** 量一段音频的指标 */
function stat(f) {
  const a = readWav(f)
  const st = summarize(pitchTrack(a))
  const vs = voicedSeconds(a)
  return { sec: +(a.data.length / a.sr).toFixed(2), f0: st?.mean ?? null, range: st?.range ?? null, vs }
}

// 配对：同一个 cfg 用同一句文本，便于横向比
const rows = []
for (const cfg of CONFIGS) {
  if (cfg.id === 'A0-real-target') continue
  for (const [li, L] of TEXTS.entries()) {
    let r = { cfg: cfg.id, note: cfg.note, text: L.t, cat: L.cat, li }
    try {
      const s = await mimoSpeak(L.t, cfg)
      r.file = join(WAV, `${cfg.id}-L${li}.wav`)
      writeFileSync(r.file, s.buf)
      r.ms = s.ms
      Object.assign(r, stat(r.file))
    } catch (e) {
      r.err = e.message
    }
    rows.push(r)
    process.stdout.write(`  ${cfg.id} L${li} ${r.err ? '❌ ' + r.err : `音域 ${(r.range ?? NaN).toFixed(1)} F0 ${(r.f0 ?? NaN).toFixed(1)} ${r.ms}ms`}\n`)
  }
}

// MiniMax 也放进去当参照
for (const [li, L] of TEXTS.entries()) {
  let r = { cfg: 'Z-minimax', note: 'MiniMax turbo（参照）', text: L.t, cat: L.cat, li }
  try {
    const s = await mmSpeak(L.t)
    r.file = join(WAV, `Z-minimax-L${li}.wav`)
    writeFileSync(r.file, s.buf)
    Object.assign(r, stat(r.file))
  } catch (e) {
    r.err = e.message
  }
  rows.push(r)
}

// ================================================================ ③ 打分

// 打分：三项偏差加权求和。语速用「有声秒/字符」做近似
function score(r) {
  const chars = r.text.replace(/[\s，。！？、…—「」（）【】·~～!?.,:;]/g, '').length
  const rate = r.vs > 0 ? chars / r.vs : NaN
  // 真实数据没有字符数，所以语速目标用「平均时长」反推不了 ——
  // 改用真实语音的「有声秒/时长」占比做参照（正常 0.85~0.95），下面只比 F0 和音域
  const dF0 = Math.abs(r.f0 - TARGET.f0) / 6 // 6 半音 = 一个八度的一半
  const dRange = Math.abs(r.range - TARGET.range) / 4
  return { score: METRICS[0].weight * dF0 + METRICS[1].weight * dRange, rate }
}

const byCfg = new Map()
for (const r of rows) {
  if (!byCfg.has(r.cfg)) byCfg.set(r.cfg, { note: r.note, items: [] })
  byCfg.get(r.cfg).items.push(r)
}

const summary = [...byCfg.entries()].map(([id, g]) => {
  const ok = g.items.filter((r) => !r.err)
  const s = ok.map(score)
  return {
    id,
    note: g.note,
    f0: avg(ok.map((r) => r.f0)),
    range: avg(ok.map((r) => r.range)),
    rate: avg(s.map((x) => x.rate)),
    ms: avg(ok.map((r) => r.ms)),
    score: avg(s.map((x) => x.score)),
    items: g.items,
  }
})
summary.sort((a, b) => a.score - b.score)

console.log(`\n=== ③ 和真实目标打分（越小越像，只比音高 + 音域）===\n`)
console.log(`  目标：音高 ${TARGET.f0.toFixed(1)}  音域 ${TARGET.range.toFixed(2)}`)
console.log('')
console.log('  排名  配置                    相似度  音高    音域    延迟')
for (const [i, s] of summary.entries()) {
  const mark = i < 3 ? ' ★' : ''
  console.log(
    `  ${String(i + 1).padStart(3)}.  ${s.id.padEnd(24)} ${s.score.toFixed(2).padStart(6)}${mark} ${s.f0?.toFixed(1).padStart(6)} ${s.range?.toFixed(2).padStart(7)} ${String(Math.round(s.ms ?? 0)).padStart(5)}ms`
  )
}

// ================================================================ ④ 页面

// 页面顶部放几条真实片段做对照（复制过去）
import { copyFileSync } from 'node:fs'
mkdirSync(join(OUT, 'real'), { recursive: true })
const realSample = real.slice(0, 4).map((r, i) => {
  const dst = join(OUT, 'real', `real-${i}.wav`)
  copyFileSync(join(DATASET, r.f), dst)
  return { file: `real/real-${i}.wav`, f0: r.f0, range: r.range, sec: r.sec }
})

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const rel = (f) => `wav/${f.split(/[\\/]/).pop()}`

const html = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>MiMo 调参 —— 拿真实语音当靶子</title>
<style>
 body{background:#141419;color:#e6e6ee;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:1180px;margin:0 auto;padding:28px}
 h1{font-size:19px;margin:0 0 6px}
 h2{font-size:15px;margin:26px 0 8px;color:#cfd3e6}
 .meta{color:#8f93a8;font-size:12.5px;margin-bottom:18px}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #2c2c36;padding:8px 10px;vertical-align:top;text-align:left}
 th{background:#1e1e24;font-weight:400;color:#a9adc0;font-size:12.5px}
 .cfg{color:#9fd8ff;font-family:ui-monospace,Consolas,monospace;font-size:12px}
 .note{color:#8f93a8;font-size:11.5px}
 .line{color:#cfd3e6;font-size:12.5px}
 .cat{color:#7f8bb5;font-size:11px}
 audio{width:100%;height:32px;margin-top:4px}
 .num{font-size:11px;color:#8f93a8;font-variant-numeric:tabular-nums}
 .best{background:#1c2b22}
 .real{background:#2a2233}
 .fail{color:#ff9a9a}
 .hint{color:#8f93a8;font-size:12.5px;margin-top:20px;border-left:2px solid #34344a;padding-left:12px}
 .metric{display:flex;gap:24px;margin:10px 0 18px}
 .metric div{background:#191920;border:1px solid #2c2c36;border-radius:8px;padding:10px 16px}
 .metric b{color:#7fd8a0;font-variant-numeric:tabular-nums}
</style>
<h1>MiMo 调参 —— 拿真实语音当靶子</h1>
<div class="meta">
 不再猜「她该是什么音域」：<b>本机有 ${allWav.length} 条芙宁娜真实语音</b>，直接从里面量出目标，
 再让每个配置去够它。<br>
 下面每个配置的<b>相似度</b>是「音高偏差 + 音域偏差」的加权和，越小越像。
</div>

<div class="metric">
  <div>目标 <b>音高 ${TARGET.f0.toFixed(1)}</b> 半音</div>
  <div>目标 <b>音域 ${TARGET.range.toFixed(2)}</b> 半音</div>
  <div>真实样本 <b>${real.length}</b> 条</div>
</div>

<h2>① 先听真实芙宁娜（这是靶子）</h2>
<table>
<tr><th style="width:20%">来源</th><th style="width:22%">特征</th><th style="width:58%">试听</th></tr>
${realSample
  .map(
    (r, i) => `<tr class="real"><td class="cfg">真实语音 #${i + 1}</td>
     <td class="num">音高 ${r.f0.toFixed(1)} · 音域 ${r.range.toFixed(1)} · ${r.sec}s</td>
     <td><audio controls preload="none" src="${r.file}"></audio></td></tr>`
  )
  .join('')}
</table>

<h2>② 各配置（按相似度排序）</h2>
<table>
<tr><th style="width:22%">配置</th><th style="width:20%">相似度</th><th style="width:58%">试听</th></tr>
${summary
  .map(
    (s, si) =>
      s.items
        .map((r, i) => {
          const cls = si === 0 ? 'best' : ''
          const label =
            i === 0
              ? `<td rowspan="${s.items.length}" class="${cls}"><div class="cfg">${esc(s.id)}</div><div class="note">${esc(s.note)}</div></td>`
              : ''
          const scoreCell =
            i === 0
              ? `<td rowspan="${s.items.length}" class="${cls}"><div class="num">相似度 <b>${s.score.toFixed(2)}</b>（${si === 0 ? '最像' : `第 ${si + 1}`})</div>
                  <div class="num">音高 ${s.f0?.toFixed(1) ?? '—'}（目标 ${TARGET.f0.toFixed(1)}）<br>音域 ${s.range?.toFixed(2) ?? '—'}（目标 ${TARGET.range.toFixed(2)}）<br>延迟 ${Math.round(s.ms ?? 0)}ms</div></td>`
              : ''
          const cell = r.err
            ? `<td class="fail">失败：${esc(r.err)}</td>`
            : `<td><audio controls preload="none" src="${rel(r.file)}"></audio><div class="num">${esc(r.text.slice(0, 12))}… · 音域 ${r.range?.toFixed(1) ?? '—'}</div></td>`
          return `<tr class="${cls}">${label}${scoreCell}${cell}</tr>`
        })
        .join('')
  )
  .join('')}
</table>

<div class="hint">
 相似度只比<b>音高 + 音域</b>（语速没比 —— 真实数据没配 transcript，量不出字/秒）。<br>
 但<b>像不像本人还得靠耳朵</b>：指标只能帮你排掉明显不对的，剩下的判断在你。<br>
 对照着听法：先听顶部真实片段几次记住那个劲，再往下听 —— 哪个最像，那就是它。
</div>
</html>`

writeFileSync(join(OUT, 'index.html'), html)
console.log(`\n✅ 试听页：${join(OUT, 'index.html')}`)
