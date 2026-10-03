/**
 * 端到端验证「回复 → 情绪 → 挑参考 → GPT-SoVITS 合成 → wav」
 *   node scripts/test-tts.mjs
 *
 * 前提：本地 GPT-SoVITS 的 api_v2.py 已经在 9880 上跑着。
 * 没跑的话这个脚本会告诉你怎么起。
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))
const { resolveEmotion, CATEGORIES } = require(join(ROOT, 'src', 'emotion.js'))

const CACHE = join(ROOT, '.userdata-dev', 'tts-cache')

// ------------------------------------------------------------------ 情绪识别

console.log('=== 1. 情绪识别（标签 → 兜底规则）===\n')

const cases = [
  ['[开心]嘿嘿，你终于来啦！', '开心', 'tag'],
  ['【温柔】别急，我陪着你呢。', '温柔', 'tag'],
  ['（惊讶）诶？这个东西是怎么弄出来的？', '惊讶', 'tag'],
  ['[生气]哼！又把我晾在一边不管了！', '生气', 'tag'],
  ['[平静]嗯，我在这儿呢，你说吧。', '平静', 'tag'],
  ['[得意]这种程度的谜题，我一眼就看穿了。', '开心', 'tag'],
  ['[无奈]好吧，那就照你说的办。', '平静', 'tag'],
  ['怎么可能？那是魔术，怎么可能真的实现？', '惊讶', 'rule'],
  ['哈哈，今天你来得真早呀！', '开心', 'rule'],
  ['对不起…我没能守护住大家。', '难过', 'rule'],
  ['晚安，早点休息吧。', '温柔', 'rule'],
  ['原来如此，我明白了。', '平静', 'rule'],
  ['[乱写的]这句的标签是无效的。', '平静', 'rule'],
  ['这是正文里的[方括号]，不该被当成标签吃掉。', '平静', 'rule'],
]

let pass = 0
for (const [input, wantCat, wantSrc] of cases) {
  const r = resolveEmotion(input)
  const ok = r.category === wantCat && r.source === wantSrc
  if (ok) pass++
  const mark = ok ? '✅' : '❌'
  console.log(`${mark} ${JSON.stringify(input)}`)
  console.log(`     → ${r.category}（来源 ${r.source}）${ok ? '' : `  期望 ${wantCat}/${wantSrc}`}`)
  console.log(`     清洗后: ${JSON.stringify(r.cleaned)}`)
}
console.log(`\n情绪识别 ${pass}/${cases.length} 通过\n`)

// ------------------------------------------------------------------ 参考库

const lib = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))
console.log('=== 2. 参考库 ===')
console.log(`  ${lib.clips.length} 条，目录 ${lib.vendorDir}`)
const missing = lib.clips.filter((c) => !existsSync(join(ROOT, 'assets', 'voice', c.file)))
console.log(`  文件缺失：${missing.length}${missing.length ? ' —— ' + missing.map((m) => m.id).join(',') : ' ✅'}`)

// ------------------------------------------------------------------ TTS

const tts = createTts({
  config: { enabled: true, backend: 'gptsovits' },
  root: ROOT,
  cacheDir: CACHE,
  log: (m) => console.log('  [tts]', m),
  resolveKey: () => null,
})

console.log('\n=== 3. 后端探活 ===')
const probe = await tts.probe()
console.log(`  ${probe.ok ? '✅' : '❌'} ${probe.detail}`)
if (!probe.ok) {
  console.log(`
  启动方式（另开一个终端）：
    cd D:\\GPT-SoVITS\\GPT-SoVITS-1007-cu128\\GPT-SoVITS-1007-cu128
    runtime\\python.exe api_v2.py -c D:\\project\\Personal_assistant\\desktop-pet\\voice\\gptsovits.pet.yaml -a 127.0.0.1 -p 9880
`)
  process.exit(1)
}

console.log('\n=== 4. 合成实测 ===\n')

const lines = [
  { text: '嘿嘿，你终于来啦！我等你好久了哦。', cat: '开心' },
  { text: '嗯，我在这儿呢，你说吧。', cat: '平静' },
  { text: '诶？这个东西是怎么弄出来的？', cat: '惊讶' },
  { text: '辛苦啦，先歇一会儿吧。', cat: '温柔' },
  { text: '哼！又把我晾在一边不管了！', cat: '生气' },
  { text: '……你都不理我。', cat: '难过' },
]

const results = []
for (const { text, cat } of lines) {
  const r = await tts.speak({ text, category: cat })
  if (!r.ok) {
    console.log(`❌ [${cat}] ${text}\n     ${r.error}`)
    continue
  }
  const kb = (statSync(r.file).size / 1024).toFixed(0)
  console.log(`✅ [${cat}] ${text}`)
  console.log(`     参考：${r.ref.endsWith}·${r.ref.id.slice(0, 8)} ${r.ref.seconds}s「${r.ref.text.slice(0, 22)}…」`)
  console.log(`     理由：${r.ref.reasons.join('、') || '（无）'}   得分 ${r.ref.score}`)
  console.log(`     ${r.ms}ms  ${kb}KB  ${r.cached ? '（缓存命中）' : '（新合成）'}  → ${r.file}`)
  results.push(r)
}

console.log('\n=== 5. 缓存验证 ===')
const again = await tts.speak({ text: lines[0].text, category: '开心' })
console.log(`  再合成同一句：${again.ms}ms  cached=${again.cached} ${again.cached ? '✅' : '❌'}`)

console.log('\n=== 6. 延迟统计 ===')
const fresh = results.filter((r) => !r.cached)
if (fresh.length) {
  const ms = fresh.map((r) => r.ms).sort((a, b) => a - b)
  const avg = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)
  console.log(`  ${fresh.length} 条新合成：最快 ${ms[0]}ms / 中位 ${ms[Math.floor(ms.length / 2)]}ms / 最慢 ${ms[ms.length - 1]}ms / 均值 ${avg}ms`)
  console.log(`  参考音频时长均值 ${(fresh.reduce((a, r) => a + r.ref.seconds, 0) / fresh.length).toFixed(2)}s`)
}

console.log('\n=== 7. 冷却轮换验证（同类连说 6 次）===')
const picked = []
for (let i = 0; i < 6; i++) {
  const p = tts.pick('太好了，终于搞定了！', '开心')
  picked.push(p.clip.id.slice(0, 8))
  // 模拟真实使用：每次合成后 rememberRef 会更新
  await tts.speak({ text: `太好了，终于搞定了！第${i}次。`, category: '开心' })
}
console.log(`  选到：${picked.join(' → ')}`)
console.log(`  用到 ${new Set(picked).size} 条不同参考`)

console.log('\n=== 8. 汇总 ===')
console.log(`  ${JSON.stringify(tts.stats)}`)

// 写一份可点开听的报告
const report = join(ROOT, 'tts-test-report.html')
const rows = results
  .map(
    (r) => `<tr>
  <td>${r.ref.category}</td>
  <td>${r.ref.endsWith}·${r.ref.lenBucket ?? ''}</td>
  <td>${r.ref.seconds}s</td>
  <td>${r.ref.text}</td>
  <td>${r.ms}ms</td>
  <td><audio controls src="${r.file.replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/'), '..')}"></audio></td>
</tr>`
  )
  .join('\n')
writeFileSync(
  report,
  `<!doctype html><meta charset="utf-8"><title>桌面宠物 - 语音合成实测</title>
<style>body{font-family:system-ui,'Microsoft YaHei';background:#1a1a1e;color:#eee;padding:24px}
h1{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:6px 8px;font-size:13px;vertical-align:middle}
th{background:#26262c}audio{height:30px}</style>
<h1>芙宁娜语音合成实测（${new Date().toLocaleString('zh-CN')}）</h1>
<table><tr><th>情绪</th><th>参考句式</th><th>参考时长</th><th>参考原文</th><th>合成耗时</th><th>试听</th></tr>
${rows}
</table>
<p style="color:#888;font-size:12px">参考音频来自《原神》中文语音包（米哈游版权，仅本地个人使用，不二次配布）。
声音克隆模型由 GPT-SoVITS v4 在本地推理。</p>`,
  'utf8'
)
console.log(`\n试听报告：${report}`)
