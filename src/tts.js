const { fetchBuffered } = require('./api-request')
const { AsyncLocalStorage } = require('node:async_hooks')
/**
 * TTS —— 把一句回复变成一段能播的 wav。
 *
 * 设计要点：
 *
 *   ① 后端可插拔。默认 minimax（云端 API），
 *      也能切 siliconflow（云端 CosyVoice2），或者直接 none 关掉。
 *      换角色/换后端的成本应该只是改配置，不是改代码。
 *
 *   ② 「用哪条参考音频」不在这里决定，交给 voice-select.js。
 *      这个模块只负责：拿到 (文本, 情绪类别) → 挑参考 → 调后端 → 落盘。
 *
 *   ③ 结果落盘缓存。桌宠的回复大量重复（「嗯嗯。」「我在这儿呢。」），
 *      同一条文本 + 同一个参考 + 同一套参数 = 字节完全一样，没必要重算。
 *      一次 GPT-SoVITS 推理在 5060 上要 1~3 秒，缓存命中是 0ms。
 *
 *   ④ 不碰播放。播放和嘴型在渲染层（那里才有 WebAudio），
 *      这里只把 wav 写到磁盘并给一个 pet://app/audio/tts/<file> 地址。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')
const { pickReference, charCount } = require('./voice-select')

/** 默认配置 —— 用户 config.json 里的 tts 段会和这些做深合并 */
const DEFAULTS = {
  enabled: false,
  backend: 'minimax',

  /** 回复一到就自动念出来。false 时只在气泡上留个「念」按钮 */
  autoplay: true,

  gptsovits: {
    baseUrl: 'http://127.0.0.1:9880',
    /**
     * 桌宠启动时顺手把本地语音服务拉起来。
     * 服务本来就在跑就不碰；是我们拉起来的，退出时由我们关掉。
     * 找不到整合包也只是不出声，不影响打字聊天。
     */
    autoStart: true,
    textLang: 'zh',
    promptLang: 'zh',
    /** cut5 是官方默认；短句用 cut0（不切）能少一点拼接感 */
    textSplitMethod: 'cut5',
    /**
     * v3/v4 的 CFM 采样步数。32 是默认，24 已经听不出差别，延迟降 1/4
     */
    sampleSteps: 24,
    /**
     * 锁随机种子。
     *
     * 同一轮回复的几句话如果各自随机采样，语气会有额外的抖动。
     * 打开后种子由「情绪类别 + 参考音频」推导 ——
     * 是确定值，所以磁盘缓存照样命中，而同一条参考下的所有句子采样风格一致。
     */
    seedLock: true,
    /** 没开 seedLock 时用 -1（每次随机） */
    seed: -1,
    /** 语速。芙宁娜原声偏快，1.05 左右比较像 */
    speedFactor: 1.05,
    temperature: 1.0,
    topK: 5,
    topP: 1.0,
    /** 首次调用要建缓存，给宽一点 */
    timeoutMs: 90000,
  },

  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    /** 预置音色写 'model:alex'，克隆音色写上传拿到的 uri */
    voice: '',
    timeoutMs: 60000,
  },

  /**
   * MiniMax 云端声音克隆。
   *
   * 和另外两条后端最大的不同：**不需要参考音频**。
   * 音色锁在云端的 `voiceId` 上，克隆一次之后每次合成只报这个名字。
   *
   * 为什么选 turbo 而不是 hd：实测听不出差别，但便宜 43%（¥2.0 vs ¥3.5 / 万字符），
   * 而且更快（655~1067ms vs 811~1848ms）。详见 scripts/compare-tts-tiers.mjs。
   *
   * ⚠️ 计费口径：**1 个汉字算 2 个字符**，标点算 1 个。
   *    一句 60 汉字的回复 ≈ 125 计费字符 —— 算钱时别按字数算，会差一倍。
   */
  minimax: {
    /** 注意是 minimaxi.com（国内站）。国际站 api.minimax.io 不认国内账号的 key */
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: '',
    model: 'speech-2.8-turbo',
    /** 克隆得到的音色名（自己起的那个，不是返回的） */
    voiceId: '',
    speed: 1.0,
    vol: 1.0,
    pitch: 0,
    /**
     * 情绪。留空 = 不传（默认）。
     * 实测传 emotion=happy 比不传高 4.7 半音，**确实有影响** ——
     * 但多一个变量就多一份不确定，而换到云端本来图的就是「稳」。
     * 想按情绪走就把 emotionMap 填上，可选值：
     *   happy / sad / angry / fearful / disgusted / surprised / neutral
     */
    emotion: '',
    emotionMap: null,
    sampleRate: 32000,
    bitrate: 128000,
    timeoutMs: 60000,
  },

  /**
   * 小米 MiMo 声音克隆。
   *
   * 结构上比 MiniMax 简单：**没有克隆步骤、没有 voiceId** ——
   * 克隆音频每次随请求内联发过去（base64），所以不存在「7 天不用被删」的问题。
   *
   * 为什么可能更值得用：
   *   ① **限时免费**（三个 TTS 模型都免费，不消耗 Token Plan 额度）
   *   ② 支持**行内音频标签**（`[叹气]` `[轻笑]` `[颤抖]` 这类）和自然语言风格指令
   *      —— MiniMax 的 emotion 参数只有 7 个粗粒度值还不能混
   *   ③ 样本只要**数秒**（MiniMax 要 10 秒~5 分钟）
   *
   * 坑：`voice` 字段的语义随 model 变化 ——
   *   mimo-v2.5-tts          → 音色名（`mimo_default` / `冰糖` / `茉莉` / `苏打` / `白桦` …）
   *   mimo-v2.5-tts-voiceclone → **base64 data URL**（`data:audio/wav;base64,…`），只能 mp3/wav
   *   mimo-v2.5-tts-voicedesign → 不支持这个字段（音色由 user message 描述）
   */
  mimo: {
    /** Token Plan 端点（`tp-` 开头的 key 只认它）；按量计费是 api.xiaomimimo.com */
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    apiKey: '',
    model: 'mimo-v2.5-tts-voiceclone',
    /** 克隆样本（mp3/wav）。留空则回退到 presetVoice */
    voiceSample: '',
    /** 预置音色（非克隆模式时用） */
    presetVoice: 'mimo_default',
    /** 自然语言风格指令，放在 user message 里。比如「用轻快上扬的语调，带着小骄傲」 */
    instruction: '',
    format: 'wav',
    timeoutMs: 60000,
  },

  cache: {
    enabled: true,
    /** 缓存文件数上限，超了删最旧的 */
    maxFiles: 400,
  },

  /**
   * 输出响度归一化 + 裁掉首尾静音。
   *
   * 静音的实测数据：每段自带首部静音 0.07~0.71s（乱跳）、尾部约 0.22s，
   * 加上播放层 70ms 间隔 → 句间停顿约 0.77s，是自然停顿的 2~3 倍且忽长忽短。
   * 裁掉后由播放层按句尾标点补一个固定停顿，节奏才可控。
   */
  trimSilence: true,
  normalizeLoudness: true,
  loudness: { targetRms: 0.09, peakCeiling: 0.97, leadKeepMs: 40, tailKeepMs: 90 },

  /**
   * 语速校准（**默认关闭** —— 实测这条路不成立，见下）。
   *
   * 想法：不同参考的输出语速差 2.3 倍，而 speed_factor 是线性的，
   * 那先用一句固定的探测句测出每个参考的语速、再按比例补偿，不就能拉齐了？
   *
   * 实测结果：**不能**。探测句测出的语速无法预测另一个句子的语速：
   *     参考 d27bb7f4  探测 3.57 → 实际 2.82（最低 → 最低，对）
   *     参考 494396d3  探测 6.79 → 实际 6.29（最高 → 最高，对）
   *     参考 f062c823  探测 6.12 → 实际 2.75（偏高 → 却是最低，错得离谱）
   * 排序大体成立，但被「嗯，我在听，你说吧。」这种**带长语气词的短句**打崩 ——
   * 一个拖长的「嗯」就把整句的语速拉下去了，而探测句里没有这种情况。
   * 加宽 clamp 之后极差没改善（2.29 → 2.20 倍），整体还被拖慢了三成。
   *
   * 结论：想真正拉齐语速，只能**对每一句实际合成后再测、再重合成**（成本翻倍），
   * 或者**建库时用多句探测**得到每条参考的稳健补偿值（一次性成本，推荐）。
   * 在那之前，宁可不校准，也不要一个「看起来在工作、实际更糟」的机制。
   */
  rateCalibration: false,
  /** 目标语速，单位：字 / 有声秒。开启校准时才用 */
  rateTarget: 4.3,
  /** 校正幅度上下限 */
  rateClamp: [0.55, 1.6],
  /** 校准用的探测句 —— 太短测不准，太长每次多花时间 */
  rateProbeText: '这是一句用来校准朗读速度的测试句子。',

  /** 记住最近用过的参考音频，避免连着两句一个味。只在 referenceMode='rotate' 时生效 */
  recentRefMemory: 6,

  /**
   * 参考音频的挑选策略。
   *
   *   'sticky'（默认）—— **每个情绪类别固定用同一条参考**。
   *   'rotate'        —— 每次都在类别内换（原来的行为）。
   *
   * 为什么默认 sticky：实测（npm run diag:prosody）
   *   同一条参考、同一句话，重跑三次输出**逐字节相同**（种子锁定了，噪声为 0）；
   *   但换成同类别里的另一条参考，输出会变：
   *       音高差 4.6 半音（将近四度）
   *       语速差 1.9 倍
   *       响度差 2.6 倍
   *   而冷却机制本来是**每轮都强制换参考**的 —— 于是每回复一句就换一个嗓子，
   *   这正是用户反复反馈的「情绪不连贯」。
   *
   * 现在有三档：
   *   'fixed'  —— **整只桌宠固定用同一条参考**（素材全是戏剧化台词时推荐）
   *   'sticky' —— 每个情绪类别固定用同一条（声音随情绪变）
   *   'rotate' —— 每次都在类别内换（原行为，跳得最厉害）
   *
   * 为什么 'fixed' 往往更好（实测数据）：
   *   · 换一条参考 = 音高差 **5.9 半音**（接近三全音）+ 语速差 1.9 倍 + 响度差 2.6 倍
   *     —— 听起来就是换了个嗓子
   *   · 而整个「平静」池 122 条里**没有一条是真正平淡的**（音域最小 6.05、中位 9.35，
   *     自然平静说话是 3~6）—— 素材全是游戏剧情/战斗台词，都在演。
   *     所以「按情绪换参考」带来的**不一致**，远大于它带来的**情绪准确度**
   *   · 固定一条之后情绪并没丢：表情（模型自带 + 标准参数）和标点决定的语调起伏都还在，
   *     丢的只是"借来的那点语气"
   *
   * fixedRef 填 library.json 里的 clip id。用 scripts/audition-ref.mjs 生成试听页来挑。
   */
  referenceMode: 'sticky',
  /** referenceMode='fixed' 时用哪条参考（clip id） */
  fixedRef: '',
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v
  }
  return out
}

