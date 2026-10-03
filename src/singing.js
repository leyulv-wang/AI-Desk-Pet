/**
 * 唱歌 —— 把一首歌换成角色的嗓子，然后在桌宠里唱出来。
 *
 * 和 TTS 的关系：**两条完全独立的链路，共用一张「嗓子」**。
 *   TTS    ：一句话 → 合成 → 几百毫秒 → 边说边播（要低延迟，逐句流水线）
 *   唱歌   ：一首歌 → 分离人声 → 换音色 → 混音 → 几分钟 → 整首播（要音质，离线批处理）
 *
 * 所以这里不做「流式」，也不该做：整首歌的转换天然是批处理，
 * 唯一能优化的是「等的时候让她看起来在忙」和「同一首歌别算两遍」。
 *
 * 为什么是「一个任务起一个 Python 进程」而不是常驻服务：
 *   ① 8G 显存要和 Live2D、可能还有 GPT-SoVITS 抢。算完就退出，显存立刻还回来。
 *   ② 常驻服务要处理「模型热切换 / 崩了重启 / 版本不一致」，全是白来的复杂度。
 *   ③ 代价只是每次多花 10~30 秒读模型 —— 而整首歌本来就要几分钟，占比很小。
 *
 * 为什么用子进程而不是把 Python 嵌进来：模型栈是 PyTorch + CUDA，
 * 跟 Electron 的 node 是两套运行时，除了 spawn 没有别的接法。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** 进度行前缀。管线往 stdout 打的每一行，只有带这个前缀的才当进度解析 */
const PROGRESS_PREFIX = '@@PROGRESS '
const RESULT_PREFIX = '@@RESULT '

/** 能直接喂给 ffmpeg 的输入格式（其实 ffmpeg 什么都吃，这里只是给选择框用） */
const AUDIO_EXT = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.aiff', '.ape']

/**
 * 默认配置。用户 config.json 里的 `singing` 段会和这些做深合并。
 *
 * 放在 config.json 而不是写死：换引擎、换分离模型、调混音比例都不该改代码。
 */
const DEFAULTS = {
  /** 总开关。关掉之后按钮还在，但点了会说「没开」 */
  enabled: true,

  /** 人声分离（管线内部用 demucs，不走 audio-separator） */
  separate: {
    /**
     * demucs 模型。实测 htdemucs / htdemucs_ft / mdx_extra 三者输出
     * **相关系数 0.998+** —— 换分离器几乎不改变结果，所以用最快的 htdemucs。
     */
    model: 'htdemucs',
    /**
     * 分离结果按歌曲缓存。
     * 同一首歌换音色重唱时跳过分离 —— 实测分离约占总耗时 1/3，
     * 重唱时能省掉。
     */
    cache: true,
  },

  /**
   * 转换引擎。目前只有 ddsp 一种：
   *   ddsp —— DDSP-SVC + 训练好的音色模型（D:\models\DDSP-SVC\voices\<名字>）
   *
   * 为什么不是 RVC：试过 RVC（检索式），但公开的芙宁娜 RVC 模型训练得很不充分
   * （20.6 分钟素材 / 150 epochs / 40kHz），实测音色、咬字、稳定性全面不如 DDSP。
   * 详见 singing/README.md 的结论段。
   */
  engine: 'ddsp',

  /** DDSP-SVC 转换参数（engine=ddsp 时有效） */
  ddsp: {
    /** 音色模型名。对应 D:\models\DDSP-SVC\voices\<名字>\{model.pt, config.yaml} */
    voice: '芙宁娜',
    /**
     * 说话人编号。**1-based** —— DDSP 内部是 `spk_embed(spk_id - 1)`，
     * 传 0 会索引 -1，直接触发 CUDA device-side assert（会把显卡驱动搞成 TDR）。
     * 单说话人模型固定用 1。
     */
    spkId: 1,
    /**
     * 共振峰偏移。只改音色（嗓音粗细/年龄感），不改音高。
     * **实测 0 已经是最优**：往两边调音色相似度都下降（−1 → −0.11，+1 → −0.04，
     * +4 → −0.41），所以默认不动它。
     */
    formant: 0,
    /**
     * 随机种子。DDSP 的噪声激励是 `torch.randn_like`，**没种子就每次输出都不同**
     * （实测同配置两次跑，波形差 0.46）。固定它才能做到「同一首歌每遍结果一致」。
     */
    seed: 1,
    /** 生成时用的是哪张卡算的；换卡后音色细微差别属正常 */
    amp: true,
  },

  /** 混音 */
  mix: {
    /** 伴奏增益（dB） */
    instrumentalGain: -1,
    /** 人声增益（dB）。实测 0 时人声/伴奏约 +0.2 dB，比例合适 */
    vocalGain: 0,
    /** 输出响度（LUFS）。-14 是流媒体常用值 */
    targetLufs: -14,
    /** 输出格式。wav 无损但大，m4a 小很多 */
    format: 'wav',
  },

  /** 超时。整首歌几分钟是正常的，给足 */
  timeoutMs: 30 * 60 * 1000,
}

