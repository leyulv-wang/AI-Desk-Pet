/**
 * 静态立绘渲染器 —— Live2D 之外的第二条路
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它是什么
 * ─────────────────────────────────────────────────────────────────────
 * 不用 Live2D 模型，用**一组图片**当角色：情绪变了就换一张图。
 * 虚拟主播圈叫 **PNGtuber**，美术圈叫**差分图 / 立绘差分**，
 * 日本老牌桌宠平台（伺か / 伪春菜）几十年前就这么干了。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要做这条备用路
 * ─────────────────────────────────────────────────────────────────────
 * Live2D 那条路的成本在**换角色**上：
 *   · 得找到模型，而且大多是别人的同人作品（我们现在那个芙宁娜明确禁止二次配布）
 *   · 几十 MB，还要 Cubism Core
 * 静态立绘是几张 PNG，几百 KB，自己画/AI 生成都行。
 * 代价是**没有形变** —— 表情靠换整张画，不能像 Live2D 那样眉毛眼睛一起动。
 * 两条路并存，配置里切，各取所需。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 一个关键决定：**不用 Pixi**
 * ─────────────────────────────────────────────────────────────────────
 * Live2D 那条路必须用 Pixi（Cubism 渲染器依赖它）。但静态立绘要的东西
 * —— 换图、淡入、呼吸、点一下弹一下 —— 用 CSS 全都能做，而且更简单：
 *   · 不用加载 400KB 的 pixi.min.js 和 Cubism Core
 *   · 不占 WebGL 上下文（省显存，和「云端语音不吃显存」是一个思路）
 *   · 动效交给合成器，比每帧 JS 改参数更省 CPU
 * 所以这个文件**一行 Pixi 都没有**，纯 DOM。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 对外接口和 petModel 完全一致
 * ─────────────────────────────────────────────────────────────────────
 * 上层（chat.js / main.js）不需要知道当前是哪种渲染器 —— 两边暴露同一组方法。
 * 这是能「配置里切换」的前提。Live2D 独有的那几个（getParam / holdMouth）
 * 这里给**无害的空实现**，不是抛错 —— 上层用的是可选链调用，但不抛错更稳。
 */
