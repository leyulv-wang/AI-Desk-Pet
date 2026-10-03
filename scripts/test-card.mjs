/**
 * 角色卡读取 + 转 prompt 的回归测试
 *   node scripts/test-card.mjs
 *   node scripts/test-card.mjs "<真实卡文件>"     # 额外拿真卡跑一遍
 *
 * 为什么用**自己造的** PNG 而不是仓库里放一张真卡：
 *   真卡是别人的同人作品（作者保留著作权），不该进仓库。
 *   而这里要测的是**格式解析**，自己拼一张符合规范的 PNG 就够了，
 *   而且能把 tEXt / zTXt / iTXt 三种块、V1/V2/V3 三种规格都覆盖到 ——
 *   真卡只能覆盖它自己那一种。
 *
 * 守这些：
 *   ① 三种 PNG 文本块都读得出来（真实世界的卡三种都有）
 *   ② V2/V3 字段在 data 里、V1 平铺、**V3 还并排一份扁平副本** —— 都要读对
 *   ③ 只认 chara/ccv3，别的 PNG 要报错而不是返回空卡
 *   ④ 转 prompt：占位符要换、星号要去、`mes_example` 空了要从 description 里抽
 *   ⑤ 预算：卡再大也不能把 prompt 撑爆
 */
import { createRequire } from 'node:module'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { readCard, cardSpec, bookEntries } = require(join(ROOT, 'src', 'character-card.js'))
const { composeCardPrompt, stripNarration, fillPlaceholders, dialogueSamples, BUDGET } = require(join(ROOT, 'src', 'character-card-prompt.js'))

let pass = 0
const fails = []
const ok = (cond, label, extra = '') => {
  if (cond) pass++
  else fails.push(`${label}${extra ? ` —— ${extra}` : ''}`)
}

const TMP = mkdtempSync(join(tmpdir(), 'card-test-'))

// ---------------------------------------------------------------- 造 PNG

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  // 我们的读取器不校验 CRC，但填真的更接近真实文件
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0)
  return Buffer.concat([len, body, crc])
}
const IHDR = (() => {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(1, 0)
  d.writeUInt32BE(1, 4)
  d[8] = 8
  d[9] = 6
  return chunk('IHDR', d)
})()
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IEND = chunk('IEND', Buffer.alloc(0))

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

function makePng(kind, obj) {
  let textChunk
  if (kind === 'tEXt') {
    textChunk = chunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(b64(obj), 'utf8')]))
  } else if (kind === 'zTXt') {
    textChunk = chunk('zTXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from([0]), zlib.deflateSync(Buffer.from(b64(obj), 'utf8'))]))
  } else {
    // iTXt: keyword\0 flag(1) method(1) lang\0 translated\0 text
    textChunk = chunk('iTXt', Buffer.concat([
      Buffer.from('chara\0', 'latin1'), Buffer.from([0, 0]), Buffer.from('\0\0', 'latin1'), Buffer.from(b64(obj), 'utf8'),
    ]))
  }
  return Buffer.concat([SIG, IHDR, textChunk, IEND])
}

// ---------------------------------------------------------------- 造卡

const V2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '测试角色',
    description: '{{char}}是一个测试角色。\n{{user}}: 你是谁？\n{{char}}: *她抬起下巴* 哼，我是{{char}}，记好了。\n{{user}}: 喜欢什么？\n{{char}}: 甜的东西——尤其是马卡龙，别问为什么。',    personality: '骄傲，嘴硬，其实很怕孤单。',
    scenario: '{{user}}在一间咖啡馆里遇到了{{char}}。',
    first_mes: '*她转过头* 哦？是你啊。',
    mes_example: '', // ← 关键：真卡经常是空的，对白藏在 description 里
    creator_notes: '不该进 prompt',
    post_history_instructions: '保持傲娇，不要ooc。',
    tags: ['test'],
    creator: 'tester',
    character_version: '1.0',
    alternate_greetings: ['第二版问候'],
    character_book: {
      entries: [
        { keys: ['下雨'], content: '{{char}}: 下雨了啊……', enabled: true },
        { keys: ['关闭'], content: '这条是关掉的', enabled: false },
        { keys: [], content: '没 key 也没 constant，应被丢掉', enabled: true },
      ],
    },
    extensions: {},
  },
}

// V3：data 里一套 + 顶层并排一份扁平副本（酒馆导出就是这样，实测过）
const V3 = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: { ...V2.data, description: '{{char}}是 V3 数据段里的描述。' },
  // 扁平副本，比 data 旧 —— 不该盖掉 data
  description: '这是顶层那份老的扁平描述，不该被用',
  name: '顶层旧名字',
}

