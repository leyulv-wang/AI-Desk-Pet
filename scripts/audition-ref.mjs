/**
 * 生成参考音频试听页，用来挑一条「很日常」的固定参考
 *   node scripts/audition-ref.mjs [候选数]
 *
 * ⚠️ **这个脚本目前是坏的，别直接跑** —— 生成出来的页面 6 条候选里 5 条是同一个声音。
 *
 * 原因：候选是从**整个数据集**（<语音包目录>\Furina）里挑的，
 * 而 tts.speak() 解析参考时只认 assets/voice/library.json 里的 id：
 *     const forced = refId ? library.clips.find(c => c.id === refId) : null
 * 查不到就**静默回落**到默认策略，于是每条候选都用同一条参考。
 * 实测：候选1（恰好在库里）音频正常，候选2~6 的 30 个播放器其实只有 5 个不同文件。
 * 查法：node scripts/check-audition.mjs（逐条比对音频文件名）
 *
 * 修法（很小）：让 speak() 支持直接给参考**文件路径**，或加一个 config.libraryPath
 * 指向「临时生成的库」—— 把候选写进去再合成。改完必须先跑 check-audition.mjs
 * 确认是 6 组不同音频，再拿去给人听。
 *
 * 另外候选筛选要**分池取样**，别按音域全局排序 —— 那样前几名全是「无奈」
 * （叹气式低能量，音域确实最窄），但「叹气」不等于「日常」，
 * 6 条里 4 条一个味道就没法比较。
 *
 * 为什么需要它：固定一条参考之后，那条参考就决定了整只桌宠的声音性格。
 * 而「哪条听起来最日常」是**耳朵的事，不是指标的事** —— 我只能量音域、语速、响度，
 * 量不出「像不像平常说话」。所以把候选都合成出来，你自己听。
 *
 * 候选怎么筛（能自动化的部分）：
 *   1. 只看那些「语气平淡」的池子：平静 / 无奈 / 温柔（其他池子全是戏剧化台词）
 *   2. 量每条自己的音域（窄 = 不夸张）和时长（4~6.5s 最适合当参考）
 *   3. 按音域排序取前 N 条 —— 但会跳过音域过分相同的，尽量给你**不同音色**的选择
 *
 * 每条参考都用同样的几句日常台词合成，方便横向对比。
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pitchTrack, summarize } from './lib/wav-prosody.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))
const N = Number(process.argv[2]) || 6

const OUT = join(ROOT, '.userdata-dev', 'audition')
mkdirSync(OUT, { recursive: true })

const SRC = process.env.PET_VOICE_SRC || 'D:\\下载\\原神语音包\\Furina'
const LIB = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))
const cache = JSON.parse(readFileSync(join(ROOT, '.cache', 'emotion-labels.json'), 'utf8'))

/** 用来对比的日常台词。覆盖陈述/问/叹/省略四种句尾，长度也不同 */
const LINES = [
  { cat: '平静', t: '嗯，我在听，你说吧。' },
  { cat: '平静', t: '今天天气还不错，要不要出去走走？' },
  { cat: '开心', t: '太好了，你终于回来啦！' },
  { cat: '得意', t: '哼，这种程度的问题我一眼就看穿了。' },
  { cat: '无奈', t: '好吧好吧，那就听你的。' },
]

// ---------------------------------------------------------------- 选候选

function readWavDecimated(file, decim = 4) {
  const buf = readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
  let pos = 12, fmt = null, data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    else if (id === 'data') data = buf.subarray(body, Math.min(body + size, buf.length))
    pos = body + size + (size % 2)
  }
  if (!fmt || !data || fmt.bits !== 16) return null
  const ch = fmt.ch
  const total = Math.floor(data.length / 2 / ch)
  const n = Math.floor(total / decim)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let k = 0; k < decim; k++) acc += data.readInt16LE((i * decim + k) * 2 * ch) / 32768
    out[i] = acc / decim
  }
  return { sr: fmt.sr / decim, data: out, seconds: total / fmt.sr }
}

