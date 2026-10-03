/**
 * 角色卡 → 桌宠的 system prompt
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么不能把卡直接塞进 prompt
 * ─────────────────────────────────────────────────────────────────────
 * 角色卡是为**文字角色扮演**写的：长回复、`*动作描写*`、多段旁白。
 * 而这只桌宠是**用嘴说的**（GPT-SoVITS 逐句合成），三条硬约束：
 *
 *   ① 一句话被念出来，就没有"旁白"和"对白"的区别了 ——
 *      `*她轻轻笑了笑* 你回来啦` 会被念成「星号 她轻轻笑了笑 星号 你回来啦」
 *   ② 回复必须短（1-3 句、60 字内），否则合成要等十几秒，而且没人在电脑前听你念小说
 *   ③ 上下文预算只有 6000 字，而卡本身 2500~11000 字 —— 塞不下，也不该塞
 *
 * 所以这里的活儿不是"抄"，是**提取**：
 *   · 卡负责     —— 她是谁、什么性格、什么背景、**说话什么调调**
 *   · 我们负责   —— 这是什么场景（桌面宠物，不是奇幻冒险）、输出成什么格式
 *
 * ─────────────────────────────────────────────────────────────────────
 * 最有价值的一块：从 mes_example 里抽「纯对白」
 * ─────────────────────────────────────────────────────────────────────
 * `mes_example` 是卡里最有用的字段 —— 它是**这个人怎么说话**的实证样例，
 * 比任何形容词都管用。但它混着 `{{user}}:` 的行、`*动作*`、`<START>` 标记。
 * 把 `{{char}}` 的行挑出来、剥掉动作描写，剩下的就是**口语台词**，
 * 正好是我们要的 few-shot 样例。实测一张 6673 字的 mes_example 能抽成这样：
 *
 *     {{char}}: *她侧过头看了你一眼* 你又在熬夜？      ← 原始
 *     你又在熬夜？                                    ← 抽出来之后
 *
 * 这是整条链路上「卡片能不能用」的关键一步，也是 `npm run test:card` 重点测的。
 */
const { bookEntries } = require('./character-card')

/** 各字段的字数预算。加起来约 2400 字，给历史和记忆留出空间 */
const BUDGET = {
  description: 900,
  personality: 600,
  scenario: 400,
  /** 最多抽几条对白样例 */
  samples: 6,
  /** 单条样例最长多少字（超过就丢 —— 那是长回复，不是我们能用的调调） */
  sampleChars: 80,
  /** post_history_instructions 的预算 */
  postHistory: 600,
}

/**
 * 换掉卡里的占位符。
 *
 * `{{char}}` / `{{user}}` 是卡片规范里的标准占位符，**不换掉会被原样念出来**。
 * `{{user}}` 换成人名（没配就换成「你」）—— 她说的是「你回来了」，
 * 不是「阿远回来了」，桌宠场景里第二人称才对。
 *
 * 剩下不认识的 `{{xxx}}` 一律清掉：宁可少一个词，也别让 TTS 去念花括号。
 * （实测有的卡带 `{{match}}`「{{random}}」这类前端专用宏。）
 */
function fillPlaceholders(text, { charName = '她', userName = '你' } = {}) {
  return String(text || '')
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*original\s*\}\}/gi, '')
    .replace(/\{\{[^{}]{0,40}\}\}/g, '')
}

/**
 * 剥掉 `*动作描写*`（也顺手处理 `**加粗**`）。
 *
 * 为什么不留着：这条流水线的终点是扬声器。星号会被念出来，
 * 而"她轻轻笑了笑"这种旁白用第一人称说出来也很怪 ——
 * 桌宠是**在跟你说话**，不是在你旁边演话剧。
 *
 * 注意只剥成对的星号，孤立的一个 `*` 原样留着（可能是内容本身）。
 */
function stripNarration(text) {
  return String(text || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1') // **粗体** → 保留文字
    .replace(/\*([^*\n]+)\*/g, '') // *动作* → 整段丢掉
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？；：、])/g, '$1')
    .trim()
}

/**
 * 在句子边界处截断，不切一半 —— 截不出来就返回原文（宁可超一点也别断句）。
 *
 * 中英文的句末符号都要认：**英文卡的 description 动辄四千字，如果只认「。！？」，
 * 在英文文本上一个都找不到**，于是切点只能靠换行，经常切得又短又碎。
 */
