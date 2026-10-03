/**
 * 读角色卡（SillyTavern / Character Card V1·V2·V3）
 *
 * 为什么要有这个模块：
 *   角色卡是社区里沉淀了好几年的东西 —— 一张好卡里的人格描述、说话风格样例
 *   （`mes_example`）比我们自己现写的档案强得多。硬要自己写，就是在重新发明它。
 *
 * 格式（[V2 规范](https://github.com/malfoyslastname/character-card-spec-v2)）：
 *   · 卡就是一个 PNG，人格 JSON 塞在 PNG 的文本块里
 *   · 块名 `chara`，内容是 **base64(JSON)**
 *   · V3 多塞一个块 `ccv3`（同样是 base64(JSON)），`chara` 保留一份 V2 形态做向下兼容
 *   · 也有直接给 `.json` 的（没图，只有数据）
 *
 * 本模块只负责「读出来 + 摊平」，不做任何 prompt 取舍 ——
 * 「哪些字段进 prompt」是 `character-card-prompt.js` 的事。
 * 分开是因为读格式有规范可依（能写测试），而取舍是审美（要能随时改）。
 */
const fs = require('fs')
const zlib = require('zlib')

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const isPng = (buf) => buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIG)

/**
 * 把 PNG 里所有文本块抠出来。
 *
 * 处理三种块（PNG 规范里的 tEXt / zTXt / iTXt）：
 *   tEXt —— 关键字\0文本
 *   zTXt —— 关键字\0压缩方法(1字节)\0 zlib 压缩后的文本
 *   iTXt —— 关键字\0压缩标志(1)压缩方法(1)语言标签\0翻译关键字\0文本
 *
 * 为什么三种都要认：不同工具存卡的方式不一样（SillyTavern 存 tEXt，
 * 有的编辑器存 zTXt 省体积），只认 tEXt 会有一批卡读不出来，
 * 而失败的方式是"卡是空白的"，很难查。
 *
 * @returns {Map<string,string>} 关键字 → 文本（同名取第一个）
 */
function readPngTextChunks(buf) {
  const out = new Map()
  if (!isPng(buf)) return out

  let pos = 8
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = pos + 8
    if (body + len + 4 > buf.length) break // 截断的文件，别读越界

    try {
      if (type === 'tEXt') {
        const raw = buf.subarray(body, body + len)
        const z = raw.indexOf(0)
        if (z > 0) {
          const key = raw.toString('latin1', 0, z)
          // PNG 文本块按规范是 latin1，但实际存的是 UTF-8 字节，得按 UTF-8 解
          if (!out.has(key)) out.set(key, raw.subarray(z + 1).toString('utf8'))
        }
      } else if (type === 'zTXt') {
        const raw = buf.subarray(body, body + len)
        const z = raw.indexOf(0)
        if (z > 0) {
          const key = raw.toString('latin1', 0, z)
          // z 后面是 1 字节压缩方法（0 = zlib），再往后才是数据
          const data = raw.subarray(z + 2)
          if (!out.has(key)) out.set(key, zlib.inflateSync(data).toString('utf8'))
        }
      } else if (type === 'iTXt') {
        const raw = buf.subarray(body, body + len)
        const z = raw.indexOf(0)
        if (z > 0) {
          const key = raw.toString('latin1', 0, z)
          const compressed = raw[z + 1] === 1
          // 压缩方法(1) + 语言标签\0 + 翻译关键字\0 + 文本
          let p = z + 3
          p = raw.indexOf(0, p) + 1 // 跳过语言标签
          p = raw.indexOf(0, p) + 1 // 跳过翻译关键字
          const data = raw.subarray(p)
          if (!out.has(key)) out.set(key, (compressed ? zlib.inflateSync(data) : data).toString('utf8'))
        }
      }
    } catch {
      // 单个块坏了不该让整张卡读不出来 —— 继续找下一个
    }

    if (type === 'IEND') break
    pos = body + len + 4
  }
  return out
}

