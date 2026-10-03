/**
 * 回归守卫：固定参考（referenceMode='fixed'）真的生效了吗
 *   node scripts/check-fixed-ref.mjs            # 含真实合成
 *   node scripts/check-fixed-ref.mjs --no-synth # 只查逻辑，不用开语音服务
 *
 * 为什么要有这个脚本：
 *   前面已经证明「换参考 = 换人」（音高差 5.9 半音、语速差 1.9 倍、响度差 2.6 倍）。
 *   fixed 模式是最终选择，所以必须有一条硬断言守着它 —— 而不是靠肉耳听。
 *
 * 这个脚本读的是**真实的 config.json**，不是自己拼一份配置。
 *   自己拼配置的脚本只能证明「代码写对了」，证明不了「你文件填对了」。
 *   踩过这个坑：probe-reply-prosody.mjs 就是自己拼配置的，config 写错它也照样绿。
 *
 * 查五件事：
 *   ① config.json 里 referenceMode / fixedRef 都填对了
 *   ② fixedRef 指向的那条参考确实在 library.json 里
 *   ③ 八个情绪类别**全部**都指向同一条参考（fixed 不随情绪变）
 *   ④ 真实合成一句「生气」的话，回来用的还是那条固定参考（不是生气池里的）
 *   ⑤ 反面：fixedRef 填错时不许崩，要回落 sticky 并说清楚
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))
const { CATEGORIES } = require(join(ROOT, 'src', 'emotion.js'))

const NO_SYNTH = process.argv.includes('--no-synth')
const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ---------------------------------------------------------------- ① 读真实配置

console.log('=== ① config.json ===\n')

const raw = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const ttsCfg = raw.tts || {}
console.log(`  referenceMode = ${JSON.stringify(ttsCfg.referenceMode)}`)
console.log(`  fixedRef      = ${JSON.stringify(ttsCfg.fixedRef)}`)

check(ttsCfg.referenceMode === 'fixed', "referenceMode 是 'fixed'", `实际 ${JSON.stringify(ttsCfg.referenceMode)}`)
check(!!ttsCfg.fixedRef, 'fixedRef 非空')

// ---------------------------------------------------------------- ② 参考在库里吗

console.log('\n=== ② fixedRef 在参考库里吗 ===\n')

const lib = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))
const clip = lib.clips.find((c) => c.id === ttsCfg.fixedRef)
check(!!clip, `库里找得到 ${ttsCfg.fixedRef}`)
if (!clip) {
  console.log('\n  库里找不到这条，后面的检查没意义，先停。')
  process.exit(1)
}
console.log(`    ${clip.id}`)
console.log(`    情绪标注：${clip.category}${clip.fine && clip.fine !== clip.category ? ` / ${clip.fine}` : ''}  时长 ${clip.seconds}s  收尾「${clip.endsWith}」`)
console.log(`    原文：「${clip.text}」`)

// ---------------------------------------------------------------- ③ 八个类别都指向它

console.log('\n=== ③ 八个情绪类别是否都指向同一条 ===\n')

const mk = (cfg) =>
  createTts({
    config: { enabled: true, backend: 'gptsovits', cache: { enabled: false }, ...cfg },
    root: ROOT,
    cacheDir: join(ROOT, '.userdata-dev', 'fixed-ref-check'),
    log: () => {},
    resolveKey: () => null,
  })

const tts = mk({ referenceMode: ttsCfg.referenceMode, fixedRef: ttsCfg.fixedRef })

const PROBE_TEXT = '嗯，我知道了，你先去忙吧。'
for (const cat of CATEGORIES) {
  const picked = tts.pick(PROBE_TEXT, cat)
  check(picked?.clip?.id === ttsCfg.fixedRef, `${cat}`, `→ ${picked?.clip?.id?.slice(0, 8) ?? '(null)'}`)
}

// 换个句子、换成长句，也必须是同一条（fixed 不看文本形状）
for (const text of ['真的吗？那太好了！', '唉，随你吧。', '你、你怎么能这样说！', '本神今天心情不错哦。']) {
  const picked = tts.pick(text, '开心')
  check(picked?.clip?.id === ttsCfg.fixedRef, `换句子「${text.slice(0, 10)}」仍固定`, `→ ${picked?.clip?.id?.slice(0, 8)}`)
}

// ---------------------------------------------------------------- ④ 真实合成

console.log('\n=== ④ 真实合成（用「生气」这个类别，它自己的池子里没有温柔）===\n')

if (NO_SYNTH) {
  console.log('  --no-synth，跳过')
} else {
  const probe = await tts.probe()
  console.log(`  语音服务：${probe.ok ? '在线' : '不可用'} — ${probe.detail || ''}`)
  if (!probe.ok) {
    failures.push('语音服务不可用，④ 没跑成')
    console.log('  ❌ 服务不在，无法验证合成路径（先 npm run voice）')
  } else {
    const res = await tts.speak({ text: '哼，本神可没那么好骗。', category: '生气', noCache: true })
    check(res.ok, '合成成功', res.ok ? `${res.ms}ms` : res.error)
    if (res.ok) {
      check(res.ref.id === ttsCfg.fixedRef, '合成实际用的参考是固定的那条', `→ ${res.ref.id.slice(0, 8)}（标注 ${res.ref.category}）`)
      check(res.ref.reasons?.includes('固定参考'), '理由标注为「固定参考」', `reasons=${JSON.stringify(res.ref.reasons)}`)
      console.log(`    输出：${res.file}`)
    }
  }
}

// ---------------------------------------------------------------- ⑤ 反面：填错要回落

console.log('\n=== ⑤ 反面：fixedRef 填错时不许崩 ===\n')

const bogus = mk({ referenceMode: 'fixed', fixedRef: '这条根本不存在' })
const fell = bogus.pick(PROBE_TEXT, '温柔')
check(!!fell?.clip?.id, '回落到 sticky 挑到了一条', `→ ${fell?.clip?.id?.slice(0, 8)}（${fell?.clip?.category}）`)
check(fell?.clip?.id !== '这条根本不存在', '没有把不存在的 id 原样返回')

const empty = mk({ referenceMode: 'fixed', fixedRef: '' })
const fell2 = empty.pick(PROBE_TEXT, '温柔')
check(!!fell2?.clip?.id, 'fixedRef 为空时也能挑到', `→ ${fell2?.clip?.id?.slice(0, 8)}`)

// ---------------------------------------------------------------- 结论

console.log('\n=== 结论 ===\n')
if (failures.length === 0) {
  console.log(`  ✅ 固定参考生效：全部 ${CATEGORIES.length} 个情绪类别、任意句子，用的都是同一条`)
  console.log(`     ${ttsCfg.fixedRef}（${clip.category}）「${clip.text.slice(0, 24)}…」`)
  console.log('     换参考只改 config.json 的 tts.fixedRef，代码不用动。')
} else {
  console.log(`  ❌ ${failures.length} 项没过：`)
  for (const f of failures) console.log(`     · ${f}`)
  process.exitCode = 1
}