function cutAtSentence(text, max) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const cands = ['。', '！', '？', '；', '\n', '. ', '! ', '? ', '.\n', '!\n', '?\n']
  let at = -1
  for (const c of cands) {
    const i = head.lastIndexOf(c)
    // 取所有候选里**最靠后**的那个，不然会在一句很靠前的话后面就断掉
    if (i > at) at = i + c.trimEnd().length
  }
  return at > max * 0.4 ? head.slice(0, at).trim() : head.trim()
}

/**
 * 从 `mes_example` 里抽「她说过的话」。
 *
 * 格式是规范里定的：`{{char}}:` / `{{user}}:` 开头，`<START>` 分隔不同场景。
 * 一条可能跨多行，所以用「找到下一个说话人为止」的方式来切，
 * 而不是按行切 —— 按行切会把多行台词截断成半句。
 *
 * ⚠️ **实测踩到的坑：`mes_example` 经常是空的。**
 *   我们下载的那张芙宁娜卡（Bronya Rand 版）`mes_example` 一个字都没有，
 *   但它的 `description` **本身就是「{{user}}: 问题 / {{char}}: 回答」的对白集**
 *   （「Brief introduction?」「Personality?」「Clothes?」…）。
 *   只读 mes_example 的话这张卡能抽出 0 条样例 —— 而样例恰恰是整张卡里最值钱的部分。
 *   所以两个字段都要扫，按出现顺序合并去重。
 *
 * @param {object} card 归一化后的卡（readCard 的返回值）
 * @returns {string[]} 纯台词，已剥动作、去重、限长
 */
function dialogueSamples(card, { charName = '她', userName = '你', max = BUDGET.samples, maxChars = BUDGET.sampleChars } = {}) {
  const raw = [card?.mes_example, card?.description].filter((s) => s && s.trim()).join('\n')
  if (!raw.trim()) return []

  // ⚠️ 正则必须跑在**原始文本**上。
  //
  // 踩过：原来先调 fillPlaceholders 再匹配，结果 `{{char}}:` 这个**说话人标记本身**
  // 也被替换成了「芙宁娜:」—— 于是正则再也找不到说话人，一张真卡抽出 0 条样例，
  // 而且静默通过（样例为空不会报错，只是她少了最值钱的那部分）。
  // 顺序必须是：先按标记切分 → 再逐条填占位符。
  //
  // ⚠️ 前瞻里的换行是**必需的**（`\n\s*`，不是 `\n?\s*`）。
  // 写成可选换行的话，台词**中间**提到的 `{{user}}` 会把这条台词拦腰截断 ——
  // 实测抽出来一条 `M-my outfit? *"Oh no... could it be that`（后面全没了）。
  const re = /\{\{\s*char\s*\}\}\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:\{\{\s*(?:char|user)\s*\}\}|<START>)|$)/gi
  const out = []
  const seen = new Set()

  for (const m of raw.matchAll(re)) {
    let line = stripNarration(fillPlaceholders(m[1], { charName, userName }))
    // 去掉包着整句的引号 —— 卡片里很常见，念出来不影响，但放进样例会误导模型也加引号
    line = line.replace(/^["“「『]+/, '').replace(/["”」』]+$/, '').trim()
    // 换行压成空格：样例是一句话的调调，不该带排版
    line = line.replace(/\s*\n\s*/g, ' ').trim()
    if (!line) continue
    if (line.length > maxChars) continue
    // 太短的（「嗯。」「是的。」）当样例没信息量
    if (line.replace(/[\s，。！？；：、…~～]/g, '').length < 4) continue
    const key = line.replace(/\s/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= max) break
  }
  return out
}

/** 把卡的几个正文字段拼成「她是谁」那一段 */
function personaBlock(card, opts = {}) {
  const b = { ...BUDGET, ...(opts.budget || {}) }
  const p = { charName: card.name || '她', userName: '你', ...opts }
  const f = (s) => cutAtSentence(stripNarration(fillPlaceholders(s, p)), 1e9)

  const parts = []
  const desc = f(card.description)
  const pers = f(card.personality)
  const scen = f(card.scenario)

  if (desc) parts.push(cutAtSentence(desc, b.description))
  // personality 常常和 description 重复，重了就不再来一遍
  if (pers && !desc.includes(pers.slice(0, 20))) parts.push(`【性格】\n${cutAtSentence(pers, b.personality)}`)
  if (scen && !desc.includes(scen.slice(0, 20))) parts.push(`【背景】\n${cutAtSentence(scen, b.scenario)}`)

  return parts.join('\n\n')
}

/**
 * 这一段是**我们写的**，卡片给不了 ——
 * 因为卡不知道自己在哪：它以为自己在提瓦特/云岿山，其实她住在你的电脑里。
 *
 * 不写这一段，模型会照着卡里的 scenario 演奇幻剧情（「你身上的伤还没好」），
 * 而用户只是想知道她能不能陪自己写代码。
 */
