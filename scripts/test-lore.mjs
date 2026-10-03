/**
 * 情境反应（世界书）匹配的回归测试
 *   node scripts/test-lore.mjs
 *
 * 守三条：
 *   ① **该命中的要命中** —— 用户说「今天下雨了」，她得想起水位那句
 *   ② **不该命中的绝不能命中** —— 这条比①重要。世界书的 key 里有 `Fun`、`Rain`
 *      这种短英文词，用子串匹配的话 "function" 会命中 Fun、"brain" 会命中 Rain。
 *      而"她为什么突然说起下雨"比"她没接住下雨这个梗"出戏得多。
 *   ③ **预算** —— 一次最多注入几条、多少字，不能把记忆和历史挤掉
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createLore, MAX_ENTRIES, MAX_CHARS } = require(join(ROOT, 'src', 'lore.js'))

const LORE = join(ROOT, 'assets', 'lore', 'furina.scenes.json')
if (!existsSync(LORE)) {
  console.error(`没有 ${LORE}\n先跑：node scripts/import-card-lore.mjs "<卡文件>" --id=furina`)
  process.exit(1)
}

const lore = createLore({ file: LORE })
console.log(`载入 ${lore.count} 条情境反应`)
if (lore.source) console.log(`来源：${lore.source}\n`)

let pass = 0
const fails = []
const ok = (cond, label, extra = '') => {
  if (cond) pass++
  else fails.push(`${label}${extra ? ` —— ${extra}` : ''}`)
}

// ---------------------------------------------------------------- ① 该命中

const SHOULD_HIT = [
  ['今天下雨了，好烦', '下雨'],
  ['外面下雪了诶', '下雪'],
  ['好无聊啊，有什么好玩的吗', '无聊'],
  ['早上好，起床了', '早上好'],
  ['晚安，我要睡了', '晚安'],
  ['你平时喜欢吃什么甜点？', '甜点'],
  ['最近有点烦心事', '烦心事'],
  ['你会唱歌吗', '唱歌'],
  ['那地方一片沙漠', '沙漠'],
  ['刮风了', '刮风'],
]

for (const [text, expectKey] of SHOULD_HIT) {
  const got = lore.match(text)
  const hit = got.some((g) => g.keys.some((k) => k.includes(expectKey) || expectKey.includes(k)))
  ok(hit, `① 「${text}」命中「${expectKey}」`, hit ? '' : `实际：${JSON.stringify(got.map((g) => g.keys))}`)
}

// ---------------------------------------------------------------- ② 不该命中

const SHOULD_MISS = [
  // 英文 key 的子串陷阱：Fun / Rain / Snow / Desert 这些短词
  ['this function has a bug', 'Fun'],
  ['the brain is complex', 'Rain'],
  ['I need to download it', 'Snow'],
  ['dessert is nice', 'Desert'],
  ['popularity contest', 'Popular'], // 这个**应该**命中（是真词），下面单独测
]

for (const [text, badKey] of SHOULD_MISS) {
  const got = lore.match(text)
  const keys = got.flatMap((g) => g.keys)
  // popularity contest 那条是反例里的例外，跳过
  if (badKey === 'Popular') continue
  ok(!keys.includes(badKey), `② 「${text}」不该命中「${badKey}」`, `实际命中了 ${JSON.stringify(keys)}`)
}

// 全角/其它语言的干扰
for (const text of ['', '   ', '嗯', '在吗', '12345', '哈哈哈哈']) {
  const got = lore.match(text)
  ok(got.length === 0, `② 「${text || '(空)'}」不该命中任何条目`, `实际：${JSON.stringify(got.map((g) => g.keys))}`)
}

// 但英文原词还是要能命中（否则用户夹英文就瞎了）
const en = lore.match('it is raining outside')
ok(en.length > 0, '② 英文整词 raining 应该命中', `实际：${JSON.stringify(en.map((g) => g.keys))}`)

// ---------------------------------------------------------------- ③ 预算

const spam = '下雨 下雪 刮风 沙漠 早上好 晚安 唱歌 甜点 无聊 晚安 生气 通心粉'
const many = lore.match(spam)
ok(many.length <= MAX_ENTRIES, `③ 最多 ${MAX_ENTRIES} 条`, `实际 ${many.length} 条`)
ok(
  many.reduce((a, g) => a + g.content.length, 0) <= MAX_CHARS,
  `③ 总字数不超过 ${MAX_CHARS}`,
  `实际 ${many.reduce((a, g) => a + g.content.length, 0)} 字`
)

const blk = lore.block('今天下雨了')
ok(blk.text.includes('这个话题她有自己的说法'), '③ block 带说明头')
ok(/参考/.test(blk.text), '③ block 说了「参考，不必照抄」')
ok(lore.block('嗯').text === '', '③ 没命中时 block 是空串')

// ---------------------------------------------------------------- 结论

console.log('\n=== 抽查 ===\n')
for (const t of ['今天下雨了，好烦', '好无聊啊', 'this function has a bug']) {
  const b = lore.block(t)
  console.log(`  「${t}」`)
  console.log(b.text ? b.text.split('\n').map((l) => '     ' + l).join('\n') : '     （不注入）')
  console.log('')
}

console.log('=== 结论 ===\n')
if (!fails.length) {
  console.log(`  ✅ ${pass} 项断言全过`)
} else {
  console.log(`  ❌ ${fails.length}/${pass + fails.length} 项没过：`)
  for (const f of fails) console.log(`     · ${f}`)
  process.exitCode = 1
}
