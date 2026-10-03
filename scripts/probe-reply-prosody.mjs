/**
 * 回归守卫：参考音频的稳定性
 *   node scripts/probe-reply-prosody.mjs
 *
 * 守两条不变量：
 *   ① 一轮回复内部只用一条参考（否则一句话会被念成两种语气）
 *   ② **同一种情绪永远用同一条参考**（跨轮也不许换）
 *
 * 为什么这两条重要 —— 见 npm run diag:prosody 的实测：
 *   同一条参考、同一句话，重跑三次输出**逐字节相同**（种子锁定了，噪声为 0）；
 *   但换成同类别里的另一条参考，输出会变成另一个嗓子：
 *       音高差 4.6 半音（将近四度）· 语速差 1.9 倍 · 响度差 2.6 倍
 *   所以「换参考」= 「换人」。任何偷偷换参考的路径都是 bug。
 *
 * 脚本会先跑一遍 rotate 模式当反例（证明这个坑真实存在），再跑 sticky 模式验证修好了。
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))
const { createSplitter } = require(join(ROOT, 'src', 'sentence.js'))

const REPLIES = [
  { category: '温柔', text: '阿远？唔，本神记住这个名字了。不过美式那种苦水，怎么比得上配马卡龙的下午茶呀。' },
  { category: '开心', text: '真的吗？那太好了！本神早就想去看看了，你什么时候有空？' },
  { category: '平静', text: '嗯，我知道了。你先忙吧，我在这儿等着。' },
]

function mk(tag, mode) {
  return createTts({
    config: {
      enabled: true,
      backend: 'gptsovits',
      referenceMode: mode,
      cache: { enabled: false },
      normalizeLoudness: false, // 测的是参考稳定性，别让归一化掩盖信号
    },
    root: ROOT,
    cacheDir: join(ROOT, '.userdata-dev', `lock-${tag}`),
    log: () => {}, // 把「锁定参考」的日志压掉，输出清爽
    resolveKey: () => null,
  })
}

function split(text) {
  const s = createSplitter()
  return [...s.feed(text), ...s.flush()]
}

let failures = 0

// ---------------------------------------------------------------- A. 反例

console.log('=== A. 反例：rotate 模式（旧行为，每句独立选参考）===\n')

for (const r of REPLIES) {
  const tts = mk('rot', 'rotate')
  const ids = []
  for (const s of split(r.text)) {
    const res = await tts.speak({ text: s, category: r.category })
    ids.push(res.ref.id)
  }
  const uniq = new Set(ids)
  console.log(`【${r.category}】${ids.map((i) => i.slice(0, 8)).join(' → ')}  ${uniq.size} 条 ${uniq.size > 1 ? '← 语气会断' : ''}`)
}

console.log('\n  （反例里换参考是预期的 —— 它证明这个坑真实存在，也说明不变量②有必要）\n')

// ---------------------------------------------------------------- B. 不变量

console.log('=== B. sticky 模式（默认）：一轮内一条 + 同类永远一条 ===\n')

const sticky = mk('sticky', 'sticky')

for (const r of REPLIES) {
  const sents = split(r.text)
  const ids = []
  const picked = sticky.pick(sents[0], r.category, { lock: true })
  console.log(`【${r.category}】锁定 ${picked.clip.id.slice(0, 8)}（${picked.clip.category}·${picked.clip.endsWith}）`)
  for (const s of sents) {
    const res = await sticky.speak({ text: s, category: r.category, noCache: true })
    ids.push(res.ref.id)
    console.log(`     ←「${s}」`)
  }
  const uniq = new Set(ids)
  const ok = uniq.size === 1
  if (!ok) failures++
  console.log(`   一轮内：${uniq.size} 条参考 ${ok ? '✅' : '❌ 一轮内换了参考'}\n`)
}

// 跨轮：同类别再说两次，必须还是同一条
console.log('  跨轮同类别复查（每个类别再说 2 次）：')
for (const r of REPLIES) {
  const before = sticky.pick('随便一句话', r.category)?.clip.id
  const a = await sticky.speak({ text: '再说一句看看。', category: r.category, noCache: true })
  const b = await sticky.speak({ text: '还有这一句。', category: r.category, noCache: true })
  const same = a.ref.id === b.ref.id && a.ref.id === before
  if (!same) failures++
  console.log(`     ${r.category}：${before?.slice(0, 8)} → ${a.ref.id.slice(0, 8)} → ${b.ref.id.slice(0, 8)} ${same ? '✅' : '❌ 跨轮换参考了'}`)
}

// 每个类别锁的是哪条
console.log('\n  当前各类别锁定的参考：')
for (const [cat, id] of Object.entries(sticky.stickyMap)) {
  const clip = sticky.library?.clips?.find((c) => c.id === id)
  console.log(`     ${cat}：${id.slice(0, 8)}${clip ? `（${clip.endsWith}）「${clip.text.slice(0, 18)}…」` : ''}`)
}

console.log('\n=== 结论 ===')
if (failures === 0) {
  console.log('  ✅ 两条不变量都成立：一轮内一条参考，同类别跨轮也不换。')
  console.log('     声音只在**情绪类别变化**时才变 —— 这才是「连贯」。')
  console.log('     改 voice-select.js / tts.js 的挑选逻辑后，记得回来跑这个。')
} else {
  console.log(`  ❌ ${failures} 处违反不变量，参考音频在偷偷换 —— 语气会断。`)
  process.exitCode = 1
}
