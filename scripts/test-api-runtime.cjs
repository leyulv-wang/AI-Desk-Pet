const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('protocol serves only public resources and audio in external user data', t => {
  const { resolvePetFile } = require('../src/app-protocol')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-public-'))
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-private-'))
  t.after(() => { fs.rmSync(root, { recursive: true }); fs.rmSync(data, { recursive: true }) })
  for (const rel of ['src/renderer/index.html', 'config.json', '.userdata-dev/facts.json']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), 'fixture')
  }
  fs.mkdirSync(path.join(data, 'tts-cache')); fs.writeFileSync(path.join(data, 'tts-cache/a.wav'), 'audio')
  const resolve = url => resolvePetFile(url, { root, ttsDir: path.join(data, 'tts-cache'), singingDir: path.join(data, 'singing') })
  assert.equal(resolve('pet://app/src/renderer/index.html').status, 200)
  for (const rel of ['config.json', '.userdata-dev/facts.json', 'src/main.js', 'audio/tts/%2e%2e/config.json', 'src/renderer/%5c..%5cmain.js']) {
    assert.notEqual(resolve('pet://app/' + rel).status, 200, rel)
  }
  assert.equal(resolve('pet://app/audio/tts/a.wav').file, path.join(data, 'tts-cache/a.wav'))
  assert.equal(resolve('pet://app/%zz').status, 400)
})

test('API timeout covers a stalled response body and aborts the underlying fetch', async () => {
  const { fetchBuffered } = require('../src/api-request')
  let signal
  const fetchImpl = async (_url, options) => {
    signal = options.signal
    return { status: 200, statusText: 'OK', headers: {}, arrayBuffer: () => new Promise(() => {}) }
  }
  await assert.rejects(fetchBuffered('https://example.invalid', { timeoutMs: 20, fetchImpl }), /超时/)
  assert.equal(signal.aborted, true)
})

test('cloud singing uses API, caches by content and settings, and cancels without publishing', async t => {
  const { createSinging } = require('../src/singing')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-cloud-'))
  t.after(() => fs.rmSync(dir, { recursive: true }))
  let calls = 0, pending = false, signal
  const singing = createSinging({ root: dir, userDataDir: path.join(dir, 'data'),
    config: { apiKey: 'test', prompt: '清澈女声演唱，保留原曲旋律与节奏' },
    fetchImpl: async (_url, options) => {
      calls++; signal = options.signal
      const body = JSON.parse(options.body)
      assert.equal(body.model, 'music-cover'); assert.ok(body.audio_base64)
      if (pending) return new Promise(() => {})
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: Buffer.alloc(1200, 1).toString('hex') }, extra_info: { music_duration: 10000 } }))
    } })
  fs.writeFileSync(path.join(singing.songsDir, 'song.wav'), 'input')
  const result = await singing.start({ file: 'song.wav' })
  assert.equal(result.ok, true)
  assert.ok(result.result.url.startsWith('pet://app/audio/singing/'))
  assert.equal((await singing.start({ file: 'song.wav' })).cached, true)
  assert.equal(calls, 1)
  singing.reload({ apiKey: 'test', prompt: '轻柔女声演唱，保留原曲旋律与节奏' })
  assert.equal(singing.listSongs()[0].result, null)
  pending = true
  const job = singing.start({ file: 'song.wav' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(singing.cancel().ok, true)
  assert.equal((await job).cancelled, true)
  assert.equal(signal.aborted, true)
  assert.equal(singing.listSongs()[0].result, null)
  assert.equal(singing.forget('../').ok, false)
})

