/**
 * 看看一张角色卡里到底装了什么
 *   node scripts/inspect-card.mjs "D:\SillyTavern\SillyTavern\data\default-user\characters\xxx.png"
 *   node scripts/inspect-card.mjs --dir "D:\...\characters"
 *
 * 只读不改，用来决定「哪些字段值得进 prompt、哪些必须丢掉」。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { readCard, cardSpec, readPngTextChunks } = require(join(ROOT, 'src', 'character-card.js'))

const argv = process.argv.slice(2)
const dirArg = (argv.find((a) => a.startsWith('--dir=')) || '').slice(6)
const files = []
if (dirArg) {
  const d = resolve(dirArg)
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isFile() && /\.(png|json|charx)$/i.test(f)) files.push(p)
  }
} else {
  // 注意别写 `.map(resolve)` —— resolve 收多个参数，map 会把下标和数组也传进去，
  // 报的错是「paths[2] 必须是字符串」，跟路径本身一点关系都没有
  files.push(...argv.filter((a) => !a.startsWith('--')).map((p) => resolve(p)))
}

if (!files.length) {
  console.error('用法：node scripts/inspect-card.mjs <卡文件...>  |  --dir=<目录>')
  process.exit(1)
}

for (const f of files) {
  console.log('='.repeat(78))
  console.log(basename(f))
  console.log('='.repeat(78))
  let card
  try {
    card = readCard(f)
  } catch (e) {
    console.log(`  ❌ 读不出来：${e.message}`)
    continue
  }
  const spec = card._spec
  console.log(`  规格：${spec}`)
  // readCard 返回的已经是摊平过的对象了，所以这里直接当平铺用
  const d = card

  // 卡里到底塞在哪个 PNG 文本块 —— 决定「换工具导出后还读不读得出来」
  try {
    const chunks = readPngTextChunks(readFileSync(f))
    if (chunks.size) console.log(`  PNG 文本块：${[...chunks.keys()].join('、')}`)
  } catch {}
  console.log(`  原始顶层字段：${Object.keys(card._raw || {}).join('、')}`)
  console.log(`  摊平后字段：${Object.keys(card).filter((k) => k !== '_raw').join('、')}`)

  // 尖括号占位符 —— 直接用会原样念出来，必须先替换
  const all = JSON.stringify(card)
  const ph = [...new Set((all.match(/\{\{[a-z_]+\}\}/gi) || []).map((s) => s.toLowerCase()))]
  if (ph.length) console.log(`  占位符：${ph.join('、')}`)

  // 角色扮演痕迹：星号动作、多段、引号对白 —— 这些念出来会很怪
  const mes = String(d.mes_example || '') + String(d.first_mes || '') + String(d.description || '')
  const stars = (mes.match(/\*[^*\n]{2,}\*/g) || []).length
  if (stars) console.log(`  ⚠️ 星号动作描写 ${stars} 处（\\*她笑了笑\\* 这种，TTS 会把星号念出来）`)

  const strFields = [
    'name', 'creator', 'character_version', 'creator_notes', 'system_prompt',
    'post_history_instructions', 'description', 'personality', 'scenario',
    'first_mes', 'mes_example',
  ]
  for (const k of strFields) {
    const v = d[k]
    if (!v) continue
    const s = String(v)
    console.log(`\n  ── ${k}（${s.length} 字）`)
    console.log(s.split('\n').map((l) => '     ' + l).join('\n'))
  }

  if (Array.isArray(d.alternate_greetings) && d.alternate_greetings.length) {
    console.log(`\n  ── alternate_greetings：${d.alternate_greetings.length} 条`)
    for (const g of d.alternate_greetings.slice(0, 2)) {
      console.log(`     · 「${String(g).slice(0, 80)}…」`)
    }
  }
  if (Array.isArray(d.tags) && d.tags.length) console.log(`\n  ── tags：${d.tags.join('、')}`)

  if (d.character_book) {
    const entries = d.character_book.entries || []
    console.log(`\n  ── character_book（世界书）：${entries.length} 条`)
    for (const e of entries.slice(0, 8)) {
      const keys = (e.keys || []).join('|')
      console.log(`     · [${keys}] → ${String(e.content || '').slice(0, 60).replace(/\n/g, ' ')}…`)
    }
  }

  const ext = d.extensions || {}
  const extKeys = Object.keys(ext)
  if (extKeys.length) console.log(`\n  ── extensions：${extKeys.join('、')}`)

  const known = new Set([...strFields, 'alternate_greetings', 'tags', 'character_book', 'extensions', 'group_only_greetings', 'assets', 'nickname', 'creator_notes_multilingual', 'source', 'creation_date', 'modification_date'])
  const unknown = Object.keys(d).filter((k) => !known.has(k))
  if (unknown.length) console.log(`\n  ── 其它字段：${unknown.join('、')}`)

  const total = strFields.reduce((a, k) => a + String(d[k] || '').length, 0)
  console.log(`\n  ── 上面这些正文字段合计 ${total} 字`)
  console.log('')
}