;(() => {
  // ---------------------------------------------------------------- 情绪名映射
  //
  // 主进程传下来的是中文类别（emotion.js 的 8 类）。清单里的键可能是
  // 中文也可能是英文（PNGtuber 素材包一般是 happy/sad/angry 这种）。
  // 两套都认，免得用户为了适配我们还去改素材包的文件名。
  const ALIAS = {
    开心: ['开心', 'happy', 'joy', 'smile'],
    得意: ['得意', 'proud', 'smug', 'confident'],
    惊讶: ['惊讶', 'surprise', 'surprised', 'shock'],
    生气: ['生气', 'angry', 'anger', 'mad'],
    难过: ['难过', 'sad', 'sorrow'],
    温柔: ['温柔', 'gentle', 'tender', 'soft'],
    无奈: ['无奈', 'helpless', 'wry', 'resigned'],
    平静: ['平静', 'neutral', 'normal', 'calm', 'default'],
  }

  /** 中文类别 → 清单里实际存在的那个键。找不到返回 null（调用方回落默认图） */
  function resolveKey(images, cat) {
    const want = ALIAS[cat] || [cat]
    for (const w of want) {
      if (images[w]) return w
    }
    // 退一步：不区分大小写地找一遍（素材包命名不规范时有用）
    const lower = Object.keys(images).reduce((m, k) => ((m[k.toLowerCase()] = k), m), {})
    for (const w of want) {
      const hit = lower[w.toLowerCase()]
      if (hit) return hit
    }
    return null
  }

  /**
   * 建一个静态立绘角色。
   * @param {object} opts
   * @param {HTMLElement} opts.host 挂载容器（铺满窗口，pointer-events 由外层管）
   * @param {string} opts.baseUrl 图片目录的 URL 前缀（pet://app/assets/models/xxx）
   * @param {object} opts.manifest 清单：{ default, images, talk, idleEmotions, idleIntervalSec }
   */
  function createStaticPet({ host, baseUrl, manifest }) {
    const images = manifest?.images || {}
    const talkFile = manifest?.talk || null
    const defaultKey = manifest?.default || (images.neutral ? 'neutral' : Object.keys(images)[0])
    const idlePool = Array.isArray(manifest?.idleEmotions)
      ? manifest.idleEmotions.filter((k) => images[k])
      : Object.keys(images).filter((k) => k !== defaultKey)
    const [idleMin, idleMax] = Array.isArray(manifest?.idleIntervalSec)
      ? manifest.idleIntervalSec
      : [12, 25]

    const url = (file) => `${baseUrl.replace(/\/+$/, '')}/${file}`

    // ---- DOM
    //
    // 两个槽做交叉淡入：换图时新图先淡入、旧图再撤，避免中间闪一下白
    // （直接改同一个 <img> 的 src 会闪 —— 新图解码完成前是空的）
    host.innerHTML = ''
    host.style.cssText += ';position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;pointer-events:none;'

    const stage = document.createElement('div')
    stage.className = 'static-pet-stage'
    host.appendChild(stage)

    const slots = [0, 1].map((i) => {
      const img = document.createElement('img')
      img.className = 'static-pet-img'
      img.draggable = false
      img.style.cssText =
        'position:absolute;bottom:0;left:50%;transform:translateX(-50%);' +
        'max-height:100%;max-width:100%;object-fit:contain;opacity:0;' +
        `transition:opacity var(--sp-fade,180ms) ease;will-change:opacity,transform;`
      stage.appendChild(img)
      return img
    })

    let front = 0 // 当前显示的是哪个槽
    let currentKey = defaultKey
    let talking = false
    let emotionTimer = null
    let idleTimer = null
    let running = true
    let destroyed = false

    /**
     * 往指定槽里装一张图，装好了再淡入。
     *
     * **必须有 onerror**：图片 404 或 MIME 不对时（`pet://` 协议按扩展名给
     * Content-Type，`.svg` 漏配过一次就中招）浏览器不会触发 onload，
     * 结果就是**立绘一片空白但没有任何报错** —— 用户只会觉得软件坏了。
     * 这里至少把它打到 console。
     *
     * @param {number} idx 目标槽（0 或 1）
     * @param {string} file 清单里的文件名
     */
    function setImage(idx, file) {
      const img = slots[idx]
      const next = url(file)
      if (img.src === next && img.complete && img.naturalWidth) {
        img.style.opacity = '1'
        slots[1 - idx].style.opacity = '0'
        front = idx
        return
      }
      img.onerror = () => {
        console.error(
          `[static-pet] 图片加载失败：${next}` +
            `（检查文件是否存在、扩展名有没有登记在 main.js 的 MIME 表里）`,
        )
      }
      img.onload = () => {
        if (destroyed) return
        img.style.opacity = '1'
        slots[1 - idx].style.opacity = '0'
        front = idx
      }
      img.src = next
    }

    /**
     * 换到某个键对应的图。同键不重复换（否则每次情绪刷新都要淡一次）。
     *
     * ⚠️ **判据必须是 currentKey，而且 currentKey 只能由这个函数维护。**
     * 调用方不要「先把 currentKey 改了再调 show」—— 那样这里的守卫会看到
     * key === currentKey，误判成「已经显示过了」直接 return，**图永远不换**，
     * 而 emotion 属性却是对的（踩过：setEmotion 里就是先改了 currentKey）。
     */
    function show(key, { force = false } = {}) {
      const file = images[key] || images[defaultKey]
      if (!file) return
      if (!force && key === currentKey) return
      setImage(1 - front, file)
      currentKey = key
    }

    /** 情绪图：说话时优先显示 talk 差分 */
    function refresh() {
      if (talking && talkFile) {
        setImage(1 - front, talkFile)
      } else {
        // 从「说话图」切回「情绪图」时，currentKey 没变（一直是情绪键），
        // 所以必须 force —— 否则守卫会拦下来，说完话就一直挂着说话脸。
        show(currentKey, { force: true })
      }
    }

    // ---- 待机随机表情
    //
    // 为什么需要：静态立绘最大的问题是「不动」。Live2D 有呼吸和眨眼撑着，
    // 静态图不换就是一张死图。随机换表情是最省事的「活着」信号。
    function scheduleIdle() {
      clearTimeout(idleTimer)
      if (!running || destroyed || !idlePool.length) return
      const wait = (idleMin + Math.random() * Math.max(0, idleMax - idleMin)) * 1000
      idleTimer = setTimeout(() => {
        if (talking) return scheduleIdle() // 说话时不抢
        const pick = idlePool[Math.floor(Math.random() * idlePool.length)]
        show(pick, { force: true })
        // 约 3.5 秒后回默认
        setTimeout(() => {
          if (!talking && !destroyed) show(defaultKey, { force: true })
        }, 3500)
        scheduleIdle()
      }, wait)
    }

    // ---- 对外

    const api = {
      /** 静态立绘是 DOM，资源一加载就能用。图还没到也先算 ready —— 首帧不会闪 */
      get ready() {
        return !destroyed && !!images[defaultKey]
      },

      get emotion() {
        return currentKey
      },

      /**
       * 点没点中。
       *
       * Live2D 那边用 `model.getBounds()`（模型自身的包围盒，会跟着动作变）。
       * 静态立绘用图片在屏幕上的实际矩形 —— 但**不能只看矩形**：
       * 立绘是透明的 PNG，四周大片空白，用矩形会出现「点到空气也算点到」。
       * 所以额外用**像素级命中**：把点击坐标映射到图片像素，读 alpha。
       * 代价是一次 getImageData（几毫秒），只在点击时发生，可接受。
       */
      hitTest(x, y) {
        const img = slots[front]
        if (!img || !img.complete || !img.naturalWidth) return false
        const r = img.getBoundingClientRect()
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false
        try {
          const c = api._alphaCanvas || (api._alphaCanvas = document.createElement('canvas'))
          const w = (c.width = img.naturalWidth)
          const h = (c.height = img.naturalHeight)
          const ctx = c.getContext('2d', { willReadFrequently: true })
          ctx.clearRect(0, 0, w, h)
          ctx.drawImage(img, 0, 0)
          const px = Math.floor(((x - r.left) / r.width) * w)
          const py = Math.floor(((y - r.top) / r.height) * h)
          return ctx.getImageData(px, py, 1, 1).data[3] > 8 // alpha 阈值，8 以下算透明
        } catch {
          // 读不到像素（跨源/CSP）就退回矩形判定 —— 宁可宽松，也别点了没反应
          return true
        }
      },

      setTalking(on) {
        const next = !!on
        if (next === talking) return
        talking = next
        refresh()
      },

      /** @param {string} cat 中文情绪类别（开心/得意/惊讶/生气/难过/温柔/无奈/平静） */
      setEmotion(cat) {
        const key = resolveKey(images, cat)
        // 注意：**不要**在这里先写 currentKey —— show() 自己会写。
        // 先写会让 show() 的「同键不换」守卫误判，图不换但 emotion 变了。
        if (key && !talking) show(key)
        // 情绪是有时效的：几秒后回默认，免得一直挂着某个表情
        clearTimeout(emotionTimer)
        emotionTimer = setTimeout(() => {
          if (!talking) show(defaultKey)
        }, 6000)
      },

      /**
       * 角色配置。
       *
       * 和 Live2D 那条路共用一个入参（characters/<id>.json 的 live2d 段），
       * 静态立绘只认 `images` / `talk` / `default` 这几个键，其余忽略。
       * 这样角色文件不用为两种渲染器写两份。
       */
      setFaceConfig(cfg) {
        if (cfg?.staticImages) {
          Object.assign(images, cfg.staticImages)
        }
      },

      setVoiceActive() {
        /* 静态立绘没有「嘴型」这个概念 —— 说话靠 talk 差分图。空实现是故意的 */
      },

      /** 戳一下：弹一下 + 通知外层（台词由 chat.js 管，这里只做动效） */
      tap() {
        const img = slots[front]
        if (!img) return
        img.style.transition = 'opacity var(--sp-fade,180ms) ease, transform 140ms cubic-bezier(.3,1.6,.5,1)'
        img.style.transform = 'translateX(-50%) scale(1.06) translateY(-6px)'
        setTimeout(() => {
          img.style.transform = 'translateX(-50%)'
          setTimeout(() => {
            img.style.transition = 'opacity var(--sp-fade,180ms) ease'
          }, 160)
        }, 140)
      },

      getFps: () => 0, // DOM 渲染没有「帧率」可言，交给合成器
      getParam: () => 0, // Live2D 专有：静态立绘没有参数
      holdMouth() {
        /* 同上 */
      },

      /**
       * 「嘴张开度」。
       *
       * Live2D 那边读的是 ParamMouthOpenY（连续值 0~1）。静态立绘**没有嘴型参数** ——
       * 说话时换的是整张 talk 差分图，只有开/关两态。所以这里返回**二值**：
       * 说话中 1，否则 0。
       *
       * 为什么不返回 -1（「不支持这个参数」）：`--selftest` 靠这个值判断
       * 「嘴张得够大了，可以截图」（main.js 里 `v > 0.45` 才 capturePage）。
       * 返回 -1 的话静态立绘永远截不到说话图，自检静默失效。
       */
      getMouthValue() {
        return talking ? 1 : 0
      },

      setRunning(on) {
        running = !!on
        if (running) scheduleIdle()
        else clearTimeout(idleTimer)
      },

      setFpsConfig() {
        /* 帧率治理对 DOM 没意义 —— 没在跑渲染循环 */
      },

      setBottomGap(px) {
        const gap = Math.max(0, Number(px) || 0)
        // 图片是绝对定位，stage 的 padding 不会抬高它。
        for (const img of slots) {
          img.style.bottom = `${gap}px`
          img.style.maxHeight = `calc(100% - ${gap}px)`
        }
      },

      relayout() {
        /* 布局靠 CSS（flex + object-fit），窗口变了浏览器自己重排 */
      },

      destroy() {
        destroyed = true
        clearTimeout(emotionTimer)
        clearTimeout(idleTimer)
        host.innerHTML = ''
      },
    }

    // ---- 常驻微动：呼吸
    //
    // 纯 CSS 动画，不占 JS。静态图不呼吸就是一张贴纸，加了之后「活着」感强很多。
    // 用 transform 而不是改 height —— 前者只走合成器，不触发重排。
    const breathe = document.createElement('style')
    breathe.textContent = `
      .static-pet-stage { position: relative; height: 100%; width: 100%; display: flex; align-items: flex-end; justify-content: center; }
      .static-pet-img { animation: sp-breathe 4.2s ease-in-out infinite; }
      @keyframes sp-breathe {
        0%, 100% { margin-bottom: 0; }
        50%      { margin-bottom: 6px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .static-pet-img { animation: none; }
      }
    `
    document.head.appendChild(breathe)

    // 首图
    show(defaultKey, { force: true })
    api.setBottomGap(96)
    scheduleIdle()

    return api
  }

  window.petStatic = { createStaticPet, resolveKey, ALIAS }
})()