const FLAT_POOLS = ['平静', '无奈', '温柔']
const PURE = { 平静: ['平静'], 无奈: ['无奈'], 温柔: ['温柔'] }

console.log('正在量候选音频（只看语气平淡的池子）…')
const ids = readdirSync(SRC).filter((f) => f.endsWith('.wav')).map((f) => f.replace(/\.wav$/, ''))
const rows = []
for (const id of ids) {
  const lab = cache[id]
  if (!lab) continue
  const pool = FLAT_POOLS.find((p) => PURE[p].includes(lab.e))
  if (!pool) continue
  let meta
  try { meta = JSON.parse(readFileSync(join(SRC, id + '.json'), 'utf8')) } catch { continue }
  const text = (meta.transcription || '').trim()
  if (!text || text.length < 8) continue
  const audio = readWavDecimated(join(SRC, id + '.wav'))
  if (!audio) continue
  if (audio.seconds < 3.5 || audio.seconds > 8) continue
  const s = summarize(pitchTrack(audio))
  if (!s) continue
  rows.push({ id, text, pool, fine: lab.e, v: lab.v, range: s.range, f0: s.mean, seconds: +audio.seconds.toFixed(2) })
}

rows.sort((a, b) => a.range - b.range)

// 挑候选：**每个池子各取几条**，而不是按音域全局排序。
//
// 为什么：按音域排的话前几名全是「无奈」类（叹气式低能量，音域确实最窄），
// 但「叹气」不等于「日常」—— 那样给你的试听集里 6 条有 4 条一个味道，
// 根本没法比较。分池取样 + 池内按音域排，才有得挑。
const perPool = Math.max(1, Math.ceil(N / FLAT_POOLS.length))
const picked = []
for (const pool of FLAT_POOLS) {
  const list = rows.filter((r) => r.pool === pool).sort((a, b) => a.range - b.range)
  let taken = 0
  for (const r of list) {
    if (taken >= perPool || picked.length >= N) break
    // 同一池内也要求音高拉开，避免几条听起来几乎一样
    if (picked.some((p) => Math.abs(p.f0 - r.f0) < 1.2)) continue
    picked.push(r)
    taken++
  }
  // 这个池子一条都没选上（音高全撞了）就退让一步，硬取最平的那条
  if (taken === 0 && list.length && picked.length < N) picked.push(list[0])
}
// 还不够就按音域补齐
if (picked.length < N) {
  for (const r of rows) {
    if (picked.length >= N) break
    if (!picked.includes(r)) picked.push(r)
  }
}

console.log(`\n候选 ${picked.length} 条（按音域从窄到宽，音高彼此拉开以便比较音色）：`)
for (const p of picked) {
  console.log(`  ${p.range.toFixed(2)} 半音  ${p.f0.toFixed(1)}  ${p.seconds}s  [${p.pool}]  「${p.text.slice(0, 30)}…」`)
}

// ---------------------------------------------------------------- 合成

const tts = createTts({
  config: {
    enabled: true,
    backend: 'gptsovits',
    referenceMode: 'fixed',
    trimSilence: true,
    normalizeLoudness: true,
    gptsovits: { sampleSteps: 24, speedFactor: 1.05, seedLock: true },
    cache: { enabled: false },
  },
  root: ROOT,
  cacheDir: join(OUT, 'wav'),
  log: () => {},
  resolveKey: () => null,
})

const probe = await tts.probe()
if (!probe.ok) {
  console.error(`\n语音服务不可用：${probe.detail}`)
  console.error('先 npm run voice 把 GPT-SoVITS 起起来')
  process.exit(1)
}

console.log('\n开始合成…（每条候选 × 每句台词）')
const results = []
for (const p of picked) {
  const clips = []
  let totalMs = 0
  for (const L of LINES) {
    const r = await tts.speak({ text: L.t, category: L.cat, refId: p.id, noCache: true })
    if (!r.ok) {
      console.log(`  ${p.id.slice(0, 8)} 失败：${r.error}`)
      break
    }
    clips.push({ ...L, file: r.file, ms: r.ms })
    totalMs += r.ms
  }
  if (clips.length === LINES.length) {
    results.push({ ...p, clips, avgMs: Math.round(totalMs / clips.length) })
    console.log(`  ${p.id.slice(0, 8)} ✓  平均 ${Math.round(totalMs / clips.length)}ms`)
  }
}