/**
 * 由字符串推一个稳定的非负整数种子。
 *
 * 关键是「稳定」：同样的输入永远给同样的种子，
 * 所以磁盘缓存不会因为种子每次都变而全部失效。
 */
function deterministicSeed(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 1) % 2147483647
}

/**
 * 解析 16-bit PCM WAV 的头部，拿到 data 块的位置和格式。
 * @returns {{ok:true, dataOff:number, n:number, channels:number, sr:number}|{ok:false, reason:string}}
 */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: '不是 RIFF/WAVE' }
  }
  let pos = 12
  let channels = 0
  let sr = 0
  let bits = 0
  let dataOff = -1
  let dataSize = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      sr = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataOff = body
      dataSize = Math.min(size, buf.length - body)
    }
    pos = body + size + (size % 2)
  }
  if (dataOff < 0 || !channels) return { ok: false, reason: '缺 fmt/data 块' }
  if (bits !== 16) return { ok: false, reason: `只支持 16-bit，this=${bits}` }
  const n = Math.floor(dataSize / 2 / channels)
  if (n < 100) return { ok: false, reason: '样本太少' }
  return { ok: true, dataOff, n, channels, sr }
}

/** 写一个规范的 44 字节头 + PCM 数据 */
function packWav(pcm, sr, channels) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sr, 24)
  header.writeUInt32LE(sr * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** 找第一/最后一个「有声」样本（按 5ms 块扫峰值，比逐样本快） */
function voiceBounds(buf, info, { absThresh = 0.006, relThresh = 0.03 } = {}) {
  const { dataOff, n, channels } = info
  // 先求全段峰值，用相对阈值 —— 不同参考的绝对电平差很多
  let peak = 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(buf.readInt16LE(dataOff + i * 2 * channels))
    if (a > peak) peak = a
  }
  peak /= 32768
  if (peak < 1e-4) return { first: 0, last: n - 1, peak }
  const thr = Math.max(absThresh, peak * relThresh)

  const blk = Math.max(1, Math.round(0.005 * info.sr))
  const lim = thr * 32768
  let first = -1
  let last = -1
  for (let s = 0; s < n; s += blk) {
    const e = Math.min(n, s + blk)
    let p = 0
    for (let i = s; i < e; i++) {
      const a = Math.abs(buf.readInt16LE(dataOff + i * 2 * channels))
      if (a > p) p = a
    }
    if (p > lim) {
      if (first < 0) first = s
      last = e
    }
  }
  if (first < 0) return { first: 0, last: n - 1, peak }
  return { first, last, peak }
}

