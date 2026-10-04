const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ROOT = path.resolve(__dirname, '..')
const { Memory } = require('../src/memory')
const { History } = require('../src/history')
const { createSinging } = require('../src/singing')
const quiet = () => {}
const tick = () => new Promise(r => setImmediate(r))
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-regression-'))
  const owned = []
  t.after(() => {
    for (const object of owned) {
      clearTimeout(object.timer)
      clearTimeout(object._recallSaveTimer)
    }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, own: object => { owned.push(object); return object } }
}

test('a newly observed conversation survives restart before consolidation', t => {
  const { dir, own } = fixture(t)
  const memory = own(new Memory({ dir, request: null, log: quiet }))
  memory.observe('用户明天去北京出差', '知道了')
  const restored = own(new Memory({ dir, request: null, log: quiet }))
  assert.equal(restored.pending.length, 1)
  assert.equal(restored.pending[0].user, '用户明天去北京出差')
})

test('clearing memory rejects an old extraction and preserves new observations', async t => {
  const { dir, own } = fixture(t)
  const gate = deferred()
  const memory = own(new Memory({ dir, request: () => gate.promise, log: quiet }))
  memory.observe('用户喜欢蓝色', '知道了')
  const job = memory.consolidate()
  memory.clear()
  memory.observe('用户现在住在上海', '知道了')
  gate.resolve(JSON.stringify([{ text: '用户喜欢蓝色' }]))
  await job
  assert.equal(memory.facts.length, 0)
  assert.equal(memory.pending.length, 1)
  assert.equal(memory.pending[0].user, '用户现在住在上海')
})

test('clearing history rejects an old archive and keeps new messages in context', async t => {
  const { dir, own } = fixture(t)
  const gate = deferred()
  const history = own(new History({ dir, request: () => gate.promise, recentCount: 2, archiveAfter: 6, archiveChunk: 6, log: quiet }))
  for (let i = 0; i < 5; i++) history.append('旧消息' + i, '旧回复' + i)
  const job = history.archiveIfNeeded()
  history.clear()
  history.append('新消息', '新回复')
  gate.resolve('旧对话摘要')
  await job
  assert.equal(history.archives.blocks.length, 0)
  assert.deepEqual(history.buildContext().messages, [{ role: 'user', content: '新消息' }, { role: 'assistant', content: '新回复' }])
})

test('clearing history also rejects an in-flight archive merge', async t => {
  const { dir, own } = fixture(t)
  const gate = deferred()
  const history = own(new History({ dir, request: () => gate.promise, maxBlocks: 2, log: quiet }))
  history.archives.blocks = [1, 2, 3].map(n => ({ fromSeq: n, toSeq: n, overview: '旧档案' + n }))
  const job = history.mergeOldest()
  history.clear()
  gate.resolve('合并的旧摘要')
  await job
  assert.equal(history.archives.blocks.length, 0)
})

test('changing embedding model clears old vectors and cached queries', async t => {
  const { dir, own } = fixture(t)
  const memory = own(new Memory({ dir, request: null, embed: async texts => texts.map(() => [1, 0]), embedModel: 'A', log: quiet }))
  memory.addFacts([{ text: '用户喜欢编程' }])
  await memory.embedMissing()
  await memory.embedQuery('兴趣')
  memory.configureEmbedding({ model: 'B', identity: 'B@new-provider', enabled: true, vecMinScore: .4, vecMargin: .1, embedTimeoutMs: 800 })
  memory.embed = async texts => texts.map(() => [0, 1, 0])
  await memory.embedMissing()
  assert.deepEqual(Object.values(memory.embeddings), [[0, 1, 0]])
  assert.deepEqual(await memory.embedQuery('兴趣'), [0, 1, 0])
  assert.equal(JSON.parse(fs.readFileSync(memory.embPath)).model, 'B')
})

test('an old embedding response cannot repopulate memory after clearing it', async t => {
  const { dir, own } = fixture(t)
  const gate = deferred()
  const memory = own(new Memory({ dir, request: null, embed: () => gate.promise, embedModel: 'A', log: quiet }))
  memory.addFacts([{ text: '用户喜欢编程' }])
  const job = memory.embedMissing()
  memory.clear()
  gate.resolve([[1, 0]])
  await job
  assert.deepEqual(memory.embeddings, {})
})

test('audio configuration changes invalidate a completed singing result', t => {
  const { dir } = fixture(t)
  const singing = createSinging({ root: dir, userDataDir: path.join(dir, 'data'), log: quiet })
  fs.writeFileSync(path.join(singing.songsDir, 'song.wav'), 'fixture')
  const first = singing.listSongs()[0].key
  const output = path.join(singing.outRoot, first)
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'mixed.wav'), 'old result')
  fs.writeFileSync(path.join(output, 'meta.json'), JSON.stringify({ output: 'mixed.wav' }))
  assert.ok(singing.listSongs()[0].result)
  for (const config of [{ ddsp: { seed: 123 } }, { separate: { model: 'another-model' } }, { mix: { vocalGain: 2 } }]) {
    singing.reload(config)
    assert.notEqual(singing.listSongs()[0].key, first)
    assert.equal(singing.listSongs()[0].result, null)
  }
})

