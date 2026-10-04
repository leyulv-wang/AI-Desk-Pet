/**
 * 桌宠主进程
 *
 * 职责：
 *   1. 开一个「透明 + 无边框 + 置顶 + 默认鼠标穿透」的窗口
 *   2. 渲染层按需开关鼠标穿透（桌宠身上/输入框上要能点，其余地方穿透到桌面）
 *   3. 代聊天请求 —— API Key 只留在主进程，渲染层永远拿不到
 */
const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, protocol, net, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { createTts, DEFAULTS: TTS_DEFAULTS } = require('./tts')
const { createVoiceServer } = require('./voice-server')
const { createSinging, DEFAULTS: SINGING_DEFAULTS, AUDIO_EXT } = require('./singing')
const { createLore } = require('./lore')
const { createSpokenExtractor, spokenOf } = require('./spoken')
const cardModule = require('./character-card')
const { composeCardPrompt } = require('./character-card-prompt')
const emotion = require('./emotion')
const { createSplitter, pauseAfter } = require('./sentence')

const ROOT = path.join(__dirname, '..')
const CONFIG_PATH = path.join(ROOT, 'config.json')

/**
 * 运行时数据（Chromium 缓存、GPU 缓存等）默认放在项目目录里，保持便携：
 * 整个桌宠就是一个文件夹，拷走就能用，删掉就干净。
 * 想放别处就设环境变量 PET_USER_DATA。
 *
 * 例外：--selftest / --shot / --js-file 这种开发模式会被自动塞进隔离目录 ——
 * 它们会真的发消息、真的写记忆，不能污染你的真实数据。
 *
 * --js-file 一开始漏了，后果是调试脚本悄悄读写**真实数据**：
 * 我在里面量字幕的滚动状态，读到的却是生产目录的历史，结论全对不上。
 */
const IS_DEV_RUN =
  process.argv.includes('--selftest') || process.argv.includes('--shot') || process.argv.some((a) => a.startsWith('--js-file'))
const USER_DATA_DIR = process.env.PET_USER_DATA
  || (IS_DEV_RUN ? path.join(ROOT, '.userdata-dev') : path.join(ROOT, '.userdata'))
app.setPath('userData', USER_DATA_DIR)

/** TTS 合成出来的 wav 落在这儿。渲染层通过 pet://app/.userdata/tts-cache/<file> 取 */
const TTS_CACHE_DIR = path.join(app.getPath('userData'), 'tts-cache')
/** 唱歌的产物（成品 + 人声轨 + meta.json）落在这儿，同样通过 pet://app/ 取 */
const SINGING_OUT_DIR = path.join(app.getPath('userData'), 'singing')

/**
 * 用自定义协议 pet://app/<相对路径> 提供所有本地文件。
 *
 * 为什么不直接 loadFile：Live2D 模型和贴图是用 XHR/fetch 加载的，
 * 而 Chromium 默认禁止 file:// 页面去 XHR 其它 file:// 资源。
 * 与其关掉 webSecurity，不如起一个规范协议来源，安全和 CSP 都保得住。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
])

function registerAppProtocol() {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    // 静态立绘的占位素材是 SVG（见 scripts/make-static-pet.mjs）。
    // ⚠️ 少了这一行的话它会被当 application/octet-stream 返回，
    //    <img> 拒绝解码（naturalWidth=0）、onload 永不触发 —— 表现是**立绘完全不显示**
    //    但也不报任何错。踩过一次。
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.moc3': 'application/octet-stream',
  }

  // TTS 吐出来的 wav 放在 userData 下，必须能从渲染层 fetch 到。
  // 但整个 .userdata 里有 facts.json / history.json / embeddings.json，
  // 不能一起敞开 —— 只放行这几个子目录。
  //
  // 唱歌的产物（.userdata/singing/）是同一类东西：渲染层要 fetch 成品和人声轨。
  // 加进来的时候顺手改成「白名单数组」—— 之前是一个字符串，再加第二个地方
  // 就得写第二遍 if，迟早漏掉一个。
  const SERVED_SUBDIRS = [
    path.relative(ROOT, TTS_CACHE_DIR).split(path.sep).join('/'),
    path.relative(ROOT, SINGING_OUT_DIR).split(path.sep).join('/'),
  ]

  protocol.handle('pet', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('not found', { status: 404 })

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const target = path.resolve(ROOT, rel)

    // 防目录穿越：解析后必须还在 ROOT 里
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }

    // .userdata 里只放行白名单子目录，别的一律 403（内存/历史/向量都在那儿）
    const relNorm = path.relative(ROOT, target).split(path.sep).join('/')
    if (relNorm === '.userdata' || relNorm.startsWith('.userdata/')) {
      if (!SERVED_SUBDIRS.some((d) => relNorm.startsWith(d + '/'))) {
        return new Response('forbidden', { status: 403 })
      }
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return new Response('not found', { status: 404 })
    }

    const res = await net.fetch(pathToFileURL(target).toString())
    // 显式给出 Content-Type —— file:// 的推断不一定靠谱
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream'
    const headers = new Headers(res.headers)
    headers.set('Content-Type', type)
    return new Response(res.body, { status: res.status, headers })
  })
}

// 窗口尺寸：上面留给聊天记录，下面给桌宠，最底下是输入栏
const WIN_W = 460
const WIN_H = 720
const MARGIN = 16

// ---------------------------------------------------------------- 配置

/**
 * 向量化的默认配置。
 *
 * Key 和地址按这个优先级找：
 *   1. config.json 里的 embedding.apiKey / baseUrl / model（最明确）
 *   2. 环境变量三件套 EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL
 *   3. 各家服务商的常见变量名 + 内置默认（阿里百炼）
 */
const EMBED_DEFAULTS = {
  enabled: true,
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'Qwen/Qwen3-Embedding-0.6B',
  /** 会自动尝试的环境变量名，按序 */
  keyEnvNames: [
    'EMBEDDING_API_KEY',
    'DASHSCOPE_API_KEY',
    'ALIYUN_API_KEY',
    'SILICONFLOW_API_KEY',
    'OPENAI_API_KEY',
    'ZHIPUAI_API_KEY',
  ],
  /** 向量召回的判定：绝对下限 + 与最佳得分的最大差距（不同模型基线差很多，两个都要） */
  vecMinScore: 0.4,
  vecMargin: 0.1,
  /** 查询向量化的超时。实测 8B 中位 111ms 但尾部能到 2.8s，超了就本轮退回 BM25 */
  embedTimeoutMs: 800,
}

/** 读环境变量：先看进程，再看 Windows 用户级（覆盖"变量是后来才加的"） */
function readEnvOrReg(name) {
  if (process.env[name]?.trim()) return process.env[name].trim()
  if (process.platform === 'win32') return readUserEnvVar(name)
  return null
}

function loadConfig() {
  const defaults = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-flash',
    /** 角色 id，对应 characters/<id>.json。换角色只改这一个字段 */
    character: 'furina',
    /**
     * 你的名字。角色卡里写 `{{user}}` 的地方会换成它（不填就换成「你」）。
     * 桌宠场景下「你回来了」比「阿远回来了」自然，所以默认是「你」。
     */
    userName: '',
    /**
     * 留空 = 用角色文件里的那份（推荐）。
     * 想临时覆盖就在这里写，会完全顶掉角色设定。
     */
    systemPrompt: '',
    maxHistory: 20,
    temperature: 0.8,
    /** 记忆抽取用的模型。留空则跟 model 相同 */
    extractModel: '',
    /** 历史部分最多占多少字符（近的原文 + 远的档案概览一起算） */
    contextBudget: 6000,
    /** 最近多少条原文原样进上下文 */
    recentCount: 16,
    /** 未归档的原文超过多少条就触发压缩 */
    archiveAfter: 40,
    /** 档案段数上限，超了就把最老的几段合并成一段 */
    maxBlocks: 8,
    /** 遗忘曲线：老而没被用到的事实降权但不删除。关掉就是所有有效事实等权 */
    decayEnabled: true,
    /** 一件没了结的未来事项最多主动提几次（提够了就不再念，防复读机） */
    maxSurfaces: 2,
    /** 帧率档位：说话/刚交互时用 active，长时间没人理降到 idle。掉帧感明显就把 idle 调高 */
    fpsActive: 60,
    fpsIdle: 30,
    /** 向量化（记忆的语义召回）。apiKey 留空则自动找环境变量里的可用 Key */
    embedding: { ...EMBED_DEFAULTS },
    /** 语音（TTS）。enabled 默认 false —— 没装 GPT-SoVITS 也不该开机就报错 */
    tts: { ...TTS_DEFAULTS },
    /** 唱歌（离线翻唱管线）。和 tts 是两条独立链路，共用同一张嗓子 */
    singing: { ...SINGING_DEFAULTS },
  }

  let cfg = { ...defaults }
  if (!fs.existsSync(CONFIG_PATH)) {
    cfg._missing = true
  } else {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      // 丢掉以下划线开头的注释键
      const clean = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')))
      cfg = { ...defaults, ...clean }
      // embedding 是嵌套对象，得单独合并，否则配一半会把默认值整块顶掉
      const rawEmb = raw.embedding || {}
      cfg.embedding = { ...EMBED_DEFAULTS, ...rawEmb }
      // 没在 config.json 里显式写的，允许被环境变量三件套覆盖
      if (!rawEmb.baseUrl) cfg.embedding.baseUrl = readEnvOrReg('EMBEDDING_BASE_URL') || cfg.embedding.baseUrl
      if (!rawEmb.model) cfg.embedding.model = readEnvOrReg('EMBEDDING_MODEL') || cfg.embedding.model
      // tts 也是嵌套的，同理逐层合并
      cfg.tts = { ...TTS_DEFAULTS }
      for (const [k, v] of Object.entries(raw.tts || {})) {
        cfg.tts[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(TTS_DEFAULTS[k] || {}), ...v } : v
      }
      // singing 同理（separate / ddsp / mix 都是嵌套对象）
      // 注意：老配置里可能还留着已废弃的 rvc / zeroshot 段 —— 合并进来无害
      // （没有代码读它们了），但别再往模板里写。
      cfg.singing = { ...SINGING_DEFAULTS }
      for (const [k, v] of Object.entries(raw.singing || {})) {
        cfg.singing[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(SINGING_DEFAULTS[k] || {}), ...v } : v
      }
    } catch (e) {
      console.error('[config] config.json 解析失败，改用默认配置：', e.message)
      cfg._broken = e.message
    }
  }

  // 角色：人格正文来自 characters/<id>.json。
  // 泛用规则（情绪标签）由代码追加 —— 换角色不该把这条规则漏掉。
  cfg.characterData = loadCharacter(cfg.character, { userName: cfg.userName || '你' })
  const override = (cfg.systemPrompt || '').trim()
  cfg.systemPrompt = override || cfg.characterData.systemPrompt
  cfg.systemPromptIsOverride = !!override

  cfg.apiKey = resolveApiKey(cfg.apiKey)
  cfg.apiKeySource = cfg.apiKey ? apiKeySource : null
  return cfg
}

