/**
 * 查「废片」是哪来的：同一句话，换种子反复合成，看输出稳不稳
 *   node scripts/diagnose-dud.mjs
 *   node scripts/diagnose-dud.mjs --texts="诶？,嗯。"
 *
 * 背景（实测）：
 *   一次真实自检里，回复的第一段「诶？」合成成了
 *   **0.40s、只有 0.06s 出声、RMS 0.0023**（正常 0.09）的近乎全零的片子。
 *   它躲过了 src/tts.js 的废片守卫 —— 守卫只看语速（字数/有声秒），
 *   而一段静音在语速上完全「正常」。
 *
 * 这个脚本要回答三个问题：
 *   ① 是不是**稳定复现**的（同种子必现 → 可以当回归用例）
 *   ② 是**短句**特有的，还是随机偶发
 *   ③ 换种子能不能救回来（能救 → 现有重试机制加一条判据就够）
 *
 * 判据和 scripts/probe-segments.mjs 保持一致 —— 别各写一套。
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav, rms, voicedSeconds } from './lib/wav-prosody.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

const argTexts = (process.argv.find((a) => a.startsWith('--texts=')) || '').slice(8)
const TEXTS = argTexts
  ? argTexts.split(',').map((s) => s.trim()).filter(Boolean)
  : ['诶？', '嗯，我在听。', '好吧。']

const REF = '7cd3e85678f2c4ef'
const ATTEMPTS = 3

/** 和 probe-segments.mjs 同一套判据 */
const MIN_RMS = 0.02
const MIN_VOICED = 0.6
const MIN_SECONDS = 0.3

function judge(file) {
  const a = readWav(file)
  const sec = a.data.length / a.sr
  const r = rms(a)
  const vs = voicedSeconds(a)
  const ratio = sec > 0 ? vs / sec : 0
  const dud = r < MIN_RMS || ratio < MIN_VOICED || sec < MIN_SECONDS
  return { sec, r, vs, ratio, dud }
}

const tts = createTts({
  config: {
    enabled: true,
    backend: 'gptsovits',
    referenceMode: 'fixed',
    fixedRef: REF,
    cache: { enabled: false },
  },
  root: ROOT,
  cacheDir: join(ROOT, '.userdata-dev', 'dud'),
  log: () => {},
  resolveKey: () => null,
})

const probe = await tts.probe()
if (!probe.ok) {
  console.error(`语音服务不可用：${probe.detail}\n先 npm run voice`)
  process.exit(1)
}

const baseSeed = tts.pick('x', '平静') && null // 只是确认库已加载
console.log(`参考固定为 ${REF}（${tts.library.clips.find((c) => c.id === REF).category}）`)
console.log(`每种文本合成 ${ATTEMPTS} 次，每次换一个种子\n`)

const rows = []
for (const t of TEXTS) {
  for (let i = 0; i < ATTEMPTS; i++) {
    // 和 tts.js 的重试同款：seed + attempt*7919
    const seed = (1 + i * 7919) % 2147483647
    const r = await tts.speak({ text: t, category: '平静', noCache: true, seed })
    if (!r.ok) {
      console.log(`  ❌「${t}」合成失败：${r.error}`)
      rows.push({ t, i, ok: false })
      continue
    }
    const j = judge(r.file)
    rows.push({ t, i, ...j, file: r.file })
    console.log(
      `  ${j.dud ? '❌' : '✅'}「${t}」第 ${i + 1} 次  ` +
        `${j.sec.toFixed(2)}s  有声 ${(j.ratio * 100).toFixed(0)}%  RMS ${j.r.toFixed(4)}  ${r.ms}ms`
    )
  }
  console.log('')
}

// ---------------------------------------------------------------- 结论

console.log('=== 结论 ===\n')

const byText = new Map()
for (const r of rows) {
  if (!byText.has(r.t)) byText.set(r.t, [])
  byText.get(r.t).push(r)
}

let anyDud = false
for (const [t, list] of byText) {
  const duds = list.filter((x) => x.dud).length
  if (duds) anyDud = true
  console.log(`  「${t}」 ${list.length - duds}/${list.length} 正常` + (duds === list.length ? '  ← 次次都废' : duds ? '  ← 偶发' : ''))
}

console.log('')
if (!anyDud) {
  console.log('  ✅ 这批文本没出废片。')
} else {
  console.log('  读法：')
  console.log('    · 某句「次次都废」→ 和文本本身有关（多半是太短），得在切句或守卫上治')
  console.log('    · 只是「偶发」   → 加一条判据让守卫重试就行')
  console.log('    · 换了种子就正常 → 现有重试机制能救，只需要把判据从「只看语速」扩成「也看响度」')
}
