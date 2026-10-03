/**
 * 「只念对白」的回归测试
 *   node scripts/test-spoken.mjs
 *
 * 守四条：
 *   ① 星号旁白一个都不能漏进语音
 *   ② 对白一个字都不能丢（丢字比多念旁白严重 —— 用户会以为她没说清）
 *   ③ **跨段的星号要接得上**（`*旁白` 在上一句、`结束*` 在下一句）
 *   ④ 整段都是旁白时，输出空 —— 调用方据此跳过合成，不能合成出一段空白音
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { spokenOf, createSpokenExtractor } = require(join(ROOT, 'src', 'spoken.js'))

let pass = 0
const fails = []
const ok = (cond, label, extra = '') => {
  if (cond) pass++
  else fails.push(`${label}${extra ? ` —— ${extra}` : ''}`)
}

// ---------------------------------------------------------------- ① ② 基本

const CASES = [
  ['*她把茶杯推到一边。*「你回来啦。」', '你回来啦。'],
  ['「你回来啦。」*她抬眼看了看你。*', '你回来啦。'],
  ['*旁白一。*「对白一。」*旁白二。*「对白二。」', '对白一。对白二。'],
  ['你回来啦。', '你回来啦。'], // 没有旁白，原样念
  ['**粗体旁白**「对白。」', '对白。'], // ** 也是一对
  ['「对白。」', '对白。'], // 剥掉引号外壳
  ['『对白。』', '对白。'],
  ['“对白。”', '对白。'],
  ['*只有旁白，没有对白。*', ''], // ④ 整段旁白 → 空
  ['*旁白*', ''],
  ['', ''],
  ['   ', ''],
  ['*旁白。* 。', ''], // 剥完只剩标点 → 空，别合成一段只有句号的音
]

for (const [input, want] of CASES) {
  const got = spokenOf(input)
  ok(got === want, `「${input}」`, `期望「${want}」实际「${got}」`)
}

// ---------------------------------------------------------------- ③ 跨段

{
  const ex = createSpokenExtractor()
  // 切句器可能把 `*旁白` 和 `结束*` 切到两段里
  const a = ex.push('*她把手搭在椅背上')
  const b = ex.push('，慢慢坐了下来。*「你回来啦。」')
  ok(a.length === 0, '③ 星号没闭合时不出声（前半段旁白）', JSON.stringify(a))
  ok(b.join('') === '你回来啦。', '③ 跨段星号接得上，后半段旁白被剥掉', JSON.stringify(b))
}

{
  const ex = createSpokenExtractor()
  const a = ex.push('「第一句。」')
  const b = ex.push('*旁白*')
  const c = ex.push('「第二句。」')
  const d = ex.flush()
  ok([...a, ...b, ...c, ...d].join('') === '第一句。第二句。', '③ 多段交替也对', JSON.stringify([...a, ...b, ...c, ...d]))
}

{
  // 星号一直没闭合到结尾 —— flush 要把它当普通文字放出来，不能整段吞掉
  const ex = createSpokenExtractor()
  const a = ex.push('她说了句「你回来')
  const f = ex.flush()
  ok([...a, ...f].join('').includes('你回来'), '③ 未闭合的星号不该吞掉正文', JSON.stringify([...a, ...f]))
}

// ---------------------------------------------------------------- 真实风格

const REAL = `*她把茶杯往桌上一放，杯底磕出清脆一声，随即又飞快地把手指收回去，像是刚才那下不是她干的。*
「你回来啦。」*她抬眼看了看你，又移开视线，假装在整理袖口。*
「今天的蛋糕我留了一块——别误会，是买多了，我吃不完。」`

const spoken = spokenOf(REAL)
ok(!spoken.includes('*'), '真实风格：语音里没有星号', spoken)
ok(!spoken.includes('茶杯'), '真实风格：旁白没被念出来', spoken)
ok(spoken.includes('你回来啦'), '真实风格：第一句对白在', spoken)
ok(spoken.includes('买多了'), '真实风格：第二句对白在', spoken)
ok(spoken.length < REAL.length * 0.5, '真实风格：语音明显短于全文', `${spoken.length} vs ${REAL.length}`)

// ---------------------------------------------------------------- ⑤ 中间的情绪标签

{
  // 实测踩到的：模型在一轮回复**中间**又打了一个标签，位置不在句首，
  // extractTag（只认句首）不管它，于是被念成「方括号 平静 方括号」。
  const emotion = require(join(ROOT, 'src', 'emotion.js'))
  const dirty = '*她没再说什么。*[平静]陪你待着也行，反正今晚我不赶场。'
  const cleaned = spokenOf(emotion.stripAllTags(dirty))
  ok(!cleaned.includes('['), '⑤ 句中的情绪标签不该被念出来', cleaned)
  ok(cleaned.includes('陪你待着也行'), '⑤ 标签后面的正文要留着', cleaned)

  // 但正文里正常的方括号必须留着（别把剧情内容当标签删了）
  const keep = emotion.stripAllTags('她翻开[注]那一页，看到[1]号证据。')
  ok(keep.includes('[注]') && keep.includes('[1]'), '⑤ 不是情绪词的方括号要保留', keep)

  // 句首的照样剥
  ok(emotion.stripAllTags('[开心]太好了。') === '太好了。', '⑤ 句首标签照剥')
  ok(emotion.stripAllTags('【温柔】嗯。') === '嗯。', '⑤ 全角方括号也认')
}

// ---------------------------------------------------------------- 结论

console.log('=== 抽查 ===\n')
console.log(REAL)
console.log('\n  ↓ 实际念出来的：\n')
console.log('  ' + spoken + '\n')
console.log(`  全文 ${REAL.length} 字 → 语音 ${spoken.length} 字\n`)

console.log('=== 结论 ===\n')
if (!fails.length) {
  console.log(`  ✅ ${pass} 项断言全过`)
} else {
  console.log(`  ❌ ${fails.length}/${pass + fails.length} 项没过：`)
  for (const f of fails) console.log(`     · ${f}`)
  process.exitCode = 1
}