/**
 * 读角色文件。
 *
 * 一个人物 = 两样东西，分开管：
 *   ① **她是谁** —— 要么我们自己写的 `characters/<id>.json` 的 systemPrompt，
 *      要么一张角色卡（`characters/cards/<id>.png|json`，社区格式）。
 *      卡在就用卡，卡里的人设覆盖 json 里那份。
 *   ② **她在这个程序里怎么表现** —— live2d 表情映射、tapLines、情绪语音开关。
 *      这些卡片里没有，永远来自 `characters/<id>.json`。
 *
 * 为什么允许"卡 + json 并存"：卡片规范里根本没有"Live2D 表情映射"这个概念，
 * 也不该有（那是每个前端自己的事）。所以卡负责人格，json 负责接线，
 * 换卡不用动接线的部分。
 *
 * 找不到就退化成一份通用小宠物设定 —— 缺个文件不该让桌宠开不了机。
 */
let loadedCharacterId = null
let loadedCharacter = null

/** 找这个角色有没有对应的角色卡 */
function findCard(wantId) {
  // config 里直接写路径的情况：`"character": "D:/cards/xxx.png"`
  if (/[\\/]/.test(wantId) || /\.(png|json|charx)$/i.test(wantId)) {
    const p = path.isAbsolute(wantId) ? wantId : path.join(ROOT, wantId)
    return fs.existsSync(p) ? p : null
  }
  for (const ext of ['png', 'json']) {
    const p = path.join(ROOT, 'characters', 'cards', `${wantId}.${ext}`)
    if (fs.existsSync(p)) return p
  }
  return null
}

function loadCharacter(id, { userName = '你' } = {}) {
  const wantId = String(id || 'furina').trim() || 'furina'
  // 缓存键带上 userName —— 卡里的 {{user}} 是靠它替换的，换了就得重编
  const cacheKey = `${wantId}|${userName}`
  if (loadedCharacterId === cacheKey && loadedCharacter) return loadedCharacter

  const fallback = {
    id: 'fallback',
    name: wantId,
    systemPrompt:
      '你是一只桌面小宠物。你说话简短、口语化、有点俏皮，像个住在电脑里的小伙伴。' +
      '每次回复控制在 1-3 句话以内，不要用列表和标题，不要长篇大论。',
    emotionalVoice: true,
    live2d: { expressions: {}, motions: {} },
    _fallback: true,
  }

  // ① 我们自己的文件：接线（live2d/tapLines）+ 默认人格
  const file = path.join(ROOT, 'characters', `${wantId}.json`)
  let ch = fallback
  let local = null
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const clean = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')))
      local = clean
      ch = { ...fallback, ...clean }
      ch.live2d = { expressions: {}, motions: {}, ...(raw.live2d || {}) }
    } else {
      console.error(`[character] 没有 characters/${wantId}.json，先用通用设定顶着`)
    }
  } catch (e) {
    console.error(`[character] characters/${wantId}.json 解析失败：${e.message}`)
  }

  // ② 角色卡：有就用卡里的人格盖掉 json 里那份
  const cardPath = findCard(wantId)
  if (cardPath) {
    try {
      const card = cardModule.readCard(cardPath)
      const built = composeCardPrompt(card, {
        userName,
        append: local?.personaAppend || '',
      })
      ch = {
        ...ch,
        name: card.name || ch.name,
        systemPrompt: built.systemPrompt,
        postHistory: built.postHistory,
        _card: { path: cardPath, spec: card._spec, creator: card.creator, stats: built.stats },
      }
      console.log(
        `[character] 用角色卡：${path.basename(cardPath)}（${card._spec}，${card.creator || '未知作者'}）` +
          ` → 人格 ${built.systemPrompt.length} 字，样例 ${built.samples.length} 条（卡里原有 ${built.stats.description + built.stats.mesExample} 字）`
      )
      if (!built.samples.length) {
        console.log('[character] 注意：这张卡没抽出可用的对白样例（台词都太长或没标说话人）—— 她的说话调调会弱一些')
      }
    } catch (e) {
      console.error(`[character] 角色卡读不出来（${cardPath}）：${e.message}`)
    }
  }

  loadedCharacterId = cacheKey
  loadedCharacter = ch
  return ch
}

/**
 * API Key 的查找顺序：
 *   1. config.json 里的 apiKey
 *   2. 进程环境变量（用户从自己的终端启动时会有）
 *   3. Windows 用户级环境变量（从注册表读 —— 覆盖"环境变量是后来才设的，
 *      当前进程没继承到"这种情况，省得你为了让它生效去注销一次）
 */
let apiKeySource = null
/** 环境变量里找到的 Key 只查一次并缓存 —— 免得每次配置重载都去 spawn 一个 reg.exe */
let envKeyCache

function resolveApiKey(fromConfig) {
  if (fromConfig && String(fromConfig).trim()) {
    apiKeySource = 'config.json'
    return String(fromConfig).trim()
  }

  if (envKeyCache !== undefined) {
    apiKeySource = envKeyCache ? envKeyCache.source : null
    return envKeyCache ? envKeyCache.key : ''
  }

  const names = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'ZHIPUAI_API_KEY']

  for (const n of names) {
    const v = process.env[n]
    if (v && v.trim()) {
      envKeyCache = { key: v.trim(), source: `环境变量 ${n}` }
      apiKeySource = envKeyCache.source
      return envKeyCache.key
    }
  }

  if (process.platform === 'win32') {
    for (const n of names) {
      const v = readUserEnvVar(n)
      if (v) {
        envKeyCache = { key: v, source: `用户环境变量 ${n}` }
        apiKeySource = envKeyCache.source
        return v
      }
    }
  }

  envKeyCache = null
  apiKeySource = null
  return ''
}

/** 从 HKCU\Environment 读用户级环境变量（找不到就返回 null） */
function readUserEnvVar(name) {
  try {
    const out = require('node:child_process').execFileSync(
      'reg',
      ['query', 'HKCU\\Environment', '/v', name],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 }
    )
    // 输出形如：    DEEPSEEK_API_KEY    REG_SZ    sk-xxxx
    const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

let config = loadConfig()
const mockMode = () => !config.apiKey || !config.apiKey.trim()

console.log(
  `[config] 模型=${config.model}  接口=${config.baseUrl}  ` +
    `Key=${config.apiKeySource ? `来自 ${config.apiKeySource}` : '未找到 → 演示模式'}`
)
if (config._missing) console.log('[config] 没有 config.json（这不是错，Key 可以从环境变量来）')
if (config._broken) console.log('[config] config.json 解析失败：', config._broken)

// ---------------------------------------------------------------- 本地状态

const STATE_PATH = path.join(app.getPath('userData'), 'ui-state.json')
/**
 * 进程号落盘 —— 给「关闭桌宠.cmd」用的。
 *
 * 为什么不靠命令行去捞 electron 进程：捞到的可能不止一个（Electron 有多个子进程），
 * 而且换个启动方式（npm start / 直接跑 electron.exe）命令行就不一样了。
 * 自己写下自己的 pid，是最不会认错人的办法。
 */
const PID_PATH = path.join(app.getPath('userData'), 'pet.pid')
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json')

const DEFAULT_STATE = { scale: 1, chatCollapsed: false }
const SCALE_MIN = 0.6
const SCALE_MAX = 1.8

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`[state] 读 ${path.basename(file)} 失败，用默认值：`, e.message)
    return fallback
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    return true
  } catch (e) {
    console.error(`[state] 写 ${path.basename(file)} 失败：`, e.message)
    return false
  }
}

let uiState = { ...DEFAULT_STATE, ...readJson(STATE_PATH, {}) }
uiState.scale = clampScale(uiState.scale)

function clampScale(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n * 20) / 20))
}

function saveUiState(patch = {}) {
  uiState = { ...uiState, ...patch }
  uiState.scale = clampScale(uiState.scale)
  writeJson(STATE_PATH, uiState)
  return uiState
}

// 对话原文的读写搬到了 src/history.js（那边还负责分层归档）。
// history.json 的路径在上面的「本地状态」一节已经声明过了。

// ---------------------------------------------------------------- 缩放

/**
 * 整体缩放：同时改窗口尺寸和网页缩放倍率，
 * 这样 CSS 像素下的布局尺寸不变，视觉上等比放大缩小。
 * 锚点固定在右下角 —— 放大时朝左上方长。
 */