/** 主进程用的默认值，导出给 main.js 合并配置 */
module.exports = { createSinging, DEFAULTS, AUDIO_EXT }

/**
 * @param {object} opts
 * @param {string} opts.root             desktop-pet 根目录
 * @param {string} opts.userDataDir      .userdata 目录
 * @param {object} opts.config           config.json 的 singing 段
 * @param {function} [opts.log]
 */
function createSinging({ root, userDataDir, config = {}, log = () => {} }) {
  const cfg = deepMerge(DEFAULTS, config)

  /** 输入歌曲放这儿。用户往里丢文件，面板里就列出来 */
  const songsDir = path.join(root, 'songs')
  /** 产物放这儿。渲染层通过 pet://app/.userdata/singing/... 取 */
  const outRoot = path.join(userDataDir, 'singing')
  /** 管线本体。DDSP-SVC 那条链（旧版这里是已废弃的 pipeline.py） */
  const pipelinePath = path.join(root, 'singing', 'ddsp_cover.py')
  /**
   * Python 环境。**注意是 .venv-ddsp 而不是 .venv** ——
   * 那里面装的是 DDSP-SVC 依赖 + CUDA 版 torch（torch 2.8.0+cu129，本地 wheel 装的，
   * 已在本机 RTX 5060 上验证 CUDA 可用）。
   */
  const venvDir = path.join(root, 'singing', '.venv-ddsp')
  const logFile = path.join(userDataDir, 'singing.log')

  /** 正在跑的任务。同一时刻只允许一个 —— GPU 只有一块，排队比并发快 */
  let current = null
  let lastError = null

  fs.mkdirSync(songsDir, { recursive: true })
  fs.mkdirSync(outRoot, { recursive: true })

  function reload(next) {
    Object.assign(cfg, deepMerge(DEFAULTS, next || {}))
    log(`配置已重载（engine=${cfg.engine}）`)
  }

  // ---------------------------------------------------------------- 环境探测

  /**
   * 找 Python。顺序：
   *   ① 环境变量 PET_SINGING_PYTHON（最明确，调试用）
   *   ② singing/.venv-ddsp（正常路径）
   *   ③ 系统 python（大概率缺依赖，但至少能报出「缺什么」而不是「找不到 python」）
   */
  function findPython() {
    const cands = [
      process.env.PET_SINGING_PYTHON,
      path.join(venvDir, 'Scripts', 'python.exe'),
      path.join(venvDir, 'bin', 'python'),
    ].filter(Boolean)
    for (const p of cands) {
      try {
        if (fs.existsSync(p)) return p
      } catch {
        /* 忽略 */
      }
    }
    return process.platform === 'win32' ? 'python' : 'python3'
  }

  /**
   * 环境体检。这是「点了按钮没反应」和「告诉你缺什么」的区别 ——
   * 用户不该靠猜。返回的 detail 会直接显示在面板上。
   */
  function probe() {
    if (!fs.existsSync(pipelinePath)) {
      return { ok: false, detail: `找不到管线脚本：${pipelinePath}` }
    }
    const py = findPython()
    const isVenv = py.includes(`${path.sep}.venv-ddsp${path.sep}`)
    if (!isVenv && !process.env.PET_SINGING_PYTHON) {
      return {
        ok: false,
        detail: 'singing/.venv-ddsp 还没建好（DDSP-SVC 的 Python 环境），见 singing/README.md',
        python: py,
        needsSetup: true,
      }
    }
    return { ok: true, detail: `Python：${py}`, python: py, engine: cfg.engine }
  }

  // ---------------------------------------------------------------- 歌曲清单

  /** 列 songs/ 下的音频。按修改时间倒序 —— 刚丢进去的排最前面 */
  function listSongs() {
    let names = []
    try {
      names = fs.readdirSync(songsDir)
    } catch {
      return []
    }
    return names
      .filter((n) => AUDIO_EXT.includes(path.extname(n).toLowerCase()))
      .map((n) => {
        const full = path.join(songsDir, n)
        let st = null
        try {
          st = fs.statSync(full)
        } catch {
          return null
        }
        const key = songKey(full, st)
        const out = resultOf(key)
        return {
          name: path.basename(n, path.extname(n)),
          file: n,
          size: st.size,
          mtime: st.mtimeMs,
          key,
          /** 已经转换过就带上产物地址，界面直接显示「播放」而不是「唱」 */
          result: out,
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
  }

  /**
   * 歌曲的稳定 id。
   *
   * 为什么把 mtime/size 也算进去：换掉同名文件（重新下载了一版伴奏）时，
   * 缓存必须失效。只用路径的话会拿旧的分离结果去混新的歌 —— 时间轴全错。
   *
   * 为什么把 engine/model 也算进去：换音色模型就是另一份产物，
   * 不能互相覆盖（同一首歌用两个模型各唱一版是正常需求）。
   */
  function songKey(file, st) {
    const sig = [
      path.resolve(file),
      st.size,
      Math.round(st.mtimeMs),
      cfg.engine,
      // 影响音色的参数都要进 key：换音色/共振峰就是另一份产物，不能互相覆盖
      cfg.engine === 'ddsp' ? `${cfg.ddsp.voice}:${cfg.ddsp.spkId}:${cfg.ddsp.formant}` : '',
    ].join('|')
    return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 12)
  }

  /** 产物目录 */
  function outDirOf(key) {
    return path.join(outRoot, key)
  }

  /** 读一份已完成的产物（没有 / 不完整就返回 null） */
  function resultOf(key) {
    const dir = outDirOf(key)
    const metaPath = path.join(dir, 'meta.json')
    if (!fs.existsSync(metaPath)) return null
    let meta = null
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    } catch {
      return null
    }
    const mix = path.join(dir, meta.output || 'mixed.wav')
    if (!fs.existsSync(mix)) return null

    // 口型包络要跟着**人声轨**走，不是成品。
    // 成品里鼓和贝斯会一起进包络，她的嘴就会跟着鼓点乱动 —— 一眼假。
    // 管线把纯人声写成 vocal_converted.wav（vocal_raw.wav 是分离出来的原唱，不能用）。
    const vocal = path.join(dir, meta.mouth || 'vocal_converted.wav')
    const rel = (p) => 'pet://app/' + path.relative(root, p).split(path.sep).join('/')

    return {
      key,
      url: rel(mix),
      mouthUrl: fs.existsSync(vocal) ? rel(vocal) : null,
      dir,
      meta,
      size: safeSize(mix),
    }
  }

  function safeSize(p) {
    try {
      return fs.statSync(p).size
    } catch {
      return 0
    }
  }

  // ---------------------------------------------------------------- 跑一个任务

  /**
   * 开唱。同一时刻只跑一个 —— 再点一次会被拒绝而不是排队。
   *
   * 为什么不做队列：一首歌要几分钟，排队等第二首的体验还不如明确告诉用户
   * 「她还在唱上一首」。想换歌就先停。
   *
   * @param {object} opts
   * @param {string} opts.file        songs/ 下的文件名（不是绝对路径 —— 不给界面任意读盘的能力）
   * @param {boolean} [opts.force]    忽略缓存，重算
   * @param {function} opts.onProgress
   */
  function start({ file, force = false, onProgress = () => {} }) {
    if (!cfg.enabled) return { ok: false, error: '唱歌功能没开（config.json 的 singing.enabled）' }
    if (current) return { ok: false, error: `她还在唱「${current.song}」，等这首唱完或者点停止` }

    // 只认 songs/ 里的文件名。挡掉 ../ 之类 —— 渲染层不该有任意读盘的能力
    const base = path.basename(String(file || ''))
    const full = path.join(songsDir, base)
    if (!base || !fs.existsSync(full)) return { ok: false, error: `找不到歌曲：${base}` }

    const st = fs.statSync(full)
    const key = songKey(full, st)

    // 缓存命中：直接返回产物，一行 Python 都不用跑
    if (!force) {
      const hit = resultOf(key)
      if (hit) {
        log(`[singing] 命中缓存 ${key}（${base}）`)
        return { ok: true, cached: true, key, result: hit }
      }
    }

    const env = probe()
    if (!env.ok) return { ok: false, error: env.detail, needsSetup: env.needsSetup }

    const outDir = outDirOf(key)
    fs.mkdirSync(outDir, { recursive: true })

    const args = [
      pipelinePath,
      '--input', full,
      '--outdir', outDir,
      '--voice', cfg.ddsp.voice,
      '--spk-id', String(cfg.ddsp.spkId),
      '--formant', String(cfg.ddsp.formant),
      '--seed', String(cfg.ddsp.seed),
      '--demucs-model', cfg.separate.model,
      '--vocal-gain', String(cfg.mix.vocalGain),
      '--inst-gain', String(cfg.mix.instrumentalGain),
      '--loudness', String(cfg.mix.targetLufs),
      '--emit-progress',
    ]
    if (force) args.push('--force')

    log(`[singing] 开始：${base} → ${outDir}`)
    log(`[singing] ${env.python} ${args.slice(0, 4).join(' ')} …`)

    /**
     * stdout 走管道（要实时读进度），stderr 也走管道。
     *
     * 注意和 voice-server 的区别：那边**必须**重定向到文件，
     * 因为它的 stdout 是管道时父进程一死就 OSError。但那是常驻服务的问题；
     * 这里是一次性子进程，父进程死了它也该跟着死，没有「孤儿继续写断管道」的场景。
     * 而且我们必须实时看到进度行，重定向到文件就得轮询读文件，更绕。
     */
    const child = spawn(env.python, args, {
      cwd: path.join(root, 'singing'),
      windowsHide: true,
      env: {
        ...process.env,
        // 让 Python 别缓冲 stdout —— 不然进度会攒到进程结束才吐出来，
        // 界面上的进度条就变成「一直 0%，然后突然 100%」
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    })

    const job = {
      key,
      song: base,
      startedAt: Date.now(),
      stage: '准备中',
      pct: 0,
      child,
      cancelled: false,
    }
    current = job

    const logStream = fs.createWriteStream(logFile, { flags: 'a' })
    logStream.write(`\n===== ${new Date().toISOString()} ${base} =====\n`)

    const emit = (payload) => {
      job.stage = payload.stage ?? job.stage
      job.pct = payload.pct ?? job.pct
      try {
        onProgress({ key, song: base, ...payload, stage: job.stage, pct: job.pct })
      } catch (e) {
        log(`[singing] 进度回调炸了：${e.message}`)
      }
    }

    emit({ stage: '启动管线', pct: 0 })

    let buf = ''
    const onLine = (line) => {
      if (!line) return
      if (line.startsWith(PROGRESS_PREFIX)) {
        try {
          emit(JSON.parse(line.slice(PROGRESS_PREFIX.length)))
        } catch {
          /* 半行/坏行忽略，不影响任务 */
        }
        return
      }
      if (line.startsWith(RESULT_PREFIX)) {
        try {
          job.resultMeta = JSON.parse(line.slice(RESULT_PREFIX.length))
        } catch {
          /* 忽略 */
        }
        return
      }
      // 普通日志行：写文件 + 转发给调用方（main.js 会打到终端）
      logStream.write(line + '\n')
      log(`[singing] ${line}`)
    }

    const consume = (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) onLine(l)
    }

    child.stdout.on('data', consume)
    child.stderr.on('data', consume)

    const timeout = setTimeout(() => {
      if (!current || current !== job) return
      log(`[singing] 超过 ${Math.round(cfg.timeoutMs / 60000)} 分钟还没完，掐掉`)
      job.timedOut = true
      killTree(child)
    }, Number(cfg.timeoutMs) || DEFAULTS.timeoutMs)

    return new Promise((resolve) => {
      const finish = (payload) => {
        clearTimeout(timeout)
        if (buf.trim()) onLine(buf.trim())
        logStream.end()
        if (current === job) current = null
        resolve(payload)
      }

      child.on('error', (e) => {
        lastError = e.message
        finish({ ok: false, error: `起不来 Python：${e.message}`, key })
      })

      child.on('close', (code) => {
        if (job.cancelled) return finish({ ok: false, cancelled: true, key, error: '已停止' })
        if (job.timedOut) return finish({ ok: false, key, error: '超时' })
        if (code !== 0) {
          lastError = `管线退出码 ${code}`
          return finish({
            ok: false,
            key,
            error: `管线失败了（退出码 ${code}）。完整日志：${logFile}`,
          })
        }
        // 管线把产物路径写在 @@RESULT 行里；这里落一份 meta.json，供下次直接命中缓存
        // （命中就一行 Python 都不用跑）。少了这步 resultOf() 永远返回 null，
        // 会误报「管线说成功了，但产物没落盘」。
        if (job.resultMeta) {
          try {
            fs.writeFileSync(
              path.join(outDir, 'meta.json'),
              JSON.stringify(
                {
                  output: path.basename(job.resultMeta.mixed || 'mixed.wav'),
                  mouth: path.basename(job.resultMeta.mouth || 'vocal_converted.wav'),
                  engine: cfg.engine,
                  voice: cfg.ddsp.voice,
                  spkId: cfg.ddsp.spkId,
                  formant: cfg.ddsp.formant,
                  seed: cfg.ddsp.seed,
                  song: job.resultMeta.song,
                  duration: job.resultMeta.duration,
                  seconds: job.resultMeta.seconds,
                  finishedAt: new Date().toISOString(),
                },
                null,
                2,
              ),
              'utf8',
            )
          } catch (e) {
            log(`[singing] 写 meta.json 失败：${e.message}`)
          }
        }
        const result = resultOf(key)
        if (!result) {
          return finish({ ok: false, key, error: `管线说成功了，但产物没落盘（看 ${logFile}）` })
        }
        emit({ stage: '完成', pct: 100 })
        finish({ ok: true, key, result, ms: Date.now() - job.startedAt })
      })
    })
  }

  /** 停止当前任务。整棵进程树都要收 —— Python 会 fork 出 ffmpeg */
  function cancel() {
    if (!current) return { ok: false, error: '现在没有在唱' }
    current.cancelled = true
    log(`[singing] 用户停止：${current.song}`)
    killTree(current.child)
    return { ok: true }
  }

  /** 删掉某首歌的产物，强制下次重算 */
  function forget(key) {
    const dir = outDirOf(path.basename(String(key || '')))
    if (!dir.startsWith(outRoot)) return { ok: false, error: '非法 key' }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  function status() {
    return {
      enabled: !!cfg.enabled,
      engine: cfg.engine,
      env: probe(),
      songsDir,
      logFile,
      running: current
        ? { key: current.key, song: current.song, stage: current.stage, pct: current.pct, ms: Date.now() - current.startedAt }
        : null,
      lastError,
      config: {
        engine: cfg.engine,
        voice: cfg.ddsp.voice,
        spkId: cfg.ddsp.spkId,
        formant: cfg.ddsp.formant,
        seed: cfg.ddsp.seed,
        separateModel: cfg.separate.model,
      },
    }
  }

  return { reload, probe, listSongs, start, cancel, forget, status, resultOf, songsDir, outRoot, cfg }
}

// ---------------------------------------------------------------- 小工具

/** 只合并纯对象，数组和标量直接覆盖 —— 和 main.js 合并 tts 的做法一致 */
function deepMerge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

/**
 * 杀进程树。
 *
 * 为什么不能只 child.kill()：Python 会 spawn ffmpeg 和分离/转换的子进程，
 * 杀掉父进程之后那些孙进程会变成孤儿继续占着显存 ——
 * 表现是「点了停止，但显存没降，下次跑 OOM」。
 * Windows 上用 taskkill /T 才是真的连根拔。
 */
function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    try {
      child.kill()
    } catch {
      /* 已经没了 */
    }
  }
}
