/** Cloud music cover generation; no local inference runtime. */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { fetchBuffered } = require('./api-request')
const AUDIO_EXT = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.aiff', '.ape']
const DEFAULTS = { enabled: true, backend: 'minimax', baseUrl: '', apiKey: '', model: 'music-cover',
  prompt: '清澈明亮的女声演唱，带有舞台感与细腻情绪，保留原曲旋律和节奏。',
  sampleRate: 44100, bitrate: 256000, timeoutMs: 300000 }
function createSinging({ root, userDataDir, config = {}, getProvider = () => ({}), resolveKey = name => process.env[name], fetchImpl, log = () => {} }) {
  let cfg = { ...DEFAULTS, ...config }, current = null, lastError = null
  const songsDir = path.join(root, 'songs'), outRoot = path.join(userDataDir, 'singing')
  fs.mkdirSync(songsDir, { recursive: true }); fs.mkdirSync(outRoot, { recursive: true })
  function settings() {
    const provider = getProvider() || {}
    return { ...cfg, baseUrl: cfg.baseUrl || provider.baseUrl || 'https://api.minimax.cn/v1',
      apiKey: cfg.apiKey || provider.apiKey || resolveKey('MINIMAX_API_KEY') || '' }
  }
  function probe() {
    const s = settings()
    if (s.backend !== 'minimax') return { ok: false, detail: '唱歌目前使用 MiniMax 云端 API，请设置 singing.backend=minimax。' }
    if (!s.apiKey) return { ok: false, detail: '请配置 MiniMax API Key；可沿用说话的 MiniMax Key。' }
    if (s.model !== 'music-cover') return { ok: false, detail: '音频翻唱需要 music-cover 模型。' }
    if (typeof s.prompt !== 'string' || s.prompt.length < 10 || s.prompt.length > 300) return { ok: false, detail: '翻唱风格描述需要 10–300 个字符。' }
    return { ok: true, detail: 'MiniMax 云端翻唱（需要账号具有音乐接口权限）' }
  }
  const validKey = key => typeof key === 'string' && /^[a-f0-9]{24}$/.test(key)
  function keyFor(file, s = settings()) {
    const { apiKey, enabled, timeoutMs, ...identity } = s
    return crypto.createHash('sha256').update(JSON.stringify(identity)).update(fs.readFileSync(file)).digest('hex').slice(0, 24)
  }
  function resultOf(key) {
    if (!validKey(key)) return null
    const dir = path.join(outRoot, key)
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
      if (!['mixed.mp3', 'mixed.wav'].includes(meta.output)) return null
      const file = path.join(dir, meta.output)
      if (!fs.statSync(file).isFile()) return null
      return { dir, file, url: `pet://app/audio/singing/${key}/${meta.output}`, mouthUrl: null, meta }
    } catch { return null }
  }
  function listSongs() {
    return fs.readdirSync(songsDir).filter(file => AUDIO_EXT.includes(path.extname(file).toLowerCase())).sort().flatMap(file => {
      const full = path.join(songsDir, file), stat = fs.statSync(full)
      if (!stat.isFile()) return []
      const key = keyFor(full)
      return [{ file, name: path.basename(file, path.extname(file)), size: stat.size, key, result: resultOf(key) }]
    })
  }
  async function start({ file, force = false, onProgress = () => {} } = {}) {
    if (!cfg.enabled) return { ok: false, error: '唱歌功能已关闭' }
    if (current) return { ok: false, error: '已有翻唱任务，请等待或停止当前任务' }
    if (typeof file !== 'string' || path.basename(file) !== file || !AUDIO_EXT.includes(path.extname(file).toLowerCase())) return { ok: false, error: '请选择歌单中的音频文件' }
    const full = path.join(songsDir, file)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, error: '歌曲不存在' }
    if (fs.statSync(full).size > 50 * 1024 * 1024) return { ok: false, error: '参考音频不能超过 50MB' }
    const s = settings(), key = keyFor(full, s), cached = resultOf(key)
    if (!force && cached) return { ok: true, cached: true, key, result: cached }
    const env = probe()
    if (!env.ok) return { ok: false, error: env.detail }
    const job = { key, song: file, stage: '等待云端生成', pct: 0, startedAt: Date.now(), controller: new AbortController() }
    current = job; lastError = null
    const progress = stage => { job.stage = stage; onProgress({ key, song: file, stage, pct: job.pct }) }
    try {
      progress('等待云端生成（可以随时停止等待）')
      const response = await fetchBuffered(`${s.baseUrl.replace(/\/+$/, '')}/music_generation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify({ model: s.model, prompt: s.prompt, stream: false, output_format: 'hex',
          audio_base64: fs.readFileSync(full).toString('base64'),
          audio_setting: { sample_rate: s.sampleRate, bitrate: s.bitrate, format: 'mp3' } }),
        signal: job.controller.signal, timeoutMs: s.timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) })
      if (!response.ok) throw new Error(`MiniMax 音乐接口 HTTP ${response.status}：${(await response.text()).slice(0, 200)}`)
      const json = await response.json()
      if (json.base_resp?.status_code !== 0) throw new Error(`MiniMax 音乐接口 ${json.base_resp?.status_code}：${json.base_resp?.status_msg || '未知错误，请检查音乐接口权限'}`)
      const hex = json.data?.audio
      if (typeof hex !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(hex) || hex.length < 2000) throw new Error('音乐接口未返回有效音频')
      job.controller.signal.throwIfAborted()
      const dir = path.join(outRoot, key)
      fs.mkdirSync(dir, { recursive: true })
      const audio = path.join(dir, 'mixed.mp3'), meta = path.join(dir, 'meta.json')
      const tmpAudio = `${audio}.part`, tmpMeta = `${meta}.part`
      try {
        fs.writeFileSync(tmpAudio, Buffer.from(hex, 'hex'))
        fs.writeFileSync(tmpMeta, JSON.stringify({ output: 'mixed.mp3', duration: (json.extra_info?.music_duration || 0) / 1000, backend: s.backend, model: s.model }))
        fs.renameSync(tmpAudio, audio)
        fs.renameSync(tmpMeta, meta)
      } finally {
        fs.rmSync(tmpAudio, { force: true }); fs.rmSync(tmpMeta, { force: true })
      }
      job.pct = 100; progress('云端翻唱完成')
      return { ok: true, cached: false, key, result: resultOf(key) }
    } catch (error) {
      if (job.controller.signal.aborted) return { ok: false, cancelled: true, key, error: '已停止等待云端生成' }
      lastError = error.message; log(`[singing] ${lastError}`)
      return { ok: false, key, error: lastError }
    } finally { if (current === job) current = null }
  }
  function cancel() {
    if (!current) return { ok: false, error: '没有正在生成的任务' }
    current.controller.abort(); return { ok: true }
  }
  function forget(key) {
    if (!validKey(key)) return { ok: false, error: '非法缓存 key' }
    if (current?.key === key) return { ok: false, error: '请先停止当前任务' }
    const dir = path.join(outRoot, key)
    try {
      if (fs.existsSync(dir) && fs.realpathSync(dir) !== path.resolve(dir)) return { ok: false, error: '非法缓存目录' }
      for (const name of ['mixed.mp3', 'mixed.wav', 'meta.json']) fs.rmSync(path.join(dir, name), { force: true })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }
  return { songsDir, outRoot, start, cancel, forget, listSongs, resultOf, probe,
    reload: config => { cfg = { ...DEFAULTS, ...config } },
    status: () => ({ enabled: cfg.enabled, backend: cfg.backend, env: probe(), running: current ? { key: current.key, song: current.song, stage: current.stage, pct: current.pct, startedAt: current.startedAt } : null, lastError }) }
}
module.exports = { createSinging, DEFAULTS, AUDIO_EXT }
