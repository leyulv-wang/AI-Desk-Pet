/**
 * 语音服务（GPT-SoVITS）的进程管理
 *
 * 桌宠启动时可以顺手把这个服务拉起来，省得每次开两个终端。
 *
 * 一个关键决定：**子进程的 stdout / stderr 重定向到日志文件，不走管道。**
 *
 * 因为踩过一个很阴的坑：如果 stdout 是管道，而父进程被 kill 掉，
 * 管道断了，子进程每次写日志就抛 `OSError: [Errno 22] Invalid argument`。
 * GPT-SoVITS 的请求处理外面套着一个宽泛的 `except Exception`，
 * 于是这个写日志的失败被吞成 `{"message":"tts failed","Exception":"[Errno 22]..."}`
 * —— 端口照样能连、探活一切正常，但每一句合成都 400。
 * 重定向到文件就没有"管道断裂"这回事了。
 *
 * 归属规则：
 *   · 服务本来就在跑（你自己起的）→ 不碰它，退出时也不杀
 *   · 是我们拉起来的               → 退出时收干净
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

/** 整合包可能在这些地方。整合包常见「套两层同名目录」，所以每层再往下探两层 */
function candidateRoots(extra = []) {
  return [
    process.env.GPTSOVITS_HOME,
    ...extra,
    'D:\\GPT-SoVITS',
    'E:\\GPT-SoVITS',
    'F:\\GPT-SoVITS',
  ].filter(Boolean)
}

function isVoiceRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, 'api_v2.py')) && fs.existsSync(path.join(dir, 'GPT_SoVITS'))
  } catch {
    return false
  }
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir)
      .map((n) => path.join(dir, n))
      .filter((p) => {
        try {
          return fs.statSync(p).isDirectory()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

/** 找整合包根目录（往下探两层，兼容「套两层同名目录」的解压结构） */
function findVoiceRoot(extra = []) {
  for (const base of candidateRoots(extra)) {
    if (!fs.existsSync(base)) continue
    if (isVoiceRoot(base)) return base
    for (const l1 of subdirs(base)) {
      if (isVoiceRoot(l1)) return l1
      for (const l2 of subdirs(l1)) {
        if (isVoiceRoot(l2)) return l2
      }
    }
  }
  return null
}

/** 纯 TCP 探活。故意不依赖任何路由 —— 服务版本之间路由会变 */
function probePort(baseUrl, timeoutMs = 900) {
  return new Promise((resolve) => {
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
 * @param {object} opts.config      config.json 的 tts.gptsovits 段
 * @param {string} opts.configPath  桌宠自己的 gptsovits.pet.yaml 绝对路径
 * @param {string} opts.userDataDir 日志写这儿
 * @param {string[]} [opts.searchExtra] 额外搜索路径
 * @param {function} [opts.log]
 */
function createVoiceServer({ config, configPath, userDataDir, searchExtra = [], log = () => {} }) {
  const baseUrl = config?.baseUrl || 'http://127.0.0.1:9880'
  const logFile = path.join(userDataDir, 'voice-server.log')

  let child = null
  let owned = false
  let starting = false
  let lastDetail = '还没启动'

  function status() {
    return {
      owned,
      pid: child?.pid || null,
      starting,
      detail: lastDetail,
      logFile,
    }
  }

  /**
   * 保证服务可用。
   * @returns {{ok:boolean, spawned:boolean, detail:string}}
   */
  async function ensure({ waitMs = 180000 } = {}) {
    if (await probePort(baseUrl)) {
      lastDetail = owned ? `已就绪（我们起的，pid ${child?.pid}）` : '已就绪（外部在跑，桌宠不接管）'
      return { ok: true, spawned: false, detail: lastDetail }
    }

    if (starting) {
      lastDetail = '正在启动中…'
      return { ok: false, spawned: false, detail: lastDetail }
    }

    const root = findVoiceRoot(searchExtra)
    if (!root) {
      lastDetail = '没找到 GPT-SoVITS 整合包；设环境变量 GPTSOVITS_HOME 指过去'
      log(`[voice-server] ${lastDetail}`)
      return { ok: false, spawned: false, detail: lastDetail }
    }

    const python = path.join(root, 'runtime', 'python.exe')
    if (!fs.existsSync(python)) {
      lastDetail = `${root} 里没有 runtime\\python.exe`
      log(`[voice-server] ${lastDetail}`)
      return { ok: false, spawned: false, detail: lastDetail }
    }
    if (!fs.existsSync(configPath)) {
      lastDetail = `缺少权重配置 ${configPath}`
      log(`[voice-server] ${lastDetail}`)
      return { ok: false, spawned: false, detail: lastDetail }
    }

    // 日志重定向到文件而不是管道 —— 见文件头的说明，管道断了会让服务变残废
    let out = null
    try {
      fs.mkdirSync(userDataDir, { recursive: true })
      out = fs.openSync(logFile, 'a')
    } catch (e) {
      log(`[voice-server] 打不开日志文件：${e.message}`)
    }

    const args = ['api_v2.py', '-c', configPath, '-a', new URL(baseUrl).hostname, '-p', String(Number(new URL(baseUrl).port) || 9880)]
    child = spawn(python, args, {
      cwd: root,
      stdio: out === null ? 'ignore' : ['ignore', out, out],
      detached: false,
      windowsHide: true,
    })
    owned = true
    starting = true

    child.on('exit', (code) => {
      starting = false
      if (owned && code) {
        lastDetail = `服务退出，退出码 ${code}（看 ${path.basename(logFile)}）`
        log(`[voice-server] ${lastDetail}`)
      }
      child = null
    })
    child.on('error', (e) => {
      starting = false
      lastDetail = `拉起失败：${e.message}`
      log(`[voice-server] ${lastDetail}`)
    })

    log(`[voice-server] 已拉起（pid ${child.pid}），整合包 ${root}`)

    // 等它把模型读进显存
    const t0 = Date.now()
    while (Date.now() - t0 < waitMs) {
      if (await probePort(baseUrl, 600)) {
        starting = false
        lastDetail = `已就绪（${Math.round((Date.now() - t0) / 1000)}s 起来，pid ${child?.pid}）`
        log(`[voice-server] ${lastDetail}`)
        return { ok: true, spawned: true, detail: lastDetail, logFile }
      }
      if (!child) {
        starting = false
        lastDetail = `启动过程中退出了，看 ${logFile}`
        return { ok: false, spawned: true, detail: lastDetail, logFile }
      }
      await new Promise((r) => setTimeout(r, 700))
    }

    starting = false
    lastDetail = `等了 ${Math.round(waitMs / 1000)}s 还没起来，看 ${logFile}`
    return { ok: false, spawned: true, detail: lastDetail, logFile }
  }

  /** 只收我们自己拉起来的那个。你自己起的服务桌宠不碰 */
  function stop() {
    if (!owned || !child) return false
    try {
      log('[voice-server] 关掉我们拉起的语音服务')
      child.kill()
    } catch {
      /* 已经没了 */
    }
    child = null
    owned = false
    return true
  }

  return { ensure, status, stop, probe: () => probePort(baseUrl), logFile, findVoiceRoot: () => findVoiceRoot(searchExtra) }
}

module.exports = { createVoiceServer, findVoiceRoot, probePort, candidateRoots }