/**
 * WAV 后处理：**裁掉首尾静音** + **响度归一化**。
 *
 * 为什么要裁静音（实测数据）：
 *   每段合成出来都自带一段首尾静音，首部在 0.07~0.71s 之间乱跳、尾部稳定约 0.22s。
 *   而播放时相邻两段之间还有 70ms 间隔 —— 于是实际句间停顿约
 *       0.22(尾) + 0.07(间隔) + 0.48(首) ≈ 0.77s
 *   是自然句间停顿（0.2~0.4s）的 2~3 倍，而且因为首部静音乱跳，**忽长忽短**。
 *   用户的原话是「像一句一句蹦出来，停顿怪」。
 *
 *   裁掉之后再在渲染层补一个**按句尾标点定的固定停顿**，节奏就是可控的了：
 *   问句后多留一点、省略号后更长、普通句号中等。
 *
 * 为什么要归一化：同类别不同参考的响度能差 2.6 倍（GPT-SoVITS 的输出电平跟着参考走）。
 *
 * 只处理 16-bit PCM；别的格式原样返回 —— 后处理绝不该把音频搞坏。
 */
function postProcessWav(buf, { trim = true, loudness = true, targetRms = 0.09, peakCeiling = 0.97, leadKeepMs = 40, tailKeepMs = 90 } = {}) {
  const info = parseWav(buf)
  if (!info.ok) return { buf, changed: false, skipped: info.reason }

  const { dataOff, n, channels, sr } = info
  let first = 0
  let last = n
  let trimmedMs = 0

  if (trim) {
    const b = voiceBounds(buf, info)
    const leadKeep = Math.round((leadKeepMs / 1000) * sr)
    const tailKeep = Math.round((tailKeepMs / 1000) * sr)
    first = Math.max(0, b.first - leadKeep)
    last = Math.min(n, b.last + tailKeep)
    trimmedMs = Math.round(((b.first - first) + (n - last)) / sr * 1000)
    // 保险：别把整段都裁掉（阈值判错时会这样）
    if (last - first < n * 0.25) {
      first = 0
      last = n
      trimmedMs = 0
    }
  }

  const m = last - first
  let rms = 0
  let peak = 0
  for (let i = first; i < last; i++) {
    const v = buf.readInt16LE(dataOff + i * 2 * channels) / 32768
    rms += v * v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }
  rms = Math.sqrt(rms / m)

  let gain = 1
  if (loudness && rms > 1e-5) {
    gain = targetRms / rms
    if (peak * gain > peakCeiling) gain = peakCeiling / peak
    if (gain > 8) gain = 8
  }

  const pcm = Buffer.alloc(m * channels * 2)
  for (let i = 0; i < m; i++) {
    for (let c = 0; c < channels; c++) {
      let v = Math.round(buf.readInt16LE(dataOff + (first + i) * 2 * channels + c * 2) * gain)
      if (v > 32767) v = 32767
      else if (v < -32768) v = -32768
      pcm.writeInt16LE(v, (i * channels + c) * 2)
    }
  }

  return {
    buf: packWav(pcm, sr, channels),
    changed: true,
    gain: +gain.toFixed(3),
    rms: +rms.toFixed(4),
    trimmedMs,
    seconds: +(m / sr).toFixed(3),
  }
}

/** 有声时长（不含首尾静音）—— 校准语速用 */
function voicedSecondsOfWav(buf) {
  const info = parseWav(buf)
  if (!info.ok) return NaN
  const b = voiceBounds(buf, info)
  return (b.last - b.first) / info.sr
}

/** 整段时长（秒） */
function secondsOfWav(buf) {
  const info = parseWav(buf)
  if (!info.ok) return NaN
  return info.n / info.sr
}

/**
 * 判「废片」的绝对阈值 —— 只在归一化之后才有意义（normalizeLoudness 把 RMS 拉到 0.09）。
 *
 * 这三个数是**量出来的**，不是拍的（scripts/check-dud-metric.mjs）：
 *   正常片子实测：RMS 0.0900、有声窗占比 48%~94%（中位 71%）
 *   被判出来的废片：RMS 0.0023（正常 0.09）、峰值 0.0295（正常 0.47~0.92）
 *
 * ⚠️ 「有声窗占比」的阈值定在 **0.3** 而不是 0.5。
 *   一开始写的 0.5，理由是「参照 probe-segments.mjs 报的正常 91~98%」——
 *   但那个 91~98% 量的是**首尾有声之间的跨度占比**（voicedSeconds），
 *   而这里是**有声窗的占空比**：真实语音词与词之间有停顿，
 *   占空比天然只有 48%~94%。两个指标长得像，含义完全不同。
 *   拿 0.5 去卡占空比 → 4% 的正常音频被误判（实测 53 个里 2 个）。
 *   0.3 落在「正常下限 0.48」和「废片」之间，留了一倍余量。
 *
 * RMS 才是最可靠的那条：真实废片的 RMS 比正常低 40 倍，一眼就分得开。
 */
const DUD_VOICE_THR = 0.01
const DUD_MIN_RMS = 0.02
const DUD_MIN_VOICE_RATIO = 0.3
const DUD_MIN_SECONDS = 0.25

/**
 * 量一段 wav 的响度、峰值、有声占比 —— 判「废片」用。
 *
 * 为什么不复用 voiceBounds：
 *   voiceBounds 是**相对阈值**（峰值 < 1e-4 或全段都在阈值下时，直接返回整段），
 *   它的用途是「裁首尾静音」，判不出来是正常的（宁可什么都不裁）。
 *   而判废片要的是**绝对**判断「这段到底出没出声」，两个需求方向相反。
 *   实测过：一段峰值 0.0037 的近乎全零的片子，voiceBounds 会认为整段都有声，
 *   于是 voicedSeconds ≈ 全长，语速算出来完全正常 —— 现有守卫就是这么漏掉它的。
 *
 * ⚠️ **有声占比必须按「窗」算，不能逐采样点数。**
 *   这里踩过一个代价不小的坑：第一版是逐采样点数 `|v| > 阈值`，
 *   然后拿 0.5 当阈值判废片 —— 而逐采样点数的正常范围是 **35%~80%**
 *   （语音波形每个周期都要过零，大量采样点天然在阈值以下），
 *   于是**约三分之一的好音频被判成废片**，每句白白重试 3 次。
 *   本地后端是白等几秒，云端后端是**白花三倍的钱**。
 *
 *   改成 10ms 窗取峰值之后，正常范围是 83%~99%，废片是 15% 上下，
 *   0.5 这个阈值才落在该在的位置。见 scripts/check-dud-metric.mjs（那个脚本就是为这次误判写的）。
 *
 * 绝对阈值只在**归一化之后**才有意义（normalizeLoudness 会把 RMS 拉到 0.09），
 * 所以调用方要自己判断该不该用。
 */
function inspectWav(buf) {
  const info = parseWav(buf)
  if (!info.ok || !info.n) return null
  const { dataOff, n, channels, sr } = info

  let sum = 0
  let peak = 0
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataOff + i * 2 * channels) / 32768
    sum += v * v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }

  // 有声占比：10ms 窗，窗内峰值超阈值就算这个窗「有声」
  const win = Math.max(1, Math.round(0.01 * sr))
  let loudWins = 0
  let wins = 0
  for (let s = 0; s + win <= n; s += win) {
    let p = 0
    for (let i = s; i < s + win; i++) {
      const a = Math.abs(buf.readInt16LE(dataOff + i * 2 * channels)) / 32768
      if (a > p) p = a
    }
    if (p > DUD_VOICE_THR) loudWins++
    wins++
  }

  return {
    seconds: n / sr,
    rms: Math.sqrt(sum / n),
    peak,
    /** 有声音的窗占比。正常 0.83~0.99，废片 0.15 上下 */
    voiceRatio: wins ? loudWins / wins : 0,
  }
}