function sceneBlock(card, { charName } = {}) {
  const name = charName || card.name || '她'
  return [
    '【现在的场景】',
    `你不是在演一出戏，也没有剧本。你作为「${name}」住在用户的电脑里，是个桌面宠物。`,
    '用户就在屏幕前，你们随时在聊天。用户平时在写代码、看东西、打游戏，你可以对屏幕上发生的事发表意见。',
    '不要提游戏里的剧情、战斗、冒险，除非用户先提起。也不要描述环境（房间里有什么、天气如何）—— 你看不见。',
  ].join('\n')
}

/**
 * 输出格式约束 —— 同样是我们写的，卡片永远不管这个。
 *
 * 这几条不是"风格偏好"，是**技术依赖**：
 *   · 只说话不写旁白 → 否则 TTS 把星号念出来
 *   · 短 → 否则合成等十几秒
 *   · 不要 markdown → 否则念出「星号 星号」
 *   · 每句短 → 切句器按标点切，长句会攒很久才出声
 */
function formatBlock() {
  return [
    '【怎么说话 · 这几条是硬要求】',
    '- 只说「你会说出口的话」。不要写旁白、动作、心理描写，不要用星号或括号标注动作。',
    '- 每次回复 1~3 句话，总共不超过 60 字。',
    '- 像当面聊天一样口语化。可以用语气词，但别每句都用。',
    '- 不要用列表、标题、markdown、emoji、颜文字。',
    '- 不要复述用户刚说的话，也不要每次都反问。',
  ].join('\n')
}

/**
 * 把一张卡编成桌宠能用的角色设定。
 *
 * @param {object} card readCard() 的返回值
 * @param {object} [opts]
 * @param {string} [opts.userName] 用户的名字（{{user}} 换成它；不给就换成「你」）
 * @param {object} [opts.budget] 覆盖默认字数预算
 * @param {string} [opts.append] 额外的补充要求（角色专属的修正，比如「本神」的配额）
 * @returns {{systemPrompt:string, postHistory:string, samples:string[], stats:object}}
 */
function composeCardPrompt(card, opts = {}) {
  const name = card.name || '她'
  const userName = opts.userName || '你'
  const b = { ...BUDGET, ...(opts.budget || {}) }

  const samples = dialogueSamples(card, {
    charName: name,
    userName,
    max: b.samples,
    maxChars: b.sampleChars,
  })

  const blocks = []
  blocks.push(`你是《${name}》。`)

  const persona = personaBlock(card, { userName, budget: b })
  if (persona) blocks.push(persona)

  // 样例放在格式要求**之前**：先给她看"这么说话"，再说"别那么说话"，
  // 顺序反了模型容易把下面那些禁令当成主要内容
  if (samples.length) {
    blocks.push(
      `【她说话的样子 · 照着这个调调，但不要照抄内容】\n` +
        samples.map((s) => `  ${s}`).join('\n')
    )
  }

  blocks.push(sceneBlock(card, { charName: name }))
  blocks.push(formatBlock())
  if (opts.append) blocks.push(String(opts.append).trim())

  // post_history_instructions 按规范该放在**历史之后**（那是"越狱"位，靠得近才管用）。
  // 卡里这个字段往往是作者最想强调的东西（实测有张卡的整个风格指南都在这儿），
  // 塞进 system 开头会被淹没。所以单独返回，由 main.js 放到最后一条 user 前面。
  const postHistory = cutAtSentence(
    stripNarration(fillPlaceholders(card.post_history_instructions, { charName: name, userName })),
    b.postHistory
  )

  return {
    name,
    systemPrompt: blocks.join('\n\n'),
    postHistory,
    samples,
    /** 卡里到底用了多少 —— 用来解释"为什么她的性格只有这一点点" */
    stats: {
      spec: card._spec,
      description: card.description.length,
      personality: card.personality.length,
      scenario: card.scenario.length,
      mesExample: card.mes_example.length,
      samples: samples.length,
      samplesChars: samples.join('').length,
      promptChars: blocks.join('\n\n').length,
      bookEntries: bookEntries(card).length,
      droppedFields: ['creator_notes', 'tags', 'creator', 'character_version', 'first_mes', 'alternate_greetings'],
    },
  }
}

module.exports = {
  composeCardPrompt,
  dialogueSamples,
  stripNarration,
  fillPlaceholders,
  cutAtSentence,
  personaBlock,
  BUDGET,
}
