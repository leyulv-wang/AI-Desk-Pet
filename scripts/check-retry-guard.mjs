/**
 * 验证废片护栏的判据准不准
 *   node scripts/check-retry-guard.mjs
 *
 * 要回答的问题：护栏会不会在**正常**的片子上误判成废片而白白重试？
 * 如果会，每句话的合成成本就翻两三倍（实测过一次耗时从 5.5s/句 涨到 12s/句）。
 *
 * 判据是：字数 / 有声秒数 > 12 就认定废片。
 * 所以这里直接把「后处理之后的 buffer」喂给 voicedSecondsOfWav，看它算出来对不对。
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

// 借用 tts 内部的解析能力：先合成一个已知正常的片子，再看判据算出来多少
const OUT = join(ROOT, '.userdata-dev', 'guardcheck')
mkdirSync(OUT, { recursive: true })

const tts = createTts({
  config: {
    enabled: true,
    backend: 'gptsovits',
    referenceMode: 'fixed',
    fixedRef: '7cd3e85678f2c4ef',
    trimSilence: true,
    normalizeLoudness: true,
    gptsovits: { sampleSteps: 24, speedFactor: 1.05, seedLock: true },
    cache: { enabled: false },
  },
  root: ROOT,
  cacheDir: OUT,
  log: (m) => console.log('  [tts]', m),
  resolveKey: () => null,
})

const LINES = [
  '嗯，我在听，你说吧。',
  '今天天气还不错，要不要出去走走？',
  '哼，这种程度的问题我一眼就看穿了。',
  '好吧好吧，那就听你的。',
]

const ch = (t) => t.replace(/[，。！？、…—]/g, '').length

console.log('逐句合成，看护栏会不会误判：\n')
for (const t of LINES) {
  const r = await tts.speak({ text: t, category: '平静', noCache: true })
  if (!r.ok) {
    console.log(`  ❌ ${t} → ${r.error}`)
    continue
  }
  console.log(`  「${t}」  ${ch(t)} 字  ${r.ms}ms`)
}

console.log()
console.log('统计：', JSON.stringify(tts.stats))
const retries = tts.stats.retries || 0
if (retries === 0) {
  console.log('\n✅ 没有触发任何重试 —— 判据不会误伤正常片子')
} else {
  console.log(`\n⚠️ 触发了 ${retries} 次重试。正常片子不该被误判，看看上面的 [tts] 日志里`)
  console.log('   「合成结果异常」那几行的字/秒是多少 —— 如果远小于 12，说明判据有问题。')
}
