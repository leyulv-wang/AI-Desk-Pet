/**
 * 把角色卡的世界书抽出来、翻成中文，做成我们可以按关键词触发的「情境反应」
 *   node scripts/import-card-lore.mjs "<卡文件>" --id=furina
 *
 * 为什么需要这一步：
 *   角色卡里的 `character_book`（世界书）是**她对具体话题的现成反应** ——
 *   下雨、下雪、被夸人气、早上好、晚上好、喜欢吃什么……
 *   这些正好是桌宠最缺的东西：日常闲聊时她不能每次都从头编。
 *
 *   实测拿到的这张卡里，18 条有 3649 字，而且不少是照着**官方语音逐字**写的
 *   （比如「晚上好」那条就是游戏里谢贝蕾妲小姐减肥那段）。
 *   比自己编强得多。
 *
 * 但直接搬过来不能用，三个原因：
 *   ① 是英文的 —— 我们的桌宠说中文
 *   ② 带 `*动作描写*` —— 会被 TTS 念出来
 *   ③ 语气是「在任水神」的 —— 我们自己的人设是卸任后，得统一
 *
 * 所以让 LLM 翻一遍，并且**用我们的人设口吻翻**，而不是逐字直译。
 * 输出落在 assets/lore/<id>.scenes.json，由 src/lore.js 按关键词触发。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { readCard, bookEntries } = require(join(ROOT, 'src', 'character-card.js'))

const CARD = process.argv.slice(2).find((a) => !a.startsWith('--'))
const ID = (process.argv.find((a) => a.startsWith('--id=')) || '').split('=')[1] || 'furina'
const DRY = process.argv.includes('--dry')

if (!CARD) {
  console.error('用法：node scripts/import-card-lore.mjs "<卡文件>" [--id=furina] [--dry]')
  process.exit(1)
}

// ---------------------------------------------------------------- Key

function regVar(n) {
  if (process.platform !== 'win32') return null
  try {
    const o = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', n], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    const m = o.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}
function dshCred(n) {
  const p = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(p)) return null
  const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${n}\\s*:\\s*(\\S+)\\s*$`, 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}

const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const KEY = (cfg.apiKey || '').trim() || process.env.DEEPSEEK_API_KEY || regVar('DEEPSEEK_API_KEY') || dshCred('DEEPSEEK_API_KEY')
if (!KEY) {
  console.error('没找到 DEEPSEEK_API_KEY')
  process.exit(1)
}

// ---------------------------------------------------------------- 抽条目

const card = readCard(CARD)
const entries = bookEntries(card)
if (!entries.length) {
  console.error('这张卡没有世界书')
  process.exit(1)
}

console.log(`卡：${card.name}（${card._spec}）`)
console.log(`世界书：${entries.length} 条，${entries.reduce((a, e) => a + e.content.length, 0)} 字\n`)

/** 只把 {{char}} 那一句挑出来 —— {{user}} 那半句是酒馆的提问模板，我们不需要 */
function charLine(content) {
  const m = String(content).match(/\{\{\s*char\s*\}\}\s*[:：]\s*([\s\S]*)$/i)
  return (m ? m[1] : content).trim()
}

const payload = entries.map((e, i) => ({
  i,
  keys: e.keys,
  text: charLine(e.content),
}))

// ---------------------------------------------------------------- 翻译

const SYS = `你在给一只**中文**桌面宠物准备「情境反应」素材。这个桌宠扮演《原神》的芙宁娜，时期是**卸任水神之后**。

给你若干条英文素材，每条是她对某个话题的一句反应。请把它们改写成中文口语台词。

要求：
1. 翻成中文，但**不要逐字直译** —— 按下面的人设口吻重写，像她真的会说的话。
2. 删掉所有动作描写（英文里的 *...* 部分），只留她说出口的话。
3. 每条**不超过 40 个字**，1~2 句。
4. 她默认自称「我」。「本神」极少用，只在得意、端着架子时偶尔出现，一整条最多一次。
5. 保留她的调调：舞台腔、爱面子、嘴硬心软、句尾语气词（哦/嘛/啦/呀/哼）。
6. 卸任后的她更生活化：提甜点、茶会、通心粉、剧团、购物都可以；不要提水神身份、预言、白淞镇这类沉重旧事。
7. 顺便给每条生成 2~4 个**中文触发词**（用户可能怎么提起这个话题），要口语化、简短。
8. **专有名词必须用官方简中译名**，别自己音译。已知对照：
   Crabaletta → 谢贝蕾妲小姐；The Queen's Crown → 《王后的荣冠》；
   Furina → 芙宁娜；Fontaine → 枫丹；Opera Epiclese → 歌剧院；Neuvillette → 那维莱特；
   Navia → 娜维娅；Charlotte → 夏洛蒂；Wriothesley → 莱欧斯利；Clorinde → 克洛琳德。
   英文素材里凡是人名/作品名，都先想一下官方简中叫什么。

只输出 JSON，不要别的：
{"items":[{"i":0,"content":"中文台词","keys":["触发词1","触发词2"]}]}`

