/**
 * 流式句子切分
 *
 * 为什么需要它：
 * GPT-SoVITS 合成一句话要 1.5~2 秒。如果等 LLM 把整段回复写完再送去合成，
 * 用户按下回车后要等 3~4 秒才听到声音。
 *
 * 但如果 LLM 一边吐字、我们一边按句号切，第一句一完整就立刻送去合成，
 * 那么「她开始说话」的等待就只剩「第一句写完 + 合成一句」。
 * 后面几句在她念第一句的时候并行合成，听起来就是连续的。
 *
 * 这个模块就是那个增量切分器：喂碎片进去，吐出已经完整的句子。
 */

/** 句末标点。省略号用 …（U+2026），但流式里也可能是三个句点，两种都认 */
const ENDERS = new Set(['。', '！', '？', '!', '?', '；', ';', '…'])

/** 句末标点后面常见的收尾符号，应该跟着上一句一起切走 */
const TRAILERS = new Set([
  '\u300D', // 」
  '\u300F', // 』
  '"',
  '\u201D', // 右双引号
  '\u2019', // 右单引号
  '\uFF09', // ）
  ')',
  '\u3011', // 】
  ']',
  '\uFF5E', // ～
  '~',
])

/** 长句兜底时的次级切点 */
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':'])

/**
 * 句首的括号标记 —— 情绪标签（`[开心]` / `【开心】` / `（开心）`）之类。
 *
 * 和 `src/emotion.js` 的 `extractTag` 认的是**同一套写法**：那边负责真剥，
 * 这边只用来**数有效字数**。改一边记得改另一边，
 * `scripts/test-splitter.mjs` 里有一条断言盯着两者别走偏。
 */
const LEADING_MARK = /^\s*[[【（(]\s*[^\]】)）\n]{1,6}?\s*[\]】)）]\s*[:：,，。.、-]?\s*/

/**
 * 有效字数：去掉句首标记、去掉空白之后的字数。
 * 判断「够不够长」一律用它，**别用 `.length`**。
 *
 * 为什么要去掉句首标记 —— 实测踩到的第二个洞：
 *   `[开心]陪你？` 用 `.length` 数出来是 6 个字，**刚好越过 minChars=6**，
 *   于是「陪你？」被单独发出去合成（标签在 acceptSegment 里才剥掉）。
 *   而它和「诶？」是同一类东西：两三个字，合成极不稳，
 *   这一次 3 次重试**全部失败**（有声占比 37% / 33% / 44%），最后放出去的是一段哑音。
 */
const effectiveChars = (s) =>
  String(s || '')
    .replace(LEADING_MARK, '')
    .replace(/\s/g, '').length

const DEFAULTS = {
  /**
   * 短于这个字数的句子先攒着，跟下一句拼起来 —— 太短的片段 GPT-SoVITS 念得很怪。
   *
   * 6 → 10 是改成角色扮演之后调的。原来 6 是按「短句闲聊」定的，
   * 而角色扮演的句尾经常是「好。」「嗯。」「谢谢。」这种一两字的收束句，
   * 各自成段的话既浪费一次合成、又特别容易出废片
   * （实测短段落的废片率明显偏高，一轮 3 句能触发 3 次重试）。
   */
  minChars: 10,
  /** 超过这个字数还没遇到句号就硬切，否则一句话能拖到几百字 */
  maxChars: 48,
}

/**
 * 找第一个句末标点应该切在哪儿。找不到返回 -1。
 *
 * 单独抽出来是因为**要扫两遍**：一遍找本句的切点，一遍看下一句写到哪儿了
 * （短句要拼进下一句，见 drain）。两处必须用同一套省略号/换行规则，
 * 各写一份迟早走偏 —— 这个文件里「…」被从中间切开的坑已经踩过一次了。
 */
function findCut(text) {
  for (let i = 0; i < text.length; i++) {
    if (ENDERS.has(text[i])) {
      // 「...」当省略号处理：吃掉连续的点
      let cut = i + 1
      while (cut < text.length && (text[cut] === '.' || text[cut] === '…')) cut++
      return cut
    }
    if (text[i] === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
      let cut = i + 3
      while (cut < text.length && text[cut] === '.') cut++
      return cut
    }
    if (text[i] === '\n') return i + 1
  }
  return -1
}

/** 把「句末标点 + 收尾符号 + 空白」一起吃掉，返回真正的切点 */
function eatTail(text, cut) {
  let end = cut
  while (end < text.length && TRAILERS.has(text[end])) end++
  while (end < text.length && /\s/.test(text[end])) end++
  return end
}

/**
 * 建一个增量切分器。
 * @param {object} [opts]
 * @param {number} [opts.minChars]
 * @param {number} [opts.maxChars]
 */