const V1 = {
  name: '老卡',
  description: '{{char}}是一张 V1 的卡，没有 spec 字段。',
  personality: '简单',
  scenario: '',
  first_mes: '你好。',
  mes_example: '{{char}}: 这是 V1 的样例台词。',
}

// ---------------------------------------------------------------- ① 三种块

for (const kind of ['tEXt', 'zTXt', 'iTXt']) {
  const f = join(TMP, `${kind}.png`)
  writeFileSync(f, makePng(kind, V2))
  try {
    const c = readCard(f)
    ok(c.name === '测试角色', `① ${kind} 读得出名字`, `读到「${c.name}」`)
  } catch (e) {
    ok(false, `① ${kind} 读得出名字`, e.message)
  }
}

// ---------------------------------------------------------------- ② 三种规格

{
  const f = join(TMP, 'v2.json')
  writeFileSync(f, JSON.stringify(V2))
  const c = readCard(f)
  ok(c._spec === 'v2', '② JSON v2 判对规格', c._spec)
  ok(c.description === V2.data.description, '② v2 字段从 data 里取')
}

{
  const f = join(TMP, 'v3.png')
  writeFileSync(f, makePng('tEXt', V3))
  const c = readCard(f)
  ok(c._spec === 'v3', '② V3 判对规格', c._spec)
  // 关键：data 里的新版要赢过顶层的扁平旧版
  ok(c.description.includes('V3 数据段'), '② V3 以 data 为准，不被顶层扁平副本盖掉', c.description.slice(0, 30))
  ok(c.name === '测试角色', '② V3 名字取 data 的', c.name)
}

{
  const f = join(TMP, 'v1.json')
  writeFileSync(f, JSON.stringify(V1))
  const c = readCard(f)
  ok(c._spec === 'v1', '② V1 判对规格', c._spec)
  ok(c.name === '老卡', '② V1 平铺字段读得到')
}

// ---------------------------------------------------------------- ③ 非卡文件要报错

{
  const f = join(TMP, 'notacard.png')
  writeFileSync(f, Buffer.concat([SIG, IHDR, chunk('tEXt', Buffer.from('Comment\0hello', 'latin1')), IEND]))
  let err = null
  try { readCard(f) } catch (e) { err = e.message }
  ok(!!err && /chara|ccv3/.test(err), '③ 普通 PNG 要报错，不能返回空卡', err || '(没报错)')
}

// ---------------------------------------------------------------- ④ 转 prompt

const card = readCard(join(TMP, 'v2.json'))
const built = composeCardPrompt(card, { userName: '阿远' })

