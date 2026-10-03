/**
 * 情境反应（角色卡世界书的运行时）
 *
 * 干什么：用户提到某个话题时，把她对这个话题的现成反应拼进上下文。
 *
 * 为什么需要：
 *   桌宠最常遇到的不是"难题"，是"没话找话" —— 下雨了、早上好、好无聊、晚上吃什么。
 *   这些场合她不能每次都从头编，编出来还容易跑偏。
 *   角色卡的世界书恰好就是干这个的（酒馆里也是这个用途），而且实测那 18 条
 *   不少是照官方语音写的 —— 比自己编强。
 *
 * 为什么用**关键词**匹配而不是向量检索：
 *   ① 世界书的语义就是"命中这个词就注入这段"，规范里 `keys` 字段就是这么定的
 *   ② 它必须**可预测**。用户说「下雨」她就该提水位，不该因为向量相似度差 0.02 而不提。
 *      记忆检索可以模糊（记错一件小事没人在意），但"她怎么突然说起下雨"很出戏。
 *   ③ 零成本 —— 不用调 embedding，不用等
 *   我们的记忆系统（事实/历史）走 BM25⊕向量，那套负责"记得你这个人"；
 *   这套负责"对眼前这个话题有反应"，两者职责不重叠。
 *
 * 匹配的两个坑：
 *   · **英文 key 要卡词边界**。卡里的 key 有 `Fun`、`Rain`，用子串匹配的话
 *     "function" 会命中 "Fun"、"brain" 会命中 "Rain"。
 *   · **中文 key 不能卡词边界**（中文没空格）。「下雨天」得能命中 key「下雨」，
 *     所以中文走子串匹配。
 */
const fs = require('fs')
const path = require('path')

/** 一次最多注入几条 / 总共多少字。情境反应是佐料，不能挤掉记忆和历史 */
const MAX_ENTRIES = 2
const MAX_CHARS = 320

/** 纯 ASCII 的 key 走词边界匹配，含中文的走子串匹配 */
const isAscii = (s) => /^[\x00-\x7F]+$/.test(s)

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {object} opts
 * @param {string} opts.file  assets/lore/<id>.scenes.json
 * @param {Function} [opts.log]
 */
function createLore({ file, log = () => {} } = {}) {
  let data = null
  let error = null

  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    // 没有这个文件是**正常情况**（不是每个角色都有世界书），不当错误
    if (e.code !== 'ENOENT') {
      error = `读不到 ${file}：${e.message}`
      log(`[lore] ${error}`)
    }
  }

  const entries = (data?.entries || []).filter((e) => e && e.content && Array.isArray(e.keys) && e.keys.length)

  /** 每条预先编译好匹配器，别每次请求都重新建正则 */
  const compiled = entries.map((e) => ({
    entry: e,
    // 长的 key 更具体，命中它应该比命中一个短词更有说服力
    matchers: e.keys.map((k) => {
      const key = String(k).trim()
      if (!key) return null
      if (isAscii(key)) {
        return { key, re: new RegExp(`(^|[^A-Za-z0-9])${escapeRe(key)}([^A-Za-z0-9]|$)`, 'i'), weight: key.length }
      }
      return { key, re: null, weight: key.length }
    }).filter(Boolean),
  }))

  /**
   * 挑出该注入的条目。
   * @param {string} text 用户这句话
   * @returns {Array<{id:string, keys:string[], content:string, score:number}>}
   */
  function match(text) {
    const t = String(text || '')
    if (!t.trim() || !compiled.length) return []

    const hits = []
    for (const c of compiled) {
      const matched = []
      let score = 0
      for (const m of c.matchers) {
        const ok = m.re ? m.re.test(t) : t.includes(m.key)
        if (ok) {
          matched.push(m.key)
          score += m.weight
        }
      }
      if (matched.length) hits.push({ ...c.entry, keys: matched, score })
    }

    // 分数高的优先；同分按原顺序（世界书里的顺序是作者排的，有意义）
    hits.sort((a, b) => b.score - a.score)

    const out = []
    let used = 0
    for (const h of hits) {
      if (out.length >= MAX_ENTRIES) break
      if (used + h.content.length > MAX_CHARS && out.length) break
      out.push(h)
      used += h.content.length
    }
    return out
  }

  return {
    /** 有哪些条目（设置面板/自检看） */
    get entries() {
      return entries.map((e) => ({ id: e.id, keys: e.keys, from: e.from, content: e.content }))
    },
    get count() {
      return entries.length
    },
    get error() {
      return error
    },
    /** 数据来源，启动日志里报一下 */
    get source() {
      return data?._来源 || null
    },
    match,

    /**
     * 拼成能直接塞进 system 的一段。
     *
     * 措辞上特意做了两件事：
     *   · 「可以参考、也可以自己说」—— 不然她会把每条反应当成必须复读的台词
     *   · 「场合对不上就只借调子」—— 关键词匹配天生会误伤。
     *     实测「蛋糕」被挂到过「下午好」那条上，你晚上带块蛋糕她会说「下午好呀」。
     *     与其指望把每个 key 都调准（调不完），不如让模型自己发现时间不对就只借语气。
     */
    block(text) {
      const got = match(text)
      if (!got.length) return { text: '', picked: got }
      const lines = got.map((g) => `- 说到「${g.keys[0]}」时，她的反应大概是这样：「${g.content}」`)
      return {
        text:
          '【这个话题她有自己的说法 · 参考这个反应，保持同样的调子，也可以自己说】\n' +
          lines.join('\n') +
          '\n（如果这条反应和眼前的场合对不上 —— 比如时间不对、说的不是同一件事 —— 就只借那个语气，别照搬内容。）',
        picked: got,
      }
    },
  }
}

module.exports = { createLore, MAX_ENTRIES, MAX_CHARS }
