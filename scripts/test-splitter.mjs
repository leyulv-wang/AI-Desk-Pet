/**
 * 流式切分器的回归测试
 *   node scripts/test-splitter.mjs
 *
 * 为什么要有这个 —— 它是整条语音流水线的第一环：
 *   切错一次，后面合成、播放、嘴型全跟着错，而且错得很安静（少一个字就是少一个字）。
 *
 * 守四条不变量：
 *   ① **不丢字**：把所有段拼回去（去掉空白）必须等于原文
 *      —— 这条抓的是「情绪标签吃掉了开头两个字」那一类 bug
 *   ② **流式 == 一次性**：逐字喂进去的结果，必须等于整段一次性切的结果
 *      —— 流式路径和测试路径不同源，是这类代码最经典的坑
 *   ③ **不发小段**：除了最后一段（后面没句子可拼了）和「整段只有一句」，
 *      不允许出现短于 minChars 的片段
 *      —— 见下面那条真实回归用例
 *   ④ **边界**：省略号不被从中间切开、收尾引号跟着上一句、超长句有硬切兜底
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createSplitter, splitSentences, effectiveChars, DEFAULTS } = require(join(ROOT, 'src', 'sentence.js'))
const { CATEGORIES, extractTag } = require(join(ROOT, 'src', 'emotion.js'))

const { minChars, maxChars } = DEFAULTS
let pass = 0
const fails = []
const ok = (cond, label, extra = '') => {
  if (cond) pass++
  else fails.push(`${label}${extra ? ` —— ${extra}` : ''}`)
}
const strip = (s) => String(s).replace(/\s/g, '')

/** 逐字喂 */
function stream(text) {
  const s = createSplitter()
  const out = []
  for (const ch of text) out.push(...s.feed(ch))
  out.push(...s.flush())
  return out
}

// ---------------------------------------------------------------- 用例

const CASES = [
  {
    name: '★ 真实回归：开头是「诶？」的流式回复',
    text: '诶？你、你居然学我说话！「本神」这个词是从本神这偷的吧，还敢恶人先告状？唔……好吧，算你有点意思，我就暂且饶你一回。',
    // 这就是那个洞：短句后面还有内容、且拼起来超过 maxChars 时，短句被单独发了出去
    forbid: ['诶？'],
  },
  {
    name: '★ 真实回归：标签算进了字数，[开心]陪你？ 又漏成小段',
    text: '[开心]陪你？这话该我说才对吧。要不你写你的代码，我在旁边给你挑刺——怎么样，这提议够有诚意了吧？',
    // `[开心]陪你？`.length === 6，刚好越过 minChars，于是「陪你？」被单独发了出去。
    // 标签要等 acceptSegment 才剥，所以切句器必须自己把句首标记排除在字数之外。
    forbid: ['[开心]陪你？'],
  },
  { name: '普通陈述', text: '嗯，我知道了。你先忙吧，我在这儿等着。' },
  { name: '问句连发', text: '真的吗？那太好了！你什么时候有空？' },
  { name: '省略号收尾', text: '这个嘛……让我想想。' },
  { name: '三个句点的省略号', text: '唔...好吧。那就这样。' },
  { name: '引号收尾要跟着上一句', text: '他说「今天不来了。」然后我们就走了。' },
  { name: '括号收尾', text: '她小声说了一句（大概是这个意思。）我没听清。' },
  { name: '单句无标点', text: '这句话没有句号' },
  { name: '整段就一个字', text: '嗯。' },
  { name: '整段就两个字', text: '好吧。' },
  { name: '换行也算切点', text: '第一行\n第二行。' },
  { name: '分号', text: '先这样；剩下的明天再说。' },
  { name: '全是短句', text: '嗯。好。行。可以。那就这样吧。' },
  { name: '超长句要硬切', text: '这是一句刻意写得很长很长而且中间一个句末标点都不放进去的话用来验证超过上限之后切分器会不会一直攒着不吐出来' + '。' },
]

console.log(`切分器参数：minChars=${minChars} maxChars=${maxChars}\n`)

for (const c of CASES) {
  const batch = splitSentences(c.text)
  const strm = stream(c.text)

  // ① 不丢字
  ok(strip(batch.join('')) === strip(c.text), `① batch 不丢字：${c.name}`, `拼回「${strip(batch.join(''))}」`)
  ok(strip(strm.join('')) === strip(c.text), `① stream 不丢字：${c.name}`, `拼回「${strip(strm.join(''))}」`)

  // ② 流式 == 一次性（句长都在 maxChars 内的用例才要求完全一致；
  //    超长句在流式下会被 SOFT_BREAK 提前切，那是设计如此）
  const longest = Math.max(...batch.map((s) => strip(s).length))
  if (longest <= maxChars) {
    ok(
      JSON.stringify(strm) === JSON.stringify(batch),
      `② 流式==一次性：${c.name}`,
      `stream=${JSON.stringify(strm)} batch=${JSON.stringify(batch)}`
    )
  }

  // ③ 不发小段。
  //    最后一段除外 —— 它后面没有句子可拼了，短也只能发（「我没听清。」就是 5 个字）。
  //    用 effectiveChars（切句器内部那把尺），不是裸 strip —— 否则标签会被算进字数，
  //    测出来和实际行为不是一回事。
  if (batch.length > 1) {
    const tiny = batch.slice(0, -1).filter((s) => effectiveChars(s) < minChars)
    ok(tiny.length === 0, `③ 无小段：${c.name}`, `出现了 ${JSON.stringify(tiny)}`)
  }

  // ④ 指定不许出现的片段
  for (const f of c.forbid || []) {
    ok(!batch.includes(f), `④ 不该切出「${f}」：${c.name}`, `实际切成了 ${JSON.stringify(batch)}`)
    ok(!strm.includes(f), `④ 流式下也不该切出「${f}」：${c.name}`, `实际切成了 ${JSON.stringify(strm)}`)
  }

  console.log(`  【${c.name}】${batch.length} 段`)
  for (const s of batch) console.log(`      ${strip(s).length.toString().padStart(2)} 字  「${s}」`)
}

// ---------------------------------------------------------------- 两把尺子不能走偏

console.log('句首标记：sentence.js 的 effectiveChars 和 emotion.js 的 extractTag 是否一致\n')

for (const cat of CATEGORIES) {
  for (const [open, close] of [['[', ']'], ['【', '】'], ['（', '）']]) {
    const tagged = `${open}${cat}${close}你好，今天天气不错。`
    const byExtract = strip(extractTag(tagged).cleaned).length
    const byEffective = effectiveChars(tagged)
    ok(
      byExtract === byEffective,
      `标记字数一致：${open}${cat}${close}`,
      `extractTag 剩 ${byExtract} 字，effectiveChars 算 ${byEffective} 字`
    )
  }
}
console.log(`  ${CATEGORIES.length} 个类别 × 3 种括号写法，两种剥法算出的字数一致\n`)

// ---------------------------------------------------------------- 结论

console.log('\n=== 结论 ===\n')
if (!fails.length) {
  console.log(`  ✅ ${pass} 项断言全过（${CASES.length} 个用例）`)
  console.log('     改 sentence.js 之后一定要回来跑这个 —— 它是语音流水线的第一环。')
} else {
  console.log(`  ❌ ${fails.length}/${pass + fails.length} 项没过：`)
  for (const f of fails) console.log(`     · ${f}`)
  process.exitCode = 1
}
