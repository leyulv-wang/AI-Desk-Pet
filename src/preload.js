/**
 * preload —— 渲染层与主进程之间唯一的通道。
 * 只暴露这几个方法，别的什么都不给。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  /** 鼠标穿透开关。ignore=true 时点击穿过窗口落到桌面上 */
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('pet:set-ignore-mouse', ignore),

  /** 开一次对话。上下文由主进程组装，这里只给这一句 */
  chatStart: (id, text) => ipcRenderer.invoke('chat:start', { id, text }),
  chatStop: (id) => ipcRenderer.invoke('chat:stop', { id }),

  onDelta: (fn) => ipcRenderer.on('chat:delta', (_e, p) => fn(p)),
  onReasoning: (fn) => ipcRenderer.on('chat:reasoning', (_e, p) => fn(p)),
  onDone: (fn) => ipcRenderer.on('chat:done', (_e, p) => fn(p)),
  onError: (fn) => ipcRenderer.on('chat:error', (_e, p) => fn(p)),

  /** 配置被改动（切回窗口时自动重读） */
  onConfigChanged: (fn) => ipcRenderer.on('config:changed', (_e, p) => fn(p)),

  /** 窗口被隐藏 / 显示 —— 渲染层据此暂停或恢复绘制 */
  onVisibility: (fn) => ipcRenderer.on('window:visibility', (_e, visible) => fn(visible)),

  // ---- 语音
  /** 主进程切好的一句语音，渲染层排队播放 */
  onTtsSegment: (fn) => ipcRenderer.on('tts:segment', (_e, p) => fn(p)),
  /** 这一轮回复被判定成什么情绪 */
  onTtsEmotion: (fn) => ipcRenderer.on('tts:emotion', (_e, p) => fn(p)),
  /** 停止说话（用户按了停止 / 切了话题） */
  onTtsStop: (fn) => ipcRenderer.on('tts:stop', (_e, p) => fn(p)),
  /** 本地语音服务的启动进度 */
  onTtsServer: (fn) => ipcRenderer.on('tts:server', (_e, p) => fn(p)),
  ttsStatus: () => ipcRenderer.invoke('tts:status'),
  ttsSpeak: (text, category) => ipcRenderer.invoke('tts:speak', { text, category }),
  ttsLibrary: () => ipcRenderer.invoke('tts:library'),
  ttsProbe: () => ipcRenderer.invoke('tts:probe'),
  ttsClearCache: () => ipcRenderer.invoke('tts:clear-cache'),
  ttsSetEnabled: (on) => ipcRenderer.invoke('tts:set-enabled', on),
  ttsStartServer: () => ipcRenderer.invoke('tts:start-server'),
  ttsServerStatus: () => ipcRenderer.invoke('tts:server-status'),

  // ---- 唱歌
  /** 开一首歌的转换任务。进度通过 onSingProgress 回来，函数本身在跑完时 resolve */
  singStart: (file, force) => ipcRenderer.invoke('singing:start', { file, force }),
  singCancel: () => ipcRenderer.invoke('singing:cancel'),
  singStatus: () => ipcRenderer.invoke('singing:status'),
  singList: () => ipcRenderer.invoke('singing:list'),
  /** 弹文件选择器，选中的文件会被拷进 songs/ */
  singPick: () => ipcRenderer.invoke('singing:pick'),
  singForget: (key) => ipcRenderer.invoke('singing:forget', key),
  singOpenFolder: () => ipcRenderer.invoke('singing:open-folder'),
  onSingProgress: (fn) => ipcRenderer.on('singing:progress', (_e, p) => fn(p)),

  // ---- UI 状态（缩放、面板折叠）
  getUiState: () => ipcRenderer.invoke('ui:get-state'),
  setUiState: (patch) => ipcRenderer.invoke('ui:set-state', patch),
  zoomBy: (delta) => ipcRenderer.invoke('ui:zoom-by', delta),
  resetZoom: () => ipcRenderer.invoke('ui:reset-zoom'),

  // ---- 对话历史（含分层归档）
  loadHistory: () => ipcRenderer.invoke('history:load'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  historyStats: () => ipcRenderer.invoke('history:stats'),
  historyArchive: () => ipcRenderer.invoke('history:archive'),

  // ---- 长期记忆
  memoryStats: () => ipcRenderer.invoke('memory:stats'),
  memoryList: () => ipcRenderer.invoke('memory:list'),
  memoryConsolidate: () => ipcRenderer.invoke('memory:consolidate'),
  memoryEmbed: () => ipcRenderer.invoke('memory:embed'),
  memoryForget: (key) => ipcRenderer.invoke('memory:forget', key),
  memoryClear: () => ipcRenderer.invoke('memory:clear'),
  memoryRemember: (text) => ipcRenderer.invoke('memory:remember', text),
  memoryOpen: () => ipcRenderer.invoke('memory:open'),

  getStatus: () => ipcRenderer.invoke('pet:get-status'),
  reloadConfig: () => ipcRenderer.invoke('pet:reload-config'),
  openConfig: () => ipcRenderer.invoke('pet:open-config'),
  quit: () => ipcRenderer.invoke('pet:quit'),
  hide: () => ipcRenderer.invoke('pet:hide'),
})
