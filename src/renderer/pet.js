/**
 * Live2D 桌宠渲染
 *
 * 依赖 vendor/ 下的三个文件（由 npm run setup 下载）：
 *   pixi.min.js                → window.PIXI
 *   live2dcubismcore.min.js    → Cubism 运行时
 *   cubism4.min.js             → PIXI.live2d.Live2DModel
 *
 * 对外暴露 window.petModel：
 *   ready            加载完成的 Promise
 *   hitTest(x, y)    这个点是不是压在角色身上（给鼠标穿透判定用）
 *   setTalking(bool) 说话状态 —— 驱动嘴型开合
 *   tap()            被点了一下 —— 播放 TapBody 动作
 */
;(() => {
  'use strict'

  const canvas = document.getElementById('pet-canvas')
  const errorOverlay = document.getElementById('error-overlay')
  const errorDetail = document.getElementById('error-detail')

  function fail(message) {
    console.error('[pet]', message)
    errorDetail.textContent = message
    errorOverlay.hidden = false
  }

  if (!window.PIXI) {
    fail('PIXI 没加载进来 —— 先跑 `npm run setup` 下载 vendor/ 里的库。')
    return
  }
  if (!PIXI.live2d) {
    fail('Live2D 插件没加载进来（Cubism Core 或 cubism4.min.js 缺失）—— 先跑 `npm run setup`。')
    return
  }

  // ---------------------------------------------------------------- 舞台

  const app = new PIXI.Application({
    view: canvas,
    backgroundAlpha: 0,          // 透明窗口，不能有底色
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    resizeTo: window,
    powerPreference: 'low-power',
  })

  // ---------------------------------------------------------------- 帧率治理

  /**
   * 桌宠大部分时间是「站着不动」的。无条件 60fps 会白烧一个 CPU 核
   * （实测空闲时渲染进程 ~78% 单核 + GPU 进程 ~23%）。
   *
   * 所以按活跃度分档。档位可调 —— 想要更省电就调低，想要更顺滑就调高。
   * 窗口被隐藏时直接停掉 ticker，一点不烧。
   */
  const FPS = { active: 60, recent: 60, idle: 30 }
  const RECENT_MS = 4000

  /** 允许外部（配置）调档位 */
  function setFpsConfig({ active, idle, recent } = {}) {
    if (Number.isFinite(active)) FPS.active = Math.max(5, Math.min(144, active))
    if (Number.isFinite(idle)) FPS.idle = Math.max(5, Math.min(144, idle))
    FPS.recent = Number.isFinite(recent) ? recent : FPS.active
    currentFps = -1            // 强制下一帧重新应用
  }

  let lastActiveAt = performance.now()
  let currentFps = FPS.active
  let running = true
  /** 正在播语音。和 talking 分开：说话时嘴由音频包络驱动，不需要正弦兜底 */
  let voiceActive = false

  function markActive() {
    lastActiveAt = performance.now()
  }

  function setFps(fps) {
    if (fps === currentFps) return
    currentFps = fps
    // 渲染循环和模型更新循环是两个 ticker，都要限
    app.ticker.maxFPS = fps
    PIXI.Ticker.shared.maxFPS = fps
    console.log(`[pet] 帧率档位 → ${fps}fps`)
  }

  function governorTick() {
    if (!running) return
    const since = performance.now() - lastActiveAt
    setFps(talking || voiceActive ? FPS.active : since < RECENT_MS ? FPS.recent : FPS.idle)
  }

  /** 窗口隐藏时彻底停掉渲染；显示时恢复 */
  function setRunning(on) {
    if (on === running) return
    running = on
    if (on) {
      app.start()
      PIXI.Ticker.shared.start()
      markActive()
      setFps(FPS.active)
    } else {
      app.stop()
      PIXI.Ticker.shared.stop()
    }
  }

  let model = null
  let talking = false
  let mouthPhase = 0
  /** 有真实音频时，嘴型由它驱动（见 ticker）；没有时才退回正弦假动作 */
  let face = null
  /** 角色文件里配的表情/动作映射 */
  let faceConfig = null
  /** 嘴型的平滑值：真包络有毛刺，直接上会抖 */
  let mouthSmooth = 0
  /** 把嘴型定格在某个值上多久（截图用，见 holdMouth） */
  let mouthHoldUntil = 0
  let mouthHoldValue = 0
  /** 待机微动开关。没配就默认开 —— 大多数 VTS 模型都没有 idle 动作 */
  let idleLife = true
  /** 戳一下之后收拾现场用的定时器 */
  let tapTimer = null
  /** 戳她时的限时覆盖：保持期截止时间 + 是否还在管 */
  let tapHoldUntil = 0
  let tapActive = false
  /** 「手出现」的开关参数（角色文件配） */
  let tapShowParam = null
  /** 框架不会自动还原的手臂参数，松开时由我们拉回静止值 */
  let tapRestParams = []

  // ---------------------------------------------------------------- 待机动作

  let idleTimer = null

  function scheduleIdle() {
    clearTimeout(idleTimer)
    // 6~14 秒随机播一次待机动作，避免看起来像张静止图
    const wait = 6000 + Math.random() * 8000
    idleTimer = setTimeout(() => {
      if (model && !talking) {
        const group = faceConfig?.idleMotion || 'Idle'
        try {
          // motion() 返回 Promise，组不存在时会 reject ——
          // 光用 try/catch 接不住异步 rejection，会变成未处理的 Promise 警告刷屏
          const p = model.motion(group)
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } catch {
          /* 模型没有这个动作组，正常 —— 待机微动由 ticker 里的呼吸/摇头负责 */
        }
      }
      scheduleIdle()
    }, wait)
  }

  // ---------------------------------------------------------------- 嘴型

  /**
   * 说话中时把 ParamMouthOpenY 顶掉动作给的值。
   *
   * 关键：必须等模型自己的 update（动作/物理演算）跑完再覆盖，
   * 否则待机动作每帧都会把嘴型冲回 0。
   * 模型在 Ticker.shared 上以 NORMAL(0) 优先级更新，
   * 这里用 LOW(-25) 就能保证排在它后面。
   *
   * 嘴型有两个来源，优先用真的：
   *   ① window.petVoice 正在播音频 → 按真实音量包络开合（准）
   *   ② 没有音频（没开语音 / 纯打字）→ 退回两个正弦叠加（凑合能看）
   *
   * 表情参数也在这里叠加 —— 同样必须排在动作之后。
   */
  function installMouthOverride() {
    PIXI.Ticker.shared.add(
      () => {
        if (!model) return
        const core = model.internalModel?.coreModel
        if (!core) return

        const now = performance.now()

        // ---- 嘴
        let value = 0
        const voiceLevel = window.petVoice?.mouthLevel?.() ?? 0
        if (voiceLevel > 0.0001) {
          // 真包络：起音快、收音慢，听起来才像在说话
          const k = voiceLevel > mouthSmooth ? 0.55 : 0.28
          mouthSmooth += (voiceLevel - mouthSmooth) * k
          // 映射到合理的张口幅度：包络本身偏小，抬一点底
          value = Math.min(1, Math.pow(mouthSmooth, 0.75) * 1.35)
        } else if (talking) {
          // 没音频可跟，只好用假动作兜着
          mouthSmooth = 0
          mouthPhase += 0.28
          value = 0.32 + 0.34 * Math.abs(Math.sin(mouthPhase)) + 0.12 * Math.abs(Math.sin(mouthPhase * 2.7))
          value = Math.min(1, value)
        } else {
          mouthSmooth *= 0.6
          if (mouthSmooth < 0.01) mouthSmooth = 0
        }

        // 定格：截图用。capturePage 有几百毫秒延迟，不冻住的话拍到的永远是闭嘴那帧
        if (mouthHoldUntil > now) value = mouthHoldValue

        try {
          core.setParameterValueById('ParamMouthOpenY', value)
        } catch {
          /* 参数不存在就算了 */
        }

        /**
         * 戳她时的「抬手 → 放手」限时覆盖。
         *
         * 为什么不用模型自带的 wave.exp3.json：**表情是持久状态**。
         * pixi-live2d-display 的 expression() 一旦设上，之后每帧都会重新叠加它，
         * 而「挥手」这个表情其实就是把 Param15 置 1（手出现的开关）——
         * 结果动作播完了，Param15 还钉在 1，**手一直举着**。
         * 而且 model.expression() **不传参不是重置，是「随机挑一个表情」**
         * （expression(t){ void 0===t ? setRandomExpression() : setExpression(t) }），
         * 真正的重置是 expressionManager.resetExpression()。这个坑很隐蔽。
         *
         * 为什么还得自己把手臂参数拉回来：实测（scripts/debug-tap-trace.js）
         * 动作播完后 Param14/16/17 会**冻在最后一帧的值上**，
         * 框架不还原，stopAllMotions() 也没用：
         *     未戳           14=0     15=0     16=0      17=0
         *     戳后 0.9s      14=1     15=1     16=0.556  17=0.972
         *     戳后 1.6s~4.5s 14=1     15=1     16=-0.98  17=-0.698   ← 冻住不动了
         *
         * 所以这里分两段自己做：
         *   保持期：顶住「手出现」开关，手臂交给动作去摆
         *   松开期：把开关和手臂参数一起线性拉回静止值，动作也停掉
         */
        if (tapActive) {
          const t = now - tapHoldUntil
          const releaseMs = Number(faceConfig?.tapReleaseMs) || 450
          if (now < tapHoldUntil) {
            if (tapShowParam) {
              try {
                core.setParameterValueById(tapShowParam, 1)
              } catch {
                /* 参数不存在就算了 */
              }
            }
          } else if (t < releaseMs) {
            const k = 1 - t / releaseMs // 1 → 0
            if (tapShowParam) {
              try {
                core.setParameterValueById(tapShowParam, k)
              } catch {
                /* 忽略 */
              }
            }
            // 手臂参数框架不还原，自己拉回静止值（默认 0）
            for (const id of tapRestParams) {
              try {
                core.setParameterValueById(id, 0 * k)
              } catch {
                /* 忽略 */
              }
            }
          } else {
            tapActive = false
            // 动作停掉，免得它继续往这些参数上写
            try {
              model.internalModel?.motionManager?.stopAllMotions?.()
            } catch {
              /* 忽略 */
            }
            try {
              model.internalModel?.motionManager?.expressionManager?.resetExpression?.()
            } catch {
              /* 忽略 */
            }
          }
        }

        // ---- 表情（叠加，不动嘴）
        face?.apply(core, now)

        // ---- 待机微动
        //
        // 芙宁娜这个模型**没有 idle 动作**（只有一个挥手动作），
        // 光靠物理演算（头发/飘带）+ 眨眼会显得像张静止图。
        // 所以自己叠一点极慢的呼吸和摇头 —— 幅度很小，但一眼就能看出「活着」。
        //
        // 注意用 add 而不是 set：鼠标跟随（model.focus）会写 ParamAngleX/Y/Z，
        // 我们只在其之上加一点偏移，不能覆盖掉。
        if (idleLife) {
          const t = now / 1000
          const sway = [
            ['ParamBreath', 0.5 + 0.5 * Math.sin(t * 0.55)],
            ['ParamAngleX', Math.sin(t * 0.23) * 1.6],
            ['ParamAngleY', Math.sin(t * 0.31 + 1.1) * 1.1],
            ['ParamAngleZ', Math.sin(t * 0.19 + 2.3) * 0.9],
            ['ParamBodyAngleX', Math.sin(t * 0.17 + 0.7) * 0.8],
          ]
          for (const [id, v] of sway) {
            try {
              core.addParameterValueById(id, v)
            } catch {
              /* 参数不存在就算了 */
            }
          }
        }
      },
      null,
      PIXI.UPDATE_PRIORITY.LOW
    )
  }

  // ---------------------------------------------------------------- 加载模型

  /** 让角色眼睛/头跟着鼠标转（比内置 autoInteract 可控） */
  function followPointer() {
    let lastX = null
    let lastY = null

    window.addEventListener('pointermove', (e) => {
      // 只有「真的移动了」才算活跃。
      // 鼠标停在窗口上时（尤其开了 setIgnoreMouseEvents 的 forward:true），
      // 系统会持续送来坐标不变的事件；照单全收会让帧率永远降不下去。
      const moved = lastX === null || Math.abs(e.clientX - lastX) > 2 || Math.abs(e.clientY - lastY) > 2
      lastX = e.clientX
      lastY = e.clientY
      if (!moved) return

      markActive()
      if (!model) return
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      // canvas 的 CSS 尺寸就是舞台的逻辑尺寸，所以直接用相对坐标即可
      try { model.focus(e.clientX - rect.left, e.clientY - rect.top) } catch { /* 忽略 */ }
    }, { passive: true })
  }

  /**
   * 改用静态立绘（PNGtuber）渲染。
   *
   * 为什么这个决定放在 pet.js 里、而不是另起一个 boot 脚本：
   *   `load()` 本来就是「读清单 → 加载模型」的唯一入口，而且它是 **async** 的 ——
   *   在这里替换 `window.petModel` 天然发生在下面那次**同步赋值之后**（见 413/420 行），
   *   时序正好。另起一个脚本就要处理「谁先跑」的竞态，反而更绕。
   *
   * 上层（chat.js / main.js）全程只认 `window.petModel`，所以这里换掉之后
   * **一行都不用改** —— 这正是 static-pet.js 把接口对齐的意义。
   */
  function useStaticRenderer(manifest) {
    if (!window.petStatic) {
      fail('配置要静态立绘，但 static-pet.js 没加载进来（index.html 里漏了 script 标签）。')
      return
    }

    // 立绘目录：清单里可以用 staticDir 单独指，否则跟着模型名走
    const dir = manifest.staticDir || manifest.model || 'Furina'
    const spec = manifest.static || {}
    const images = spec.images || {}

    /**
     * 没有图就**明确报错**，不要静默白屏。
     * 「桌宠消失了但没报错」是最难查的一类问题 —— 用户只会觉得软件坏了。
     */
    if (!Object.keys(images).length) {
      fail(
        `静态立绘没有配置图片。请把 PNG 放进 assets/models/${dir}/，` +
          `并在 assets/models/index.json 里加 static.images —— ` +
          `键用中文情绪名（开心/难过/生气…）或 happy/sad/angry 这类英文名都认。` +
          `详细说明见 README 的「静态立绘」一节。`,
      )
      return
    }

    // Live2D 那套不再需要：停掉渲染循环、藏掉空画布。
    // （Pixi 的 Application 已经建好了，停 ticker 比 destroy 安全 —— destroy 会把
    //   canvas 一起拆掉，而静态立绘还要挂在自己的容器里）
    try {
      app.ticker?.stop()
    } catch {
      /* 忽略 */
    }
    if (canvas) canvas.style.display = 'none'

    // 静态立绘挂到**自己的容器**里，绝不能直接用 canvas.parentNode。
    //
    // canvas 的直接父节点是 <body>，而 createStaticPet() 第一件事就是
    // `host.innerHTML = ''`（它以为 host 是专用容器）—— 传 body 进去会把
    // 输入栏、对话面板、历史浮层、错误浮层**全部删掉**。
    // 实测症状：body 只剩立绘和一个 script 标签，桌宠彻底没法用，而且不报任何错。
    const host = document.createElement('div')
    host.id = 'pet-static-host'
    canvas.parentNode.insertBefore(host, canvas)

    window.petModel = window.petStatic.createStaticPet({
      host,
      baseUrl: `pet://app/assets/models/${dir}`,
      manifest: spec,
    })

    console.log(
      `[pet] 渲染器 = 静态立绘  目录=${dir}  表情=${Object.keys(images).join(', ')}`,
    )
  }

  async function load() {
    // setup 脚本会写一份清单，告诉我们当前装的是哪个模型
    let manifest = { path: 'Hiyori/Hiyori.model3.json' }
    try {
      const res = await fetch('pet://app/assets/models/index.json')
      if (res.ok) manifest = { ...manifest, ...(await res.json()) }
    } catch { /* 没清单就用默认值 */ }

    /**
     * 用哪条渲染路。优先级：
     *   ① URL 参数 `?renderer=`  —— main.js 按 config.json 的 pet.renderer 传下来（正常路径）
     *   ② 清单里的 `renderer`    —— 手工装素材时写在 models/index.json 里
     *   ③ 默认 live2d
     *
     * 为什么优先 URL 而不是直接读清单：配置的唯一事实来源是 config.json，
     * 清单是「装了哪个模型」，两件事不该混在一个文件里。
     */
    const want =
      new URLSearchParams(location.search).get('renderer') || manifest.renderer || 'live2d'

    if (want === 'static') {
      useStaticRenderer(manifest)
      return
    }

    const url = `pet://app/assets/models/${manifest.path}`
    // 不加缓存破坏参数，避免每次启动都重下贴图
    model = await PIXI.live2d.Live2DModel.from(url, {
      autoUpdate: true,
      autoInteract: false,
    })

    app.stage.addChild(model)

    relayout()
    window.addEventListener('resize', relayout)

    // 鼠标点角色 → 播一个被戳的动作
    model.on('pointertap', () => window.petModel.tap())

    installMouthOverride()
    followPointer()
    scheduleIdle()

    if (!face) face = window.petFace.createFace(faceConfig || {})

    // 帧率治理挂在渲染 ticker 上（优先级放低，别跟渲染抢）
    app.ticker.add(governorTick, null, PIXI.UPDATE_PRIORITY.LOW)
    setFps(FPS.active)

    console.log('[pet] 模型已加载：', manifest.path)
  }

  /** 底部让给输入栏 / 字幕的高度，收起输入区时会变小从而腾出空间 */
  let bottomGap = 96

  /**
   * 重新同步渲染分辨率 + 重新摆位。
   *
   * 关键：window.devicePixelRatio 会跟着网页缩放倍率变，
   * 但 Pixi 的 resolution 是建 Application 时读一次的。
   * 缩放之后不同步的话，画布的实际像素没变、却被拉大显示 → 糊。
   * 这就是「放大后看着不清楚」的根因。
   */
  function relayout() {
    if (!model) return
    const dpr = window.devicePixelRatio || 1
    if (Math.abs(app.renderer.resolution - dpr) > 0.01) {
      app.renderer.resolution = dpr
      app.renderer.resize(window.innerWidth, window.innerHeight)
    }
    layout()
  }

  /** 把角色摆到中下部、按可用高度缩放 */
  function layout() {
    if (!model) return
    // 用 screen（逻辑尺寸）而不是 renderer（含 DPI 缩放倍率的物理尺寸）
    const { width, height } = app.screen

    const usable = Math.max(120, height - bottomGap)
    const targetH = usable * 0.94

    const origW = model.internalModel?.originalWidth || model.width || width
    const origH = model.internalModel?.originalHeight || model.height || targetH
    const scale = Math.min(targetH / origH, (width * 0.94) / origW)

    model.scale.set(scale)
    model.anchor.set(0.5, 1)              // 以底边中点为锚，站在输入区上沿
    model.position.set(width / 2, usable + 4)
  }

  // ---------------------------------------------------------------- 对外接口

  const ready = load()
    .then(() => true)
    .catch((e) => {
      fail(`模型加载失败：${e.message}`)
      return false
    })

  window.petModel = {
    ready,

    hitTest(x, y) {
      if (!model) return false
      try {
        const r = model.getBounds()
        return r.contains(x, y)
      } catch {
        return false
      }
    },

    setTalking(on) {
      talking = !!on
      if (!talking) mouthPhase = 0
      markActive()
    },

    /**
     * 换表情。情绪类别由主进程判定（LLM 打的标签，或关键词兜底）。
     * @param {string} cat 开心/惊讶/生气/难过/温柔/平静
     */
    setEmotion(cat) {
      if (!face) face = window.petFace.createFace(faceConfig || {})
      face.set(cat)
      // 角色配了模型自带的表情/动作名就顺带播一下
      if (model) face.playNamed(model, cat)
      markActive()
    },

    /**
     * 角色的表情映射。主进程在启动时把 characters/<id>.json 的 live2d 段送过来。
     * 不调也能跑 —— 用内置的参数预设。
     */
    setFaceConfig(cfg) {
      faceConfig = cfg || {}
      face = window.petFace.createFace(faceConfig)
      // 待机微动：角色文件显式关掉才关。VTS 模型大多没有 idle 动作，默认开着更像活的
      if (faceConfig.idleLife === false) idleLife = false
      // 戳她的参数（角色文件配）
      tapShowParam = faceConfig.tapShowParam || null
      tapRestParams = Array.isArray(faceConfig.tapRestParams) ? faceConfig.tapRestParams : []
      markActive()
    },

    get emotion() {
      return face?.category || '平静'
    },

    /** 语音播放期间保持满帧（嘴型要跟得动），但不启用心跳式的假嘴型 */
    setVoiceActive(on) {
      voiceActive = !!on
      markActive()
    },

    /**
     * 戳一下。
     *
     * 芙宁娜这个模型只有一个动作：挥手。它由两部分组成：
     *   · `Param15` 置 1 —— 「手出现」的开关（模型自带的 wave.exp3.json 就是干这个的）
     *   · `wave.motion3.json` 动画 `Param14/16/17` —— 手臂的摆动
     * 只播动作的话手根本不出现。
     *
     * 收尾完全自己做（见 ticker 里 tapActive 那段）——
     * 框架既不管表情残留，也不把动作结束后的手臂参数还原。
     */
    tap() {
      markActive()
      if (!model) return

      const group = faceConfig?.tapMotion || 'TapBody'
      const holdMs = Number(faceConfig?.tapHoldMs) || 1500

      tapHoldUntil = performance.now() + holdMs
      tapActive = true

      try {
        // motion() 的失败是 Promise rejection，不是同步异常，光 try/catch 接不住
        const p = model.motion(group)
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch {
        /* 没有这个动作组就算了 */
      }

      window.dispatchEvent(new CustomEvent('pet:tapped'))
    },

    /** 主进程在窗口隐藏/显示时调用，隐藏期间完全不渲染 */
    setRunning,

    /** 给设置面板看的当前帧率 */
    getFps: () => currentFps,

    /**
     * 当前嘴型的实际值。
     * 自动化测试用它确认「嘴是不是真的跟着音频在动」——
     * 光看「收到了音频」不够，参数得真在变才算数。
     */
    getMouthValue() {
      try {
        return model?.internalModel?.coreModel?.getParameterValueById('ParamMouthOpenY') ?? 0
      } catch {
        return 0
      }
    },

    /**
     * 读任意参数当前值。调试模型用 —— 截图看不出「参数到底停在哪」。
     * 配合 `electron . --js-file=<文件>` 用。
     */
    getParam(id) {
      try {
        return model?.internalModel?.coreModel?.getParameterValueById(id) ?? null
      } catch {
        return null
      }
    },

    /** 批量读参数，方便一次打印一组 */
    params(ids) {
      const out = {}
      for (const id of ids) out[id] = this.getParam(id)
      return out
    },

    /** 调试用：把模型实际拥有的参数名全列出来 */
    paramIds() {
      try {
        const cdi = model?.internalModel?.settings?.cdi3
        if (cdi?.Parameters) return cdi.Parameters.map((p) => p.Id)
      } catch {
        /* 忽略 */
      }
      return null
    },

    /**
     * 把嘴型定格 value 毫秒。
     *
     * 只给自动化测试截图用：capturePage() 从调用到真正抓像素有几百毫秒，
     * 说话时嘴型几十毫秒就变一次，不冻住的话永远拍到闭嘴那一帧 ——
     * 看起来就像「嘴根本没动」，其实是在动。
     */
    holdMouth(value, ms = 1200) {
      mouthHoldValue = Math.max(0, Math.min(1, Number(value) || 0))
      mouthHoldUntil = performance.now() + ms
    },

    /** 按配置调帧率档位 */
    setFpsConfig,

    /** 窗口尺寸变化 / 缩放变化后调用 */
    relayout,

    /** 输入区收起时调小，让角色长高一点 */
    setBottomGap(px) {
      bottomGap = px
      layout()
    },
  }
})()
