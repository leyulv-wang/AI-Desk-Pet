/**
 * 验证「转换好的歌真的能播」+ 面板交互状态 —— 直接驱动运行中的桌宠渲染层。
 *
 * 为什么要这么测：播放这条链（protocol → fetch → decodeAudioData → Web Audio）
 * 全在渲染进程里，主进程日志看不到。以前 playOne 失败只打 console，
 * 表现就是「点了 ▶ 没反应」，靠人肉点击试错成本太高。
 *
 * 做法：桌宠带 --remote-debugging-port 启动后，用 CDP 在渲染层里
 * 真的调一次 petVoice.sing()，然后读它自己的统计（played / failed / ctxState）。
 * `petVoice.stats` 就是为这个留的钩子（见 renderer/voice.js 的注释
 * 「真出过声没有 —— 自动化测试就看这个」）。
 *
 * `--flow` 额外跑一遍**交互状态**自检：真的点一次「唱」，然后在中途检查
 * 停止按钮是否可用、正在跑那首的按钮是否变成「停止」、别的歌的 ▶ 是否还能点。
 * 这三个都是「状态没跟着真实情况走」的 bug，只能靠真的点一遍发现。
 *
 * 用法：
 *   node scripts/probe-singing-play.mjs                     # 播 .userdata/singing 里最新那份
 *   node scripts/probe-singing-play.mjs --key 38c56093b3a7  # 指定
 *   node scripts/probe-singing-play.mjs --flow              # 额外跑交互状态自检
 *   node scripts/probe-singing-play.mjs --port 9222
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const argOf = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const PORT = Number(argOf('--port') || 9222)
const SING_DIR = path.join(process.env.PET_USER_DATA || path.join(ROOT, '.userdata'), 'singing')

// ---------------------------------------------------------------- 挑一份产物
let key = argOf('--key')
if (!key) {
  const dirs = fs
    .readdirSync(SING_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(SING_DIR, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (!dirs.length) {
    console.error(`❌ ${SING_DIR} 里没有产物，先让她唱一首`)
    process.exit(1)
  }
  key = dirs[0].name
}
const dir = path.join(SING_DIR, key)
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
const url = `pet://app/audio/singing/${key}/${meta.output || 'mixed.wav'}`
const mouth = meta.mouth ? `pet://app/audio/singing/${key}/${meta.mouth}` : null
console.log(`  产物 ${key}  (${meta.song}, ${meta.duration}s)`)
console.log(`  成品 ${url}`)
console.log(`  口型 ${mouth}\n`)

// ---------------------------------------------------------------- 连 CDP
let targets
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`)
  targets = await r.json()
} catch (e) {
  console.error(`❌ 连不上 ${PORT}。桌宠要是带 --remote-debugging-port=${PORT} 启动的。`)
  console.error(`   ${e.message}`)
  process.exit(1)
}
const page = targets.find((t) => t.type === 'page' && String(t.url).includes('renderer/index.html'))
if (!page) {
  console.error('❌ 没找到渲染层页面。目标是：')
  for (const t of targets) console.error(`   ${t.type}  ${t.url}`)
  process.exit(1)
}
console.log(`  已连上：${page.url}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

let msgId = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
function call(method, params = {}) {
  const id = ++msgId
  return new Promise((res) => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate 抛异常')
  }
  return r.result?.result?.value
}

await call('Runtime.enable')

// ---------------------------------------------------------------- UI 自检
// 先确认面板本身是好的 —— 否则「播不出来」可能只是面板没开/状态是错的
console.log('\n=== UI 自检 ===')
const staticUi = JSON.parse(await evaluate(`JSON.stringify({
  hasPanel: !!document.getElementById('sing-panel'),
  hasChatLog: !!document.getElementById('chat-log'),
  hasBtn: !!document.getElementById('btn-sing'),
})`))
for (const [k, v] of Object.entries(staticUi)) console.log(`  ${v ? '✅' : '❌'} ${k} = ${v}`)

const opened = JSON.parse(await evaluate(`(async () => {
  window.petSinging.open()
  await new Promise(r => setTimeout(r, 800))
  const sp = document.getElementById('sing-panel')
  const st = window.petSinging.status
  return JSON.stringify({
    hidden: !!sp?.hidden,
    subText: document.getElementById('sing-sub')?.textContent ?? '',
    subIsWarn: !!document.getElementById('sing-sub')?.classList.contains('warn'),
    enabled: !!st?.enabled,
    engine: st?.engine ?? null,
    envOk: !!st?.env?.ok,
    envDetail: st?.env?.detail ?? '',
    statusError: st?.statusError ?? null,
    songs: window.petSinging.songs.length,
    rows: sp ? sp.querySelectorAll('.sing-row').length : -1,
    inChatLog: !!document.querySelector('#chat-log .sing-content'),
    historyHidden: !!document.getElementById('history-panel')?.hidden,
  })
})()`))

console.log(`  面板展开=${!opened.hidden}  头部显示「${opened.subText}」${opened.subIsWarn ? ' (警告色)' : ''}`)
console.log(`  enabled=${opened.enabled}  engine=${opened.engine}  env.ok=${opened.envOk}`)
console.log(`  env：${opened.envDetail}`)
if (opened.statusError) console.log(`  ⚠️ statusError：${opened.statusError}`)
console.log(`  歌单 ${opened.songs} 首，渲染出 ${opened.rows} 行`)
console.log(`  内容在 #chat-log 里？${opened.inChatLog ? '是（没分开）' : '否（已独立）'}`)
console.log(`  点唱歌时历史面板已收起？${opened.historyHidden ? '是（互斥正常）' : '否（会叠在一起）'}`)

let uiBad = 0
const uiCheck = (ok, yes, no) => {
  console.log(`  ${ok ? '✅' : '❌'} ${ok ? yes : no}`)
  if (!ok) uiBad++
}
uiCheck(!opened.hidden, '面板能展开', '面板打不开')
uiCheck(opened.enabled, 'status.enabled = true（不再是「功能已关闭」）', 'status.enabled 是 false')
uiCheck(!opened.statusError, 'status() 没抛异常', `status() 抛了：${opened.statusError}`)
uiCheck(opened.envOk, `环境就绪（${opened.envDetail}）`, `环境没就绪：${opened.envDetail}`)
uiCheck(!opened.inChatLog, '唱歌内容**不在**对话记录里（已分开）', '唱歌内容还在 #chat-log 里（没分开）')
uiCheck(opened.rows === opened.songs, `歌单 ${opened.songs} 首都渲染出来了`, `歌单 ${opened.songs} 首只渲染了 ${opened.rows} 行`)

// ---------------------------------------------------------------- 交互状态自检
// 这一节对应三个真实踩过的 bug：
//   ① 停止按钮一直是灰的（status.running 在转换过程中是过期的）
//   ② 正在跑那首的按钮没有变成「停止」，用户再点它想停止却点不动
//   ③ 转换在跑时把 ▶ 也一起禁掉了 —— 可播放和转换是两条独立的路
if (argv.includes('--flow')) {
  console.log('\n=== 交互状态自检（真点一次「唱」）===')
  const pick = JSON.parse(
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#sing-panel .sing-row')]
      const r = rows.find(x => x.querySelector('.sing-name')?.textContent?.includes('_smoke30s')) || rows[0]
      if (!r) return JSON.stringify({ err: '没有歌' })
      const btns = [...r.querySelectorAll('button')].map(b => b.textContent)
      const force = btns.includes('重唱') ? '重唱' : '唱'
      const b = [...r.querySelectorAll('button')].find(x => x.textContent === force)
      b.click()
      return JSON.stringify({ song: r.querySelector('.sing-name').textContent, clicked: force })
    })()`),
  )
  console.log(`  点了《${pick.song}》的「${pick.clicked}」`)
  await new Promise((r) => setTimeout(r, 4000)) // 等它真的跑起来

  const mid = JSON.parse(
    await evaluate(`(() => {
      const sp = document.getElementById('sing-panel')
      const rows = [...sp.querySelectorAll('.sing-row')]
      const active = rows.find(x => x.classList.contains('active'))
      const others = rows.filter(x => !x.classList.contains('active'))
      const stopBtn = () => [...sp.querySelectorAll('.sing-actions button')].find(b => b.textContent.startsWith('停止'))
      return JSON.stringify({
        activeSong: active?.querySelector('.sing-name')?.textContent ?? null,
        activeBtns: active ? [...active.querySelectorAll('button')].map(b => b.textContent + (b.disabled ? '(禁用)' : '')) : [],
        activeTag: active?.querySelector('.sing-tag')?.textContent ?? '',
        stopDisabled: stopBtn() ? stopBtn().disabled : 'no-stop-btn',
        stopLabel: stopBtn() ? stopBtn().textContent : 'no-stop-btn',
        otherPlayBtns: others.map(r => {
          const b = [...r.querySelectorAll('button')].find(x => x.textContent === '▶')
          return b ? { song: r.querySelector('.sing-name').textContent, disabled: b.disabled } : null
        }).filter(Boolean),
      })
    })()`),
  )

  console.log(`  正在跑：${mid.activeSong ?? '（无高亮）'}   标签「${mid.activeTag}」`)
  console.log(`  那首的按钮：${mid.activeBtns.join('  ') || '（无）'}`)
  console.log(`  底部「停止」按钮 disabled = ${mid.stopDisabled}`)
  for (const o of mid.otherPlayBtns) console.log(`  其他歌《${o.song}》的 ▶ disabled = ${o.disabled}`)

  const flowCheck = (ok, yes, no) => {
    console.log(`  ${ok ? '✅' : '❌'} ${ok ? yes : no}`)
    if (!ok) uiBad++
  }
  flowCheck(mid.activeSong, '正在跑的那首被高亮出来了', '没有任何一行高亮 —— 界面看不出在跑')
  flowCheck(
    mid.activeBtns.some((b) => b.startsWith('■ 停止') && !b.includes('禁用')),
    '那首的按钮变成了可用的「■ 停止」',
    '那首的按钮不是可用的「停止」—— 用户没法从这一行掐掉',
  )
  flowCheck(
    mid.stopDisabled === false,
    `底部「停止」按钮可用（文案「${mid.stopLabel}」）`,
    `底部「停止」按钮是灰的（文案「${mid.stopLabel}」）—— 就是这次的 bug`,
  )
  flowCheck(
    mid.otherPlayBtns.length === 0 || mid.otherPlayBtns.every((o) => o.disabled === false),
    '其他歌的 ▶ 仍然可用（播放不受转换影响）',
    '其他歌的 ▶ 被禁掉了（播放和转换本该互不影响）',
  )

  // 掐掉，别留一个后台任务
  await evaluate(`window.pet.singCancel()`)
  await new Promise((r) => setTimeout(r, 2500))
  const afterCancel = JSON.parse(
    await evaluate(`JSON.stringify({
      active: !!document.querySelector('#sing-panel .sing-row.active'),
      stopDisabled: (() => {
        const b = [...document.querySelectorAll('#sing-panel .sing-actions button')].find(x => x.textContent === '停止')
        return b ? b.disabled : 'no-btn'
      })(),
      log: (window.petSinging.log || []).slice(-3),
    })`),
  )
  console.log(`  掐掉之后：有高亮=${afterCancel.active}  停止按钮disabled=${afterCancel.stopDisabled}`)
  console.log(`  面板日志末尾：${afterCancel.log.join(' | ')}`)
  flowCheck(!afterCancel.active, '掐掉后高亮消失（状态清干净了）', '掐掉后还高亮着 —— 状态没清')
  flowCheck(afterCancel.stopDisabled === true, '掐掉后「停止」按钮恢复成灰', '掐掉后「停止」还是可用的（状态没复位）')
}

// ---------------------------------------------------------------- 播放停止自检
// 对应真实踩到的严重 bug：`voice.js` 的 stop() 先把 source.onended 摘掉再 stop()，
// 导致 playOne() 的 Promise 永远不 resolve → pump() 卡死 → playing 永远 true
// → 之后**点哪首歌都播不了**。表现是「点一次停止，播放功能永久废掉」。
// 这一段就是验这个：播 → 停 → 再播，第三步必须还能出声。
if (argv.includes('--flow')) {
  console.log('\n=== 播放停止自检（播 → 停 → 再播）===')

  const playExpr = `(async () => {
    // ⚠️ 每次都要**重新按歌名找那一行** —— render() 会重建整个歌单，
    // 点击前抓到的 DOM 节点在重建后就脱离文档了，读它只会得到旧状态。
    const findRow = (name) => [...document.querySelectorAll('#sing-panel .sing-row')]
      .find(r => r.querySelector('.sing-name')?.textContent === name)
    const rowBtn = (name) => {
      const r = findRow(name)
      return r ? [...r.querySelectorAll('button')].find(b => ['▶', '■ 停'].includes(b.textContent)) : null
    }
    const rowTag = (name) => findRow(name)?.querySelector('.sing-tag')?.textContent ?? ''
    const stopBtn = () => [...document.querySelectorAll('#sing-panel .sing-actions button')]
      .find(b => b.textContent.startsWith('停止'))

    const first = [...document.querySelectorAll('#sing-panel .sing-row')]
      .find(r => [...r.querySelectorAll('button')].some(b => b.textContent === '▶'))
    if (!first) return JSON.stringify({ err: '没有已唱好的歌' })
    const song = first.querySelector('.sing-name').textContent

    rowBtn(song).click()
    await new Promise(r => setTimeout(r, 2500))
    const mid = {
      song,
      rowBtn: rowBtn(song)?.textContent,
      stopLabel: stopBtn()?.textContent,
      stopDisabled: stopBtn()?.disabled,
      speaking: window.petVoice.stats.speaking,
      played: window.petVoice.stats.played,
      tag: rowTag(song),
    }
    rowBtn(song).click()                // 再点一次 = 停
    await new Promise(r => setTimeout(r, 1200))
    const stopped = {
      rowBtn: rowBtn(song)?.textContent,
      stopLabel: stopBtn()?.textContent,
      speaking: window.petVoice.stats.speaking,
    }
    rowBtn(song).click()                // ★ 关键：停了之后还能不能再播
    await new Promise(r => setTimeout(r, 2500))
    const again = {
      rowBtn: rowBtn(song)?.textContent,
      speaking: window.petVoice.stats.speaking,
      played: window.petVoice.stats.played,
      failed: window.petVoice.stats.failed,
    }
    window.petVoice.stop()
    return JSON.stringify({ mid, stopped, again })
  })()`

  const pr = JSON.parse(await evaluate(playExpr))
  if (pr.err) {
    console.log(`  ⚠️ ${pr.err}`)
    uiBad++
  } else {
    console.log(`  ① 点 ▶ 后：行内按钮「${pr.mid.rowBtn}」 底部「${pr.mid.stopLabel}」disabled=${pr.mid.stopDisabled}`)
    console.log(`     speaking=${pr.mid.speaking}  played=${pr.mid.played}  行标签「${pr.mid.tag}」`)
    console.log(`  ② 再点一次（想停）：行内按钮「${pr.stopped.rowBtn}」 speaking=${pr.stopped.speaking}`)
    console.log(`  ③ 停了之后再点 ▶：行内按钮「${pr.again.rowBtn}」 speaking=${pr.again.speaking} played=${pr.again.played}`)

    const pbCheck = (ok, yes, no) => {
      console.log(`  ${ok ? '✅' : '❌'} ${ok ? yes : no}`)
      if (!ok) uiBad++
    }
    pbCheck(pr.mid.speaking === true, '点 ▶ 能播', '点 ▶ 没播')
    pbCheck(pr.mid.rowBtn === '■ 停', '正在播那首的按钮变成了「■ 停」', `按钮还是「${pr.mid.rowBtn}」`)
    pbCheck(
      pr.mid.stopLabel === '停止播放' && pr.mid.stopDisabled === false,
      '底部「停止」键变成可用的「停止播放」',
      `底部是「${pr.mid.stopLabel}」disabled=${pr.mid.stopDisabled}`,
    )
    pbCheck(pr.mid.tag.includes('正在唱'), '行标签显示「♪ 正在唱」', `行标签是「${pr.mid.tag}」`)
    pbCheck(pr.stopped.speaking === false, '再点一次真的停了', '再点一次没停')
    pbCheck(pr.stopped.rowBtn === '▶', '停后按钮变回「▶」', `停后按钮是「${pr.stopped.rowBtn}」`)
    pbCheck(pr.again.speaking === true, '★ 停了之后还能再播（播放器没被锁死）', '★ 停过之后就再也播不了了（播放器被锁死）')
    pbCheck(pr.again.played > pr.mid.played, '第二次播放真的进了播放统计', '第二次没有产生新的播放')
  }
}

// ---------------------------------------------------------------- 先量一份基线
const before = JSON.parse(await evaluate('JSON.stringify(window.petVoice.stats)'))
console.log(`  播放前：played=${before.played} failed=${before.failed} ctx=${before.ctxState}`)

// ---------------------------------------------------------------- 真的播一次
console.log('\n=== 触发播放（等 6 秒）===')
const expr = `(async () => {
  window.petVoice.unlock()
  window.petVoice.sing({ url: ${JSON.stringify(url)}, mouthUrl: ${JSON.stringify(mouth)}, title: '探针' })
  await new Promise(r => setTimeout(r, 3000))
  const mid = window.petVoice.stats
  const mouthLevel = window.petVoice.mouthLevel()
  await new Promise(r => setTimeout(r, 3000))
  return JSON.stringify({ mid, mouthLevel, after: window.petVoice.stats })
})()`
const out = JSON.parse(await evaluate(expr))
const mid = out.mid
const after = out.after

console.log(`  3 秒时：speaking=${mid.speaking} ctx=${mid.ctxState} played=${mid.played} failed=${mid.failed}`)
console.log(`  嘴张开度 mouthLevel = ${Number(out.mouthLevel).toFixed(3)}   （>0 说明口型包络在走）`)
console.log(`  6 秒后：speaking=${after.speaking} played=${after.played} failed=${after.failed}`)

// ---------------------------------------------------------------- 判定
console.log('\n=== 播放判定 ===')
let bad = uiBad
const check = (ok, yes, no) => {
  console.log(`  ${ok ? '✅' : '❌'} ${ok ? yes : no}`)
  if (!ok) bad++
}
check(after.played > before.played, '音频真的进入播放（played 增加）', '没播放（played 没变）')
check(after.failed === before.failed, '没有解码/取音频失败', `有 ${after.failed - before.failed} 次失败`)
check(mid.speaking === true, '播放中状态正确（speaking=true）', '不在播放状态')
check(mid.ctxState === 'running', `AudioContext 在跑（${mid.ctxState}）`, `AudioContext 不是 running（${mid.ctxState}）`)
check(Number(out.mouthLevel) > 0.01, '口型包络有值（嘴会动）', '口型包络为 0（嘴不会动）')

ws.close()
console.log(`\n${bad ? '❌ 有问题' : '✅ 面板与播放都正常'}`)
process.exit(bad ? 1 : 0)
