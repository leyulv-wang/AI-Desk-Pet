const { app, BrowserWindow, protocol, net, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { resolvePetFile } = require('../src/app-protocol')
const ROOT = path.resolve(__dirname, '..')
app.setPath('userData', process.env.PET_UI_TEST_DIR)
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
let turnId, autoplay = true, ready = true
const calls = []
const defaults = {
  'ui:get-state': {}, 'pet:get-status': { mock: true, characterName: '芙宁娜' },
  'history:load': [], 'memory:stats': { facts: 3, pending: 0, embedded: 3, avgStrength: 1, hasEmbedKey: true, embeddingsEnabled: true },
  'history:stats': { entries: 0, unarchived: 0, blocks: 0 },
  'singing:status': { enabled: true, backend: 'minimax', env: { ok: true } }, 'singing:list': [],
}
for (const channel of new Set([...fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8').matchAll(/invoke\('([^']+)'/g)].map(m => m[1]))) {
  ipcMain.handle(channel, (_event, payload) => {
    calls.push({ channel, payload })
    if (channel === 'chat:start') turnId = payload.id
    if (channel === 'tts:status') return { enabled: true, autoplay, ready, backend: 'test' }
    return defaults[channel] ?? { ok: true }
  })
}
app.whenReady().then(async () => {
  protocol.handle('pet', async request => {
    if (!process.argv.includes('--live2d') && new URL(request.url).pathname.startsWith('/vendor/')) return new Response('', { status: 404 })
    const resolved = resolvePetFile(request.url, { root: ROOT, ttsDir: path.join(process.env.PET_UI_TEST_DIR, 'tts-cache'), singingDir: path.join(process.env.PET_UI_TEST_DIR, 'singing') })
    if (resolved.status !== 200) return new Response('', { status: resolved.status })
    const response = await net.fetch(pathToFileURL(resolved.file).toString())
    return new Response(response.body, { headers: { 'Content-Type': resolved.type } })
  })
  const win = new BrowserWindow({ width: 460, height: 720, frame: false, show: false, transparent: true,
    webPreferences: { preload: path.join(ROOT, 'src/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
  const js = source => win.webContents.executeJavaScript(source)
  const settle = () => new Promise(resolve => setTimeout(resolve, 30))
  const renderer = process.argv.includes('--live2d') ? 'live2d' : 'static'
  await win.loadURL('pet://app/src/renderer/index.html?renderer=' + renderer)
  await js('Promise.resolve(window.petModel?.ready)')
  await settle()
  const failures = []
  let checks = 0
  async function check(name, fn) {
    checks++
    try { await fn(); console.log('PASS ' + name) }
    catch (e) { failures.push(name); console.error('FAIL ' + name + ': ' + e.message) }
  }
  if (renderer === 'static') {
    await check('static Furina loads PNG emotions without Live2D above the composer', async () => {
      assert.equal(await js('typeof window.PIXI'), 'undefined')
      await js(`window.petModel.setBottomGap(96);window.petModel.setEmotion('难过')`)
      await js(`Promise.all(Array.from(document.querySelectorAll('.static-pet-img')).filter(i=>i.src).map(i=>i.decode()))`)
      await settle()
      const state = await js(`(()=>{const i=Array.from(document.querySelectorAll('.static-pet-img')).find(i=>i.style.opacity==='1');return {src:i?.src,bottom:i?.getBoundingClientRect().bottom,composer:document.getElementById('input-bar').getBoundingClientRect().top}})()`)
      assert.ok(state.src?.endsWith('furina-05.png'))
      assert.ok(state.bottom < state.composer, 'static character must leave the composer clear')
      for (const emotion of ['平静', '难过', '平静']) {
        await js(`window.petModel.setEmotion(${JSON.stringify(emotion)})`)
        await js(`Promise.all(Array.from(document.querySelectorAll('.static-pet-img')).filter(i=>i.src).map(i=>i.decode()))`)
        await settle()
        const expected = emotion === '难过' ? 'furina-05.png' : 'furina-01.png'
        assert.ok((await js(`Array.from(document.querySelectorAll('.static-pet-img')).find(i=>i.style.opacity==='1')?.src`)).endsWith(expected))
      }
    })
  } else {
    await check('Live2D runtime loads on demand and model startup succeeds', async () => {
      assert.equal(await js('Promise.resolve(window.petModel.ready)'), true)
      assert.equal(await js('document.getElementById("error-overlay").hidden'), true)
      assert.equal(await js('typeof window.PIXI.live2d.Live2DModel'), 'function')
    })
  }
  await check('memory and singing share one mutually exclusive panel', async () => {
    await js(`document.getElementById('btn-sing').click()`)
    await settle()
    await js(`document.getElementById('btn-memory').click()`)
    await settle()
    const state = await js(`({memory:!document.getElementById('memory-view')?.hidden,singing:!document.getElementById('sing-panel').hidden,panel:!document.getElementById('companion-panel')?.hidden})`)
    assert.deepEqual(state, { memory: true, singing: false, panel: true })
  })
  ready = false
  win.webContents.send('config:changed', { mock: true, characterName: '芙宁娜' })
  await settle()
  await js(`window.reviewOriginalEnqueue=window.petVoice.enqueue;window.reviewAudio=[];window.petVoice.enqueue=item=>window.reviewAudio.push(item);document.getElementById('input-text').value='今天有点累，想和你聊聊。';document.getElementById('input-bar').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`)
  await settle()
  win.webContents.send('chat:delta', { id: turnId, delta: '[温柔]*她把茶杯轻轻推过来。*那就先歇一会儿吧，我陪着你。' })
  win.webContents.send('chat:done', { id: turnId })
  await settle()
  await check('stop stays available while speech is still being synthesized', async () => {
    assert.equal(await js(`document.getElementById('btn-stop').hidden`), false)
  })
  await check('quiet companionship retains a stop control during pending speech', async () => {
    await js(`document.getElementById('btn-collapse').click()`)
    assert.equal(await js(`document.getElementById('btn-quiet-stop')?.hidden`), false)
  })
  await js(`document.getElementById('btn-expand').click()`)
  win.webContents.send('tts:segment', { id: turnId, ok: true, url: 'fake.wav', text: '那就先歇一会儿吧', index: 0, pauseAfter: 380 })
  await settle()
  await check('punctuation pause reaches the audio player', async () => {
    assert.equal(await js('window.reviewAudio[0]?.pauseAfter'), 380)
  })
  await js(`document.getElementById('btn-stop').click()`)
  win.webContents.send('tts:segment', { id: turnId, ok: true, url: 'late.wav', text: '迟到的旧语音', index: 1 })
  await settle()
  await check('user stop rejects late speech on the renderer', async () => {
    assert.equal(await js('window.reviewAudio.length'), 1)
    assert.ok(calls.some(call => call.channel === 'chat:stop' && call.payload.id === turnId))
  })
  autoplay = false
  win.webContents.send('config:changed', { mock: true, characterName: '芙宁娜' })
  await settle()
  await js(`document.getElementById('input-text').value='只显示文字';document.getElementById('input-bar').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`)
  await settle()
  win.webContents.send('chat:delta', { id: turnId, delta: '[平静]这条只显示文字。' })
  win.webContents.send('chat:done', { id: turnId })
  win.webContents.send('tts:segment', { id: turnId, ok: true, url: 'disabled.wav', text: '禁用的自动播放', index: 0 })
  await settle()
  await check('autoplay false is respected in the renderer as well', async () => {
    assert.equal(await js('window.reviewAudio.length'), 1)
  })
  await js(`document.getElementById('btn-clear').click()`)
  await settle()
  await check('clear history also clears both subtitle lines', async () => {
    assert.equal(await js(`document.getElementById('sub-pet').textContent+document.getElementById('sub-me').textContent`), '')
  })
  await check('compact composer fits at its supported window size', async () => {
    const state = await js(`(()=>{const bar=document.getElementById('input-bar');return {overflow:bar.scrollWidth>bar.clientWidth+1,inputWidth:document.getElementById('input-text').getBoundingClientRect().width}})()`)
    assert.equal(state.overflow, false)
    assert.ok(state.inputWidth >= 100)
  })
  defaults['singing:list'] = [{ key: 'song1', name: '测试歌曲', file: 'test.wav', size: 100, result: { url: 'pet://app/review-song.wav', meta: { duration: 10 } } }]
  await js(`window.petVoice.enqueue=window.reviewOriginalEnqueue;window.reviewFetch=window.fetch;window.fetch=(url,options)=>url==='pet://app/review-song.wav'?new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')))):window.reviewFetch(url,options);window.petPanels.open('sing')`)
  await settle()
  await check('loading song exposes stop and clicking its row stops the real player', async () => {
    await js(`document.querySelector('.sing-row button.primary').click()`)
    await settle()
    assert.equal(await js(`!!document.querySelector('.sing-row.playing')`), true)
    assert.equal(await js(`Array.from(document.querySelectorAll('#sing-panel .sing-actions button')).find(b=>b.textContent==='停止播放')?.disabled`), false)
    await js(`document.querySelector('.sing-row.playing button.danger').click()`)
    assert.equal(await js(`window.petVoice.busy`), false)
  })
  await js(`window.petVoice.stop();window.fetch=window.reviewFetch;window.petPanels.close()`)
  defaults['singing:list'] = []
  const shotsAt = process.argv.indexOf('--shots')
  if (shotsAt >= 0) {
    const out = path.resolve(process.argv[shotsAt + 1]); fs.mkdirSync(out, { recursive: true })
    const paint = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await js(`window.petPanels?.close();document.getElementById('sub-pet').textContent='今天也在这里陪你。想聊什么，随时叫我。'`)
    await paint()
    await new Promise(resolve => setTimeout(resolve, 250))
    fs.writeFileSync(path.join(out, 'companion-compact.png'), (await win.webContents.capturePage()).toPNG())
    const previousTurn = turnId
    await js(`window.petPanels.open('chat');document.getElementById('input-text').value='今天有点累，想和你聊聊。';document.getElementById('input-bar').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`)
    for (let i = 0; i < 20 && turnId === previousTurn; i++) await settle()
    assert.notEqual(turnId, previousTurn, 'screenshot dialogue must use its own captured turn id')
    await paint()
    win.webContents.send('chat:delta', { id: turnId, delta: '[温柔]*她把茶杯轻轻推过来。*那就先歇一会儿吧，我陪着你。' })
    win.webContents.send('chat:done', { id: turnId })
    win.webContents.send('tts:done', { id: turnId })
    await settle(); await paint(); await new Promise(resolve => setTimeout(resolve, 200))
    fs.writeFileSync(path.join(out, 'companion-chat.png'), (await win.webContents.capturePage()).toPNG())
    await js(`document.getElementById('tab-memory')?.click()`); await settle(); await paint()
    fs.writeFileSync(path.join(out, 'companion-memory.png'), (await win.webContents.capturePage()).toPNG())
    await js(`document.getElementById('tab-sing').click()`); await settle(); await paint(); await new Promise(resolve => setTimeout(resolve, 200))
    fs.writeFileSync(path.join(out, 'companion-singing.png'), (await win.webContents.capturePage()).toPNG())
    await js(`window.petPanels.close();document.getElementById('sub-me').textContent='';document.getElementById('sub-pet').textContent='今天也在这里陪你。想聊什么，随时叫我。'`)
    await paint(); await new Promise(resolve => setTimeout(resolve, 250))
    fs.writeFileSync(path.join(out, 'companion-compact.png'), (await win.webContents.capturePage()).toPNG())
  }
  console.log(`UI checks: ${checks - failures.length}/${checks} passed`)
  app.exit(failures.length ? 1 : 0)
}).catch(error => { console.error(error); app.exit(1) })
