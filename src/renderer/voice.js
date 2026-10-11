/**
 * 语音播放 + 嘴型包络
 *
 * 主进程把回复切成句子、逐句合成，一句好了就扔过来。这里负责：
 *   1. 按顺序排队播放（不能抢话）
 *   2. 解码时顺手算出**真实的音量包络**，喂给嘴型
 *
 * 为什么不用「说话时正弦函数开合嘴」那套假动作：
 * 那和音频完全对不上，闭着嘴的时候嘴在动、拖长音的时候嘴在抖，一眼假。
 * 解码后按 30ms 一帧算 RMS，就是这句话真实的响度曲线 —— 免费且准确。
 */
;(function () {
  /** 包络的时间分辨率（毫秒） */
  const HOP_MS = 30
  /**
   * 段与段之间的兜底间隔。
   *
   * 正常情况下用主进程给的 `pauseAfter`（按句尾标点算：问句 300ms、省略号 380ms…），
   * 这个常量只在没给 pauseAfter 时兜底。
   *
   * 注意：合成的每一段原本自带首尾静音（首部 0.07~0.71s 乱跳），
   * 以前加上这里固定的 70ms，实际句间停顿到了 0.77s —— 又长又不稳。
   * 现在 tts.js 会把首尾静音裁掉，停顿完全由 pauseAfter 控制。
   */
  const GAP_FALLBACK_MS = 260
  /** 归一化的分位数：按 95% 分位当满格，避免个别爆音把整体压扁 */
  const NORM_PERCENTILE = 0.95

  let ctx = null
  let gain = null
  let unlocked = false

  const queue = []
  let playing = false
  let current = null // { source, env, startedAt, durationMs, text }

  /**
   * 当前 `playOne()` 那个 Promise 的 resolve。
   *
   * **为什么必须单独存一份**：`stop()` 要能立刻打断正在播的那一条，
   * 而 `pump()` 是靠 `await playOne(item)` 串起来的 —— 只要那个 Promise 不 resolve，
   * `pump()` 就永远卡在那儿，`playing` 永远是 true，之后**任何** enqueue 都进不来。
   *
   * 之前 `stop()` 里先 `current.source.onended = null` 再 `stop()`，
   * 等于把唯一的 resolve 路径也摘掉了：点一次「停止」（或再点一次 ▶ 想停）
   * 就把整个播放器永久锁死 —— 表现是「之后点哪首歌都没反应」。
   */
  let currentResolve = null
  let pendingLoad = null
  let pendingItem = null
  let gapTimer = null
  let playbackGeneration = 0

  /** 累计统计：确认「到底有没有真的出声」，而不只是「收到了通知」 */
  const totals = { played: 0, playedMs: 0, failed: 0, peak: 0, lastText: '' }

  const listeners = { state: [], error: [] }

  /**
   * 播不出来时通知外部。
   *
   * 为什么必须报出来：以前 `playOne` 只在 console 里 `console.error`，
   * 用户点了 ▶ 什么都没发生、也没有任何提示 —— 只能靠翻日志才知道
   * 是 fetch 403 还是解码失败。唱歌的产物是大文件，出问题的概率不小，
   * 静默失败在这里是不可接受的。
   */
  function emitError(message, item) {
    console.error('[voice] ' + message)
    for (const fn of listeners.error) {
      try {
        fn({ message, url: item?.url, category: item?.category })
      } catch {
        /* 监听器自己炸了不该影响别的 */
      }
    }
  }

  function ensureCtx() {
    if (ctx) return ctx
    ctx = new AudioContext()
    gain = ctx.createGain()
    gain.gain.value = 1
    gain.connect(ctx.destination)
    return ctx
  }

  /** 浏览器的自动播放策略：没交互过不让出声。第一次点击/按键时解禁 */
  function unlock() {
    if (unlocked) return
    ensureCtx()
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    unlocked = true
  }
  window.addEventListener('pointerdown', unlock, { once: false })
  window.addEventListener('keydown', unlock, { once: false })

  /**
   * 从解码后的音频算音量包络。
   * @returns {Float32Array} 每 HOP_MS 一个 0..1 的值
   */
  function buildEnvelope(buffer) {
    const data = buffer.getChannelData(0)
    const sr = buffer.sampleRate
    const hop = Math.max(1, Math.round((HOP_MS / 1000) * sr))
    const frames = Math.max(1, Math.ceil(data.length / hop))
    const env = new Float32Array(frames)

    // 每帧 RMS
    for (let f = 0; f < frames; f++) {
      const s = f * hop
      const e = Math.min(data.length, s + hop)
      let sum = 0
      for (let i = s; i < e; i++) sum += data[i] * data[i]
      env[f] = Math.sqrt(sum / Math.max(1, e - s))
    }

    // 按分位数归一化
    const sorted = Float32Array.from(env).sort()
    const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * NORM_PERCENTILE))] || 1
    const scale = ref > 1e-4 ? 1 / ref : 0
    for (let i = 0; i < frames; i++) env[i] = Math.min(1, env[i] * scale)

    // 轻度平滑：相邻帧做一次加权，避免嘴型一帧一个样地抖
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const a = env[i - 1] ?? env[i]
      const b = env[i]
      const c = env[i + 1] ?? env[i]
      out[i] = (a + 2 * b + c) / 4
    }
    return out
  }

  async function load(url, signal) {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`取音频失败 ${res.status}`)
    const buf = await res.arrayBuffer()
    ensureCtx()
    return ctx.decodeAudioData(buf)
  }

  function emitState() {
    const s = { speaking: !!current, loading: !!pendingLoad, queued: queue.length,
      busy: playing, text: current?.text || pendingItem?.text || '', category: current?.category || pendingItem?.category || '' }
    for (const fn of listeners.state) {
      try {
        fn(s)
      } catch {
        /* 监听器自己炸了不该影响播放 */
      }
    }
  }

  /** 播一条，返回 Promise，播完/被打断时 resolve */
  function playOne(item, generation) {
    return new Promise((resolve) => {
      const controller = new AbortController()
      pendingLoad = controller
      pendingItem = item
      const valid = () => generation === playbackGeneration && !controller.signal.aborted
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        if (currentResolve === done) currentResolve = null
        if (pendingLoad === controller) { pendingLoad = null; pendingItem = null }
        resolve()
      }
      currentResolve = done
      emitState()
      ;(async () => {
      let buffer
      try {
        buffer = await load(item.url, controller.signal)
      } catch (e) {
        if (!valid()) return done()
        totals.failed++
        emitError(`取音频失败：${e.message}（${item.url}）`, item)
        return done()
      }
      if (!valid()) return done()

      /**
       * 口型包络的来源可以和播放的音频**不是同一个文件**。
       *
       * 唱歌那条链路必须这样：播的是混好的成品（人声 + 伴奏），
       * 但包络要从**单独的人声轨**算 —— 拿成品算的话鼓和贝斯会一起进包络，
       * 她的嘴就会跟着鼓点开合，一眼假。
       *
       * 说话那条链路两者是同一个文件（mouthUrl 不传），行为完全不变。
       */
      let envBuffer = buffer
      if (item.mouthUrl && item.mouthUrl !== item.url) {
        try {
          envBuffer = await load(item.mouthUrl, controller.signal)
        } catch (e) {
          if (!valid()) return done()
          emitError(`口型轨解码失败，退回用成品算包络：${e.message}`, item)
          envBuffer = buffer
        }
      }
      if (!valid()) return done()
      pendingLoad = null
      pendingItem = null
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(gain)

      const env = buildEnvelope(envBuffer)
      const durationMs = buffer.duration * 1000

      current = { source, env, startedAt: performance.now(), durationMs, text: item.text, category: item.category }
      totals.played++
      totals.playedMs += durationMs
      totals.lastText = item.text || ''
      for (let i = 0; i < env.length; i++) if (env[i] > totals.peak) totals.peak = env[i]
      emitState()

      source.onended = () => {
        if (current && current.source === source) {
          current = null
          // 队列里还有下一段才停 —— 最后一段后面不需要拖一个静默尾巴
          const pause = Number(item.pauseAfter)
          const wait = queue.length ? (Number.isFinite(pause) && pause >= 0 ? pause : GAP_FALLBACK_MS) : 0
          gapTimer = setTimeout(() => {
            gapTimer = null
            if (!valid()) return done()
            emitState()
            done()
          }, wait)
        } else {
          // 已经被 stop() 提前 resolve 过了（resolve 是幂等的，再调一次无副作用）
          done()
        }
      }

      try {
        source.start()
      } catch (e) {
        emitError(`播放失败：${e.message}`, item)
        current = null
        done()
      }
      })().catch((e) => {
        if (valid()) {
          totals.failed++
          current = null
          emitError(`播放失败：${e.message}`, item)
        }
        done()
      })
    })
  }

  async function pump() {
    if (playing) return
    const generation = playbackGeneration
    playing = true
    try {
      while (generation === playbackGeneration && queue.length) {
        const item = queue.shift()
        await playOne(item, generation)
      }
    } finally {
      if (generation === playbackGeneration) {
        playing = false
        current = null
        emitState()
      }
    }
  }

  const api = {
    /**
     * 入队一段。back=true 表示这是这一轮回复的最后一句。
     *
     * `mouthUrl`（可选）= 口型包络单独取哪个文件。说话时不传；
     * 唱歌时传人声轨 —— 见 playOne 里的注释。
     */
    enqueue(item) {
      if (!item?.url) return
      queue.push(item)
      pump()
    },

    /**
     * 唱歌：播放成品。存在单独人声轨时用它驱动口型，云端只有混音时跟随混音。
     */
    sing({ url, mouthUrl, title }) {
      api.stop()
      api.enqueue({ url, mouthUrl, text: title || '', category: '唱歌' })
    },

    /** 打断：停掉正在播的、清空队列、嘴闭上 */
    stop() {
      playbackGeneration++
      queue.length = 0
      playing = false
      pendingLoad?.abort()
      pendingLoad = null
      pendingItem = null
      clearTimeout(gapTimer)
      gapTimer = null

      // 先把「解开 pump」需要的两样东西摘出来，再动 source ——
      // 顺序反了（比如先摘 onended）就会丢掉唯一的 resolve 路径，播放器永久锁死
      const src = current?.source
      const done = currentResolve
      current = null
      currentResolve = null

      if (src) {
        try {
          src.onended = null
          src.stop()
        } catch {
          /* 已经停了 */
        }
      }
      // ★ 关键：一定要 resolve，否则 pump() 卡在 await 上、playing 永远 true，
      //   之后所有 enqueue 都会被 `if (playing) return` 挡掉（点哪首都没反应）
      if (done) done()
      emitState()
    },

    /**
     * 当前嘴应该张多大（0..1）。
     * pet.js 每帧调用 —— 用当前播放位置去包络里查表。
     */
    mouthLevel() {
      if (!current) return 0
      const elapsed = performance.now() - current.startedAt
      if (elapsed < 0 || elapsed > current.durationMs) return 0
      const idx = Math.floor(elapsed / HOP_MS)
      return current.env[idx] ?? 0
    },

    get speaking() {
      return !!current
    },
    get pending() {
      return queue.length
    },
    get busy() { return playing || !!pendingLoad || !!current },

    /** 真出过声没有 —— 自动化测试就看这个 */
    get stats() {
      return { ...totals, speaking: !!current, queued: queue.length, ctxState: ctx?.state || 'none' }
    },

    onState(fn) {
      listeners.state.push(fn)
    },

    /** 播不出来时回调（fetch/解码/播放失败）。唱歌面板用它往日志里报错 */
    onError(fn) {
      listeners.error.push(fn)
    },

    /** 设置面板里的试听用：直接播一个 wav 地址 */
    preview(url, text) {
      api.stop()
      api.enqueue({ url, text: text || '', category: '试听' })
    },

    unlock,
  }

  window.petVoice = api
})()