const userMsg = JSON.stringify(payload, null, 1)

console.log('调用 LLM 翻译…')
const t0 = Date.now()
const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: cfg.model || 'deepseek-flash',
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.6,
    // deepseek-flash 是推理模型，会先吐 reasoning_content，max_tokens 给小了会截断
    max_tokens: 8000,
  }),
})

if (!res.ok) {
  console.error(`❌ ${res.status} ${await res.text()}`)
  process.exit(1)
}
const json = await res.json()
const content = json.choices?.[0]?.message?.content || ''
console.log(`返回 ${content.length} 字（${Date.now() - t0}ms）`)

const m = content.match(/\{[\s\S]*\}/)
if (!m) {
  console.error('❌ 没找到 JSON：\n' + content.slice(0, 800))
  process.exit(1)
}
let parsed
try {
  parsed = JSON.parse(m[0])
} catch (e) {
  console.error(`❌ JSON 解析失败：${e.message}\n` + m[0].slice(0, 800))
  process.exit(1)
}

const items = parsed.items || []
console.log(`解析出 ${items.length} 条\n`)

/**
 * 生成完之后要手工剔掉的触发词。key = 条目的英文原名（`from`），值 = 不许当触发词的词。
 *
 * 为什么需要：LLM 分配触发词是按"语义相关"来的，不看**场合对不对**。
 * 实测踩到的：它把「蛋糕」挂到了「下午好」那条上 ——
 * 于是你晚上给她带块蛋糕，她会回一句「下午好呀～我的蛋糕呢？」，时间完全不对。
 * 这类错误在 prompt 里说不清楚（每次生成换一批词），只能事后钉死。
 */
const KEY_FIXES = {
  Afternoon: ['蛋糕'], // 该归 Favorite Food 那条（那条本来就有「甜点」）
}

// ---------------------------------------------------------------- 组装

const out = []
for (const it of items) {
  const src = payload[it.i]
  if (!src || !it.content) continue
  const drop = new Set(KEY_FIXES[src.keys[0]] || [])
  const cnKeys = Array.isArray(it.keys) ? it.keys.map((k) => String(k).trim()).filter((k) => k && !drop.has(k)) : []
  // 原本的英文 key 留着 —— 用户偶尔会夹英文，没坏处
  const keys = [...new Set([...cnKeys, ...src.keys])]
  if (!keys.length) continue
  out.push({
    id: `scene-${it.i}`,
    keys,
    content: String(it.content).trim(),
    from: src.keys[0],
  })
}

out.sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]))

console.log('=== 结果 ===\n')
for (const e of out) {
  console.log(`[${e.from}] 触发词 ${e.keys.join('、')}`)
  console.log(`   「${e.content}」\n`)
}

if (DRY) {
  console.log('--dry，不写文件')
} else {
  const dir = join(ROOT, 'assets', 'lore')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${ID}.scenes.json`)
  writeFileSync(
    file,
    JSON.stringify(
      {
        _说明: '从角色卡世界书导入的情境反应。由 src/lore.js 按触发词匹配，命中就拼进上下文。',
        _来源: `角色卡：${card.name} by ${card.creator || '未知'}（世界书 ${entries.length} 条，用 ${cfg.model || 'deepseek-flash'} 翻成中文并改写为卸任后口吻）`,
        _导入时间: new Date().toISOString().slice(0, 10),
        id: ID,
        entries: out,
      },
      null,
      2
    ) + '\n'
  )
  console.log(`✅ 写入 ${file}（${out.length} 条）`)
}

/**
 * 别用 process.exit()。
 *
 * 踩过：脚本活干完了、输出全对，退出码却是 1，控制台还甩一句
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
 * 原因是 fetch（undici）的 keep-alive 连接还挂着，这时硬 exit 会撞上 libuv 的
 * 句柄断言。退出码 1 会让 `&&` 链断掉，看起来像脚本失败了 —— 其实没失败。
 * 让它自己跑完、自然退出就好。
 */