function voiceFixture() {
  const loads = new Map(), sources = []
  class AudioContext {
    constructor() { this.state = 'running'; this.destination = {} }
    createGain() { return { gain: { value: 1 }, connect() {} } }
    decodeAudioData() { return Promise.resolve({ duration: 1, sampleRate: 100, getChannelData: () => new Float32Array(100).fill(.1) }) }
    createBufferSource() {
      const source = { connect() {}, start() { this.started = true }, stop() { this.stopped = true }, onended: null }
      sources.push(source)
      return source
    }
  }
  const window = { addEventListener() {} }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/renderer/voice.js'), 'utf8'), {
    window, AudioContext, fetch: url => { const gate = deferred(); loads.set(url, gate); return gate.promise },
    performance: { now: () => 0 }, setTimeout, clearTimeout, console, Float32Array, AbortController,
  })
  const loaded = url => loads.get(url).resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })
  return { api: window.petVoice, loads, sources, loaded }
}

test('stop during audio loading prevents the cancelled track from starting', async () => {
  const { api, sources, loaded, loads } = voiceFixture()
  api.enqueue({ url: 'old.wav' })
  api.stop()
  loaded('old.wav')
  await tick()
  assert.equal(sources.filter(s => s.started).length, 0)
  assert.equal(api.speaking, false)
})

test('switching a loading song starts the new song without waiting for the old fetch', async () => {
  const { api, sources, loaded, loads } = voiceFixture()
  api.sing({ url: 'old.wav', title: '旧歌' })
  api.sing({ url: 'new.wav', title: '新歌' })
  await tick()
  assert.ok(loads.has('new.wav'), 'new playback must not wait for a cancelled fetch')
  loaded('new.wav')
  await tick()
  assert.equal(api.stats.lastText, '新歌')
  assert.equal(sources.filter(s => s.started).length, 1)
  loaded('old.wav')
  await tick()
  assert.equal(sources.filter(s => s.started).length, 1)
  api.stop()
})

function chatFixture(t, autoplay = true) {
  const { dir, own } = fixture(t)
  const gate = deferred(), events = [], handlers = {}, inflight = new Map()
  const source = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8')
  const sender = { isDestroyed: () => false, send: (channel, data) => events.push({ channel, ...data }) }
  const { createSplitter, pauseAfter } = require('../src/sentence')
  const { createSpokenExtractor, spokenOf } = require('../src/spoken')
  const history = own(new History({ dir, request: null, log: quiet }))
  const memory = own(new Memory({ dir, request: null, log: quiet }))
  const context = {
    ipcMain: { handle: (channel, handler) => { handlers[channel] = handler } }, AbortController, inflight,
    config: { tts: { enabled: true, autoplay } }, tts: { enabled: true, pick: () => null, speak: () => gate.promise },
    createSplitter, pauseAfter, createSpokenExtractor, spokenOf, emotion: require('../src/emotion'),
    console: { log: quiet, error: quiet }, setTimeout, voiceServerReady: null, voiceServer: { status: () => ({ starting: false }) },
    mockMode: () => false, buildMessages: async () => [],
    callModel: async (_m, _signal, delta) => delta('[平静]这是一段足够长度的测试语音内容。'), history, memory, win: { webContents: sender },
  }
  vm.createContext(context)
  for (const channel of ['chat:start', 'chat:stop']) {
    const start = source.indexOf(`ipcMain.handle('${channel}'`)
    const end = source.indexOf('\n})', start) + 3
    vm.runInContext(source.slice(start, end), context)
  }
  return { handlers, events, gate, sender, inflight, memory, history }
}

test('stopping after text completion suppresses late TTS segments', async t => {
  const { handlers, events, gate, sender } = chatFixture(t)
  handlers['chat:start']({ sender }, { id: 'turn', text: '你好' })
  await tick()
  assert.ok(events.some(e => e.channel === 'chat:done'))
  handlers['chat:stop']({}, { id: 'turn' })
  gate.resolve({ ok: true, url: 'late.wav' })
  await tick()
  assert.equal(events.filter(e => e.channel === 'tts:segment').length, 0)
})

test('autoplay off skips chat synthesis while still saving dialogue', async t => {
  const { handlers, events, gate, sender, memory, history } = chatFixture(t, false)
  handlers['chat:start']({ sender }, { id: 'turn', text: '你好' })
  await tick()
  gate.resolve({ ok: true, url: 'disabled.wav' })
  await tick()
  assert.equal(events.filter(e => e.channel === 'tts:segment').length, 0)
  assert.equal(history.entries.length, 2)
  assert.equal(memory.pending.length, 1)
})