function applyScale(scale) {
  if (!win) return uiState.scale
  const next = clampScale(scale)
  const bounds = win.getBounds()
  const newW = Math.round(WIN_W * next)
  const newH = Math.round(WIN_H * next)
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height

  // frameless + resizable:false 的窗口在部分平台上拒绝程序化改尺寸，临时放开
  try { win.setResizable(true) } catch { /* 忽略 */ }
  win.setBounds({ x: right - newW, y: bottom - newH, width: newW, height: newH })
  try { win.setResizable(false) } catch { /* 忽略 */ }

  win.webContents.setZoomFactor(next)
  return next
}

// ---------------------------------------------------------------- 窗口

let win = null

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea
  const s = uiState.scale
  const w = Math.round(WIN_W * s)
  const h = Math.round(WIN_H * s)

  win = new BrowserWindow({
    width: w,
    height: h,
    x: workArea.x + workArea.width - w - MARGIN,
    y: workArea.y + workArea.height - h - MARGIN,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 'screen-saver' 层级才能盖住任务栏
  win.setAlwaysOnTop(true, 'screen-saver')
  // 一开始整窗穿透，等渲染层告诉我们鼠标压到了可交互区域再打开
  win.setIgnoreMouseEvents(true, { forward: true })

  /**
   * 渲染器选择通过 URL 参数传给渲染层，而不是让它自己去读 config.json。
   *
   * 为什么：配置的**唯一事实来源**是 config.json，由主进程读；渲染层没有读盘能力
   * （contextIsolation + 没有 fs）。而 `models/index.json` 记的是「装了哪个模型」，
   * 和「用哪条渲染路」是两件事，不该混进同一个文件。
   *
   * 取值：live2d（默认）| static。渲染层那边不认识的值会当 live2d 处理。
   */
  const renderer = config.renderer === 'static' ? 'static' : 'live2d'
  win.loadURL(`pet://app/src/renderer/index.html?renderer=${renderer}`)

  win.once('ready-to-show', () => win.show())

  // 网页缩放倍率要在加载完之后设，否则会被页面加载重置
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(uiState.scale)
  })

  // 隐藏时不渲染（省 CPU），显示时恢复
  win.on('hide', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:visibility', false)
  })
  win.on('show', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:visibility', true)
  })
  win.on('minimize', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:visibility', false)
  })
  win.on('restore', () => {
    if (!win.webContents.isDestroyed()) win.webContents.send('window:visibility', true)
  })

  // 配置热重载：打开 config.json 编辑会让窗口失焦，切回来时自动重读
  win.on('focus', () => {
    const next = loadConfig()
    if (JSON.stringify(config) !== JSON.stringify(next)) {
      applyRuntimeConfig(next)
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('config:changed', {
          mock: mockMode(),
          model: config.model,
          apiKeySource: config.apiKeySource,
          systemPrompt: config.systemPrompt,
          maxHistory: config.maxHistory,
          characterId: config.characterData?.id || null,
          characterName: config.characterData?.name || null,
          live2d: config.characterData?.live2d || null,
          tapLines: config.characterData?.tapLines || [],
          fpsActive: config.fpsActive,
          fpsIdle: config.fpsIdle,
        })
      }
    }
  })

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' })

  /**
   * 开发用：`electron . --js-file=<文件> [--js-delay=3000]`
   * 在渲染层里跑文件里的 JS（顶层可用 await），打印返回值，然后退出。
   *
   * 为什么是「文件」而不是把代码写在命令行：多行 JS 经过 shell 和
   * Start-Process 的引号处理太容易坏（试过一次，注入的代码被吃掉了半个括号）。
   * 落成文件干净得多。
   *
   * 加这个是因为调试模型时「光看截图判断不了参数停在哪」——
   * 比如挥手之后手放不下来，是动作没停、还是表情钉住了、还是参数本来就没回基线，
   * 截图上完全看不出来。得能直接读 coreModel 的参数值。
   */
  const jsFileArg = process.argv.find((a) => a.startsWith('--js-file='))
  if (jsFileArg) {
    const jsFile = jsFileArg.slice('--js-file='.length)
    const jsDelay = Number((process.argv.find((a) => a.startsWith('--js-delay=')) || '').split('=')[1]) || 3000
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const code = fs.readFileSync(jsFile, 'utf8')
          const r = await win.webContents.executeJavaScript(`(async () => { ${code} })()`)
          console.log(`[js] ${typeof r === 'string' ? r : JSON.stringify(r, null, 1)}`)
        } catch (e) {
          console.error('[js] 失败：', e.message)
        }
        app.quit()
      }, jsDelay)
    })
  }

  // 把渲染层的日志转发到终端 —— 否则窗口里出的错外面完全看不到
  const isDev = process.argv.includes('--dev')
  const LEVELS = { debug: 0, verbose: 0, info: 1, warning: 2, warn: 2, error: 3 }

  win.webContents.on('console-message', (...args) => {
    // Electron 35+ 是 (event, details)；更早是 (event, level, message, line, sourceId)
    const second = args[1]
    let level, message, line, sourceId
    if (second && typeof second === 'object' && 'message' in second) {
      level = LEVELS[second.level] ?? 1
      message = second.message
      line = second.lineNumber
      sourceId = second.sourceId
    } else {
      level = Number(second) || 0
      message = args[2]
      line = args[3]
      sourceId = args[4]
    }
    if (!isDev && level < 2) return
    const tag = ['verb', 'info', 'WARN', 'ERR '][level] || 'log'
    const where = sourceId ? ` (${String(sourceId).split('/').pop()}:${line})` : ''
    console.log(`[renderer ${tag}] ${message}${where}`)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 进程崩了：', details.reason, details.exitCode)
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] 加载失败 ${code} ${desc} — ${url}`)
  })

  win.on('closed', () => { win = null })

  // 开发用：`electron . --selftest [文本] [等待毫秒]`
  // 在真实窗口里发一条消息，等回复流完，然后把落盘的历史打印出来。
  // 用来在不开图形界面交互的情况下验证「发送 → 流式回复 → 落盘」整条链路。
  const testIdx = process.argv.indexOf('--selftest')
  if (testIdx !== -1) {
    const text = process.argv[testIdx + 1] || '你好，用一句话介绍你自己'
    const wait = Number(process.argv[testIdx + 2]) || 14000
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          await win.webContents.executeJavaScript(`
            (() => {
              const input = document.getElementById('input-text')
              input.value = ${JSON.stringify(text)}
              document.getElementById('input-bar')
                .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
              return true
            })()
          `)
          console.log(`[selftest] 已发送：${text}`)
        } catch (e) {
          console.error('[selftest] 注入失败：', e.message)
        }

        /**
         * 语音观察员：和对话**并行**跑。
         *
         * 为什么不能等总结完再看：总结（记忆整理）本身要一次 LLM 调用，好几秒，
         * 等它回来时语音早就播完了，采样只能采到空气。所以发送的同时就盯着。
         */
        const watch = (async () => {
          const samples = []
          let shot = null
          const deadline = Date.now() + 60000
          let sawSpeaking = false
          let wasSpeaking = false

          while (Date.now() < deadline) {
            let speaking = false
            try {
              speaking = await win.webContents.executeJavaScript('!!window.petVoice?.speaking')
            } catch {
              break
            }
            if (speaking && !wasSpeaking) {
              sawSpeaking = true
              console.log('[selftest] 听到她开始说话了')
            }
            if (speaking) {
              const v = await win.webContents.executeJavaScript('window.petModel?.getMouthValue?.() ?? -1').catch(() => -1)
              samples.push(Number(v))
              // 等嘴张得够大再截图 —— 不然拍到的是一张闭嘴的静图，看不出在说话。
              // 截图前先把嘴型定格：capturePage 有几百毫秒延迟，不定格拍不到张嘴那帧。
              if (!shot && samples.length >= 3 && v > 0.45) {
                try {
                  await win.webContents.executeJavaScript(`window.petModel?.holdMouth?.(${v}, 1500)`)
                  await new Promise((r) => setTimeout(r, 90))
                  const img = await win.webContents.capturePage()
                  shot = path.join(app.getPath('userData'), 'speaking.png')
                  fs.writeFileSync(shot, img.toPNG())
                } catch (e) {
                  console.error('[selftest] 截图失败：', e.message)
                }
              }
            }
            wasSpeaking = speaking
            // 说过话并且已经安静下来了 → 收工
            if (sawSpeaking && !speaking) {
              const pend = await win.webContents.executeJavaScript('!!window.petVoice?.pending').catch(() => false)
              if (!pend) break
            }
            await new Promise((r) => setTimeout(r, 160))
          }
          return { samples, shot, sawSpeaking }
        })()

        setTimeout(async () => {
          // 顺手把这一轮也整理了，好让 --selftest 能验证记忆写入
          try {
            await memory.consolidate()
          } catch (e) {
            console.error('[selftest] 记忆整理失败：', e.message)
          }

          const saved = readJson(HISTORY_PATH, [])
          console.log(`[selftest] history.json 共 ${saved.length} 条记录`)
          for (const m of saved.slice(-2)) {
            console.log(`[selftest]   ${m.role}: ${String(m.content).slice(0, 80)}`)
          }
          console.log(`[selftest] facts.json 共 ${memory.facts.length} 条事实`)
          for (const f of memory.facts.slice(-6)) {
            console.log(`[selftest]   [${f.importance}] ${f.text}`)
          }

          // 语音链路：合成了几条、缓存命中几次、吐出来几个 wav、渲染层播没播
          try {
            const st = tts.stats
            const wavs = fs.existsSync(TTS_CACHE_DIR) ? fs.readdirSync(TTS_CACHE_DIR).filter((f) => f.endsWith('.wav')) : []
            console.log(
              `[selftest] 语音 后端=${tts.backend} 开关=${!!config.tts?.enabled} | ` +
                `合成 ${st.calls} 次 / 缓存命中 ${st.hits} / 失败 ${st.errors} | 落盘 ${wavs.length} 个 wav`
            )
            // 废片守卫的战绩要看得见 —— 不然它救了场也没人知道，
            // 更糟的是它**没**救回来（duds>0）时也悄无声息
            if (st.retries || st.duds) {
              console.log(
                `[selftest] 语音 废片守卫：重试 ${st.retries || 0} 次` +
                  `${st.duds ? ` / ❌ 重试后仍是废片 ${st.duds} 句` : ' / 全部救回来了 ✅'}`
              )
            }
            if (st.lastMs) console.log(`[selftest] 语音 最近一次 ${st.lastMs}ms`)
            const played = await win.webContents.executeJavaScript('window.__ttsPlayed ?? null')
            console.log(`[selftest] 渲染层收到 ${played} 段`)

            // 每句实际用了哪条参考 —— 这是「上下半句语气不一样」那个 bug 的回归检查点。
            // 一轮回复里出现两条不同参考 = 语气必然断。
            const segRefs = await win.webContents.executeJavaScript('window.__ttsRefs ?? []')
            if (segRefs.length) {
              for (const s of segRefs) {
                console.log(
                  `[selftest]   第${s.index}句 参考 ${s.refId?.slice(0, 8)} ${s.refCategory}·${s.refEnds}` +
                    `  停 ${s.pauseAfter}ms  ←「${String(s.text).slice(0, 20)}」`
                )
              }
              const uniq = new Set(segRefs.map((s) => s.refId))
              console.log(
                `[selftest] 本轮用了 ${uniq.size} 条参考 ${uniq.size === 1 ? '✅ 整轮一致，语气不会断' : '❌ 换了参考，语气会断'}`
              )
            }

            // 观察员已经在这一轮对话进行的同时采好了样
            const { samples, shot, sawSpeaking } = await watch
            if (!sawSpeaking) {
              console.log('[selftest] ❌ 全程没听到她说话')
            } else if (samples.length) {
              const min = Math.min(...samples)
              const max = Math.max(...samples)
              const changed = samples.filter((v, i) => i > 0 && Math.abs(v - samples[i - 1]) > 0.005).length
              console.log(`[selftest] 嘴型采样 ${samples.slice(0, 16).map((v) => v.toFixed(2)).join(' ')}${samples.length > 16 ? ' …' : ''}`)
              const ok = max - min > 0.05 && changed >= 2
              console.log(
                `[selftest] 嘴型范围 ${min.toFixed(3)}~${max.toFixed(3)}，变动 ${changed}/${samples.length - 1} 次 → ${ok ? '✅ 嘴在跟着音频动' : '❌ 嘴没动'}`
              )
            }
            if (shot) console.log(`[selftest] 说话中的截图 → ${shot}`)

            const vs = await win.webContents.executeJavaScript('window.petVoice?.stats ?? null')
            console.log(
              `[selftest] 渲染层实播 ${vs?.played} 段 / 累计 ${Math.round(vs?.playedMs || 0)}ms 音频 / ` +
                `解码失败 ${vs?.failed} / 包络峰值 ${(vs?.peak ?? 0).toFixed(3)} / AudioContext=${vs?.ctxState}`
            )
            const emo = await win.webContents.executeJavaScript('window.petModel?.emotion ?? null')
            console.log(`[selftest] 当前表情 ${emo}`)
          } catch (e) {
            console.error('[selftest] 语音统计失败：', e.message)
          }

          app.quit()
        }, wait)
      }, 6000)
    })
  }


  // 开发用：`electron . --shot <输出路径> [延迟毫秒]` 截图后自动退出。
  // 透明窗口的 alpha 会保留在 PNG 里，方便确认角色真的渲染出来了。
  const shotIdx = process.argv.indexOf('--shot')
  if (shotIdx !== -1) {
    const out = process.argv[shotIdx + 1] || path.join(ROOT, 'shot.png')
    const delay = Number(process.argv[shotIdx + 2]) || 6000
    /**
     * `--tap` 会在截图前模拟一次「戳她」。
     *
     * 加这个是因为「点角色触发动作」这条链路出过问题：
     * 模型建的时候开了 autoInteract:false，而 pixi-live2d-display 正是用这个开关
     * 决定要不要注册 pointertap 的 —— 结果事件根本不来，功能一直是坏的而没人发现。
     * 光看静态截图看不出「动作到底播没播」，所以要能主动触发一次。
     */
    const doTap = process.argv.includes('--tap')
    /** 戳完等多久再截图。默认 700ms（挥手动作中途）；给个大值可以看「恢复之后」的样子 */
    const tapWait = Number((process.argv.find((a) => a.startsWith('--tap-wait=')) || '').split('=')[1]) || 700
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (doTap) {
            const r = await win.webContents.executeJavaScript(`
              (() => {
                const m = window.petModel
                if (!m) return { ok: false, why: 'petModel 还没就绪' }
                m.tap()
                return { ok: true }
              })()
            `)
            console.log(`[shot] 已触发一次戳击：${JSON.stringify(r)}，等 ${tapWait}ms 后截图`)
            await new Promise((res) => setTimeout(res, tapWait))
          }
          const image = await win.webContents.capturePage()
          fs.writeFileSync(out, image.toPNG())
          const b = win.getBounds()
          // 顺便问一下渲染层的实际画布分辨率 —— 用来确认缩放后有没有重新同步
          const canvasInfo = await win.webContents
            .executeJavaScript(
              `(() => { const c = document.getElementById('pet-canvas');
                 return { css: [c.clientWidth, c.clientHeight], px: [c.width, c.height],
                          dpr: window.devicePixelRatio }; })()`
            )
            .catch(() => null)
          console.log(
            `[shot] 已保存 ${out} | 窗口 ${b.width}x${b.height} DIP | ` +
              `缩放 ${win.webContents.getZoomFactor().toFixed(2)} | ` +
              `视口 ${image.getSize().width}x${image.getSize().height}`
          )
          if (canvasInfo) {
            console.log(
              `[shot] 画布 CSS=${canvasInfo.css.join('x')} 实际像素=${canvasInfo.px.join('x')} ` +
                `devicePixelRatio=${canvasInfo.dpr.toFixed(2)}`
            )
          }
        } catch (e) {
          console.error('[shot] 失败：', e.message)
        }
        app.quit()
      }, delay)
    })
  }
}

// ---------------------------------------------------------------- 长期记忆

const { Memory } = require('./memory')
const { History } = require('./history')

/**
 * 非流式调一次模型。记忆抽取用这个。
 * max_tokens 给得比较宽 —— deepseek-flash / v4-pro 是推理模型，
 * 会在 reasoning_content 里先花掉一大截预算，给少了会返回空内容。
 */
async function callOnce(messages, { model, temperature = 0.2, maxTokens = 2600 } = {}) {
  const base = config.baseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: model || config.extractModel || config.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  }
  const j = await res.json()
  return j.choices?.[0]?.message?.content ?? ''
}

const memory = new Memory({
  dir: app.getPath('userData'),
  // 每次调用时再判断 —— 用户可能在运行中才把 Key 配上
  request: (messages) => {
    if (mockMode()) throw new Error('演示模式，跳过抽取')
    return callOnce(messages)
  },
  embed: (texts) => callEmbed(texts),
  embedModel: (config.embedding || EMBED_DEFAULTS).model,
  embedIdentity: embeddingIdentity(config.embedding || EMBED_DEFAULTS),
  embedEnabled: (config.embedding || EMBED_DEFAULTS).enabled,
  vecMinScore: (config.embedding || EMBED_DEFAULTS).vecMinScore,
  vecMargin: (config.embedding || EMBED_DEFAULTS).vecMargin,
  embedTimeoutMs: (config.embedding || EMBED_DEFAULTS).embedTimeoutMs,
  decayEnabled: config.decayEnabled !== false,
  maxSurfaces: Number(config.maxSurfaces) || 2,
  log: (m) => console.log(m),
})

/**
 * 会话历史 + 分层归档。
 * 摘要和抽取共用同一个 request —— 都是「把一段对话压成更短的东西」。
 */
const history = new History({
  dir: app.getPath('userData'),
  request: (messages) => {
    if (mockMode()) throw new Error('演示模式，跳过摘要')
    return callOnce(messages, { maxTokens: 1200 })
  },
  recentCount: Number(config.recentCount) || 16,
  archiveAfter: Number(config.archiveAfter) || 40,
  maxBlocks: Number(config.maxBlocks) || 8,
  log: (m) => console.log(m),
})

/**
 * 情境反应（角色卡世界书导入的）。
 *
 * 和记忆是两回事，别混：
 *   记忆管「你这个人」（他叫什么、在做什么、上次聊到哪）
 *   情境反应管「眼前这个话题」（下雨了、早上好、好无聊）
 * 前者要模糊召回，后者要**可预测** —— 说「下雨」就必须提水位，
 * 不能因为相似度差 0.02 就不提。所以那边走向量，这边走关键词。
 *
 * 没有 assets/lore/<角色>.scenes.json 是正常情况，不影响任何东西。
 */
const lore = createLore({
  file: path.join(ROOT, 'assets', 'lore', `${config.characterData?.id || config.character || 'furina'}.scenes.json`),
  log: (m) => console.log(m),
})

/**
 * 语音合成。
 *
 * 它是「角色的一张嗓子」，不是对话链路的一部分 —— 挂了、没开、后端不在，
 * 都只影响出声，绝不影响打字聊天。所以所有失败路径都是静默降级。
 */
const tts = createTts({
  config: config.tts,
  root: ROOT,
  cacheDir: TTS_CACHE_DIR,
  log: (m) => console.log('[tts]', m),
  resolveKey: (name) => (process.env[name] || '').trim() || (process.platform === 'win32' ? readUserEnvVar(name) : null),
})

/**
 * 语音服务进程管理。
 *
 * 开了语音的话，桌宠启动时顺手把 GPT-SoVITS 拉起来 —— 省得每次开两个终端。
 * 归属很清楚：它本来就在跑就不碰、退出也不杀；是我们拉起来的才由我们收干净。
 */
const voiceServer = createVoiceServer({
  config: config.tts?.gptsovits,
  configPath: path.join(ROOT, 'voice', 'gptsovits.pet.yaml'),
  userDataDir: app.getPath('userData'),
  searchExtra: [path.join(ROOT, '..', 'GPT-SoVITS')],
  log: (m) => console.log(m),
})

/**
 * 唱歌 —— 离线翻唱管线。
 *
 * 和 tts 是**两条独立链路**，只是共用「角色的一张嗓子」：
 *   tts     一句话 → 几百毫秒 → 边说边播
 *   singing 一首歌 → 几分钟  → 整首播
 * 所以它挂了、没配好、没建 venv，都只影响唱歌，聊天和说话一概不受影响。
 */
const singing = createSinging({
  root: ROOT,
  userDataDir: app.getPath('userData'),
  config: config.singing,
  log: (m) => console.log(m),
})

/**
 * 语音服务「就绪」的 promise。
 *
 * 为什么要有它：模型要读 4.5G 进显存，约 10 秒。而 LLM 可能在 8 秒就回完话了 ——
 * 于是第一批合成请求会在服务还没起来时发出去，全部 fetch failed，
 * 用户看到的就是「刚开桌宠时她第一句话没声」。
 * 所以合成前要等一下这个 promise（有超时兜底，服务起不来也不会卡住）。
 */
let voiceServerReady = null

function embeddingIdentity(embedding) {
  return `${String(embedding.baseUrl).replace(/\/+$/, '')}|${embedding.model}`
}

function applyRuntimeConfig(next) {
  config = next
  const embedding = config.embedding || EMBED_DEFAULTS
  memory.configureEmbedding({ ...embedding, identity: embeddingIdentity(embedding) })
  memory.decayEnabled = config.decayEnabled !== false
  memory.maxSurfaces = Number(config.maxSurfaces) || 2
  history.recentCount = Number(config.recentCount) || 16
  history.archiveAfter = Number(config.archiveAfter) || 40
  history.maxBlocks = Number(config.maxBlocks) || 8
  tts.reload(config.tts)
  singing.reload(config.singing)
  if (!config.tts?.enabled || config.tts?.autoplay === false) {
    for (const controller of inflight.values()) controller.stopSpeech?.()
  }
}

/**
 * 拼最终的 system prompt。
 *
 *   角色人格（characters/<id>.json）
 * + 情绪标签规则（emotionalVoice 打开时）
 *
 * 情绪标签规则故意放在代码里而不是角色文件里 ——
 * 它是「语音能不能挑对参考音频」的硬依赖，换角色时不该被漏掉。
 */
function composeSystemPrompt() {
  const parts = [config.systemPrompt]
  if (config.characterData?.emotionalVoice !== false && config.tts?.emotionalVoice !== false) {
    parts.push(emotion.promptRule())
  }
  return parts.join('\n\n')
}

/**
 * 找可用的向量化 Key。查找顺序：
 *   1. config.json 里 embedding.apiKey（最明确，推荐）
 *   2. 进程环境变量
 *   3. Windows 用户级环境变量
 *   4. DSH 的凭据文件（如果你用 DSH 并且 Key 存在那儿，就不用再配一遍）
 *
 * 找到哪个会在启动日志里写明来源，不会偷偷用。
 */
function findEmbedKey(names) {
  const list = names || EMBED_DEFAULTS.keyEnvNames

  for (const n of list) {
    if (process.env[n]?.trim()) return process.env[n].trim()
  }
  if (process.platform === 'win32') {
    for (const n of list) {
      const v = readUserEnvVar(n)
      if (v) return v
    }
  }
  for (const n of list) {
    const v = readDshCredential(n)
    if (v) return v
  }
  return null
}

/** 同一份 Key 从哪来的，只用于日志 */
function describeEmbedKeySource(names) {
  const list = names || EMBED_DEFAULTS.keyEnvNames
  for (const n of list) if (process.env[n]?.trim()) return `环境变量 ${n}`
  if (process.platform === 'win32') for (const n of list) if (readUserEnvVar(n)) return `用户环境变量 ${n}`
  for (const n of list) if (readDshCredential(n)) return `DSH 凭据 ${n}`
  return null
}

/** 读 DSH 的 ~/.dsh/.credentials.yaml（找不到就返回 null，不影响使用） */
function readDshCredential(name) {
  try {
    const file = path.join(app.getPath('home') || require('node:os').homedir(), '.dsh', '.credentials.yaml')
    if (!fs.existsSync(file)) return null
    const txt = fs.readFileSync(file, 'utf8')
    const m = txt.match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm'))
    return m ? m[1].replace(/^["']|["']$/g, '') : null
  } catch {
    return null
  }
}

/** 调一次 embeddings 接口，返回向量数组 */
async function callEmbed(texts) {
  const e = { ...EMBED_DEFAULTS, ...(config.embedding || {}) }
  if (!e.enabled) throw new Error('向量化已关闭')
  const key = (e.apiKey && String(e.apiKey).trim()) || findEmbedKey(e.keyEnvNames)
  if (!key) throw new Error('没有可用的向量化 API Key')

  const base = String(e.baseUrl).replace(/\/+$/, '')
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: e.model, input: texts, encoding_format: 'float' }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  }
  const j = await res.json()
  const list = j.data || []
  // 有些服务商不保证顺序，按 index 排一下更稳
  if (list.every((d) => typeof d.index === 'number')) list.sort((a, b) => a.index - b.index)
  return list.map((d) => d.embedding)
}

// ---------------------------------------------------------------- 聊天

/** id -> AbortController，用于「停止生成」 */
const inflight = new Map()

async function callModel(messages, signal, onDelta, onReasoning) {
  const base = config.baseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: Number(config.temperature) || 0.8,
      stream: true,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.trim()
      if (!line || !line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta
        if (!delta) continue
        // 推理模型（deepseek-flash / v4-pro）会先吐一大段 reasoning_content。
        // 它不是给用户看的，但可以用来显示「思考中…」，免得她呆立在那儿。
        if (delta.reasoning_content) onReasoning?.(delta.reasoning_content)
        if (delta.content) onDelta(delta.content)
      } catch {
        /* 忽略无法解析的片段（有些服务商会插入心跳） */
      }
    }
  }
}

/** 没填 Key 时的演示模式：本地造回复，逐字吐出来，方便先看效果 */
const MOCK_REPLIES = [
  '唔……我还没有接上大脑呢，去 config.json 里填个 apiKey 我就能真的说话啦。',
  '现在这个模式是不联网的哦，我说的话都是提前写好的。不过你看，我在动呢。',
  '诶，你戳我干嘛～ 等填好 API Key，我们就能好好聊天了。',
  '我先在这儿陪你待着。配置好了记得叫我。',
]

async function mockStream(text, signal, onDelta) {
  const chars = [...text]
  for (const ch of chars) {
    if (signal.aborted) return
    onDelta(ch)
    await new Promise((r) => setTimeout(r, 45))
  }
}

ipcMain.handle('chat:start', (event, { id, text }) => {
  // 新消息接管语音；上一轮即使文字已结束，也不能继续往播放器塞音频。
  for (const [previousId, previous] of inflight) {
    previous.abort()
    if (!event.sender.isDestroyed()) event.sender.send('tts:stop', { id: previousId })
  }
  const controller = new AbortController()
  inflight.set(id, controller)

  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
  }

  const userText = String(text || '').trim()
  let assistantText = ''
  const historyGeneration = history.generation
  const memoryGeneration = memory.generation
  let textFinished = false

  // ---- 语音流水线
  //
  // 关键点：不能等 LLM 把整段回复写完再送去合成，那样她要等 3~4 秒才开口。
  // 做法是「边生成边切句边合成」：
  //
  //   LLM 流 ──► 切句器 ──► 合成队列（串行）──► 渲染层按序播放
  //              ↑ 第一句一完整就立刻入队
  //
  // 情绪标签在流的最开头就会到（提示词要求的），所以第一个句子入队时
  // 情绪已经确定了，不用等整段回复。
  const speech = {
    enabled: !!(config.tts?.enabled) && config.tts?.autoplay !== false && tts.enabled,
    category: '平静',
    source: null,
    emotionDone: false,
    fedChars: 0,
    segIndex: 0,
    queue: [],
    running: false,
    dropped: false,

    /**
     * 「只念对白」的抽取器（见 src/spoken.js）。
     *
     * 每轮回复新建一个 —— 它带着 inStar 状态（星号可能跨句），
     * 跨轮复用的话，上一轮没闭合的星号会把下一轮整段吞掉。
     * 整个 speech 对象就是每轮重建的，所以放这儿天然是对的。
     */
    spoken: createSpokenExtractor(),

    /**
     * 这一轮锁定用的参考音频 id。
     *
     * 为什么必须锁：GPT-SoVITS 的语气几乎完全由参考音频决定，换参考 = 换个人在念。
     * 之前每句都独立选参考，而「冷却机制」（刚用过的参考扣分）在一句话内部也生效，
     * 于是第二句必然挑到另一条参考 —— 上半句一条、下半句另一条，语气就断了。
     * 实测 3/3 轮回复都在内部换了参考。
     *
     * 冷却的本意是「轮与轮之间别重复」，所以现在：一轮回复只在第一句时选一次参考，
     * 后面所有句子都用它；冷却在整轮结束后才记账。
     */
    refId: null,
    refInfo: null,

    /** 同一轮共用随机种子，减少逐句采样带来的语气抖动 */
    seed: null,
  }
  const splitter = createSplitter(config.tts?.split || {})
  controller.stopSpeech = () => {
    speech.dropped = true
    speech.enabled = false
    speech.queue.length = 0
    send('tts:done', { id })
  }

  function releaseTurn() {
    if (!textFinished || speech.running || speech.queue.length) return
    if (inflight.get(id) === controller) inflight.delete(id)
    send('tts:done', { id })
  }

  /** 合成队列：一条一条来（GPT-SoVITS 是单 worker，并发只会互相排队） */
  async function pumpQueue() {
    if (speech.running) return
    speech.running = true
    try {
      // 本轮第一次合成前，等服务就绪。
      // 开桌宠后第一句话最容易踩这个：模型还在读盘，请求就发出去了 → 全部 fetch failed。
      if (!speech.waitedServer) {
        speech.waitedServer = true
        if (voiceServerReady && voiceServer.status().starting) {
          console.log('[tts] 语音服务还在启动，这一句等她一下…')
          const t0 = Date.now()
          await Promise.race([voiceServerReady, new Promise((r) => setTimeout(r, 90000))])
          console.log(`[tts] 等待结束（${Date.now() - t0}ms）`)
        }
      }

      while (speech.queue.length) {
        if (speech.dropped || controller.signal.aborted) {
          speech.queue.length = 0
          break
        }
        const job = speech.queue.shift()

        // 第一句：正常选参考（冷却在这里生效一次），然后把结果锁进这一轮
        // 后面的句子：强制用同一条参考，保证整轮语气不漂
        if (!speech.refId) {
          const preview = tts.pick(job.text, speech.category)
          if (preview) {
            speech.refId = preview.clip.id
            speech.refInfo = preview.clip
            console.log(`[tts] 本轮参考锁定 ${preview.clip.category}·${preview.clip.endsWith}·${preview.clip.id.slice(0, 8)}（${preview.reasons.join('、') || '默认'}）`)
          }
        }

        const r = await tts.speak({
          text: job.text,
          category: speech.category,
          refId: speech.refId,
          seed: speech.seed,
        })
        if (speech.dropped || controller.signal.aborted) break
        if (!r.ok) {
          console.error(`[tts] 第 ${job.index} 句合成失败：${r.error}`)
          send('tts:segment', { id, index: job.index, ok: false, error: r.error, text: job.text, category: speech.category })
          continue
        }
        // 万一没选上（参考库为空之类），回填一下免得后面句句都重选
        if (!speech.refId && r.ref) {
          speech.refId = r.ref.id
          speech.refInfo = r.ref
        }
        send('tts:segment', {
          id,
          index: job.index,
          ok: true,
          url: r.url,
          ms: r.ms,
          cached: r.cached,
          text: job.text,
          category: speech.category,
          pauseAfter: job.pauseAfter,
          ref: r.ref,
        })
      }
    } finally {
      speech.running = false
      if (speech.dropped || controller.signal.aborted) speech.queue.length = 0
      releaseTurn()
    }
  }

  function enqueueSentences(sents) {
    for (const s of sents) speech.queue.push({ index: speech.segIndex++, text: s, pauseAfter: pauseAfter(s) })
    if (speech.queue.length) pumpQueue()
  }

  /**
   * 定情绪。两种情况：
   *   ① LLM 打了标签 —— 流的最开头就能拿到，立刻定了，一秒钟都不耽误
   *   ② 她忘了打 —— **不能**看到前十个字就猜。前十个字信息太少，
   *      实测「哼哼，本神记性可是很好的」的前十字「哼哼，本神记性可是」一个线索都没有，
   *      会误判成平静。要等到第一句完整了再猜，那时语气才看得出来。
   */
  function setEmotion(category, source) {
    if (speech.emotionDone) return
    speech.category = category
    speech.source = source
    speech.emotionDone = true
    send('tts:emotion', { id, category, source })
    console.log(`[tts] 情绪判定 ${category}（来源 ${source}）`)
  }

  /** 切好的句子先在这儿等着，等情绪定了再入队 */
  let pendingSentences = []

  function flushPending() {
    if (!speech.emotionDone || !pendingSentences.length) return
    const batch = pendingSentences
    pendingSentences = []
    enqueueSentences(batch)
  }

  /** 整段就是一个没闭合的标签（比如模型写成「[开心]」单独一行）→ 没有正文，丢掉 */
  function isBareTagFragment(s) {
    return /^\s*[[【（(][^\]】)）\n]*$/.test(s)
  }

  /**
   * 一段切好的正文，进队前的最后处理：剥掉情绪标签。
   *
   * 为什么剥标签放在**这里**而不是在喂切句器之前：
   * 流的前几个 token 是半截标签（比如「[生」），那时 extractTag 还认不出来，
   * cleaned 就等于原文；等标签补全，cleaned 突然短了 3 个字符 ——
   * 按 cleaned 的长度记偏移就会错位，实测丢掉了「喂，同」三个字。
   *
   * 所以改成：切句器只吃**原始文本**（偏移只增不减，永远对得上），
   * 标签在句子出来之后再剥。标签只可能出现在最开头，最多影响第一段。
   */
  function acceptSegment(rawSeg) {
    let text = rawSeg

    if (!speech.emotionDone) {
      const t = emotion.extractTag(text)
      if (t.category) {
        setEmotion(t.category, 'tag')
        text = t.cleaned
      } else if (isBareTagFragment(text)) {
        return // 光一个标签，没正文
      } else {
        // 第一句都完整了还没有标签 —— 现在才兜底猜，这时信息才够
        setEmotion(emotion.guessEmotion(text), 'rule')
      }
    } else {
      // 后面的段落理论上不该再有标签，但剥一下更保险（也顺手清掉开头空白）
      text = emotion.extractTag(text).cleaned
    }

    const clean = String(text || '').trim()
    if (clean) {
      // 只把**对白**送去合成，旁白留在屏幕上。
      // 见 src/spoken.js —— 剥星号比抽引号稳，因为流式下我们没法预读"后面有没有引号"。
      //
      // 再过一遍 stripAllTags：模型偶尔会在**一轮回复中间**又打一个标签
      // （比如旁白之后接一句「[平静]陪你待着也行」），那个位置 extractTag 不管，
      // 会原样漏进语音里被念成「方括号 平静 方括号」。
      const spoken = speech.spoken.push(emotion.stripAllTags(clean))
      for (const s of spoken) pendingSentences.push(s)
    }
    flushPending()
  }

  /** 每收到一段增量就试着切句 */
  function onDeltaText(d) {
    assistantText += d
    send('chat:delta', { id, delta: d })
    if (!speech.enabled) return

    // 只喂原始文本。偏移相对 assistantText，只增不减，不会错位。
    const fresh = assistantText.slice(speech.fedChars)
    speech.fedChars = assistantText.length
    if (!fresh) return

    for (const seg of splitter.feed(fresh)) acceptSegment(seg)
  }

  const run = async () => {
    try {
      if (!userText) throw new Error('空消息')

      if (mockMode()) {
        const reply = MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)]
        await mockStream(reply, controller.signal, onDeltaText)
      } else {
        // 上下文完全由主进程组装：人格 + 事实记忆 + 分层历史 + 这一句
        const messages = await buildMessages(userText)
        await callModel(messages, controller.signal, onDeltaText, (d) => send('chat:reasoning', { id, delta: d }))
      }

      // 流结束：把最后没标点收尾的半句也吐出来。
      // 情绪若还没定（回复太短、没有句号），acceptSegment 会用整段来兜底猜。
      if (speech.enabled) {
        const tail = assistantText.slice(speech.fedChars)
        speech.fedChars = assistantText.length
        if (tail) for (const seg of splitter.feed(tail)) acceptSegment(seg)
        for (const seg of splitter.flush()) acceptSegment(seg)
        // 抽取器也要收尾：最后一段要是卡在没闭合的星号里，得把它放出来。
        // 收完必须再 flushPending 一次 —— 上面那次 flushPending 在最后一个
        // acceptSegment 里已经跑过了，这里补出来的尾段不然会永远躺在待入队里没人管
        // （表现是「最后半句没声音」）。
        for (const s of speech.spoken.flush()) pendingSentences.push(s)
        flushPending()
        if (!speech.emotionDone) {
          // 整段都没切出句子（极其罕见），仍然要定一个情绪，否则她一句话都念不出来
          setEmotion(emotion.guessEmotion(emotion.extractTag(assistantText).cleaned || assistantText), 'rule')
          flushPending()
        }
      }

      send('chat:done', { id })
    } catch (err) {
      speech.dropped = true
      if (err.name === 'AbortError' || controller.signal.aborted) send('chat:done', { id, aborted: true })
      else send('chat:error', { id, message: err.message })
    } finally {
      textFinished = true
      releaseTurn()

      // 落盘用的是「去掉情绪标签」的正文吗？—— 不，历史要存**带标签的原文**。
      //
      // 这里踩过一个坑：一开始存的是剥掉标签的正文，结果模型在上下文里
      // 看到自己以前的回复全都没有标签，就有样学样地不打标签了（漏标率飙升）。
      // 历史就是它的「示范」，示范里必须带着标签，格式才能稳住。
      //
      // 所以：她打了标签就原样存；漏打了就用兜底判定的类别补一个 ——
      // 让上下文的示范永远 100% 规范，这个毛病会自我收敛。
      //
      // 记忆抽取才用剥掉标签的正文 —— 标签是格式噪音，不该变成关于用户的事实。
      const { category, cleaned } = emotion.resolveEmotion(assistantText)
      const hasTag = /^\s*[[【（(]/.test(assistantText)
      const stored = !assistantText.trim() ? '' : hasTag ? assistantText : `[${category}]${cleaned}`
      if (userText && historyGeneration === history.generation) {
        history.append(userText, stored)
        if (!hasTag) console.log(`[tts] 她这轮漏了情绪标签，已按「${category}」补进历史，避免示范跑偏`)
      }
      // 记忆抽取用的是「她**说出口**的话」，不是整段回复。
      //
      // 三层噪音都要剥，而且来源不一样：
      //   ① 句首情绪标签 —— `resolveEmotion` 已经剥了（就是下面的 cleaned）
      //   ② **旁白** —— 改成角色扮演之后才有的。`cleaned` 里还带着
      //      `*她把杯子搁在桌上*` 这种，那是芙宁娜自己的动作，不是关于用户的事实。
      //      实测抽取器看到的 transcript 里旁白能占到三分之二，既费 token 又添乱。
      //   ③ **句中又冒出来的标签** —— 模型偶尔会在旁白之后再来一个「[平静]」，
      //      那个位置 resolveEmotion 不管（它只认句首）。
      //
      // 用 spokenOf 而不是自己写个剥星号：那边已经处理了跨段星号、双星号、
      // 整段旁白这些边界，而且有 27 项回归测试守着（scripts/test-spoken.mjs）。
      // 历史那边**不剥** —— 角色扮演需要旁白保持连贯，两边要求正好相反。
      const forMemory = spokenOf(emotion.stripAllTags(cleaned))
      if (forMemory && userText && memoryGeneration === memory.generation) memory.observe(userText, forMemory)
    }
  }

  run()
  return { ok: true }
})

/**
 * 组装这一次请求要发的消息。
 *
 * 结构：
 *   system = 人格 prompt
 *          + 【你记得关于他的事】   ← 事实记忆（向量召回）
 *   system = 【更早的对话 · …】     ← 分层归档的概览（从新到旧，装到预算用完）
 *   ...最近 N 条原文
 *   user   = 这一句
 *
 * 事实记忆和历史归档是两套东西，各管各的：
 *   记忆管「他是什么样的人」，历史管「我们聊过什么」。
 */
async function buildMessages(userText) {
  const t0 = Date.now()
  const parts = [composeSystemPrompt()]

  // ① 事实记忆
  let factInfo = '（无）'
  let loopInfo = ''
  try {
    const ctx = await memory.buildContextAsync(userText)
    if (ctx.text) {
      parts.push(ctx.text.trim())
      factInfo =
        `${ctx.picked.length} 条 ${ctx.usedEmbedding ? 'BM25⊕向量' : 'BM25'} ` +
        `[${ctx.picked.map((p) => p.fact.text.slice(0, 14)).join(' / ')}]`
    }
    if (ctx.openLoops?.length) {
      loopInfo = ` | 开环 ${ctx.openLoops.length} 件 [${ctx.openLoops.map((f) => f.text.slice(0, 16)).join(' / ')}]`
    }
  } catch (e) {
    factInfo = `失败 ${e.message}`
  }

  // ② 情境反应：她对这个话题本来就有说法（从角色卡世界书导入的）
  //
  // 放在记忆之后：记忆说的是「你这个人」，是主语；情境反应说的是「这件事」，
  // 更贴近眼前这句，靠后一点更管用。
  let loreInfo = ''
  try {
    const b = lore.block(userText)
    if (b.text) {
      parts.push(b.text)
      loreInfo = ` | 情境 ${b.picked.length} 条 [${b.picked.map((p) => p.keys[0]).join('/')}]`
    }
  } catch (e) {
    loreInfo = ` | 情境失败 ${e.message}`
  }

  // ③ 分层历史
  const budget = Number(config.contextBudget) || 6000
  const hist = history.buildContext(budget)

  // ④ 角色卡的 post_history_instructions
  //
  // 规范里它的位置是**历史之后**（"越狱位"）—— 靠得越近越管用。
  // 卡作者放这儿的东西往往是最想强调的（实测有张卡整个风格指南都在这儿），
  // 塞进 system 开头会被淹掉。所以单独发一条 system，紧挨着这一句用户消息。
  const phi = (config.characterData?.postHistory || '').trim()
  const tail = phi ? [{ role: 'system', content: phi }] : []

  const messages = [
    { role: 'system', content: parts.join('\n\n') },
    ...hist.messages,
    ...tail,
    { role: 'user', content: userText },
  ]

  console.log(
    `[context] ${Date.now() - t0}ms | 事实 ${factInfo}${loopInfo}${loreInfo} | ` +
      `历史 ${hist.recent} 条原文 + ${hist.blocks}/${hist.totalBlocks} 段档案，共 ${hist.usedChars}/${budget} 字`
  )
  return messages
}

ipcMain.handle('chat:stop', (_event, { id }) => {
  inflight.get(id)?.abort()
  if (win && !win.webContents.isDestroyed()) win.webContents.send('tts:stop', { id })
  return { ok: true }
})

// ---------------------------------------------------------------- 语音 IPC

ipcMain.handle('tts:status', async () => {
  const probe = await tts.probe()
  return {
    enabled: !!config.tts?.enabled,
    autoplay: config.tts?.autoplay !== false,
    backend: tts.backend,
    ready: probe.ok,
    detail: probe.detail,
    libraryError: tts.libraryError,
    stats: tts.stats,
    character: { id: config.characterData?.id, name: config.characterData?.name },
  }
})

/** 试听：把一段文字念出来，给设置面板和「念一下」按钮用 */
ipcMain.handle('tts:speak', async (_event, { text, category }) => {
  const r = await tts.speak({ text, category: category || '平静' })
  return r
})

ipcMain.handle('tts:library', () => tts.describeLibrary())

ipcMain.handle('tts:probe', () => tts.probe())

/** 手动拉起语音服务（自动启动失败时，点一下 🔊 旁边的重试） */
ipcMain.handle('tts:start-server', async () => {
  if (await voiceServer.probe()) return { ok: true, spawned: false, detail: '已经在跑了' }
  const r = await voiceServer.ensure()
  return { ...r, logFile: voiceServer.logFile }
})

ipcMain.handle('tts:server-status', () => voiceServer.status())

ipcMain.handle('tts:clear-cache', () => ({ ok: true, removed: tts.clearCache() }))

/** 开关语音：写回 config.json，免得每次开桌宠都要手动改文件 */
ipcMain.handle('tts:set-enabled', (_event, on) => {
  try {
    const raw = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {}
    raw.tts = { ...(raw.tts || {}), enabled: !!on }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', 'utf8')
    config = loadConfig()
    tts.reload(config.tts)
    if (!config.tts.enabled) {
      for (const controller of inflight.values()) controller.stopSpeech?.()
    }
    return { ok: true, enabled: !!config.tts.enabled }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ---------------------------------------------------------------- 唱歌 IPC

/**
 * 开一首歌。**注意这是个长请求** —— 几分钟。
 *
 * 为什么不让渲染层 fire-and-forget、进度全走事件：
 * 那样「跑完了」这件事也得靠事件，而事件可能在面板关掉/刷新后丢。
 * 现在是 invoke 一直挂着，进度同时用事件推 —— 两条路，界面关了也不会漏结果。
 */
ipcMain.handle('singing:start', async (_event, { file, force } = {}) => {
  const send = (payload) => {
    if (win && !win.webContents.isDestroyed()) win.webContents.send('singing:progress', payload)
  }
  return singing.start({ file, force: !!force, onProgress: send })
})

ipcMain.handle('singing:cancel', () => singing.cancel())
ipcMain.handle('singing:status', () => singing.status())
ipcMain.handle('singing:list', () => singing.listSongs())
ipcMain.handle('singing:forget', (_e, key) => singing.forget(key))

ipcMain.handle('singing:open-folder', async () => {
  await shell.openPath(singing.songsDir)
  return { ok: true, path: singing.songsDir }
})

/**
 * 选歌：弹系统文件框，把选中的文件**拷进 songs/**。
 *
 * 为什么是拷贝而不是记住原路径：
 *   ① 渲染层只能访问 songs/ 下的文件名（不给它任意读盘的能力），
 *      记住外部路径就等于把那个限制绕过去了；
 *   ② 用户从下载目录里删掉原文件之后，歌单里不该出现一条点不开的记录。
 * 代价是占一份磁盘 —— 一首歌几 MB，可以接受。
 */
ipcMain.handle('singing:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选一首歌',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音频', extensions: AUDIO_EXT.map((e) => e.replace('.', '')) },
      { name: '全部文件', extensions: ['*'] },
    ],
  })
  if (r.canceled || !r.filePaths.length) return { ok: true, added: 0, songs: singing.listSongs() }

  let added = 0
  const failed = []
  for (const src of r.filePaths) {
    try {
      const base = path.basename(src)
      let dst = path.join(singing.songsDir, base)
      // 重名不覆盖：加 (2) 后缀。覆盖掉用户已有的歌是很讨厌的事。
      let n = 2
      while (fs.existsSync(dst)) {
        const ext = path.extname(base)
        dst = path.join(singing.songsDir, `${path.basename(base, ext)} (${n++})${ext}`)
      }
      fs.copyFileSync(src, dst)
      added++
    } catch (e) {
      failed.push(`${path.basename(src)}：${e.message}`)
    }
  }
  return { ok: true, added, failed, songs: singing.listSongs() }
})

// ---------------------------------------------------------------- 杂项 IPC

ipcMain.handle('pet:set-ignore-mouse', (_event, ignore) => {
  if (!win) return { ok: false }
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
  return { ok: true }
})

ipcMain.handle('pet:get-status', () => ({
  mock: mockMode(),
  model: config.model,
  baseUrl: config.baseUrl,
  apiKeySource: config.apiKeySource,
  systemPrompt: config.systemPrompt,
  maxHistory: config.maxHistory,
  fpsActive: Number(config.fpsActive) || 60,
  fpsIdle: Number(config.fpsIdle) || 30,
  missingConfig: !!config._missing,
  brokenConfig: config._broken || null,
  characterId: config.characterData?.id || null,
  characterName: config.characterData?.name || null,
  /** 角色配的表情/动作映射，渲染层拿去建 face.js */
  live2d: config.characterData?.live2d || null,
  /** 戳她一下时说什么（角色专属，放在 characters/<id>.json 里） */
  tapLines: Array.isArray(config.characterData?.tapLines) ? config.characterData.tapLines : [],
}))

ipcMain.handle('pet:quit', () => { app.quit(); return { ok: true } })

ipcMain.handle('pet:hide', () => { win?.hide(); return { ok: true } })

ipcMain.handle('pet:open-config', async () => {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), CONFIG_PATH)
  }
  await shell.openPath(CONFIG_PATH)
  return { ok: true }
})

ipcMain.handle('pet:reload-config', () => {
  applyRuntimeConfig(loadConfig())
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send('config:changed', {
      mock: mockMode(),
      model: config.model,
      apiKeySource: config.apiKeySource,
      systemPrompt: config.systemPrompt,
      maxHistory: config.maxHistory,
      characterId: config.characterData?.id || null,
      characterName: config.characterData?.name || null,
      live2d: config.characterData?.live2d || null,
      tapLines: config.characterData?.tapLines || [],
      fpsActive: config.fpsActive,
      fpsIdle: config.fpsIdle,
    })
  }
  return {
    ok: true,
    mock: mockMode(),
    model: config.model,
    apiKeySource: config.apiKeySource,
    systemPrompt: config.systemPrompt,
    maxHistory: config.maxHistory,
  }
})

// ---------------------------------------------------------------- UI 状态

ipcMain.handle('ui:get-state', () => uiState)

ipcMain.handle('ui:set-state', (_event, patch) => {
  const next = saveUiState(patch || {})
  if (patch && patch.scale !== undefined) next.scale = applyScale(next.scale)
  return next
})

/** 滚轮缩放：渲染层报上增量，这里改窗口大小 */
ipcMain.handle('ui:zoom-by', (_event, delta) => {
  const step = Number(delta) || 0
  const next = applyScale(uiState.scale + step)
  saveUiState({ scale: next })
  return { scale: next, min: SCALE_MIN, max: SCALE_MAX }
})

ipcMain.handle('ui:reset-zoom', () => {
  const next = applyScale(1)
  saveUiState({ scale: next })
  return { scale: next }
})

// ---------------------------------------------------------------- 对话历史

ipcMain.handle('history:load', () => history.entries)

ipcMain.handle('history:clear', () => {
  for (const [id, controller] of inflight) {
    controller.abort()
    if (win && !win.webContents.isDestroyed()) win.webContents.send('tts:stop', { id })
  }
  const n = history.clear()
  return { ok: true, removed: n }
})

/** 历史和分层归档的状态，界面用来看「聊了多久、压了几段」 */
ipcMain.handle('history:stats', () => history.stats())

/** 手动触发一次归档（用户点「压缩历史」时用） */
ipcMain.handle('history:archive', async () => {
  const r = await history.archiveIfNeeded()
  // 一次可能不够，连着推几轮直到压不动
  for (let i = 0; i < 3 && (await history.archiveIfNeeded()).archived; i++) { /* 继续 */ }
  return { ...r, ...history.stats() }
})

// ---------------------------------------------------------------- 记忆

ipcMain.handle('memory:stats', () => ({
  ...memory.stats(),
  extractModel: config.extractModel || config.model,
  embedBaseUrl: (config.embedding || EMBED_DEFAULTS).baseUrl,
  hasEmbedKey: !!((config.embedding || {}).apiKey || findEmbedKey()),
}))

ipcMain.handle('memory:list', () => ({
  facts: [...memory.facts].sort((a, b) => b.createdAt - a.createdAt),
  pending: memory.pending.length,
  /** 哪些事实已经有向量 */
  embedded: Object.keys(memory.embeddings),
}))

/** 立刻整理一次（用户点「整理记忆」时用） */
ipcMain.handle('memory:consolidate', async () => {
  const r = await memory.consolidate()
  // 抽完顺手把缺的向量补上，让用户能立刻看到效果
  await memory.embedMissing().catch(() => {})
  return { ...r, ...memory.stats() }
})

/** 只补向量，不抽取 */
ipcMain.handle('memory:embed', async () => {
  const n = await memory.embedMissing()
  return { embedded: n, ...memory.stats() }
})

ipcMain.handle('memory:forget', (_e, key) => ({ removed: memory.forget(key), ...memory.stats() }))

ipcMain.handle('memory:clear', () => ({ removed: memory.clear(), ...memory.stats() }))

/** 手动教一条（绕过大模型抽取） */
ipcMain.handle('memory:remember', (_e, text) => ({ added: memory.remember(text), ...memory.stats() }))

ipcMain.handle('memory:open', async () => {
  const p = path.join(app.getPath('userData'), 'facts.json')
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]')
  await shell.openPath(p)
  return { ok: true, path: p }
})

// ---------------------------------------------------------------- 生命周期

// 单实例：重复启动就把已有窗口唤到前面，而不是再开一只
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus() }
  })

  app.whenReady().then(() => {
    registerAppProtocol()
    createWindow()

    // 记下自己的 pid，好让外面的「关闭桌宠」脚本能找到正主
    try {
      fs.writeFileSync(PID_PATH, String(process.pid))
    } catch (e) {
      console.log('[pid] 写不了 pet.pid（不影响使用）：', e.message)
    }

    // 上次退出时可能有没来得及整理的对话，启动后台补一次
    if (memory.pending.length > 0) {
      console.log(`[memory] 启动补整理 ${memory.pending.length} 条待处理对话`)
      memory.schedule(6000)
    }

    // 补历史遗留的向量（比如刚开向量化，老事实还没有）
    setTimeout(() => {
      memory.embedMissing().catch((e) => console.log('[memory] 向量补齐失败:', e.message))
    }, 3000)

    // 语音服务：开了语音就顺手拉起来，省得每次开两个终端。
    // 异步做，不挡窗口显示 —— 她先立起来，嗓子随后到。
    if (config.tts?.enabled && config.tts.backend === 'gptsovits' && config.tts.gptsovits?.autoStart !== false) {
      voiceServerReady = (async () => {
        const notify = (payload) => {
          if (win && !win.webContents.isDestroyed()) win.webContents.send('tts:server', payload)
        }
        notify({ state: 'checking' })

        // 先看看是不是已经在跑了（你自己起的就更好，我们不接管）
        if (await voiceServer.probe()) {
          notify({ state: 'ready', detail: '语音服务已在运行', owned: false })
          console.log('[voice-server] 检测到已有服务，不重复启动')
          return true
        }

        notify({ state: 'starting', detail: '正在启动本地语音服务（要读 4.5G 模型，约 10~30 秒）' })
        const r = await voiceServer.ensure()
        notify({ state: r.ok ? 'ready' : 'failed', detail: r.detail, owned: r.spawned, logFile: voiceServer.logFile })
        return r.ok
      })().catch((e) => {
        console.error('[voice-server] 启动失败：', e.message)
        return false
      })
    } else if (config.tts?.enabled) {
      console.log(`[voice-server] 不自动启动（backend=${config.tts.backend}，autoStart=${config.tts.gptsovits?.autoStart}）`)
    }

    const emb = config.embedding || EMBED_DEFAULTS
    const embSource = emb.apiKey?.trim() ? 'config.json' : describeEmbedKeySource(emb.keyEnvNames)
    console.log(
      `[embedding] ${emb.enabled ? emb.model : '已关闭'} @ ${emb.baseUrl}  ` +
        `Key=${embSource ? `来自 ${embSource}` : '未找到 → 记忆将只用 BM25'}`
    )
    // 环境变量和 config.json 不一致时明确说出来，别让它悄悄生效
    const envModel = readEnvOrReg('EMBEDDING_MODEL')
    if (envModel && envModel !== emb.model) {
      console.log(`[embedding] 注意：环境变量 EMBEDDING_MODEL=${envModel}，被 config.json 的 ${emb.model} 覆盖`)
    }
    const envBase = readEnvOrReg('EMBEDDING_BASE_URL')
    if (envBase && envBase !== emb.baseUrl) {
      console.log(`[embedding] 注意：环境变量 EMBEDDING_BASE_URL=${envBase}，被 config.json 覆盖`)
    }

    // 全局快捷键：不用去点那个小小的关闭按钮
    globalShortcut.register('CommandOrControl+Shift+P', () => {
      if (!win) return
      win.isVisible() ? win.hide() : win.show()
    })
    globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    // 只关我们自己拉起来的那个语音服务。你自己起的，桌宠不碰。
    voiceServer.stop()
    singing.cancel()
    memory.flush()
    for (const controller of inflight.values()) controller.abort()
    try {
      fs.unlinkSync(PID_PATH)
    } catch {
      /* 已经没了就算了 */
    }
  })
  app.on('window-all-closed', () => app.quit())
}