/** 纯 TCP 探活 —— 不依赖后端有没有某个路由，最稳 */
function tcpProbe(baseUrl, timeoutMs = 800) {  return new Promise((resolve) => {
    let url
    try {
      url = new URL(baseUrl)
    } catch {
      return resolve(false)
    }
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    const sock = net.connect({ host: url.hostname, port })
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/**
 * @param {object} opts
 * @param {object} opts.config        config.json 的 tts 段
 * @param {string} opts.root          项目根目录（找 assets/voice/library.json）
 * @param {string} opts.cacheDir      wav 输出目录
 * @param {function} [opts.log]
 * @param {function} [opts.resolveKey] (name) => string|null，给 siliconflow 找 key
 */
function createTts({ config, root, cacheDir, log = () => {}, resolveKey = () => null, fetchImpl }) {
  let currentConfig = deepMerge(DEFAULTS, config || {})
  const requests = new AsyncLocalStorage()
  // Async work keeps its original settings even when the user reloads config.
  const cfg = new Proxy({}, { get: (_target, key) => (requests.getStore()?.config || currentConfig)[key] })

  fs.mkdirSync(cacheDir, { recursive: true })

  /**
   * wav 的对外地址。
   *
   * 必须和页面同源（页面是 pet://app/…），否则会被 CSP 的 connect-src 'self' 拦掉 ——
   * 试过用 pet://voice/ 单独开一个 host，看着更干净，但那是另一个 origin，fetch 直接被拒。
   * 所以走 pet://app/.userdata/tts-cache/…，
   * 主进程那边的协议处理器只对这一个子目录放行，别的不给看。
   */
  const urlFor = file => `pet://app/audio/tts/${encodeURIComponent(path.basename(file))}`

  const clean = (s) => String(s || '').trim()

  /**
   * 挑一条参考音频。所有挑参考的地方都走这里，保证 sticky 语义一致。
   *
   * sticky 模式下的行为：第一次用到某个情绪类别时按打分挑一条并记下来，
   * 之后这个类别**永远**用同一条。换语气只在情绪类别变化时发生。
   */
  function chooseClip({ text, category, lock }) {
    if (!library) return null

    // fixed：整只桌宠只用一条参考 —— 音色最稳，代价是语气不随情绪变
    if (cfg.referenceMode === 'fixed') {
      const want = cfg.fixedRef
      if (want) {
        const hit = library.clips.find((c) => c.id === want)
        if (hit) return { clip: hit, reasons: ['固定参考'], score: 0 }
        log(`配置的 fixedRef「${want}」在参考库里找不到，回落到 sticky`)
      }
    }

    if (cfg.referenceMode !== 'rotate') {
      const lockedId = stickyRef.get(category)
      if (lockedId) {
        const hit = library.clips.find((c) => c.id === lockedId)
        if (hit) return { clip: hit, reasons: [`${category} 类别已锁定`], score: 0 }
        stickyRef.delete(category) // 库换了，旧 id 失效
      }
      const picked = pickReference(library, {
        text,
        category,
        recentIds: [],
        // 锁定时不要随机抖动 —— 否则每次启动「平静」可能锁到不同的参考，
        // 行为不可复现，也没法跟用户解释「为什么这次声音不一样」
        random: lock ? () => 0.5 : Math.random,
      })
      if (picked && lock) {
        stickyRef.set(category, picked.clip.id)
        console.log(
          `[tts] 「${category}」类别锁定参考 ${picked.clip.id.slice(0, 8)}` +
            `（${picked.clip.endsWith}·${picked.clip.lenBucket}，${picked.reasons.join('、') || '默认'}）`
        )
      }
      return picked
    }

    return pickReference(library, { text, category, recentIds })
  }

  // ---- 参考库
  let library = null
  let libraryError = null
  const LIB_PATH = path.join(root, 'assets', 'voice', 'library.json')
  try {
    library = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'))
  } catch (e) {
    libraryError = `读不到参考库 ${LIB_PATH}：${e.message}`
    log(libraryError)
  }

  /** 最近用过的参考 id，新的在前（只在 rotate 模式用） */
  let recentIds = []

  /**
   * sticky 模式：每个情绪类别固定下来用哪条参考。
   * 第一次用到某个类别时按打分挑一条，之后一直用它。
   */
  const stickyRef = new Map()

  // ---- 统计
  const stats = { calls: 0, hits: 0, errors: 0, totalMs: 0, lastMs: 0, byCategory: {} }

  /**
   * 最近一次失败。
   *
   * 为什么单独记这个：**纯 TCP 探活会骗人**。
   * 踩过一次 —— 启动脚本的外层进程被 kill 之后，子进程 python 的 stdout 管道断了；
   * GPT-SoVITS 每处理一个请求都要写日志，写管道抛 OSError(EINVAL)，
   * 被它自己那个宽泛的 try 吞成「tts failed」。这种残废状态下端口照样连得上、
   * 探活一切正常，但每一句合成都会 400。
   * 所以状态里必须带上「最近一次真实结果」，不能只看端口通不通。
   */
  let lastError = null

  function rememberRef(id) {
    recentIds = [id, ...recentIds.filter((x) => x !== id)].slice(0, cfg.recentRefMemory)
  }

  // ---- 缓存

  function cacheKey(text, refId, seed, speed, category) {
    const backend = { ...(cfg[cfg.backend] || {}) }
    delete backend.apiKey
    delete backend.timeoutMs
    if (cfg.backend === 'mimo') backend.sampleHash = crypto.createHash('sha256').update(mimoSample()).digest('hex')
    const sig = JSON.stringify({ version: 2, backend: cfg.backend, settings: backend,
      text, category, refId, seed, speed, trimSilence: cfg.trimSilence,
      normalizeLoudness: cfg.normalizeLoudness, loudness: cfg.loudness })
    return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 20)
  }

  // ---- 语速校准
  //
  // 实测同一句话换不同参考，语速 3.61 ~ 6.92 字/秒（差 1.9 倍）。
  // 而 speed_factor 是线性的（0.8→3.55、1.0→4.41、1.3→5.64），
  // 所以「探测一次 → 按比例补偿」就能把每个参考的输出语速拉到同一目标。
  //
  // 每条参考只探测一次，结果落盘。sticky 模式下总共只有 8 条参考，
  // 也就是说一个会话最多多花 8 次合成的钱，之后就全是缓存。

  const CALIB_PATH = path.join(path.dirname(cacheDir), 'tts-calibration.json')
  let calibration = null

  function loadCalibration() {
    if (calibration) return calibration
    try {
      calibration = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'))
      if (!calibration || typeof calibration !== 'object') calibration = {}
    } catch {
      calibration = {}
    }
    return calibration
  }

  function saveCalibration() {
    try {
      fs.writeFileSync(CALIB_PATH, JSON.stringify(calibration, null, 1))
    } catch (e) {
      log(`校准结果存不下（不影响使用）：${e.message}`)
    }
  }

  /** 把某个参考的实际语速测出来，算好补偿后的 speed_factor */
  async function calibratedSpeed(clip, seed) {
    const base = cfg.gptsovits.speedFactor
    const cal = loadCalibration()

    // 校准参数变了（目标语速/基准语速/探测句）就作废重来
    const sig = `${base}|${cfg.rateTarget}|${cfg.rateProbeText}`
    const hit = cal[clip.id]
    if (hit && hit.sig === sig && Number.isFinite(hit.speed)) return hit.speed

    const probe = String(cfg.rateProbeText || '').trim()
    if (!probe) return base

    try {
      const raw = await gptsovits(probe, clip, seed, base)
      // 用「裁掉静音后的总时长」而不是「有声时长」：
      // 有声时长的阈值对短句有偏（短句里起音/收音占比大），会把短句的语速算得偏低
      const pr = postProcessWav(raw, { trim: true, loudness: false, ...(cfg.loudness || {}) })
      const dur = pr.seconds || 0
      const chars = probe.replace(/[\s，。！？、…—]/g, '').length
      if (!(dur > 0.2)) throw new Error(`探测时长异常 ${dur}`)

      const measured = chars / dur
      const [lo, hi] = cfg.rateClamp || [0.75, 1.35]
      const ratio = Math.max(lo, Math.min(hi, cfg.rateTarget / measured))
      const speed = +(base * ratio).toFixed(3)

      cal[clip.id] = { sig, speed, measured: +measured.toFixed(2), target: cfg.rateTarget, at: Date.now() }
      saveCalibration()
      log(
        `语速校准 ${clip.id.slice(0, 8)}：测得 ${measured.toFixed(2)} 字/秒 → 目标 ${cfg.rateTarget}，` +
          `speed_factor ${base} → ${speed}（×${ratio.toFixed(2)}）`
      )
      return speed
    } catch (e) {
      log(`语速校准失败（这次就按原速来）：${e.message}`)
      return base
    }
  }

  function pruneCache() {
    try {
      const files = fs
        .readdirSync(cacheDir)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
      if (files.length <= cfg.cache.maxFiles) return 0
      files.sort((a, b) => a.t - b.t)
      const drop = files.slice(0, files.length - cfg.cache.maxFiles)
      for (const d of drop) fs.unlinkSync(path.join(cacheDir, d.f))
      return drop.length
    } catch {
      return 0
    }
  }

  // ---- 后端：本地 GPT-SoVITS

  async function gptsovits(text, clip, seed, speedOverride) {
    const g = cfg.gptsovits
    const body = {
      text,
      text_lang: g.textLang,
      ref_audio_path: path.join(root, 'assets', 'voice', clip.file),
      prompt_text: clip.text,
      prompt_lang: g.promptLang,
      text_split_method: g.textSplitMethod,
      // 短句不切分，避免「嗯。」被切成一个字一句的碎片
      batch_size: 1,
      speed_factor: Number.isFinite(speedOverride) ? speedOverride : g.speedFactor,
      temperature: g.temperature,
      top_k: g.topK,
      top_p: g.topP,
      repetition_penalty: 1.35,
      sample_steps: g.sampleSteps,
      seed: Number.isFinite(seed) ? seed : g.seed,
      media_type: 'wav',
      streaming_mode: false,
      parallel_infer: true,
    }

    let res
    try {
      res = await fetchBuffered(`${g.baseUrl.replace(/\/+$/, '')}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: requests.getStore()?.signal,
        timeoutMs: g.timeoutMs,
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    } catch (e) {
      const why = e.name === 'AbortError' ? `超过 ${g.timeoutMs}ms 没返回` : e.message
      throw new Error(`GPT-SoVITS 连不上（${g.baseUrl}）：${why}`)
    }

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`GPT-SoVITS ${res.status}：${t.slice(0, 300)}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1000) throw new Error(`GPT-SoVITS 返回的音频太小（${buf.length} 字节），大概合成失败了`)
    return buf
  }

  // ---- 后端：云端 SiliconFlow

  async function siliconflow(text) {
    const s = cfg.siliconflow
    const key = s.apiKey || resolveKey('SILICONFLOW_API_KEY') || resolveKey('EMBEDDING_API_KEY')
    if (!key) throw new Error('SiliconFlow 后端需要 API Key（config.json 的 tts.siliconflow.apiKey 或环境变量）')
    if (!s.voice) throw new Error('SiliconFlow 后端需要填 voice（预置音色如 model:alex，或克隆后的 uri）')

    let res
    try {
      res = await fetchBuffered(`${s.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: s.model, input: text, voice: s.voice, response_format: 'wav' }),
        signal: requests.getStore()?.signal,
        timeoutMs: s.timeoutMs,
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    } catch (e) {
      throw new Error(`SiliconFlow 连不上：${e.name === 'AbortError' ? '超时' : e.message}`)
    }

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`SiliconFlow ${res.status}：${t.slice(0, 300)}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1000) throw new Error(`SiliconFlow 返回的音频太小（${buf.length} 字节）`)
    return buf
  }

  // ---- 后端：云端 MiniMax（声音克隆）

  /**
   * MiniMax 的语音合成。和另外两条后端有个**根本区别：不需要参考音频**。
   *
   * 为什么不需要：它把「音色」和「语气」拆成了两个东西 ——
   *   · `voice_id`  —— 克隆一次就锁死音色，之后每次合成只报这个名字
   *   · `emotion`   —— 每次合成时可以给（我们默认不给，见下）
   * 而 GPT-SoVITS 是**一段参考音频同时决定音色和语气**，
   * 所以那边「换参考 = 换嗓子」（实测音高差 5.9 半音），只能靠 fixed 模式钉死。
   * 这边天然没这个问题 —— 这也是换过来的主要理由之一。
   *
   * 响应里的音频是 **hex 字符串**（不是二进制），要自己解回字节。
   *
   * 实测（同一句话跑 13 次）：延迟 740~960ms，比本地稳得多（本地 2.1~9.0 秒）。
   * 但音高偶尔会掉到低八度附近（13 次里 2 次），不是每次都一样 ——
   * 所以下面照样走「废片守卫」，不假设它永远正常。
   */
  async function minimax(text, category) {
    const m = cfg.minimax
    const key = m.apiKey || resolveKey('MINIMAX_API_KEY')
    if (!key) throw new Error('MiniMax 后端需要 API Key（config.json 的 tts.minimax.apiKey 或环境变量 MINIMAX_API_KEY）')
    if (!m.voiceId) throw new Error('MiniMax 后端需要填 voiceId（克隆得到的那个名字）')

    const voice = { voice_id: m.voiceId, speed: m.speed ?? 1, vol: m.vol ?? 1, pitch: m.pitch ?? 0 }
    // 情绪默认不传。
    // 实测传 emotion=happy 比不传高 4.7 半音，**确实有影响** ——
    // 但用户要的是「稳定」，多一个变量就多一份不确定，所以默认关。
    // 想开就把 emotionMap 填上（见 config.json 的注释）。
    const emo = m.emotionMap?.[category] || m.emotion
    if (emo) voice.emotion = emo

    let res
    try {
      res = await fetchBuffered(`${m.baseUrl.replace(/\/+$/, '')}/t2a_v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: m.model,
          text,
          stream: false,
          voice_setting: voice,
          audio_setting: {
            sample_rate: m.sampleRate ?? 32000,
            bitrate: m.bitrate ?? 128000,
            format: 'wav',
            channel: 1,
          },
        }),
        signal: requests.getStore()?.signal,
        timeoutMs: m.timeoutMs,
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    } catch (e) {
      throw new Error(`MiniMax 连不上：${e.name === 'AbortError' ? '超时' : e.message}`)
    }

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`MiniMax HTTP ${res.status}：${t.slice(0, 300)}`)
    }
    const j = await res.json()
    // 业务错误码走 200，必须自己看 base_resp —— 只看 HTTP 状态会把失败当成功
    if (j.base_resp?.status_code !== 0) {
      throw new Error(`MiniMax ${j.base_resp?.status_code}：${j.base_resp?.status_msg || '未知错误'}`)
    }
    const hex = j.data?.audio
    if (!hex) throw new Error('MiniMax 返回里没有音频')
    const buf = Buffer.from(hex, 'hex')
    if (buf.length < 1000) throw new Error(`MiniMax 返回的音频太小（${buf.length} 字节）`)
    return buf
  }

  // ---- 后端：小米 MiMo（声音克隆）

  /**
   * 小米 MiMo 的语音合成（`mimo-v2.5-tts-voiceclone`）。
   *
   * 和 MiniMax 有个**结构性差异**，值得记住：
   *   · MiniMax —— 克隆一次拿 `voiceId`，之后每次报名字。**7 天不用会被删。**
   *   · MiMo    —— **每次请求内联 base64 音频样本**，没有 voiceId、没有过期。
   *
   * 后者简单得多（没有上传/克隆/过期这套），代价是每条请求多带约 3MB 样本。
   * 对桌面宠物这种「一天几十句」的量完全无所谓。
   *
   * 接口是**对话式**的，不是传统的 `/tts`：
   *   · 要念的文本放 `role: assistant` 的 message
   *   · 风格指令放 `role: user` 的 message
   *   · `audio.voice` 放 base64（voiceclone）或音色名（预置音色）
   * 响应在 `choices[0].message.audio.data` 里，也是 base64。
   *
   * **支持行内音频标签**（`[叹气]` `[轻笑]` 这类）和自然语言风格指令 ——
   * 这是 MiniMax 给不了的，正好对着我们的情绪系统。
   */
  function mimoSample() {
    const request = requests.getStore()
    if (request && request.sample !== undefined) return request.sample
    const f = cfg.mimo.voiceSample
    let sample = ''
    if (f) {
      try {
        const abs = path.isAbsolute(f) ? f : path.join(root, f)
        const type = /\.mp3$/i.test(abs) ? 'mpeg' : 'wav'
        sample = `data:audio/${type};base64,${fs.readFileSync(abs).toString('base64')}`
      } catch { /* Missing sample is reported by the caller. */ }
    }
    if (request) request.sample = sample
    return sample
  }

  async function mimo(text, category) {
    const m = cfg.mimo
    const key = m.apiKey || resolveKey('MIMO_API_KEY')
    if (!key) throw new Error('MiMo 后端需要 API Key（config.json 的 tts.mimo.apiKey 或环境变量 MIMO_API_KEY）')

    const isClone = m.model === 'mimo-v2.5-tts-voiceclone'
    const isDesign = m.model === 'mimo-v2.5-tts-voicedesign'
    const sample = isClone ? mimoSample() : ''
    if (isClone && !sample) {
      throw new Error('MiMo 克隆模式需要 voiceSample（mp3/wav 文件路径，base64 内联发送）')
    }

    // 消息排布按官方要求：user 放指令（可空），assistant 放要念的文本。
    // 这里很反直觉 —— 文本不是放在 input 字段里，而是塞进对话消息。
    const body = {
      model: m.model,
      messages: [{ role: 'user', content: m.instruction || '' }, { role: 'assistant', content: text }],
      audio: { format: m.format || 'wav' },
    }
    // voicedesign 不支持 voice 字段（它的音色由 user message 的描述决定）
    if (!isDesign) body.audio.voice = sample || m.presetVoice || 'mimo_default'

    let res
    try {
      res = await fetchBuffered(`${m.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: requests.getStore()?.signal,
        timeoutMs: m.timeoutMs,
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    } catch (e) {
      throw new Error(`MiMo 连不上：${e.name === 'AbortError' ? '超时' : e.message}`)
    }

    const raw = await res.text().catch(() => '')
    if (!res.ok) throw new Error(`MiMo HTTP ${res.status}：${raw.slice(0, 300)}`)
    let j
    try {
      j = JSON.parse(raw)
    } catch {
      throw new Error(`MiMo 返回的不是 JSON：${raw.slice(0, 120)}`)
    }
    const b64 = j.choices?.[0]?.message?.audio?.data
    if (!b64) throw new Error('MiMo 返回里没有音频（看 choices[0].message.audio.data）')
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < 1000) throw new Error(`MiMo 返回的音频太小（${buf.length} 字节）`)
    return buf
  }

  // ---- 对外

  const api = {
    get enabled() {
      if (!cfg.enabled || cfg.backend === 'none') return false
      // 云端后端不需要参考库 —— 音色锁在云端（MiniMax 的 voiceId / MiMo 内联的样本）。
      // 别的后端（gptsovits / siliconflow）都得有参考库才能挑参考音频。
      if (cfg.backend === 'minimax' || cfg.backend === 'mimo') return true
      return !!library
    },
    get backend() {
      return cfg.backend
    },
    get config() {
      return currentConfig
    },
    get libraryError() {
      return libraryError
    },
    /** 参考库原始内容（自检和设置面板用） */
    get library() {
      return library
    },
    get recentIds() {
      return recentIds.slice()
    },
    get stats() {
      return { ...stats, recentIds: recentIds.slice(), lastError }
    },
    get lastError() {
      return lastError
    },

    /**
     * 后端在不在。
     *
     * gptsovits 走的是「TCP 探活 + 最近一次真实合成结果」两道判断 ——
     * 只看端口通不通是不够的（见 lastError 的注释：残废状态端口照样通）。
     */
    async probe() {
      if (cfg.backend === 'minimax') {
        const m = cfg.minimax
        const key = m.apiKey || resolveKey('MINIMAX_API_KEY')
        if (!key) {
          return { ok: false, backend: cfg.backend, detail: '没找到 MiniMax API Key（config.json 的 tts.minimax.apiKey 或环境变量 MINIMAX_API_KEY）' }
        }
        if (!m.voiceId) {
          return { ok: false, backend: cfg.backend, detail: '没填 voiceId —— 先在 MiniMax 克隆一个音色，把名字填到 tts.minimax.voiceId' }
        }
        // 上次合成失败过就说清楚。云端失败通常是余额/权限/网络，
        // 这三种在界面上长得一模一样，所以把原始错误带出来
        if (lastError) {
          return { ok: false, backend: cfg.backend, degraded: true, detail: `上次合成失败：${lastError}` }
        }
        return { ok: true, backend: cfg.backend, detail: `云端克隆音色 ${m.voiceId} @ ${m.model}` }
      }
      if (cfg.backend === 'mimo') {
        const m = cfg.mimo
        const key = m.apiKey || resolveKey('MIMO_API_KEY')
        if (!key) {
          return { ok: false, backend: cfg.backend, detail: '没找到 MiMo API Key（config.json 的 tts.mimo.apiKey 或环境变量 MIMO_API_KEY）' }
        }
        if (m.model === 'mimo-v2.5-tts-voiceclone') {
          const abs = m.voiceSample ? (path.isAbsolute(m.voiceSample) ? m.voiceSample : path.join(root, m.voiceSample)) : null
          if (!abs || !fs.existsSync(abs)) {
            return { ok: false, backend: cfg.backend, detail: '克隆模式需要 voiceSample（mp3/wav 文件路径）' }
          }
        }
        if (lastError) {
          return { ok: false, backend: cfg.backend, degraded: true, detail: `上次合成失败：${lastError}` }
        }
        return { ok: true, backend: cfg.backend, detail: `${m.model} @ ${m.baseUrl}` }
      }
      if (cfg.backend === 'gptsovits') {
        const ok = await tcpProbe(cfg.gptsovits.baseUrl, 900)
        if (!ok) {
          return { ok: false, backend: cfg.backend, detail: `连不上 ${cfg.gptsovits.baseUrl}（GPT-SoVITS 的 api_v2.py 没在跑？）` }
        }
        // 端口是通的，但上一次合成失败过 —— 那多半是那个「管道断了」的残废状态
        if (lastError && stats.errors > stats.hits && stats.errors > 0) {
          return {
            ok: false,
            backend: cfg.backend,
            degraded: true,
            detail: `端口通但合成失败：${lastError}（重启一下语音服务试试）`,
          }
        }
        return { ok: true, backend: cfg.backend, detail: `在线 ${cfg.gptsovits.baseUrl}` }
      }
      if (cfg.backend === 'siliconflow') {
        const key = cfg.siliconflow.apiKey || resolveKey('SILICONFLOW_API_KEY') || resolveKey('EMBEDDING_API_KEY')
        return { ok: !!key && !!cfg.siliconflow.voice, backend: cfg.backend, detail: !key ? '没找到 API Key' : !cfg.siliconflow.voice ? '没填 voice' : '已配置' }
      }
      return { ok: false, backend: cfg.backend, detail: '后端是 none，语音关着' }
    },

    /** 参考库里有什么，给设置面板看 */
    describeLibrary() {
      if (!library) return { total: 0, categories: {} }
      const categories = {}
      for (const c of library.clips) {
        categories[c.category] = categories[c.category] || []
        categories[c.category].push({ id: c.id, text: c.text, seconds: c.seconds, endsWith: c.endsWith, lenBucket: c.lenBucket, fine: c.fine })
      }
      return { total: library.clips.length, categories, builtAt: library.builtAt }
    },

    /**
     * 只挑参考，不合成 —— 调试和设置面板预览用。
     * 传 lock=true 时会走 sticky 逻辑（并把结果记下来），跟 speak 保持一致。
     */
    pick(text, category, { lock = false } = {}) {
      if (!library) return null
      return chooseClip({ text: clean(text), category, lock })
    },

    /** 当前每个类别锁的是哪条参考，给设置面板和自检看 */
    get stickyMap() {
      return Object.fromEntries(stickyRef)
    },

    /**
     * 合成一句话。
     * @returns {{ok:boolean, file?:string, url?:string, ms:number, cached:boolean, ref?:object, error?:string}}
     */
    speak(args = {}) {
      return requests.run({ config: deepMerge(DEFAULTS, currentConfig), signal: args.signal }, () => api.synthesize(args))
    },

    async synthesize({ text, category = '平静', refId = null, noCache = false, seed } = {}) {
      const started = Date.now()
      const cleanText = String(text || '').trim()
      if (!cleanText) return { ok: false, ms: 0, cached: false, error: '空文本' }

      /**
       * 云端后端（minimax / mimo）走一条**没有参考音频**的路。
       *
       * 音色由云端决定（MiniMax 报 voiceId、MiMo 内联 base64 样本），本地不参与挑选 —— 所以：
       *   · 不需要参考库（library 为空也能出声）
       *   · 不需要锁参考（那边根本不存在「换参考 = 换嗓子」这个问题）
       *   · 种子也没有意义（云端不接受 seed，同一句话每次都会略有不同）
       *
       * 但**废片守卫和后处理照旧**：实测同一句话跑 13 次里有 2 次音高掉到低八度附近，
       * 不是每次都正常，所以不能假设它永远没问题。
       */
      const isCloud = cfg.backend === 'minimax' || cfg.backend === 'mimo'
      if (!isCloud && !library) return { ok: false, ms: 0, cached: false, error: libraryError || '参考库没加载' }

      let clip = null
      let picked = null
      if (isCloud) {
        const who = cfg.backend === 'mimo' ? `mimo:${cfg.mimo.model}` : `minimax:${cfg.minimax.voiceId}`
        clip = { id: who, category: '云端克隆', text: cfg.backend === 'mimo' ? cfg.mimo.model : cfg.minimax.voiceId, seconds: 0, endsWith: '', fine: '' }
      } else {
        // refId 是给设置面板「试听这条参考」和基准测试用的强制指定
        const forced = refId ? library.clips.find((c) => c.id === refId) : null
        picked = forced ? { clip: forced, reasons: ['强制指定'], score: 0 } : chooseClip({ text: cleanText, category, lock: true })
        if (!picked) return { ok: false, ms: 0, cached: false, error: '参考库里一条都没有' }
        clip = picked.clip
      }

      // 种子由「情绪 + 参考」推导，是确定值 —— 所以缓存照样命中，
      // 而同一条参考下的所有句子采样风格一致（语气不会逐句漂）
      if (!Number.isFinite(seed)) {
        seed = !isCloud && cfg.backend === 'gptsovits' && cfg.gptsovits.seedLock
          ? deterministicSeed(`${category}|${clip.id}`)
          : -1
      }

      // 语速校准：不同参考的输出语速能差 1.9 倍，先把它拉齐到同一个目标
      const speed = cfg.backend === 'gptsovits' && cfg.rateCalibration !== false
        ? await calibratedSpeed(clip, seed)
        : null

      const key = cacheKey(cleanText, clip.id, seed, speed, category)
      const file = path.join(cacheDir, `${key}.wav`)
      const ref = {
        id: clip.id,
        category: clip.category,
        fine: clip.fine,
        text: clip.text,
        seconds: clip.seconds,
        endsWith: clip.endsWith,
        reasons: picked ? picked.reasons : ['云端克隆音色'],
        score: picked ? Number(picked.score.toFixed(2)) : 0,
        speed: speed ?? null,
      }

      if (!noCache && cfg.cache.enabled && fs.existsSync(file)) {
        // 命中也要记账：被念过就算用过，否则冷却是假的
        rememberRef(clip.id)
        stats.hits++
        stats.lastMs = Date.now() - started
        return { ok: true, file, url: urlFor(file), ms: stats.lastMs, cached: true, ref, chars: charCount(cleanText) }
      }

      try {
        stats.calls++

        /**
         * 合成 + 「废片」重试。
         *
         * 两类废片，判据不同：
         *
         * ① **太短** —— GPT-SoVITS 偶尔会吐出一个短得离谱的结果：实测过一次
         *    15 个字合成成 **0.39 秒**（53.6 字/秒），听上去就是"卡了一下"。
         *    判据：字数 / 有声秒数 > MAX_RATE。正常中文口语约 4~6 字/秒，
         *    快也不会超过 10；给到 12 已经很宽松了。
         *    ⚠️ 这条判据有个前提：`voicedSecondsOfWav` 得先量对。它是相对阈值，
         *    对**近乎全零**的片会认为整段都有声 —— 于是就有了第二类。
         *
         * ② **近乎没出声** —— 实测（npm run diag:dud）在真实自检里抓到的：
         *    回复第一段「诶？」合成成 0.40s、只有 15% 的样本有声、RMS 0.0023
         *    （正常 0.09）。它**完美躲过**判据①：时长"正常"、语速"正常"。
         *    表现是她张嘴先哑半秒，听起来像卡了一下。
         *    判据：归一化之后 RMS / 有声占比 / 时长三条绝对阈值（见 inspectWav）。
         *
         * 为什么原来漏掉：守卫被 `needChars >= 4` 挡着，而「诶？」只有 1 个字 ——
         * **越是短句越容易出废片，却越不会去检查它**，正好反了。
         * 现在两类判据都跑，字数只用来决定「语速」这条能不能算（太短算不出来）。
         *
         * 重试必须**换种子** —— 种子锁定的情况下同参数必然复现同一个废片。
         * 实测「诶？」3 次里 2 次是废片，换种子确实能救回来。
         */
        const MAX_RATE = 12
        const needChars = charCount(cleanText)
        const judge = (b) => {
          const st = inspectWav(b)
          if (!st) return null // 不是能看懂的 PCM，别乱判
          if (st.seconds < DUD_MIN_SECONDS) return `只有 ${st.seconds.toFixed(2)}s`
          const norm = cfg.normalizeLoudness !== false
          if (norm && st.rms < DUD_MIN_RMS) return `几乎是静音（RMS ${st.rms.toFixed(4)}，正常约 0.09）`
          if (norm && st.voiceRatio < DUD_MIN_VOICE_RATIO) {
            return `只有 ${(st.voiceRatio * 100).toFixed(0)}% 的样本有声`
          }
          if (needChars >= 4) {
            const vs = voicedSecondsOfWav(b)
            const rate = needChars / Math.max(0.05, vs)
            if (Number.isFinite(vs) && vs > 0.15 && rate > MAX_RATE) {
              return `${needChars} 字只有 ${vs.toFixed(2)}s（${rate.toFixed(1)} 字/秒）`
            }
          }
          return null
        }
        const synthOnce = async (s) => {
          requests.getStore()?.signal?.throwIfAborted()
          let b
          if (cfg.backend === 'minimax') b = await minimax(cleanText, category)
          else if (cfg.backend === 'mimo') b = await mimo(cleanText, category)
          else if (cfg.backend === 'gptsovits') b = await gptsovits(cleanText, clip, s, speed)
          else b = await siliconflow(cleanText)
          // 裁静音 + 响度归一化。放在缓存之前做，这样缓存里存的也是处理过的版本。
          if (cfg.trimSilence !== false || cfg.normalizeLoudness !== false) {
            const pr = postProcessWav(b, {
              trim: cfg.trimSilence !== false,
              loudness: cfg.normalizeLoudness !== false,
              ...(cfg.loudness || {}),
            })
            b = pr.buf
            if (stats.calls <= 3 || pr.skipped) {
              console.log(
                `[tts] 后处理 gain=${pr.gain} 裁掉首尾静音 ${pr.trimmedMs}ms 原RMS=${pr.rms}` +
                  `${pr.skipped ? `（跳过：${pr.skipped}）` : ''}`
              )
            }
          }
          return b
        }

        let buf = await synthOnce(seed)
        for (let attempt = 1; attempt <= 2; attempt++) {
          const why = judge(buf)
          if (!why) break
          const altSeed = seed >= 0 ? (seed + attempt * 7919) % 2147483647 : -1
          log(`合成结果异常（${why}），换种子重试 ${attempt}/2`)
          stats.retries = (stats.retries || 0) + 1
          buf = await synthOnce(altSeed)
        }
        // 三次都没救回来（短句偶发就是这样）—— 至少别让"静音"混进去，
        // 记一笔，方便 npm run diag:dud 事后把它捞出来
        const stillBad = judge(buf)
        if (stillBad) {
          stats.duds = (stats.duds || 0) + 1
          log(`重试 2 次后仍是废片（${stillBad}），这一句只能这么发了`)
        }

        requests.getStore()?.signal?.throwIfAborted()
        // 先写临时文件再改名 —— 播放中被打断不会留下半个 wav
        const tmp = `${file}.${process.pid}.part`
        fs.writeFileSync(tmp, buf)
        fs.renameSync(tmp, file)
        if (cfg.cache.enabled && stats.calls % 20 === 0) pruneCache()
        rememberRef(clip.id)
        stats.lastMs = Date.now() - started
        stats.totalMs += stats.lastMs
        stats.byCategory[category] = (stats.byCategory[category] || 0) + 1
        lastError = null
        return { ok: true, file, url: urlFor(file), ms: stats.lastMs, cached: false, ref, chars: charCount(cleanText), bytes: buf.length }
      } catch (e) {
        stats.errors++
        stats.lastMs = Date.now() - started
        lastError = e.message
        return { ok: false, ms: stats.lastMs, cached: false, ref, error: e.message }
      }
    },

    /** 换配置后热更新（改后端、改语速不用重启） */
    reload(nextConfig) {
      const merged = deepMerge(DEFAULTS, nextConfig || {})
      currentConfig = merged
      recentIds = []
      return currentConfig
    },

    clearCache() {
      let n = 0
      for (const f of fs.readdirSync(cacheDir)) {
        if (f.endsWith('.wav')) {
          fs.unlinkSync(path.join(cacheDir, f))
          n++
        }
      }
      return n
    },
  }

  return api
}

module.exports = { createTts, DEFAULTS, inspectWav, postProcessWav, DUD: { DUD_VOICE_THR, DUD_MIN_RMS, DUD_MIN_VOICE_RATIO, DUD_MIN_SECONDS } }