/** base64(JSON) → 对象。解不出来返回 null，不抛 */
function decodeB64Json(b64) {
  try {
    return JSON.parse(Buffer.from(String(b64).trim(), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * 读一张卡，返回**归一化**后的平铺对象。
 *
 * 归一化做什么：
 *   · V2/V3 的字段都藏在 `data` 里，V1 是平铺的 → 统一成平铺
 *   · 补上缺失的字段（空字符串 / 空数组），调用方不用到处判 undefined
 *   · 记下这张卡原来是哪个规格（`_spec`）
 *
 * @param {string} file .png / .json
 * @returns {object} 归一化后的卡
 * @throws {Error} 文件不存在 / 不是卡 / 读不出 JSON
 */
function readCard(file) {
  if (!fs.existsSync(file)) throw new Error(`没有这个文件：${file}`)
  const buf = fs.readFileSync(file)

  let card = null

  if (isPng(buf)) {
    const chunks = readPngTextChunks(buf)
    // V3 优先 —— 它信息更全，而且 V2 那份是兼容用的副本
    card = decodeB64Json(chunks.get('ccv3')) || decodeB64Json(chunks.get('chara'))
    if (!card) {
      const keys = [...chunks.keys()]
      throw new Error(
        keys.length
          ? `PNG 里没有 chara / ccv3 文本块（找到的是：${keys.join('、')}）—— 这大概不是角色卡`
          : 'PNG 里一个文本块都没有 —— 这大概不是角色卡'
      )
    }
  } else if (/\.charx$/i.test(file)) {
    throw new Error('charx（V3 的 zip 格式）还没支持 —— 在酒馆里导出成 PNG 再试')
  } else {
    try {
      card = JSON.parse(buf.toString('utf8'))
    } catch (e) {
      throw new Error(`不是 PNG 也不是合法 JSON：${e.message}`)
    }
  }

  return normalizeCard(card)
}

/** 判规格：v1 / v2 / v3 / unknown */
function cardSpec(card) {
  const spec = card?.spec || card?.data?.spec
  if (spec === 'chara_card_v3') return 'v3'
  if (spec === 'chara_card_v2') return 'v2'
  if (card?.data && typeof card.data === 'object' && typeof card.data.name === 'string') return 'v2'
  if (typeof card?.name === 'string') return 'v1'
  return 'unknown'
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const arr = (v) => (Array.isArray(v) ? v : [])

/**
 * 摊平 + 补默认值。V1 平铺、V2/V3 在 data 里，这里统一成平铺。
 * 未知字段**保留**（规范要求编辑器不许丢未知字段，我们也照做）。
 *
 * 实测的一个坑：酒馆导出的 V3 卡里，`data` 里有一套完整的字段，
 * **顶层还并排放着一份老格式的扁平副本**（为了向下兼容老前端）。
 * 所以不能只读 `data` —— 两份要合并，以 `data` 为准、扁平那份兜底。
 * 只读 `data` 时，那些「有扁平副本、data 里反而缺字段」的卡会莫名其妙少东西。
 */
function normalizeCard(card) {
  const spec = cardSpec(card)
  const data = card?.data && typeof card.data === 'object' ? card.data : {}
  const d = spec === 'v1' ? card : { ...card, ...data }

  return {
    _spec: spec,
    _raw: card,

    name: str(d.name),
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    first_mes: str(d.first_mes),
    mes_example: str(d.mes_example),

    creator_notes: str(d.creator_notes),
    system_prompt: str(d.system_prompt),
    post_history_instructions: str(d.post_history_instructions),
    alternate_greetings: arr(d.alternate_greetings).map(str).filter(Boolean),
    character_book: d.character_book || null,

    tags: arr(d.tags).map(str),
    creator: str(d.creator),
    character_version: str(d.character_version),
    extensions: d.extensions && typeof d.extensions === 'object' ? d.extensions : {},
  }
}

/**
 * 世界书条目整理成统一的形状。
 *
 * 只保留我们真会用的字段 —— 规范里还有 position / priority / insertion_order 之类，
 * 那是给酒馆那种「按顺序拼进上下文」的前端用的，我们走的是检索，
 * 用不上（我们的记忆系统本来就是 BM25 ⊕ 向量，见 src/retrieve.js）。
 */
function bookEntries(card) {
  const entries = arr(card?.character_book?.entries)
  return entries
    .filter((e) => e && e.enabled !== false && str(e.content).trim())
    .map((e) => ({
      keys: arr(e.keys).map(str).map((k) => k.trim()).filter(Boolean),
      secondaryKeys: arr(e.secondary_keys).map(str).map((k) => k.trim()).filter(Boolean),
      content: str(e.content).trim(),
      constant: e.constant === true,
      selective: e.selective === true,
      caseSensitive: e.case_sensitive === true,
      name: str(e.name || e.comment),
    }))
    .filter((e) => e.keys.length || e.constant)
}

module.exports = { readCard, normalizeCard, cardSpec, readPngTextChunks, bookEntries }