function createSplitter(opts = {}) {
  const { minChars, maxChars } = { ...DEFAULTS, ...opts }
  let buf = ''

  /** 从 buf 里切出所有完整句子 */
  function drain(force = false) {
    const out = []

    for (;;) {
      const text = buf
      if (!text) break

      const cut = findCut(text)

      if (cut < 0) {
        // 没有句末标点。太长就找个逗号硬切，不然一直等
        if (text.length > maxChars) {
          let soft = -1
          for (let i = maxChars; i >= Math.floor(maxChars / 2); i--) {
            if (SOFT_BREAKS.has(text[i])) {
              soft = i + 1
              break
            }
          }
          if (soft > 0) {
            out.push(text.slice(0, soft).trim())
            buf = text.slice(soft)
            continue
          }
          if (text.length > maxChars * 1.8) {
            out.push(text.slice(0, maxChars).trim())
            buf = text.slice(maxChars)
            continue
          }
        }
        break
      }

      /**
       * 太短的句子要拼进下一句，**绝不单独发出去**。
       *
       * 这里原来有个洞，实测踩到了：条件写的是「短句 + 后面还有内容时，
       * 拼起来不超过 maxChars 就继续等」—— 反过来说，**一旦拼起来超过 maxChars，
       * 那个短句就单独发出去了**。于是流式回复
       *     「诶？你、你居然学我说话！「本神」这个词是……」
       * 被切成「诶？」+「你、你居然学我说话！」+……
       *
       * 而 GPT-SoVITS 拿一两个字去合成很不稳：实测「诶？」3 次里 **2 次**
       * 吐出近乎全零的片子（0.40s、只有 15% 的样本有声、RMS 0.0023，正常 0.09）。
       * 表现是她张嘴先哑半秒 —— 用户听到的就是「卡了一下」。
       *
       * 现在的规则：
       *   · 一路拼到够长为止 —— 可能不止拼一句，「嗯。好。行。可以。」要拼三次
       *   · 下一句还没写完 → 等，宁可让缓冲区长一点，也不发两个字的小段
       *   · 万一拼出来实在太长（下一句是个几百字不带标点的怪物），退回硬切兜底
       *
       * 注意「拼到够长」必须是个**循环**：只拼一句的话
       * 「嗯。好。」还是只有 4 个字，等于没修 —— 这个坑写第一版时就踩了。
       */
      let end = eatTail(text, cut)

      if (!force && end < text.length) {
        let tooLong = false
        while (effectiveChars(text.slice(0, end)) < minChars) {
          const nxt = findCut(text.slice(end))
          if (nxt < 0) break // 下一句还没写完
          const merged = eatTail(text, end + nxt)
          if (merged > maxChars * 2) {
            tooLong = true
            break
          }
          end = merged
        }
        if (tooLong) {
          // 下一句太长了，别为了拼短句造出一个巨型片段
          out.push(text.slice(0, maxChars).trim())
          buf = text.slice(maxChars)
          continue
        }
        // 拼完还是太短 → 只可能是「下一句还没写完」，等下一块
        if (effectiveChars(text.slice(0, end)) < minChars) break
      }

      // 切点正好落在缓冲区末尾 → 先别急着发。
      //
      // 因为流式输入里，终结符到的时候我们还不知道它是不是完整的：
      //   · 「…」可能是「……」的前一半（实测被从中间切开，变成一句收尾 + 一句起头）
      //   · 「。」后面可能还跟一个「」』」
      // 等下一个 token 来了再决定，代价是几十毫秒；流结束时 flush 会强制吐出来，不会卡住。
      if (!force && end >= text.length) break

      out.push(text.slice(0, end).trim())
      buf = text.slice(end)
    }

    // 兜一层：正常路径不该再出现相邻短段，但硬切兜底那条路可能造出来
    return mergeShort(out.filter(Boolean), minChars)
  }

  return {
    /** 喂一个增量片段，返回这次新切出来的完整句子（可能 0 个或多个） */
    feed(delta) {
      buf += delta
      return drain(false)
    },
    /** 流结束，把剩下的都吐出来 */
    flush() {
      const out = drain(true)
      const tail = buf.trim()
      buf = ''
      if (tail) out.push(tail)
      return mergeShort(out, minChars)
    },
    get pending() {
      return buf
    },
    reset() {
      buf = ''
    },
  }
}

/** 一次性切分（非流式场景，测试和归档摘要用） */
function splitSentences(text, opts = {}) {
  const s = createSplitter(opts)
  return [...s.feed(String(text || '')), ...s.flush()]
}

/**
 * 把过短的片段并进下一句。
 *
 * 为什么需要：流式切分为了尽早开工，短句先攒着，但如果流到这儿就结束了，
 * 剩下的「嗯。」「好。」会各自变成一个合成任务 —— GPT-SoVITS 拿两三个字
 * 去合成，韵律会非常怪（像机器人在念字）。
 */
function mergeShort(segments, minChars) {
  const out = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    if (prev && effectiveChars(prev) < minChars) {
      out[out.length - 1] = prev + seg
    } else {
      out.push(seg)
    }
  }
  return out
}

/**
 * 这段念完之后该停多久（毫秒）。
 *
 * 为什么由句尾标点决定、而不是播放层写死一个固定间隔：
 *   合成出来的每段都自带首尾静音，实测首部 0.07~0.71s 乱跳、尾部约 0.22s，
 *   加上播放层固定的 70ms 间隔 → 实际句间停顿约 0.77s，是自然停顿（0.2~0.4s）的 2~3 倍，
 *   而且忽长忽短。用户的原话是「像一句一句蹦出来，停顿怪」。
 *
 *   现在 tts.js 会把首尾静音裁掉（只留一点点余量），停顿改由标点决定 ——
 *   可控，而且和语义一致：欲言又止留白最长，问完等对方次之。
 *
 * @param {string} text 已切好的一句话
 * @returns {number} 毫秒
 */
function pauseAfter(text) {
  const t = String(text || '').trim().replace(/[」』"'）)】\]]+$/, '')
  const last = t[t.length - 1] || ''
  if (last === '…' || t.endsWith('...')) return 380 // 欲言又止
  if ('？?'.includes(last)) return 300 // 问完等对方
  if ('；;'.includes(last)) return 280
  if ('！!'.includes(last)) return 230
  return 260 // 陈述句
}

module.exports = { createSplitter, splitSentences, mergeShort, pauseAfter, effectiveChars, DEFAULTS }