ok(!/\{\{/.test(built.systemPrompt), '④ prompt 里不能残留 {{占位符}}', (built.systemPrompt.match(/\{\{[^}]*\}\}/) || [])[0] || '')
ok(built.systemPrompt.includes('阿远'), '④ {{user}} 换成了配置的名字')
ok(!/\*[^*\n]+\*/.test(built.systemPrompt), '④ prompt 里不能残留 *动作描写*', (built.systemPrompt.match(/\*[^*\n]+\*/) || [])[0] || '')
ok(built.samples.length > 0, '④ mes_example 为空时，要从 description 里抽到样例', `抽到 ${built.samples.length} 条`)
ok(built.samples.some((s) => s.includes('马卡龙')), '④ 抽出来的样例是纯台词（含马卡龙那句）', JSON.stringify(built.samples))
ok(built.systemPrompt.includes('桌面宠物'), '④ 场景段说明她是桌面宠物')
ok(built.systemPrompt.includes('不要写旁白'), '④ 格式段有「不写旁白」这条硬要求')
ok(!built.systemPrompt.includes('不该进 prompt'), '④ creator_notes 不能进 prompt（规范要求）')
ok(built.postHistory.includes('傲娇'), '④ post_history_instructions 单独返回', built.postHistory)

// 反向：确实不该出现的东西
for (const banned of ['creator_notes', 'alternate_greetings', 'tags']) {
  ok(!built.systemPrompt.includes(banned), `④ prompt 里不该有 ${banned} 这类展示性字段`)
}

// 台词**中间**提到的 {{user}} 不能把这条台词拦腰截断。
// 实测真卡上抽出过 `M-my outfit? *"Oh no... could it be that`（后面全丢了），
// 原因就是前瞻里的换行写成了可选的。
{
  const c = readCard((() => {
    const f = join(TMP, 'midline.json')
    writeFileSync(f, JSON.stringify({
      spec: 'chara_card_v2',
      data: {
        name: 'T',
        description: '{{user}}: 衣服？\n{{char}}: 我的衣服怎么了，{{user}}，你是在嫌弃我吗？这可是精心搭配的。\n{{user}}: 下一个问题',
        mes_example: '',
      },
    }))
    return f
  })())
  const s = dialogueSamples(c, { charName: 'T', userName: '你' })
  ok(s.length === 1, '④ 句中带 {{user}} 的台词照样抽得出来', `抽到 ${JSON.stringify(s)}`)
  ok(s[0] && s[0].includes('精心搭配'), '④ 句中带 {{user}} 的台词没被截断', JSON.stringify(s[0]))
  ok(s[0] && !s[0].includes('{{'), '④ 句中 {{user}} 被换掉了', JSON.stringify(s[0]))
}

// ---------------------------------------------------------------- ⑤ 预算

// 造一张超大卡，确认预算压得住
const Huge = JSON.parse(JSON.stringify(V2))
Huge.data.description = '这是一段很长的描述。'.repeat(400)
Huge.data.personality = '性格段落。'.repeat(300)
Huge.data.scenario = '场景段落。'.repeat(300)
Huge.data.mes_example = Array.from({ length: 40 }, (_, i) => `{{char}}: 这是第${i}条样例台词，长度大概二十来个字。`).join('\n')
const hb = composeCardPrompt(readCard((() => {
  const f = join(TMP, 'huge.json')
  writeFileSync(f, JSON.stringify(Huge))
  return f
})()))

const cap = BUDGET.description + BUDGET.personality + BUDGET.scenario + BUDGET.samples * BUDGET.sampleChars + 1200
ok(hb.systemPrompt.length < cap, `⑤ 超大卡的 prompt 被压到 ${cap} 字以内`, `实际 ${hb.systemPrompt.length} 字`)
ok(hb.samples.length <= BUDGET.samples, `⑤ 样例条数不超过 ${BUDGET.samples}`, `实际 ${hb.samples.length}`)
ok(hb.systemPrompt.length > 800, '⑤ 压过头也不行（她还得有性格）', `只有 ${hb.systemPrompt.length} 字`)

// ---------------------------------------------------------------- 工具函数

ok(stripNarration('*她笑了笑* 你回来啦') === '你回来啦', 'stripNarration 剥星号', stripNarration('*她笑了笑* 你回来啦'))
ok(stripNarration('**重点**在这') === '重点在这', 'stripNarration 保留粗体文字')
ok(stripNarration('3 * 4 = 12') === '3 * 4 = 12', 'stripNarration 不动孤立的星号')
ok(fillPlaceholders('{{char}}看着{{user}}', { charName: '芙宁娜', userName: '你' }) === '芙宁娜看着你', 'fillPlaceholders 替换')
ok(!fillPlaceholders('{{random}}哈哈哈').includes('{{'), 'fillPlaceholders 清掉不认识的宏')
ok(bookEntries(card).length === 1, 'bookEntries 过滤掉 disabled 和无 key 的条目', `剩 ${bookEntries(card).length} 条`)
ok(dialogueSamples({ description: '', mes_example: '' }).length === 0, 'dialogueSamples 空卡返回空数组')

// ---------------------------------------------------------------- 真实卡（可选）

const realPath = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (realPath) {
  console.log(`\n=== 真实卡：${realPath} ===\n`)
  const rc = readCard(realPath)
  const rb = composeCardPrompt(rc)
  console.log(`  规格 ${rc._spec}  名字 ${rc.name}  作者 ${rc.creator}`)
  console.log(`  正文字段 ${rc.description.length + rc.personality.length + rc.scenario.length + rc.mes_example.length} 字 → prompt ${rb.systemPrompt.length} 字`)
  console.log(`  抽出样例 ${rb.samples.length} 条：`)
  for (const s of rb.samples) console.log(`     · ${s.slice(0, 70)}`)
  console.log(`  世界书 ${bookEntries(rc).length} 条`)
  ok(rb.systemPrompt.length > 0, '真实卡也转得出 prompt')
  ok(!/\{\{/.test(rb.systemPrompt), '真实卡 prompt 无残留占位符')
}

// ---------------------------------------------------------------- 结论

console.log('\n=== 结论 ===\n')
if (!fails.length) {
  console.log(`  ✅ ${pass} 项断言全过`)
} else {
  console.log(`  ❌ ${fails.length}/${pass + fails.length} 项没过：`)
  for (const f of fails) console.log(`     · ${f}`)
  process.exitCode = 1
}
