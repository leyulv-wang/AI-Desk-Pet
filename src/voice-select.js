/**
 * 参考音频选择器
 *
 * GPT-SoVITS 每次合成都要吃一段参考音频 —— 那段音频的语气会「传染」给合成结果。
 * 所以「用哪条参考」直接决定她说这句话是什么味道。
 *
 * 朴素做法：情绪类别命中 → 从该类里随机挑一条。
 * 这个模块多做三件事，让挑出来的更贴：
 *
 *   ① 句式对齐  —— 回复是问句就优先配问句参考
 *      （问句的语调上扬是跨语言通用的，这一条收益最大）
 *   ② 长度接近  —— 参考音频的字数和回复差不多，节奏更自然
 *   ③ 冷却机制  —— 刚用过的不再用，避免连着两句听起来一模一样
 *
 * 最后加一点随机扰动，保证同类回复之间也有变化。
 *
 * 打分是加权相加，权重都提到 WEIGHTS 里，想调直接改。
 */

/** 各因素的权重 */
const WEIGHTS = {
  /** 语气强度（LLM 给的 1–3）作为基础分 */
  confidence: 1.0,
  /** 结尾标点一致 —— 问句/感叹句的语调差异很大，给最高权重 */
  punctMatch: 4.0,
  /** 长度差：每差 N 个字扣 1 分 */
  lengthPerChars: 14,
  lengthMaxPenalty: 3.0,
  /** 冷却：最近用过的扣分，越近扣越多 */
  recencyPenalty: 7.0,
  /** 随机扰动上限，保证同类之间的多样性 */
  jitter: 1.2,
}

/** 结尾标点归类 —— 语气最直接的线索 */
function classifyEnding(text) {
  const t = String(text || '').trim().replace(/[」』"']+$/, '')
  const last = t[t.length - 1] || ''
  if ('？?'.includes(last)) return '问'
  if ('！!'.includes(last)) return '叹'
  if ('…'.includes(last) || t.endsWith('...')) return '省略'
  return '陈述'
}

function charCount(text) {
  return String(text || '').replace(/\s/g, '').length
}

/**
 * 挑一条参考音频。
 *
 * @param {object} library  library.json 的内容（{ clips: [...] }）
 * @param {object} opts
 * @param {string} opts.text      要合成的回复文本
 * @param {string} opts.category  情绪类别（由 LLM 标注）
 * @param {string[]} [opts.recentIds] 最近用过的参考 id，新的在前
 * @param {function} [opts.random]    注入随机源，方便测试
 * @returns {{clip: object, score: number, reasons: string[]}|null}
 */
function pickReference(library, { text, category, recentIds = [], random = Math.random }) {
  const clips = library?.clips || []
  let cands = clips.filter((c) => c.category === category)

  // 类别里没有就退到「平静」，再没有就用全部
  if (!cands.length) cands = clips.filter((c) => c.category === '平静')
  if (!cands.length) cands = clips.slice()
  if (!cands.length) return null

  const wantPunct = classifyEnding(text)
  const wantLen = charCount(text)

  const scored = cands.map((clip) => {
    const reasons = []
    let score = (clip.confidence || 2) * WEIGHTS.confidence

    if (clip.endsWith === wantPunct) {
      score += WEIGHTS.punctMatch
      reasons.push(`句式都是「${wantPunct}」`)
    }

    const lenDiff = Math.abs((clip.chars || charCount(clip.text)) - wantLen)
    const lenPenalty = Math.min(WEIGHTS.lengthMaxPenalty, lenDiff / WEIGHTS.lengthPerChars)
    score -= lenPenalty
    if (lenPenalty < 0.4) reasons.push(`字数接近（差 ${lenDiff}）`)

    const recencyIdx = recentIds.indexOf(clip.id)
    if (recencyIdx >= 0) {
      // 最近一条扣满，越往前扣得越少
      const penalty = WEIGHTS.recencyPenalty * (1 - recencyIdx / Math.max(1, recentIds.length))
      score -= penalty
      reasons.push(`刚用过（-${penalty.toFixed(1)}）`)
    }

    score += random() * WEIGHTS.jitter

    return { clip, score, reasons }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored[0]
}

/**
 * 把 library 里的参考音频复制到工作目录，供 GPT-SoVITS 直接读。
 * （GPT-SoVITS 的 API 需要文件路径，不能直接吃网络/内存里的音频）
 */
function materialize(clip, srcDir, dstDir, fs, path) {
  const src = path.join(srcDir, clip.file)
  const dst = path.join(dstDir, clip.file)
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dstDir, { recursive: true })
    fs.copyFileSync(src, dst)
  }
  return dst
}

module.exports = { pickReference, classifyEnding, charCount, WEIGHTS, materialize }
