/**
 * 交互逻辑：对话、字幕、历史浮层、缩放、鼠标穿透协调
 *
 * 界面结构（从下往上）：
 *   按钮条 → 输入栏 → 字幕（最近一轮） → 角色
 *   历史记录是浮层，默认藏着，点「历史」才开。
 *
 * 穿透规则：
 *   鼠标压在「角色轮廓」或任意 .interactive 元素上 → 关穿透，可以点
 *   其它地方 → 开穿透，点击落到桌面上
 * 主进程用了 setIgnoreMouseEvents(true, { forward: true })，
 * 所以穿透状态下渲染层依然收得到 mousemove —— 整套机制靠这个成立。
 */
;(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)

  const logEl = $('chat-log')
  const historyPanel = $('history-panel')
  const formEl = $('input-bar')
  const inputEl = $('input-text')
  const sendBtn = $('btn-send')
  const stopBtn = $('btn-stop')
  const dotEl = $('status-dot')
  const badgeEl = $('chat-badge')
  const toastEl = $('zoom-toast')
  const subtitleEl = $('subtitle')
  const subMeEl = $('sub-me')
  const subPetEl = $('sub-pet')
  const memCountEl = $('mem-count')

  /** 发给模型的历史由主进程组装，这里只留显示用的状态 */
  let maxHistory = 20

  let currentId = null
  let currentText = ''
  let currentUserText = ''
  let mockMode = false
  let speechPending = false
  let playbackState = { speaking: false, loading: false, busy: false }

  // ------------------------------------------------------------ 状态

  function setDot(state) { dotEl.className = 'dot' + (state ? ' ' + state : '') }

  function setBadge(text) {
    if (text) { badgeEl.textContent = text; badgeEl.hidden = false }
    else badgeEl.hidden = true
  }

  function setBusy(busy) {
    sendBtn.disabled = busy
    refreshPlaybackControls()
    if (!busy) setDot(mockMode ? 'mock' : '')
  }

  function refreshPlaybackControls() {
    const audioBusy = playbackState.busy || window.petVoice.busy
    stopBtn.hidden = !(currentId || speechPending || audioBusy)
    $('btn-quiet-stop').hidden = !collapsed || stopBtn.hidden
    stopBtn.textContent = currentId ? '停止' : playbackState.category === '唱歌' ? '停止唱歌' : '停止说话'
    const text = currentId ? (currentText ? '正在回复…' : '正在思考…') :
      playbackState.loading ? '正在载入音频…' : playbackState.speaking ?
        (playbackState.category === '唱歌' ? '正在唱歌' : '正在说话') : speechPending ? '正在准备语音…' : ''
    $('activity-status').textContent = text
    $('activity-status').hidden = !text
  }

  function stopInteraction() {
    const id = currentId || activeTurnId
    activeTurnId = null
    speechPending = false
    window.petVoice.stop()
    if (id) window.pet.chatStop(id).catch(e => pushLog('err', `停止失败：${e.message}`))
    refreshPlaybackControls()
  }

  async function refreshMemCount() {
    try {
      const s = await window.pet.memoryStats()
      memCountEl.textContent = s.facts ? String(s.facts) : ''
      memCountEl.title = `${s.facts} 条事实，${s.pending} 条待整理`
    } catch { /* 忽略 */ }
  }

  // ------------------------------------------------------------ 历史浮层

  /** 给一条已存在的日志追加「用了哪条参考音频」的角标 */
  function appendVoiceChip(el, ref) {
    if (!el || !ref || el.querySelector('.voice-chip')) return
    const v = document.createElement('span')
    v.className = 'voice-chip'
    v.textContent = `${ref.fine}·${ref.endsWith}「${String(ref.text || '').slice(0, 10)}…」`
    v.title = `参考音频原文：${ref.text}`
    el.appendChild(v)
  }

  /** 把一条消息同时写进历史浮层（即使浮层是关着的，打开时也看得到） */
  /**
   * 往气泡里塞正文，顺手把 `*旁白*` 渲染成暗色斜体。
   *
   * 为什么不用 innerHTML：那要转义用户和模型给的文本，一个漏转就是注入。
   * 用 createTextNode 一段段拼，永远安全。
   *
   * 为什么要区分旁白：角色扮演模式下她的回复是「旁白 + 对白」混排的，
   * 而**语音只念对白**。同字号同颜色的话，用户没法一眼看出哪句会被念出来。
   */
  function appendRich(parent, text) {
    const s = String(text ?? '')
    const re = /\*([^*\n]+)\*/g
    let last = 0
    for (const m of s.matchAll(re)) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)))
      const span = document.createElement('span')
      span.className = 'narration'
      span.textContent = m[1]
      parent.appendChild(span)
      last = m.index + m[0].length
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)))
  }

  function pushLog(kind, text, meta) {
    const el = document.createElement('div')
    el.className = `msg ${kind}`
    // 情绪标签做成一个小角标 —— 让「判成什么情绪」可见。
    // 没有它的话，「这句话语气不对」到底是标签错了还是参考音频错了，完全查不出来。
    if (meta?.emotion) {
      const chip = document.createElement('span')
      chip.className = `emo-chip emo-${meta.emotion}`
      chip.textContent = meta.emotion
      chip.title = meta.source === 'rule' ? 'LLM 没打标签，这是关键词兜底判的' : 'LLM 自己标的情绪'
      el.appendChild(chip)
    }
    appendRich(el, text)
    logEl.appendChild(el)
    $('chat-empty').hidden = true
    logEl.scrollTop = logEl.scrollHeight
    return el
  }

  function toggleHistory(show) {
    if (show === false) window.petPanels.close()
    else if (show === true) window.petPanels.open('chat')
    else window.petPanels.toggle('chat')
    logEl.scrollTop = logEl.scrollHeight
  }

  // ------------------------------------------------------------ 收起输入区

  let collapsed = false

  /** 底部要给输入区/字幕留多高 —— 收起时腾出来给角色 */
  const GAP_EXPANDED = 96
  const GAP_COLLAPSED = 26

  function setCollapsed(on, persist = true) {
    collapsed = !!on
    formEl.classList.toggle('hidden', collapsed)
    subtitleEl.classList.toggle('hidden', collapsed)
    $('btn-expand').hidden = !collapsed
    $('btn-collapse').classList.toggle('active', collapsed)
    if (collapsed) {
      window.petPanels.close()
      $('more-menu').open = false
    }
    if (persist) window.pet.setUiState({ chatCollapsed: collapsed })
    window.petModel?.setBottomGap?.(collapsed ? GAP_COLLAPSED : GAP_EXPANDED)
    refreshPlaybackControls()
  }

  // ------------------------------------------------------------ 缩放

  let toastTimer = null

  function showToast(text) {
    toastEl.textContent = text
    toastEl.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 900)
  }

  async function zoomBy(step) {
    const r = await window.pet.zoomBy(step)
    showToast(`${Math.round(r.scale * 100)}%`)
    // 窗口尺寸和网页缩放都变了 —— 让 Pixi 重算分辨率并重新摆位
    requestAnimationFrame(() => window.petModel?.relayout?.())
  }

  // ------------------------------------------------------------ 一轮对话

  function send(text) {
    const trimmed = text.trim()
    if (!trimmed || currentId) return
    stopInteraction()

    pushLog('me', trimmed)
    subMeEl.textContent = trimmed
    subPetEl.textContent = ''
    subPetEl.className = 'sub-line pet'
    inputEl.value = ''

    currentId = `c${Date.now()}`
    activeTurnId = currentId
    speechPending = voiceState.enabled && voiceState.autoplay !== false
    window.__ttsErrShown = false
    window.__ttsRefs = []
    lastPetEntry = null
    lastEmotion = null
    currentText = ''
    currentUserText = trimmed

    setBusy(true)
    setDot('busy')
    // 开了语音就让她先闭嘴 —— 文本流完再出声，嘴型跟着真实音频走。
    // 没开语音才用「一边生成一边动嘴」的假动作。
    if (!voiceReady()) window.petModel?.setTalking(true)

    // 上下文（人格 / 事实记忆 / 分层历史）全在主进程组装，这里只给这一句
    window.pet.chatStart(currentId, trimmed).catch(e => {
      pushLog('err', `消息发送失败：${e.message}`)
      speechPending = false
      activeTurnId = null
      finish({ aborted: true })
    })
  }

  function finish({ aborted = false } = {}) {
    if (!currentId) return

    subPetEl.classList.remove('streaming', 'thinking')

    if (aborted) {
      speechPending = false
      if (!currentText) subPetEl.textContent = '（已停止）'
      pushLog('sys', `（已停止）${currentText || ''}`.trim())
    }

    if (currentText) {
      // 情绪角标现在就能给（chat:done 早于语音）；参考音频要等合成回来再补
      lastPetEntry = pushLog('pet', logText(currentText), {
        emotion: lastEmotion?.category,
        source: lastEmotion?.source,
      })
      refreshMemCount()
    } else if (!aborted) {
      subPetEl.textContent = ''
    }

    window.petModel?.setTalking(false)
    currentId = null
    currentText = ''
    currentUserText = ''
    setBusy(false)
    inputEl.focus()
  }

  // ------------------------------------------------------------ IPC 订阅

  /**
   * 流式显示时要把句首的情绪标签藏起来。
   * 标签是给语音模块用的，不该出现在字幕里 —— 而且它只占开头几个字，
   * 直接在这里做一次「剥掉已知的标签前缀」就够了。
   */
  const TAG_RE = /^\s*[[【（(]\s*([^\]】)）\n]{1,6}?)\s*[\]】)）]\s*[:：,，。.、-]?\s*/

  /**
   * 剥掉情绪标签。**两个显示函数共用这一步** —— 别各写一份，
   * 那个 KNOWN 列表长了 40 多个词，抄错一个就会出现「[开心] 显示出来了」。
   *
   * 要剥**两个位置**，不是只有句首：
   *   ① 句首那个（提示词要求的，正常都有）
   *   ② **句中又冒出来的** —— 模型偶尔会在旁白之后再来一个，
   *      实测气泡里显示成「…她把牌推到一边。[平静]我刚才一直在想…」，
   *      那个 [平静] 是给语音层看的标记，不该让人看见。
   * 判据保守：括号内容必须确实是已知情绪词才删，
   * 所以正文里的 [注]、[1]、[王后的荣冠] 都留着。
   */
  const KNOWN_EMO =
    /^(开心|高兴|快乐|喜悦|兴奋|欢快|愉快|得意|雀跃|欣喜|惊讶|吃惊|震惊|意外|诧异|惊奇|错愕|生气|愤怒|恼怒|不爽|不满|恼火|气愤|难过|悲伤|伤心|低落|沮丧|失落|委屈|哀伤|温柔|柔和|关切|宠溺|安抚|体贴|温存|暖心|平静|淡定|冷静|陈述|平常|寻常|无奈|淡然)$/
  /** 任意位置的标签形状 */
  const TAG_ANY = /[[【（(]\s*([^\]】)）\n]{1,6}?)\s*[\]】)）]/g

  function stripTag(raw) {
    const t = String(raw || '')
    const m = t.match(TAG_RE)
    const head = KNOWN_EMO.test(m?.[1]?.trim()) ? t.slice(m[0].length) : t
    return head.replace(TAG_ANY, (full, inner) => (KNOWN_EMO.test(String(inner).trim()) ? '' : full))
  }

  /**
   * 日志气泡用的文本：**保留星号**，但把空行压掉。
   *
   * 星号是旁白的标记，pushLog 会把 `*…*` 渲染成暗色斜体（appendRich）。
   * 这里要是先把星号剥了，appendRich 就什么都匹配不到，旁白和台词会长得一模一样。
   * —— 这个 bug 真发生过：displayText 里加了剥星号（为了字幕），
   *    而 pushLog 用的也是 displayText，于是样式整套失效，还没人发现。
   *
   * 空行也要压：模型习惯在旁白和对白之间空一行（`\n\n`），
   * 而 `.msg` 是 `white-space: pre-wrap` —— 那个空行会**实打实占掉一整行高度**，
   * 气泡里看着就是「行间距过大」，两条就撑满、第三条直接顶出气泡。
   * 压缩放在显示层而不是入库层：历史里保留模型自己的排版（角色扮演要连贯），
   * 而且这样连旧记录也一起修好了，不用清历史。
   */
  function logText(raw) {
    return stripTag(raw).replace(/\n{2,}/g, '\n').trim()
  }

  /**
   * 字幕用的文本：**去掉星号**，只留字。
   *
   * 字幕只有一行、没有富文本，露出 `*` 反而碍眼。
   * 想知道哪句是旁白看日志气泡就行。
   */
  function displayText(raw) {
    return logText(raw).replace(/\*+([^*\n]+)\*+/g, '$1')
  }

  window.pet.onDelta(({ id, delta }) => {
    if (id !== currentId) return
    if (!currentText) {
      subPetEl.classList.remove('thinking')
      subPetEl.textContent = ''
      subPetEl.classList.add('streaming')
    }
    currentText += delta
    subPetEl.textContent = displayText(currentText)
    refreshPlaybackControls()
  })

  // 推理模型（deepseek-flash / v4-pro）会先默默想一段；
  // 不显示的话她会呆立一两秒，看起来像卡住了。
  window.pet.onReasoning(({ id }) => {
    if (id !== currentId || currentText) return
    if (!subPetEl.classList.contains('thinking')) {
      subPetEl.classList.add('thinking')
      subPetEl.textContent = '思考中…'
    }
  })

  window.pet.onDone((payload) => {
    if (payload.id !== currentId) return
    finish({ aborted: !!payload.aborted })
  })

  window.pet.onError(({ id, message }) => {
    if (id !== currentId) return
    subPetEl.classList.remove('streaming', 'thinking')
    subPetEl.className = 'sub-line pet'
    subPetEl.textContent = ''
    pushLog('err', `出错了：${message}`)
    setDot('error')
    window.petModel?.setTalking(false)
    currentId = null
    currentText = ''
    speechPending = false
    activeTurnId = null
    window.petVoice.stop()
    setBusy(false)
    setDot('error')
  })

  // ------------------------------------------------------------ 语音

  let voiceState = { enabled: false, autoplay: true, ready: false, backend: 'none' }
  /** 当前这一轮的 id。和 currentId 不同：它不会在 finish 时被清掉 */
  let activeTurnId = null
  let lastEmotion = null
  /** finish() 时创建的那条日志元素 —— 语音信息晚到，用它回填参考音频角标 */
  let lastPetEntry = null
  /** 戳她时说什么。来自 characters/<id>.json，启动时通过 getStatus 拿到 */
  let tapLines = []

  function voiceReady() {
    return !!(voiceState.enabled && voiceState.ready && voiceState.autoplay !== false)
  }

  // 播放状态 → 保持满帧 + 记录她是不是在说话
  window.petVoice.onState((s) => {
    playbackState = s
    window.petModel?.setVoiceActive(s.speaking)
    subPetEl.classList.toggle('speaking', s.speaking)
    refreshPlaybackControls()
  })

  window.pet.onTtsEmotion(({ id, category, source }) => {
    if (id !== activeTurnId) return
    window.petModel?.setEmotion(category)
    lastEmotion = { category, source }
  })

  // 注意：语音分句是在 chat:done **之后**才陆续到的 ——
  // 主进程不等合成完就先把「这轮文本结束」发出来了。
  // 所以这里不能拿 currentId 判断（那时它已经被清空了），要用不随 finish 清零的 activeTurnId。
  window.pet.onTtsSegment((seg) => {
    if (seg.id !== activeTurnId) return
    if (!voiceState.enabled || voiceState.autoplay === false) return
    if (!seg.ok) {
      // 合成失败别装没事 —— 只提示一次，免得刷屏
      if (!window.__ttsErrShown) {
        window.__ttsErrShown = true
        pushLog('err', `这句没念出来：${seg.error}`)
        refreshVoiceState()
      }
      return
    }
    window.__ttsPlayed = (window.__ttsPlayed || 0) + 1
    window.__ttsLast = { text: seg.text, category: seg.category, ms: seg.ms, cached: seg.cached, ref: seg.ref }
    // 记下每句用的是哪条参考 —— 自检用它回归「一轮内不许换参考」
    window.__ttsRefs = window.__ttsRefs || []
    window.__ttsRefs.push({
      index: seg.index,
      text: seg.text,
      refId: seg.ref?.id || null,
      refCategory: seg.ref?.category,
      refEnds: seg.ref?.endsWith,
      pauseAfter: seg.pauseAfter ?? null,
      ms: seg.ms,
      cached: seg.cached,
    })
    window.petVoice.enqueue({ url: seg.url, text: seg.text, category: seg.category, index: seg.index, pauseAfter: seg.pauseAfter })
    // 第一条合成回来就把参考音频记到这一轮的日志上（后面几句是同一个参考，不用重复标）
    appendVoiceChip(lastPetEntry, seg.ref)
  })

  window.pet.onTtsStop(({ id } = {}) => {
    if (id && id !== activeTurnId && id !== currentId) return
    activeTurnId = null
    speechPending = false
    window.petVoice.stop()
    refreshPlaybackControls()
  })
  window.pet.onTtsDone(({ id }) => {
    if (id !== activeTurnId) return
    speechPending = false
    refreshPlaybackControls()
  })
  window.addEventListener('pet:playback-start', () => {
    stopInteraction()
    if (currentId) finish({ aborted: true })
  })
  window.petVoice.onError(({ message, category }) => {
    if (category !== '唱歌') pushLog('err', message)
  })

  /**
   * 本地语音服务的启动进度。
   *
   * 只报「正在启动」和「失败」两种 —— 成功是默认预期，不用刷屏。
   * 模型要读 4.5G 进显存，十来秒；不说一声的话用户会以为语音坏了。
   */
  window.pet.onTtsServer(({ state, detail }) => {
    if (state === 'starting') {
      setBadge('语音服务启动中…')
      pushLog('sys', `正在启动本地语音服务…（${detail}）`)
    } else if (state === 'ready') {
      setBadge('')
      pushLog('sys', `语音服务就绪：${detail}`)
    } else if (state === 'failed') {
      setBadge('语音不可用')
      pushLog('err', `语音服务起不来：${detail}`)
      pushLog('sys', '不影响打字聊天。手动起：npm run voice')
    }
    refreshVoiceState()
  })

  async function refreshVoiceState() {
    try {
      const s = await window.pet.ttsStatus()
      voiceState = s
      if (!s.enabled || s.autoplay === false) {
        speechPending = false
        if (playbackState.category !== '唱歌') {
          activeTurnId = null
          window.petVoice.stop()
        }
      }
      const btn = $('btn-voice')
      if (btn) {
        btn.textContent = s.enabled ? (s.ready ? '🔊' : '⚠️') : '🔇'
        btn.title = !s.enabled
          ? '语音已关闭，点击开启'
          : s.ready
            ? `语音已开（${s.backend}）· 点击关闭`
            : `语音开着但后端连不上：${s.detail}`
        btn.classList.toggle('on', !!(s.enabled && s.ready))
        btn.setAttribute('aria-pressed', String(!!s.enabled))
        btn.setAttribute('aria-label', s.enabled ? '关闭语音' : '开启语音')
      }
      if (s.character?.name) $('chat-title').textContent = s.character.name
    } catch (e) {
      console.error('[voice] 取状态失败', e)
    }
  }

  $('btn-voice').addEventListener('click', async () => {
    const next = !voiceState.enabled
    const r = await window.pet.ttsSetEnabled(next)
    if (!r.ok) {
      pushLog('err', `写 config.json 失败：${r.error}`)
      return
    }
    window.petVoice.unlock()
    await refreshVoiceState()

    if (!next) {
      window.petVoice.stop()
      pushLog('sys', '语音已关闭。')
      return
    }

    // 刚打开语音：后端没在线就顺手拉一把，省得用户自己去开终端
    let probe = await window.pet.ttsProbe()
    if (!probe.ok && voiceState.backend === 'gptsovits') {
      pushLog('sys', `语音服务没在线，正在启动…（${probe.detail}）`)
      setBadge('语音服务启动中…')
      const s = await window.pet.ttsStartServer()
      setBadge('')
      pushLog(s.ok ? 'sys' : 'err', s.ok ? `语音服务就绪：${s.detail}` : `起不来：${s.detail}`)
      if (!s.ok && s.logFile) pushLog('sys', `启动日志：${s.logFile}`)
      probe = await window.pet.ttsProbe()
      await refreshVoiceState()
    }
    pushLog('sys', probe.ok ? `语音已开启（${voiceState.backend}）。` : `语音开了，但还用不了：${probe.detail}`)
  })

  window.pet.onConfigChanged((status) => {
    const wasMock = mockMode
    applyStatus(status)
    refreshVoiceState()
    if (status.characterName) $('chat-title').textContent = status.characterName
    if (status.live2d) window.petModel?.setFaceConfig?.(status.live2d)
    if (wasMock && !status.mock) pushLog('sys', `已连上 ${status.model}（Key 来自 ${status.apiKeySource}）`)
    else if (!wasMock && status.mock) pushLog('sys', 'API Key 没了，切回演示模式。')
  })

  window.pet.onVisibility((visible) => window.petModel?.setRunning?.(visible))

  // ------------------------------------------------------------ 绑定

  formEl.addEventListener('submit', (e) => { e.preventDefault(); send(inputEl.value) })
  stopBtn.addEventListener('click', stopInteraction)
  $('btn-quiet-stop').addEventListener('click', stopInteraction)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (currentId || speechPending || window.petVoice.busy)) {
      e.preventDefault()
      stopInteraction()
    }
  })

  $('btn-quit').addEventListener('click', () => window.pet.quit())
  $('btn-hide').addEventListener('click', () => window.pet.hide())
  $('btn-collapse').addEventListener('click', () => setCollapsed(!collapsed))
  $('btn-expand').addEventListener('click', () => setCollapsed(false))
  $('btn-history').addEventListener('click', () => toggleHistory())

  $('btn-clear').addEventListener('click', async () => {
    stopInteraction()
    await window.pet.clearHistory()
    currentId = null
    currentText = ''
    lastPetEntry = null
    subMeEl.textContent = ''
    subPetEl.textContent = ''
    setBusy(false)
    logEl.innerHTML = ''
    pushLog('sys', '对话记录已清空（长期记忆不受影响）。')
  })

  $('btn-config').addEventListener('click', async () => {
    await window.pet.openConfig()
    pushLog('sys', '已打开 config.json。改完切回桌宠窗口会自动重新载入。')
  })

  // ---- 记忆面板
  // 单例：已经开着就关掉，绝不再追加一份（之前每次点都会往对话里塞新内容）
  $('btn-memory').addEventListener('click', () => window.petPanels.toggle('memory'))
  window.addEventListener('pet:panel', ({ detail }) => {
    if (detail.tab === 'memory') toggleMemoryPanel().catch(e => pushLog('err', `读取记忆失败：${e.message}`))
    if (detail.tab === 'chat') logEl.scrollTop = logEl.scrollHeight
  })

  async function toggleMemoryPanel() {
    const existing = $('memory-body').querySelector('.memory-panel')
    if (existing) {
      await existing.refresh?.()
      return
    }

    const panel = document.createElement('div')
    panel.className = 'memory-panel'

    const info = document.createElement('div')
    info.className = 'memory-info'
    info.textContent = '读取中…'
    panel.appendChild(info)

    const actions = document.createElement('div')
    actions.className = 'memory-actions'
    panel.appendChild(actions)

    const note = (t) => { info.textContent = t }

    async function render() {
      const s = await window.pet.memoryStats()
      const h = await window.pet.historyStats().catch(() => null)

      const vec = !s.embeddingsEnabled
        ? '未启用'
        : s.embedded >= s.facts && s.facts > 0
          ? `已全部向量化（${s.embedded}/${s.facts}）`
          : `${s.embedded}/${s.facts} 已向量化`

      const lines = [
        `记住了 ${s.valid ?? s.facts} 件事` +
          (s.invalid ? ` · ${s.invalid} 条已失效` : '') +
          ` · 待整理 ${s.pending} 条${s.busy ? '（整理中…）' : ''}`,
        s.embeddingsEnabled ? `能按含义找回相关记忆：${vec}` : '目前按文字查找相关记忆',
      ]
      if (s.openLoops) {
        lines.push(
          `【未了的事】${s.openLoops} 件` +
            (s.openLoopsDue ? ` · ${s.openLoopsDue} 件到点该提了` : '') +
            `（每件最多主动提 2 次，提够就不再念）`
        )
      }
      if (h) {
        lines.push(
          `保留 ${h.entries} 条对话，${h.blocks} 段往事摘要${h.busy ? '（整理中…）' : ''}`
        )
      }
      if (s.embeddingsEnabled && !s.hasEmbedKey) lines.push('语义检索暂不可用，仍可按文字查找记忆。')

      note(lines.join('\n'))
      refreshMemCount()
    }

    const mk = (label, fn, danger) => {
      const b = document.createElement('button')
      b.textContent = label
      if (danger) b.classList.add('danger')
      b.addEventListener('click', fn)
      actions.appendChild(b)
    }

    mk('整理记忆', async () => {
      note('正在整理待处理的对话…')
      const r = await window.pet.memoryConsolidate()
      note(r.error ? `整理失败：${r.error}` : `整理完成，新增 ${r.added} 条。`)
      await render()
    })

    mk('压缩历史', async () => {
      note('正在把较早的对话压缩成档案…')
      const r = await window.pet.historyArchive()
      note(r.archived ? `已归档 ${r.archived} 条。` : '当前不需要压缩（原文还不够长，或已压完）。')
      await render()
    })

    mk('完善检索', async () => {
      note('正在向量化…')
      const r = await window.pet.memoryEmbed()
      note(r.embedded ? `新增 ${r.embedded} 条向量。` : '没有需要补的。')
      await render()
    })

    mk('查看记忆', async () => {
      const { facts, embedded } = await window.pet.memoryList()
      const has = new Set(embedded || [])
      if (!facts.length) { note('还没记住任何事。多聊几句，或点「整理记忆」。'); return }
      const valid = facts.filter((f) => !f.invalidAt)
      const invalid = facts.filter((f) => f.invalidAt)
      const fmt = (f) => `${has.has(f.id) ? '●' : '○'} ${f.text}`
      let out = valid.slice(0, 10).map((f, i) => `${i + 1}. ${fmt(f)}`).join('\n')
      if (valid.length > 10) out += `\n…还有 ${valid.length - 10} 条有效`
      if (invalid.length) {
        out += `\n\n已失效（不再影响回答，仅作记录）：\n`
        out += invalid.slice(0, 5).map((f) => `  ✗ ${f.text}`).join('\n')
        if (invalid.length > 5) out += `\n  …还有 ${invalid.length - 5} 条`
      }
      note(out + '\n（● = 支持语义查找，○ = 支持文字查找）')
    })

    mk('打开文件', () => window.pet.memoryOpen())

    mk('清空记忆', async () => {
      const r = await window.pet.memoryClear()
      note(`已清空 ${r.removed} 条记忆。`)
      refreshMemCount()
    }, true)

    mk('收起面板', () => window.petPanels.close())

    panel.refresh = render
    $('memory-body').appendChild(panel)
    await render()
  }

  // ---- 被戳
  //
  // 为什么不走 Pixi 的 pointertap：模型创建时开了 autoInteract:false，
  // 而 pixi-live2d-display 正是用这个开关决定要不要注册 pointertap 的
  //   set autoInteract(t){ ... t ? this.on("pointertap", Handler, this) : this.off(...) }
  // 关掉之后模型也不是 interactive 的，所以那个事件**根本不会来** ——
  // 「点角色」这个功能一直是坏的，直到这里才发现。
  //
  // 现在用项目自己的 hitTest 判定，和鼠标穿透协调用的是同一套逻辑，不会两边不一致。
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const el = e.target
    if (el && el.closest && el.closest('.interactive')) return // 点在 UI 上不算
    if (e.clientX === undefined) return
    if (!window.petModel?.hitTest(e.clientX, e.clientY)) return
    window.petModel.tap()
  })

  window.addEventListener('pet:tapped', () => {
    if (currentId) return
    // 台词来自角色文件；没配就用一份通用的兜底
    const lines = tapLines.length ? tapLines : ['诶？', '干嘛呀～', '唔……', '在的在的。']
    subMeEl.textContent = ''
    subPetEl.className = 'sub-line pet'
    subPetEl.textContent = lines[Math.floor(Math.random() * lines.length)]
    setTimeout(() => { if (!currentId && subPetEl.textContent && !subMeEl.textContent) subPetEl.textContent = '' }, 1800)
  })

  // ---- 缩放
  window.addEventListener('wheel', (e) => {
    const overLog = e.target.closest && e.target.closest('#chat-log')
    const onPet = window.petModel?.hitTest(e.clientX, e.clientY)
    if (!e.ctrlKey && (overLog || !onPet)) return
    e.preventDefault()
    zoomBy(e.deltaY < 0 ? 0.05 : -0.05)
  }, { passive: false })

  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(0.05) }
    else if (e.key === '-') { e.preventDefault(); zoomBy(-0.05) }
    else if (e.key === '0') {
      e.preventDefault()
      window.pet.resetZoom().then((r) => { showToast(`${Math.round(r.scale * 100)}%`); window.petModel?.relayout?.() })
    }
  })

  // ------------------------------------------------------------ 鼠标穿透协调

  let lastIgnore = null
  let raf = null

  function applyIgnore(ignore) {
    if (ignore === lastIgnore) return
    lastIgnore = ignore
    window.pet.setIgnoreMouse(ignore)
  }

  function evaluatePointer(x, y) {
    const el = document.elementFromPoint(x, y)
    const onUI = !!(el && el.closest('.interactive'))
    const onPet = window.petModel?.hitTest(x, y) || false
    applyIgnore(!(onUI || onPet))
    document.getElementById('pet-canvas').classList.toggle('hot', onPet && !onUI)
  }

  window.addEventListener('mousemove', (e) => {
    const { clientX: x, clientY: y } = e
    if (raf) return
    raf = requestAnimationFrame(() => { raf = null; evaluatePointer(x, y) })
  }, { passive: true })

  window.addEventListener('mouseleave', () => applyIgnore(true))

  // ------------------------------------------------------------ 启动

  function applyStatus(status) {
    mockMode = !!status.mock
    maxHistory = status.maxHistory || 20
    if (Array.isArray(status.tapLines)) tapLines = status.tapLines
    if (status.fpsActive || status.fpsIdle) {
      window.petModel?.setFpsConfig?.({ active: status.fpsActive, idle: status.fpsIdle })
    }
    if (mockMode) { setDot('mock'); setBadge('演示模式') }
    else { setDot(''); setBadge('') }
  }

  async function restoreHistory() {
    const saved = await window.pet.loadHistory()
    if (!Array.isArray(saved) || saved.length === 0) return

    const showLast = 40
    const tail = saved.slice(-showLast)
    const hidden = saved.length - tail.length
    if (hidden > 0) pushLog('sys', `…更早的 ${hidden} 条已省略`)
    for (const m of tail) pushLog(m.role === 'assistant' ? 'pet' : 'me', m.role === 'assistant' ? logText(m.content) : m.content)

    // 字幕里显示最后一句她说的话，这样一启动就知道聊到哪了
    const lastPet = [...saved].reverse().find((m) => m.role === 'assistant')
    if (lastPet) subPetEl.textContent = displayText(lastPet.content)

    /**
     * 回放完再滚一次底，而且要等下一帧。
     *
     * pushLog 里每加一条就 `scrollTop = scrollHeight`，但回放是**同步连续加几十条**，
     * 加的过程中布局还没稳定（气泡高度、自动换行都还没算完），
     * 于是最后那次 scrollHeight 是偏小的 —— 结果停在中间，
     * 打开看到的不是最新一句，而是一条长回复的开头。
     * 实测：塞一条 5 段的长回复进历史，启动后视口停在它的第一行。
     */
    requestAnimationFrame(() => {
      logEl.scrollTop = logEl.scrollHeight
    })
  }

  async function boot() {
    const state = await window.pet.getUiState()
    if (state) setCollapsed(!!state.chatCollapsed, false)

    const status = await window.pet.getStatus()
    applyStatus(status)

    // 角色的表情/动作映射（characters/<id>.json 的 live2d 段）
    if (status.live2d) window.petModel?.setFaceConfig?.(status.live2d)
    if (Array.isArray(status.tapLines) && status.tapLines.length) tapLines = status.tapLines
    if (status.characterName) $('chat-title').textContent = status.characterName

    await restoreHistory()
    await refreshMemCount()
    await refreshVoiceState()

    const ok = await window.petModel?.ready
    if (ok === false) pushLog('sys', '形象没加载出来，看屏幕中间的提示。')

    if (status.missingConfig) {
      pushLog('sys', '没找到 config.json。点「设置」生成一份，或直接用环境变量里的 Key。')
    }

    inputEl.focus()
  }

  boot()
})()
