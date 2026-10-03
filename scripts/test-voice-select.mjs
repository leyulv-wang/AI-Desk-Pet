/**
 * 演示参考音频选择器的行为
 *   node scripts/test-voice-select.mjs
 *
 * 看三件事：
 *   ① 句式对齐有没有生效（问句配问句）
 *   ② 长度接近有没有生效
 *   ③ 冷却机制（不会连着两次用同一条）
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { pickReference, classifyEnding, charCount } = require('../src/voice-select.js')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const lib = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))
console.log(`参考库: ${lib.clips.length} 条，类别 ${lib.categories.join(' / ')}\n`)

console.log('=== 参考库全貌 ===')
for (const cat of lib.categories) {
  const list = lib.clips.filter((c) => c.category === cat)
  console.log(`\n【${cat}】${list.length} 条`)
  for (const c of list) {
    console.log(`  ${c.endsWith}·${c.lenBucket}  ${String(c.seconds).padStart(4)}s  v${c.confidence}  「${c.text.slice(0, 40)}${c.text.length > 40 ? '…' : ''}」`)
  }
}

// ---------------------------------------------------------------- 模拟对话

console.log('\n\n=== 模拟对话：看她会给每句话配哪条参考 ===')

const CONVO = [
  ['开心', '嘿嘿，今天你来得真早呀！'],
  ['平静', '嗯，我在这儿呢，你说吧。'],
  ['惊讶', '诶？这个东西是怎么弄出来的？'],
  ['温柔', '辛苦啦，先歇一会儿吧。'],
  ['生气', '哼，又把我晾在一边不管了！'],
  ['难过', '……你都不理我。'],
  ['开心', '太好了！终于搞定了！'],
  ['开心', '嗯嗯。'],                       // 短句，看长度匹配
  ['惊讶', '真的假的？'],
  ['平静', '原来是这么回事。'],
]

const recent = []
for (const [cat, text] of CONVO) {
  const r = pickReference(lib, { text, category: cat, recentIds: recent })
  if (!r) { console.log(`  「${text}」 → 没得选`); continue }
  console.log(`\n  【${cat}】「${text}」`)
  console.log(`      句式 ${classifyEnding(text)} · ${charCount(text)} 字`)
  console.log(`      → ${r.clip.endsWith}·${r.clip.lenBucket} ${r.clip.seconds}s 「${r.clip.text.slice(0, 34)}…」`)
  console.log(`      理由: ${r.reasons.length ? r.reasons.join('、') : '（仅按类别+随机）'}  得分 ${r.score.toFixed(2)}`)
  recent.unshift(r.clip.id)
  if (recent.length > 6) recent.pop()
}

// ---------------------------------------------------------------- 冷却验证

console.log('\n\n=== 冷却机制验证：同一类别连说 8 次 ===')
const happyPool = lib.clips.filter((c) => c.category === '开心').length
const picks = []
const rec2 = []
for (let i = 1; i <= 8; i++) {
  const r = pickReference(lib, { text: '嗯嗯，我知道啦！', category: '开心', recentIds: rec2 })
  picks.push(r.clip.id.slice(0, 8))
  rec2.unshift(r.clip.id)
  if (rec2.length > 4) rec2.pop()
}
console.log(`  连续 8 次选到: ${picks.join(' → ')}`)
const uniq = new Set(picks).size
console.log(`  用到了 ${uniq} 条不同的参考（该类别共 ${happyPool} 条可选）${uniq >= 3 ? ' ✅ 有轮换' : ' ⚠️ 轮换不足'}`)
const consecutive = picks.filter((p, i) => i > 0 && p === picks[i - 1]).length
console.log(`  连续两次相同: ${consecutive} 次 ${consecutive === 0 ? '✅' : '⚠️'}`)

// ---------------------------------------------------------------- 句式对齐统计

console.log('\n\n=== 句式对齐效果统计（跑 200 次随机回复）===')
const TESTS = [
  ['开心', '真的吗？'], ['开心', '太棒了！'], ['开心', '我知道了。'],
  ['平静', '你说什么？'], ['平静', '原来如此。'], ['平静', '这样啊……'],
  ['惊讶', '怎么会？'], ['惊讶', '哇！'], ['生气', '别闹了！'],
]
let punctHit = 0
let total = 0
for (const [cat, text] of TESTS) {
  const want = classifyEnding(text)
  let hit = 0
  for (let i = 0; i < 25; i++) {
    const r = pickReference(lib, { text, category: cat })
    if (r.clip.endsWith === want) hit++
  }
  total += 25
  punctHit += hit
  console.log(`  ${want}句「${text}」→ 配到${want}句参考 ${hit}/25 次（${Math.round((hit / 25) * 100)}%）`)
}
console.log(`\n  整体句式命中率 ${Math.round((punctHit / total) * 100)}%`)
console.log(`  （建库时保证了每个类别四种句尾尽量齐全，所以能到 100%。随机挑的期望值是 25%）`)