if (!results.length) {
  console.error('一条都没合成出来，放弃')
  process.exit(1)
}

// ---------------------------------------------------------------- 出页面

/**
 * HTML 里用的相对路径。
 *
 * 注意基准是**页面所在的目录**，不是项目根 —— 一开始按项目根算，
 * 结果路径变成 `.userdata-dev/.userdata-dev/audition/wav/...`，音频全部加载不出来。
 */
const rel = (f) => relative(OUT, f).replace(/\\/g, '/')

const cards = results
  .map(
    (r, i) => `
<section class="card">
  <h2>候选 ${i + 1} <span class="id">${r.id.slice(0, 8)}</span>
    <span class="tags">${r.pool} · 音域 ${r.range.toFixed(2)} 半音 · 音高 ${r.f0.toFixed(1)} · ${r.seconds}s · 平均 ${r.avgMs}ms</span>
  </h2>
  <p class="ref">参考原文：「${r.text}」</p>
  <div class="lines">
    ${r.clips.map((c) => `<div class="line"><span class="tag">${c.cat}</span><span class="txt">${c.t}</span><audio controls src="${rel(c.file)}"></audio></div>`).join('\n    ')}
  </div>
  <p class="pick">选定这条就把 <code>config.json</code> 改成：<code>"referenceMode": "fixed", "fixedRef": "${r.id}"</code></p>
</section>`
  )
  .join('\n')

const html = `<!doctype html><meta charset="utf-8"><title>挑一条日常参考音频</title>
<style>
 body{font-family:system-ui,'Microsoft YaHei';background:#16161a;color:#e8e8f0;padding:24px;max-width:1100px;margin:0 auto}
 h1{font-size:19px;margin-bottom:6px}
 .hint{color:#9a9ab0;font-size:13px;line-height:1.7;margin-bottom:20px}
 .hint b{color:#cfcfe6}
 .card{background:#1e1e24;border:1px solid #2c2c36;border-radius:10px;padding:14px 16px;margin-bottom:14px}
 .card h2{font-size:15px;margin:0 0 6px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
 .id{color:#7fd0ff;font-family:ui-monospace,monospace;font-size:13px}
 .tags{color:#8c8ca6;font-size:12px;font-weight:400}
 .ref{color:#a8a8c0;font-size:12.5px;margin:0 0 10px}
 .lines{display:flex;flex-direction:column;gap:6px}
 .line{display:grid;grid-template-columns:52px 1fr 300px;gap:10px;align-items:center;font-size:13px}
 .tag{color:#ffd98a;font-size:11px;background:rgba(255,217,138,.12);border-radius:4px;padding:1px 6px;text-align:center}
 .txt{color:#dcdcea}
 audio{height:30px;width:100%}
 .pick{margin:12px 0 0;font-size:12px;color:#8c8ca6}
 code{background:#2a2a34;padding:1px 5px;border-radius:4px;color:#bfe9ff;font-size:11.5px}
</style>
<h1>挑一条「很日常」的参考音频</h1>
<p class="hint">
 每条候选都用同样的 5 句日常台词合成，方便横向对比。<br>
 <b>要听的是「像不像平常说话」，不是「好不好听」</b> —— 参考音频的语气会整段传染给所有合成结果。<br>
 注意听三件事：① 语气夸张不夸张 ② 语速快慢 ③ 音色是不是你想要的她。<br>
 选定后告诉我候选编号（或直接把 id 填进 config.json）。
</p>
${cards}
`

const outFile = join(OUT, 'index.html')
writeFileSync(outFile, html, 'utf8')
console.log(`\n试听页：${outFile}`)
console.log(`共 ${results.length} 条候选 × ${LINES.length} 句台词`)
