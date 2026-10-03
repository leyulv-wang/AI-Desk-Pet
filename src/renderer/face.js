/**
 * 表情 —— 把情绪类别映射成 Live2D 参数偏移。
 *
 * 为什么不用模型的「表情文件」（expressions）：
 *   1. 官方示例模型 Hiyori 一个表情都没有，只有动作组
 *   2. 不同模型的表情名千奇百怪（F01 / smile / exp_03…），换模型就得重配一遍
 *   3. 真正通用的东西是**参数**——Cubism 标准参数名在所有模型上都是一样的
 *
 * 所以这里直接推标准参数：眼睛开合/微笑、眉毛高低内外、嘴型、脸颊、头部角度。
 * 换任何模型都能用，最多某些参数不存在（会自动跳过）。
 *
 * 关键：用 addParameterValueById **叠加**，不是覆盖。
 * 覆盖会把待机动作的眨眼和呼吸一起顶掉，角色会变成一张死脸。
 */
;(function () {
  /** 一段表情变化持续多久（毫秒）。太快像抽搐，太慢像没反应 */
  const TRANSITION_MS = 380

  /**
   * 每类情绪的参数偏移。
   * 数值都是「在动作算出来的基础上加多少」，范围按 Cubism 标准参数走。
   *
   * **只用各模型普遍都有的参数。** 当前芙宁娜模型（VTS 免费配布版）有：
   *   ParamEyeLOpen/ROpen · ParamEyeLSmile/RSmile · ParamEyeBallX/Y
   *   ParamBrowLForm/RForm · ParamBrowLY/RY · ParamMouthForm · ParamMouthOpenY
   *   ParamAngleX/Y/Z · ParamBodyAngleX/Y/Z · ParamBreath
   * 没有 ParamCheek、ParamBrowLAngle/RAngle、ParamBrowLX/RX ——
   * 所以以下预设一个都没用它们（脸红改用模型自带的 blush 表情，见角色文件的 expressions）。
   *
   * 模型缺哪个参数，apply() 会单独 try/catch 跳过，不会整段失效。
   */
  const PRESETS = {
    开心: {
      ParamEyeLSmile: 0.85,
      ParamEyeRSmile: 0.85,
      ParamMouthForm: 0.7,
      ParamBrowLY: 0.35,
      ParamBrowRY: 0.35,
      ParamBrowLForm: 0.25,
      ParamBrowRForm: 0.25,
      ParamAngleZ: 3,
    },
    得意: {
      // 端着架子：眼睛微眯、嘴角扬起、下巴抬高、头轻轻一侧
      ParamEyeLOpen: -0.15,
      ParamEyeROpen: -0.15,
      ParamEyeLSmile: 0.5,
      ParamEyeRSmile: 0.5,
      ParamMouthForm: 0.55,
      ParamBrowLY: 0.45,
      ParamBrowRY: 0.45,
      ParamAngleY: 5,
      ParamAngleZ: -4,
      ParamBodyAngleZ: 3,
    },
    惊讶: {
      ParamEyeLOpen: 0.4,
      ParamEyeROpen: 0.4,
      ParamBrowLY: 0.9,
      ParamBrowRY: 0.9,
      ParamBrowLForm: 0.35,
      ParamBrowRForm: 0.35,
      ParamAngleY: 3,
    },
    生气: {
      ParamEyeLOpen: -0.15,
      ParamEyeROpen: -0.15,
      // 眉毛压下来用「变形」代替「角度」—— 这个模型没有 ParamBrowLAngle
      ParamBrowLY: -0.85,
      ParamBrowRY: -0.85,
      ParamBrowLForm: -0.6,
      ParamBrowRForm: -0.6,
      ParamMouthForm: -0.75,
      ParamAngleZ: -4,
      ParamBodyAngleZ: -3,
    },
    难过: {
      ParamEyeLOpen: -0.35,
      ParamEyeROpen: -0.35,
      ParamBrowLY: -0.45,
      ParamBrowRY: -0.45,
      // 内侧上抬 = 委屈。模型没有 ParamBrowLX，用「变形」近似
      ParamBrowLForm: 0.6,
      ParamBrowRForm: 0.6,
      ParamMouthForm: -0.65,
      ParamAngleY: -5,
    },
    温柔: {
      ParamEyeLOpen: -0.3,
      ParamEyeROpen: -0.3,
      ParamEyeLSmile: 0.55,
      ParamEyeRSmile: 0.55,
      ParamMouthForm: 0.35,
      ParamBrowLY: 0.15,
      ParamBrowRY: 0.15,
      ParamAngleZ: 7,
    },
    无奈: {
      // 眉毛一高一低（挑眉）+ 半闭眼 + 嘴角下垂 + 歪头 —— 这是「服了」的标准脸
      ParamEyeLOpen: -0.35,
      ParamEyeROpen: -0.35,
      ParamBrowLY: -0.35,
      ParamBrowRY: 0.3,
      ParamBrowLForm: -0.3,
      ParamBrowRForm: 0.25,
      ParamMouthForm: -0.4,
      ParamAngleZ: -7,
      ParamAngleY: -3,
      ParamBodyAngleZ: 4,
    },
    平静: {},
  }

  /**
   * @param {object} [opts]
   * @param {object} [opts.expressionMap] 角色自定义：情绪 → 模型表情名。有就优先播表情
   * @param {object} [opts.motionMap]     角色自定义：情绪 → 动作组名
   */
  function createFace(opts = {}) {
    const expressionMap = opts.expressionMap || {}
    const motionMap = opts.motionMap || {}

    /** 当前正在生效的偏移（已经插值过的） */
    let current = {}
    /** 目标偏移 */
    let target = {}
    let category = '平静'
    let lastChange = 0

    function smoothstep(t) {
      return t * t * (3 - 2 * t)
    }

    const api = {
      get category() {
        return category
      },

      /**
       * 换情绪。立刻开始往新表情过渡，不会瞬变。
       * @param {string} cat
       */
      set(cat) {
        const next = PRESETS[cat] || PRESETS['平静']
        if (cat === category && sameKeys(next, target)) return
        category = cat
        target = next
        lastChange = performance.now()
      },

      /**
       * 每帧调用（在动作更新之后）。把插值中的偏移叠加到模型参数上。
       * @param {object} core CoreModel
       * @param {number} now performance.now()
       */
      apply(core, now) {
        if (!core) return

        const t = Math.min(1, (now - lastChange) / TRANSITION_MS)
        const k = smoothstep(t)

        // 把所有用过的参数名并起来，逐个插值
        const keys = new Set([...Object.keys(current), ...Object.keys(target)])
        for (const id of keys) {
          const from = current[id] || 0
          const to = target[id] || 0
          const v = from + (to - from) * k
          if (Math.abs(v) < 0.001) {
            delete current[id]
            continue
          }
          current[id] = v
          try {
            // 叠加而不是覆盖：动作算出来的眨眼/呼吸保留着
            core.addParameterValueById(id, v)
          } catch {
            /* 这个模型没有这个参数，跳过 */
          }
        }
      },

      /** 角色配了表情/动作名就用模型自带的（有的模型表情做得比参数推的更精致） */
      playNamed(model, cat) {
        let played = false
        const exp = expressionMap[cat]
        if (exp && model) {
          try {
            model.expression(exp)
            played = true
          } catch {
            /* 模型没这个表情 */
          }
        }
        const mot = motionMap[cat]
        if (mot && model) {
          try {
            model.motion(mot)
            played = true
          } catch {
            /* 模型没这个动作组 */
          }
        }
        return played
      },

      /** 回中性 */
      reset() {
        target = {}
        lastChange = performance.now()
      },

      get presets() {
        return PRESETS
      },
    }

    return api
  }

  function sameKeys(a, b) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => a[k] === b[k])
  }

  window.petFace = { createFace, PRESETS, TRANSITION_MS }
})()
