/**
 * 唱歌面板
 *
 * 放在历史浮层里（和 🧠 记忆面板同一个位置），因为它是「低频、看一眼就关」的东西，
 * 不该常驻占着本来就紧张的窗口空间。
 *
 * 三件事要在这个文件里做对：
 *
 * ① **进度必须看得见。** 一首歌要几分钟，只有一个转圈的话用户会以为卡死了。
 *    所以管线每推进一个阶段就报一次（分离 / 转换 / 混音），界面上是阶段名 + 百分比。
 *
 * ② **播放要等成品出来**，而且口型跟的是**人声轨**不是成品 ——
 *    这条约束钉在 petVoice.sing() 上，这里只负责把两个地址都传对。
 *
 * ③ **按钮的状态要跟真实状态走**，不是跟点击走。
 *    点了「唱」之后按钮要立刻禁用（不然连点会起第二个任务），
 *    跑完/失败/取消之后要恢复 —— 这几条路径都得走同一个 render()。
 */
;(function () {
  const $ = (id) => document.getElementById(id)

  let panel = null
  let status = null
  let songs = []
  let busy = false
  let progress = null

  /**
   * **本地跟踪**「正在跑的任务」，不依赖 status.running。
   *
   * 为什么必须本地跟踪：`status` 只有 `refresh()`（向主进程要一次完整状态）才会更新，
   * 而转换过程中只会收到进度事件、不会 refresh —— 于是 `status.running` 一直停在
   * 打开面板那一刻的 null。后果就是：
   *   · 「停止」按钮永远是灰的（`ui.stop.disabled = !running`）
   *   · 正在跑的那首歌不会高亮
   *   · 界面上没有任何「正在跑」的迹象，用户以为点空了，于是反复点
   *
   * 教训：**UI 状态要跟着真实状态走，不能跟着「点过一次」走。**
   */
  let runningJob = null // { key, song, stage, pct, startedAt }

  /**
   * 播放侧的状态。和 runningJob 一样，**本地跟踪**而不是等 status 轮询。
   *
   * 为什么要单独跟踪：用户点 ▶ 开始播之后，唯一能停下来的手段就是再点一次
   * （或者底部的停止键）。所以界面必须知道「现在在播哪一首」——
   * 否则那首歌的按钮不会变成「■ 停」，用户就只能靠猜。
   */
  let playingKey = null
  let voiceSpeaking = false
  let voiceLoading = false

  /** 面板里的元素句柄。建一次，后面只改内容 —— 整块重建会丢滚动位置和按钮焦点 */
  let ui = null

  // ---------------------------------------------------------------- 取数据

  async function refresh() {
    try {
      status = await window.pet.singStatus()
    } catch (e) {
      /**
       * ⚠️ 不要把「取状态失败」显示成「功能已关闭」。
       *
       * 那样会把一个**真 bug** 伪装成**配置问题** —— 界面上看到「功能已关闭」，
       * 人就会去翻 config.json 找 enabled，而真正的原因（这里读了个已删掉的
       * 配置字段而抛异常）被完全盖住。这次就踩了这个坑。
       * 所以单独记 statusError，界面上明说「状态读取失败」。
       */
      status = {
        enabled: false,
        statusError: e.message,
        env: { ok: false, detail: `取状态失败：${e.message}` },
      }
      console.error('[singing] 取状态失败', e)
    }
    try {
      songs = await window.pet.singList()
    } catch (e) {
      songs = []
      console.error('[singing] 歌单读取失败', e)
    }
    render()
  }

  // ---------------------------------------------------------------- 渲染

  function fmtDuration(sec) {
    if (!sec || !Number.isFinite(sec)) return ''
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }

  function fmtSize(bytes) {
    if (!bytes) return ''
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`
  }

  function render() {
    if (!panel || !ui) return

    const env = status?.env || {}
    // 优先用本地跟踪的 —— status.running 在转换过程中是过期的（见 runningJob 的注释）
    const running = runningJob || status?.running || null

    // ---- 头部
    ui.sub.textContent = status?.statusError
      ? '状态读取失败'
      : status?.enabled
        ? (env.ok ? '准备好了' : '需要设置')
        : '功能已关闭'
    ui.sub.className = 'sing-sub' + (status?.enabled && env.ok && !status?.statusError ? '' : ' warn')

    // ---- 信息行
    const lines = []
    if (status?.statusError) {
      lines.push(`⚠️ 取状态失败：${status.statusError}`)
      lines.push('请重新打开面板再试一次。')
    } else if (!status?.enabled) {
      lines.push('唱歌功能关着。config.json 里把 singing.enabled 改成 true 就能用。')
    } else if (!env.ok) {
      lines.push(`⚠️ ${env.detail}`)
      if (env.needsSetup) lines.push('（这一步是一次性的：建 venv + 装依赖，几百 MB）')
    }
    if (running) {
      lines.push(`正在唱：${running.song}`)
      lines.push(`${running.stage}${running.pct ? ` · ${running.pct}%` : ''}`)
    } else if (status?.lastError) {
      lines.push(`上次失败：${status.lastError}`)
    }
    if (!running && !songs.length) {
      lines.push('歌单是空的。点「＋ 选歌」，或者把音频文件丢进 songs/ 目录。')
    }
    ui.info.textContent = lines.join('\n')
    ui.info.hidden = lines.length === 0

    // ---- 进度条
    const pct = progress?.pct ?? running?.pct ?? 0
    ui.bar.hidden = !(running || progress)
    ui.barFill.style.width = `${Math.max(0, Math.min(100, pct))}%`

    // ---- 歌单
    ui.list.textContent = ''
    for (const s of songs) {
      ui.list.appendChild(songRow(s, running))
    }
    ui.list.hidden = songs.length === 0

    // ---- 按钮可用性
    ui.pick.disabled = !status?.enabled
    ui.openDir.disabled = false
    /**
     * 「停止」要能停**当前实际在发生的事**：
     *   转换在跑 → 停转换（它更耗时、更该被打断）
     *   只有歌在播 → 停播放
     *   都没有 → 灰
     *
     * 以前这里只认 `running`（转换），所以放歌的时候它是灰的 ——
     * 用户就以为「没有停止播放的手段」，只好去点 ▶ 试图停止，
     * 结果撞上 voice.js 那个 Promise 锁死的 bug，播放器整个废掉。
     */
    ui.stop.disabled = !(running || voiceSpeaking || voiceLoading)
    ui.stop.textContent = running ? '停止转换' : voiceSpeaking || voiceLoading ? '停止播放' : '停止'
    ui.setup.hidden = !(status?.enabled && !env.ok)
  }

  function songRow(s, running) {
    const row = document.createElement('div')
    row.className = 'sing-row'
    const isRunning = !!running && running.key === s.key
    const isPlaying = playingKey === s.key && (voiceSpeaking || voiceLoading)
    if (isRunning) row.classList.add('active')
    if (isPlaying) row.classList.add('playing')

    const name = document.createElement('span')
    name.className = 'sing-name'
    name.textContent = s.name
    name.title = `${s.file}\n${fmtSize(s.size)}`
    row.appendChild(name)

    const tag = document.createElement('span')
    tag.className = 'sing-tag'
    if (isRunning) {
      tag.textContent = `${running.stage || ''}${running.pct ? ` ${running.pct}%` : ''}`
    } else if (isPlaying) {
      tag.textContent = '♪ 正在唱'
    } else if (s.result) {
      tag.textContent = `已唱 ${fmtDuration(s.result.meta?.duration)}`
      tag.title = `产物：${s.result.dir}`
    } else {
      tag.textContent = ''
    }
    row.appendChild(tag)

    const mk = (label, title, fn, cls, disabled) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      if (cls) b.classList.add(cls)
      b.disabled = !!disabled
      b.addEventListener('click', fn)
      return b
    }

    /**
     * ⚠️ 这里**不能**按 `busy` 一刀切把所有按钮禁掉。两个原因：
     *
     * ① 用户点了「唱」之后想停止，自然会去再点那个按钮 —— 结果它是禁用的，
     *    点不动，人只会以为程序卡了。（所以正在跑的这首，按钮要变成「停止」）
     *
     * ② **播放和转换是两条完全独立的路**：播放走渲染层的 Web Audio，
     *    转换走主进程的 Python。转换在跑的时候，听别的已经唱好的歌完全没问题 ——
     *    以前把 ▶ 也一起禁掉，等于白白锁住了唯一还能用的功能。
     */
    if (isRunning) {
      row.appendChild(mk('■ 停止', '掐掉这次转换', () => stopJob(), 'danger'))
    } else if (s.result) {
      // 正在播这首 → 按钮变「停」。用户想停止时最自然的动作就是再点它一次
      row.appendChild(
        isPlaying
          ? mk('■ 停', '停止播放这首', () => stopPlayback(), 'danger')
          : mk('▶', '让她唱这首（不影响正在跑的转换）', () => play(s), 'primary'),
      )
      row.appendChild(mk('重唱', '删掉已有产物，重新转换一遍', () => start(s, true), '', busy))
    } else {
      // 一次只跑一个转换（GPU 只有一块），但按钮不禁用 —— 点了会说清楚为什么不能跑
      row.appendChild(mk('唱', '开始转换（要等几分钟）', () => start(s, false), 'primary', false))
    }
    row.appendChild(mk('🗑', '删掉产物（下次要重算）', () => forget(s), '', isRunning))
    return row
  }

  /** 掐掉当前任务。按钮和动作栏的「停止」都走这里 */
  async function stopJob() {
    if (!runningJob && !busy && !status?.running) return
    pushSys('已请求停止…')
    try {
      await window.pet.singCancel()
    } catch (e) {
      pushSys(`停止失败：${e.message}`)
    }
  }

  // ---------------------------------------------------------------- 动作

  async function start(song, force) {
    // 一次只跑一个转换：GPU 只有一块，并发只会互相拖慢。
    // 但**要说清楚为什么不能跑** —— 静默 return 会让人以为按钮坏了。
    if (busy) {
      pushSys(`《${runningJob?.song || '另一首'}》还在转换中。等它跑完，或者点它的「■ 停止」掐掉。`)
      return
    }
    busy = true
    runningJob = { key: song.key, song: song.name, stage: '准备中', pct: 0, startedAt: Date.now() }
    progress = { stage: '准备中', pct: 0 }
    pushSys(`开始转换《${song.name}》…`)
    render()

    let r
    try {
      r = await window.pet.singStart(song.file, force)
    } catch (e) {
      r = { ok: false, error: e.message }
    } finally {
      // 无论成功、失败还是被掐掉，都必须把状态清干净 ——
      // 否则按钮会永远停在「■ 停止」，而且再也点不动任何东西
      busy = false
      runningJob = null
      progress = null
    }

    await refresh()

    // 用户点「唱歌」的意图就是**让她唱**，不是「生成一个文件等我自己去点 ▶」。
    // 之前这里只提示「唱好了，点 ▶ 听」—— 实际用起来很像没成功（找不到那个 ▶，
    // 或者以为会自动唱）。跑完直接开唱才是符合直觉的行为。
    if (r.ok) {
      const fresh = songs.find((s) => s.key === (r.key || song.key))
      if (fresh?.result) {
        pushSys(
          r.cached
            ? `《${song.name}》之前唱过，直接开唱。`
            : `《${song.name}》唱好了（${Math.round((r.ms || 0) / 1000)} 秒），开始唱。`,
        )
        play(fresh)
      } else {
        pushSys(`《${song.name}》唱完了，但产物没找到 —— 关掉面板重开一次再点 ▶。`)
      }
    } else if (r.cancelled) {
      pushSys(`《${song.name}》已停止。`)
    } else {
      pushSys(`唱歌失败：${r.error}`)
    }
  }

  function play(song) {
    const res = song.result
    if (!res) return

    // 已经在播这首 → 再点就是「停」。用户想停止时最自然的动作就是再点那个按钮，
    // 而之前这个动作不但停不了，还会把播放器锁死（见 voice.js 里 currentResolve 的注释）。
    if (playingKey === song.key && (voiceSpeaking || voiceLoading)) {
      stopPlayback()
      return
    }

    window.petVoice.unlock()
    window.dispatchEvent(new CustomEvent('pet:playback-start'))
    window.petVoice.sing({ url: res.url, mouthUrl: res.mouthUrl, title: song.name })
    playingKey = song.key

    // 字幕借用现成的那一行 —— 不新开 UI，但得让人知道现在在唱什么
    const subPet = $('sub-pet')
    const subMe = $('sub-me')
    if (subPet && subMe) {
      subMe.textContent = ''
      subPet.className = 'sub-line pet singing'
      subPet.textContent = `♪ ${song.name} ♪`
    }
    pushSys(`♪ 开始唱《${song.name}》`)
    render()
  }

  /** 停掉播放（不动正在跑的转换） */
  function stopPlayback() {
    window.petVoice.stop()
    playingKey = null
    voiceSpeaking = false
    voiceLoading = false
    const subPet = $('sub-pet')
    if (subPet?.classList.contains('singing')) {
      subPet.textContent = ''
      subPet.className = 'sub-line pet'
    }
    pushSys('已停止播放。')
    render()
  }

  /**
   * 底部「停止」键的统一入口。
   *
   * 这个键以前只绑在「停止转换」上，所以只在转换跑的时候可用 ——
   * 用户在放歌的时候看它是灰的，就以为「没有停止播放的手段」。
   * 现在按当前**实际在发生什么**决定它停什么：
   *   有转换在跑 → 先停转换（它更耗时、更该被打断）
   *   只有歌在播   → 停播放
   *   都没有       → 灰
   */
  function stopAnything() {
    if (runningJob || busy) return stopJob()
    if (voiceSpeaking || voiceLoading) return stopPlayback()
  }

  async function forget(song) {
    await window.pet.singForget(song.key)
    await refresh()
  }

  /**
   * 往**唱歌面板自己的**日志区写一条，不再塞进对话记录。
   *
   * 以前是往 #chat-log 追加 .msg.sys —— 结果「跑了 79 秒」「取音频失败 403」
   * 「加了 2 首」这些话和聊天记录混在同一条滚动流里，翻记录全是噪音，
   * 而且唱歌面板一关，它的操作反馈就散落在聊天里了。
   *
   * 面板没开时也留着（最多 60 条），重新打开还能看到刚才发生了什么。
   */
  const sysLines = []
  function pushSys(text) {
    console.log(`[singing] ${text}`)
    sysLines.push(text)
    if (sysLines.length > 60) sysLines.shift()
    renderSys()
  }

  /** 把留存的日志行铺进面板。面板没建时什么都不做 */
  function renderSys() {
    if (!ui?.log) return
    ui.log.replaceChildren()
    for (const t of sysLines) {
      const el = document.createElement('div')
      el.className = 'sing-line'
      el.textContent = t
      ui.log.appendChild(el)
    }
    ui.log.scrollTop = ui.log.scrollHeight
  }

  // ---------------------------------------------------------------- 面板
  //
  // 面板的**外壳**（标题栏 + 关闭按钮）在 index.html 的 #sing-panel 里，
  // 这里只负责生成内容体，塞进 #sing-body。外壳归 HTML 管、内容归 JS 管，
  // 这样标题栏不随内容重建，滚动位置和焦点也不会丢。

  function build() {
    const el = document.createElement('div')
    el.className = 'sing-content'

    const info = document.createElement('div')
    info.className = 'sing-info'
    el.appendChild(info)

    const bar = document.createElement('div')
    bar.className = 'sing-bar'
    const barFill = document.createElement('div')
    barFill.className = 'sing-bar-fill'
    bar.appendChild(barFill)
    el.appendChild(bar)

    const list = document.createElement('div')
    list.className = 'sing-list'
    el.appendChild(list)

    // 状态 / 操作反馈区。放在动作按钮**上方**，因为它比按钮更常看
    const log = document.createElement('div')
    log.className = 'sing-log'
    el.appendChild(log)

    const actions = document.createElement('div')
    actions.className = 'sing-actions'
    const mk = (label, title, fn) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.addEventListener('click', fn)
      actions.appendChild(b)
      return b
    }
    const pick = mk('＋ 选歌', '从磁盘选音频，会拷进 songs/', async () => {
      const r = await window.pet.singPick()
      if (r.added) pushSys(`加了 ${r.added} 首。`)
      if (r.failed?.length) pushSys(`有 ${r.failed.length} 个没加进来：${r.failed.join('；')}`)
      await refresh()
    })
    const openDir = mk('歌曲文件夹', '把歌丢进去也行', () => window.pet.singOpenFolder())
    const setup = mk('怎么装环境', '第一次用要建 Python 环境', () => {
      pushSys('唱歌环境还没建。在 desktop-pet 目录下跑：npm run sing:setup')
      pushSys('（要下 PyTorch + 分离模型，几百 MB，只跑一次）')
    })
    const stop = mk('停止', '停掉正在跑的转换，或者正在放的歌', () => stopAnything())

    el.appendChild(actions)

    // sub 在 #sing-panel 的标题栏里（index.html），不在这里生成
    ui = { sub: $('sing-sub'), info, bar, barFill, list, log, pick, openDir, stop, setup }
    return el
  }

  function toggle(show) {
    const shell = $('sing-panel')
    if (!shell) return
    const next = show === undefined ? !(window.petPanels.visible && window.petPanels.selected === 'sing') : show

    if (!next) {
      if (window.petPanels.selected === 'sing') window.petPanels.close()
      return
    }

    window.petPanels.open('sing')
  }

  function openView() {
    if (!panel) {
      panel = build()
      $('sing-body').replaceChildren(panel)
    }
    renderSys() // 把面板关着的时候攒下的日志铺进去
    refresh()
  }

  window.pet.onSingProgress((p) => {
    progress = p
    // 本地任务状态也要跟着走 —— 界面上的进度、高亮、「停止」按钮都靠它
    if (runningJob) {
      runningJob.stage = p.stage ?? runningJob.stage
      runningJob.pct = p.pct ?? runningJob.pct
    }
    render()
  })

  // 播放状态跟踪 + 播放结束（或被别的音频打断）就把字幕收掉。
  // 不靠 setTimeout 猜时长 —— 歌曲长度是可变的，猜必错。
  window.petVoice.onState((s) => {
    const wasSpeaking = voiceSpeaking
    const wasLoading = voiceLoading
    voiceSpeaking = !!s.speaking && s.category === '唱歌'
    voiceLoading = !!s.loading && s.category === '唱歌'
    // 播放停了（自然放完 / 被打断 / 被 stop）→ 清掉「在播哪首」，
    // 那首歌的按钮会从「■ 停」变回「▶」
    if (!voiceSpeaking && !voiceLoading && !s.busy && playingKey) playingKey = null
    if ((wasSpeaking !== voiceSpeaking || wasLoading !== voiceLoading) && panel) render()

    if (s.speaking || s.loading || s.busy) return
    const subPet = $('sub-pet')
    if (subPet?.classList.contains('singing')) {
      subPet.textContent = ''
      subPet.className = 'sub-line pet'
    }
  })

  // 播放出问题要让人看见。
  // voice.js 那边失败时会把原因回调过来（取音频失败 / 解码失败 / 播放失败），
  // 以前只打 console，用户点了 ▶ 毫无反应也不知道为什么。
  window.petVoice.onError(({ message, category }) => {
    if (category !== '唱歌') return
    pushSys(`唱歌播放失败：${message}`)
  })

  function wire() {
    $('btn-sing')?.addEventListener('click', () => toggle())
    $('btn-close-sing')?.addEventListener('click', () => toggle(false))
  }
  document.addEventListener('DOMContentLoaded', wire)
  // DOMContentLoaded 可能已经过了（脚本在 body 末尾），兜一下
  if (document.readyState !== 'loading') wire()

  window.addEventListener('pet:panel', ({ detail }) => {
    if (detail.tab === 'sing') openView()
  })

  /** 给自检脚本用的把手 */
  window.petSinging = {
    toggle,
    refresh,
    open: () => toggle(true),
    close: () => toggle(false),
    get songs() {
      return songs
    },
    get status() {
      return status
    },
    get log() {
      return sysLines.slice()
    },
  }
})()
