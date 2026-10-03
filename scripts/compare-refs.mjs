/**
 * 横向对比指定的参考音频：同样几句话，各自合成一遍
 *   node scripts/compare-refs.mjs <clipId> [clipId ...]
 *
 * 例：node scripts/compare-refs.mjs 7cd3e85678f2c4ef 9fc3f59d8cb538ea
 *
 * 和 audition-ref.mjs 的区别（那个脚本目前是坏的，见它文件头的说明）：
 *   这个只接受**已经在 assets/voice/library.json 里**的 clip id。
 *   因为 tts.speak() 解析 refId 时只认库里的条目：
 *       const forced = refId ? library.clips.find(c => c.id === refId) : null
 *   查不到就静默回落到默认策略 —— 结果就是"N 条候选其实同一个声音"。
 *   所以这里一进来就先校验，不在库里直接报错退出，绝不让坏数据流出去。
 *
 * 输出：.userdata-dev/compare/index.html（并排试听）+ 控制台打印 wav 路径
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav, pitchTrack, summarize, voicedSeconds } from './lib/wav-prosody.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

const OUT = join(ROOT, '.userdata-dev', 'compare')
const LIB = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))

// ---------------------------------------------------------------- 参数校验

const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!ids.length) {
  console.error('用法：node scripts/compare-refs.mjs <clipId> [clipId ...]')
  console.error('\n可用的 id（从 library.json 里取）：')
  for (const c of LIB.clips) console.error(`  ${c.id}  [${c.category}] ${c.text.slice(0, 28)}…`)
  process.exit(1)
}

const picks = []
for (const id of ids) {
  const clips = LIB.clips.filter((c) => c.id === id || c.id.startsWith(id))
  if (!clips.length) {
    console.error(`❌ ${id} 不在 library.json 里 —— 用这个脚本前必须先把它加进参考库`)
    console.error('   （这就是 audition-ref.mjs 生成出来的页面为什么全是重复声音）')
    process.exit(1)
  }
  if (clips.length > 1) {
    console.error(`❌ ${id} 匹配到多条：${clips.map((c) => c.id).join(', ')}`)
    process.exit(1)
  }
  const c = clips[0]
  const file = join(ROOT, 'assets', 'voice', c.file)
  if (!existsSync(file)) {
    console.error(`❌ ${c.id} 的音频文件不存在：${c.file}`)
    process.exit(1)
  }
  picks.push(c)
}

/** 用来对比的台词。覆盖问/叹/陈述，长短都有 */
const LINES = [
  { cat: '平静', t: '嗯，我在听，你说吧。' },
  { cat: '平静', t: '今天天气还不错，要不要出去走走？' },
  { cat: '开心', t: '太好了，你终于回来啦！' },
  { cat: '得意', t: '哼，这种程度的问题我一眼就看穿了。' },
  { cat: '无奈', t: '好吧好吧，那就听你的。' },
]

// ---------------------------------------------------------------- 参考自身特征