test('MiniMax cache follows voice settings and an in-flight request keeps its original config', async t => {
  const { createTts } = require('../src/tts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tts-'))
  t.after(() => fs.rmSync(dir, { recursive: true }))
  const bodies = []
  let release, hold = false
  const config = { enabled: true, backend: 'minimax', trimSilence: false, normalizeLoudness: false,
    minimax: { apiKey: 'test', voiceId: 'voice-a', speed: 1 } }
  const tts = createTts({ root: dir, cacheDir: path.join(dir, 'cache'), config,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      if (hold) await new Promise(resolve => { release = resolve })
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: Buffer.alloc(1200, 1).toString('hex') } }))
    } })
  const first = await tts.speak({ text: '测试语音' })
  assert.equal(first.ok, true)
  assert.ok(first.url.startsWith('pet://app/audio/tts/'))
  assert.equal((await tts.speak({ text: '测试语音' })).cached, true)
  tts.reload({ ...config, minimax: { ...config.minimax, voiceId: 'voice-b', speed: 1.2 } })
  const second = await tts.speak({ text: '测试语音' })
  assert.notEqual(second.file, first.file)
  hold = true
  const old = tts.speak({ text: '正在生成的一句话' })
  await new Promise(resolve => setImmediate(resolve))
  tts.reload({ ...config, minimax: { ...config.minimax, voiceId: 'voice-c' } })
  release(); const original = await old
  hold = false
  const changed = await tts.speak({ text: '正在生成的一句话' })
  assert.notEqual(original.file, changed.file)
  assert.equal(bodies.at(-2).voice_setting.voice_id, 'voice-b')
  assert.equal(bodies.at(-1).voice_setting.voice_id, 'voice-c')
})

test('TTS cancellation aborts a pending request and creates no audio cache', async t => {
  const { createTts } = require('../src/tts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tts-stop-'))
  t.after(() => fs.rmSync(dir, { recursive: true }))
  let signal
  const tts = createTts({ root: dir, cacheDir: dir, config: { enabled: true, backend: 'minimax', minimax: { apiKey: 'test', voiceId: 'test' } },
    fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}) } })
  const controller = new AbortController()
  const pending = tts.speak({ text: '取消这句话', signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  assert.equal((await pending).ok, false)
  assert.equal(signal.aborted, true)
  assert.equal(fs.readdirSync(dir).filter(file => file.endsWith('.wav')).length, 0)
})

test('MiMo cache changes when a sample file is replaced at the same path', async t => {
  const { createTts } = require('../src/tts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-mimo-'))
  t.after(() => fs.rmSync(dir, { recursive: true }))
  const sample = path.join(dir, 'voice.wav'), requests = []
  fs.writeFileSync(sample, 'first sample')
  const tts = createTts({ root: dir, cacheDir: path.join(dir, 'cache'),
    config: { backend: 'mimo', trimSilence: false, normalizeLoudness: false,
      mimo: { apiKey: 'test', model: 'mimo-v2.5-tts-voiceclone', voiceSample: sample } },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body))
      return new Response(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.alloc(1200, 1).toString('base64') } } }] }))
    } })
  const first = await tts.speak({ text: '同一句话' })
  fs.writeFileSync(sample, 'second sample')
  const second = await tts.speak({ text: '同一句话' })
  assert.equal(first.ok, true); assert.equal(second.ok, true)
  assert.notEqual(first.file, second.file)
  assert.notEqual(requests[0].audio.voice, requests[1].audio.voice)
})

test('music permission errors remain actionable and never create a completed cache', async t => {
  const { createSinging } = require('../src/singing')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-music-error-'))
  t.after(() => fs.rmSync(dir, { recursive: true }))
  const singing = createSinging({ root: dir, userDataDir: path.join(dir, 'data'), config: { apiKey: 'test' },
    fetchImpl: async () => new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: '音乐接口无权限' } })) })
  fs.writeFileSync(path.join(singing.songsDir, 'song.wav'), 'input')
  const result = await singing.start({ file: 'song.wav' })
  assert.equal(result.ok, false)
  assert.match(result.error, /1004.*音乐接口无权限/)
  assert.equal(singing.status().running, null)
  assert.equal(singing.listSongs()[0].result, null)
})