const CHAR_RE = /[\s，。！？、…—「」（）【】·~～!?.,:;"'#{}A-Za-z0-9]/g

function refStats(c) {
  const audio = readWav(join(ROOT, 'assets', 'voice', c.file))
  const s = summarize(pitchTrack(audio))
  const vs = voicedSeconds(audio)
  const chars = c.text.replace(CHAR_RE, '').length
  return {
    range: s?.range ?? NaN,
    f0: s?.mean ?? NaN,
    seconds: +(audio.data.length / audio.sr).toFixed(2),
    rate: vs > 0.2 ? +(chars / vs).toFixed(2) : NaN,
  }
}

console.log(`对比 ${picks.length} 条参考，每条约 ${LINES.length} 句：\n`)
for (const c of picks) {
  const st = refStats(c)
  console.log(`  ${c.id.slice(0, 8)}  [${c.category}/${c.fine}]  ${st.seconds}s  音域 ${st.range} 半音  语速 ${st.rate} 字/秒`)
  console.log(`      「${c.text}」`)
}

// ---------------------------------------------------------------- 合成

mkdirSync(OUT, { recursive: true })

const tts = createTts({
  config: {
    enabled: true,
    backend: 'gptsovits',
    // 就用「固定一条参考」的方式合成 —— 和真正跑起来时一模一样
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
  console.error('先跑 npm run voice 把 GPT-SoVITS 起起来')
  process.exit(1)
}

console.log('\n开始合成…')
const results = []
for (const c of picks) {
  const clips = []
  for (const L of LINES) {
    const r = await tts.speak({ text: L.t, category: L.cat, refId: c.id, noCache: true })
    if (!r.ok) {
      console.error(`  ${c.id.slice(0, 8)} 失败：${r.error}`)
      break
    }
    clips.push({ ...L, file: r.file, ms: r.ms })
  }
  if (clips.length === LINES.length) {
    const st = refStats(c)
    results.push({ clip: c, st, clips })
    console.log(`  ${c.id.slice(0, 8)} ✓ ${clips.length} 句，平均 ${Math.round(clips.reduce((a, x) => a + x.ms, 0) / clips.length)}ms`)
  }
}

if (results.length !== picks.length) {
  console.error(`\n❌ 只有 ${results.length}/${picks.length} 条合成成功，不生成页面（避免又出一份不完整的试听页）`)
  process.exit(1)
}

// ---------------------------------------------------------------- 出页面

const rel = (f) => relative(OUT, f).replace(/\\/g, '/')

/** 按句排列：一行一句台词，每行里放各条参考的版本 —— 这样对比最直接 */
const rows = LINES.map((L, i) => {
  const cells = results
    .map(
      (r) => `<div class="cell">
      <audio controls src="${rel(r.clips[i].file)}"></audio>
      <span class="ms">${r.clips[i].ms}ms</span>
    </div>`
    )
    .join('\n    ')
  return `<div class="row">
  <div class="say"><span class="tag">${L.cat}</span>${L.t}</div>
  <div class="cells">
    ${cells}
  </div>
</div>`
}).join('\n')

const heads = results
  .map(
    (r) => `<th>
    <div class="id">${r.clip.id}</div>
    <div class="meta">[${r.clip.category}/${r.clip.fine}]　${r.st.seconds}s　音域 ${r.st.range}　语速 ${r.st.rate}</div>
    <div class="ref">「${r.clip.text}」</div>
    <audio controls src="${rel(join(ROOT, 'assets', 'voice', r.clip.file))}"></audio>
    <div class="ms">↑ 这是参考音频本身</div>
  </th>`
  )
  .join('\n  ')

const html = `<!doctype html><meta charset="utf-8"><title>参考音频对比</title>
<style>
 body{font-family:system-ui,'Microsoft YaHei';background:#16161a;color:#e8e8f0;padding:24px;max-width:1200px;margin:0 auto}
 h1{font-size:19px;margin:0 0 4px}
 .hint{color:#9a9ab0;font-size:13px;line-height:1.7;margin-bottom:18px}
 .hint b{color:#cfcfe6}
 table{width:100%;border-collapse:collapse;margin-bottom:22px}
 th{vertical-align:top;text-align:left;padding:10px 12px;border:1px solid #2c2c36;background:#1e1e24;font-weight:400}
 .id{color:#7fd0ff;font-family:ui-monospace,monospace;font-size:13px}
 .meta{color:#8c8ca6;font-size:11.5px;margin-top:3px}
 .ref{color:#b9b9d0;font-size:12px;margin:6px 0}
 .ms{color:#6f6f88;font-size:11px;margin-left:6px}
 .row{border:1px solid #2c2c36;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#1a1a20}
 .say{font-size:13.5px;margin-bottom:8px;color:#e8e8f0}
 .tag{color:#ffd98a;font-size:11px;background:rgba(255,217,138,.12);border-radius:4px;padding:1px 6px;margin-right:8px}
 .cells{display:grid;grid-template-columns:repeat(${results.length},1fr);gap:12px}
 .cell{display:flex;align-items:center;gap:6px}
 audio{height:30px;flex:1;min-width:0}
</style>
<h1>参考音频对比</h1>
<p class="hint">
 表头是两条参考音频本身（先听它们，感受"语气"），下面每行是一句台词的两个版本。<br>
 <b>要听的是「哪条当嗓子更顺耳」</b> —— 它决定了所有回复的语气底色，之后不会再变。<br>
 选定后把 id 填进 <code>config.json</code> 的 <code>tts.fixedRef</code>，并把 <code>referenceMode</code> 设成 <code>"fixed"</code>。
</p>
<table><tr>
  ${heads}
</tr></table>
${rows}
`

const outFile = join(OUT, 'index.html')
writeFileSync(outFile, html, 'utf8')

console.log(`\n对比页：${outFile}`)
console.log('\n直接播放的 wav（也可以拖进播放器）：')
for (const r of results) {
  console.log(`  ${r.clip.id}`)
  for (const c of r.clips) console.log(`     ${c.file}`)
}
