/**
 * 渲染器接口一致性自检。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么需要这个
 * ─────────────────────────────────────────────────────────────────────
 * 桌宠有两条形象渲染的路，它们在配置里切换：
 *
 *     Live2D   src/renderer/pet.js          window.petModel
 *     静态立绘  src/renderer/static-pet.js   window.petStatic → createStaticPet()
 *
 * 上层（chat.js / main.js）**不知道**当前用的是哪一种 —— 两边必须暴露同一组方法。
 * 这是「配置里能切」的前提，也是最容易悄悄坏掉的地方：
 *
 *     pet.js 加了个方法 → 上层开始调 → 切到静态立绘时才炸
 *
 * 而且它**只在切到静态模式时**才暴露，是那种「上线很久没人发现」的 bug。
 * check-wiring.mjs 查的是 IPC 名字对不对，查不到这里。
 *
 * 写这个脚本的当天就抓到一个真的：static-pet.js 缺 `getMouthValue`。
 *
 * 用法：node scripts/check-pet-renderers.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LIVE2D = path.join(ROOT, 'src', 'renderer', 'pet.js')
const STATIC = path.join(ROOT, 'src', 'renderer', 'static-pet.js')
const HTML = path.join(ROOT, 'src', 'renderer', 'index.html')

/**
 * 从一个对象字面量里抽出顶层键名。
 *
 * 为什么不用正则直接匹配键：`{ a, b() {}, get c() {}, d: () => {} }` 形态太多，
 * 而且方法体里还嵌着对象。所以用**花括号配平**确定范围，再只看顶层那一层。
 *
 * @param {string} src 文件内容
 * @param {string} marker 起始标记，例如 `window.petModel = {`
 */
function extractKeys(src, marker) {
  const at = src.indexOf(marker)
  if (at < 0) return null
  const open = src.indexOf('{', at)
  if (open < 0) return null

  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null

  const body = src.slice(open + 1, end)
  const keys = []
  let d = 0
  let lineStart = true
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '{' || c === '(' || c === '[') d++
    else if (c === '}' || c === ')' || c === ']') d--
    if (d !== 0) continue

    // 顶层：每遇到换行/分号就尝试解析一条属性
    if (c === '\n' || c === ';' || c === ',') lineStart = true
    else if (lineStart && /\s/.test(c)) {
      /* 还在这条的开头空白 */
    } else if (lineStart) {
      lineStart = false
      const rest = body.slice(i)
      // 支持 `name`, `name()`, `name:`, `get name()`, `async name(`
      const m = /^(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[:(,]/.exec(rest)
      if (m) keys.push(m[1])
    }
  }
  return [...new Set(keys)]
}

/** 上层实际调用了 petModel 的哪些方法 */
function calledByUpperLayers() {
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) files.push(p)
    }
  }
  walk(path.join(ROOT, 'src'))

  const hits = new Map() // 方法名 → 调用点
  for (const f of files) {
    // 渲染器自己不算「上层」
    if (f.endsWith('pet.js') || f.endsWith('static-pet.js')) continue
    const src = fs.readFileSync(f, 'utf8')
    const re = /petModel\s*\??\.\s*([A-Za-z_$][\w$]*)/g
    let m
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length
      if (!hits.has(m[1])) hits.set(m[1], [])
      hits.get(m[1]).push(`${path.relative(ROOT, f)}:${line}`)
    }
  }
  return hits
}

// ---------------------------------------------------------------- 执行
let bad = 0
const fail = (m, how) => {
  bad++
  console.log(`  ❌ ${m}`)
  if (how) console.log(`     → ${how}`)
}
const ok = (m) => console.log(`  ✅ ${m}`)

console.log('=== 1) 两个渲染器都暴露在 window 上吗 ===')
const petSrc = fs.readFileSync(LIVE2D, 'utf8')
const staticSrc = fs.readFileSync(STATIC, 'utf8')
const html = fs.readFileSync(HTML, 'utf8')

for (const [label, marker, src] of [
  ['pet.js', 'window.petModel = {', petSrc],
  ['static-pet.js', 'window.petStatic = {', staticSrc],
]) {
  if (src.includes(marker)) ok(`${label} 暴露了 ${marker.split(' ')[0]}`)
  else fail(`${label} 没有 ${marker.split(' ')[0]}`, '上层靠这个全局名找渲染器')
}

console.log('\n=== 2) index.html 加载了两个脚本吗 ===')
for (const f of ['pet.js', 'static-pet.js']) {
  if (html.includes(f)) ok(`加载了 ${f}`)
  else fail(`index.html 没加载 ${f}`, '没加载的渲染器 = 死代码，配置切过去就是白屏')
}

console.log('\n=== 3) 上层调用的方法，两边都有吗 ===')
const live2dKeys = extractKeys(petSrc, 'window.petModel = {')
const staticKeys = extractKeys(staticSrc, 'const api = {')
if (!live2dKeys) fail('从 pet.js 抽不出接口', 'extractKeys 的标记可能变了')
if (!staticKeys) fail('从 static-pet.js 抽不出接口', 'extractKeys 的标记可能变了')

if (live2dKeys && staticKeys) {
  const calls = calledByUpperLayers()
  console.log(`  上层共调用 ${calls.size} 个方法：${[...calls.keys()].sort().join(', ')}`)
  console.log('')

  const missingStatic = []
  const missingLive2d = []
  for (const [name, sites] of [...calls].sort()) {
    const inL = live2dKeys.includes(name)
    const inS = staticKeys.includes(name)
    if (inL && inS) continue
    const where = sites.slice(0, 3).join('、')
    if (!inS) missingStatic.push({ name, where })
    if (!inL) missingLive2d.push({ name, where })
  }

  if (!missingStatic.length) ok(`静态立绘覆盖了上层用到的全部 ${calls.size} 个方法`)
  for (const m of missingStatic) {
    fail(`static-pet.js 缺 \`${m.name}\``, `上层在 ${m.where} 调用 —— 切到静态立绘会静默失效`)
  }
  if (!missingLive2d.length) ok('Live2D 覆盖了上层用到的全部方法')
  for (const m of missingLive2d) {
    fail(`pet.js 缺 \`${m.name}\``, `上层在 ${m.where} 调用`)
  }

  // 静态立绘多出来的（无害，只是提示）
  const extraS = staticKeys.filter((k) => !live2dKeys.includes(k))
  const extraL = live2dKeys.filter((k) => !staticKeys.includes(k))
  if (extraS.length) console.log(`  ·  static-pet.js 独有：${extraS.sort().join(', ')}`)
  if (extraL.length) console.log(`  ·  pet.js 独有：${extraL.sort().join(', ')}`)
}

console.log('\n=== 4) 渲染器切换的入口存在吗 ===')
// main.js 里应当有按配置挑渲染器的逻辑
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
if (/petModel|createStaticPet|renderer/i.test(mainSrc)) ok('main.js 提到了渲染器相关名字')
else fail('main.js 完全没提渲染器', '那配置项切了也没人读')

/**
 * `--live`：连上**正在跑的**桌宠，看当前渲染器是不是真的建起来了。
 *
 * 静态检查只能证明「接口对得上」，证明不了「切过去不白屏」。
 * 而白屏恰恰是渲染器切换最典型的故障 —— 两边接口都齐，但加载顺序、
 * 资源路径、manifest 字段名任何一处不对，结果都是一片空白。
 *
 * 用法：先带 --remote-debugging-port=9222 启动桌宠，再
 *   node scripts/check-pet-renderers.mjs --live
 */
if (process.argv.includes('--live')) {
  console.log('\n=== 5) 实测运行中的桌宠（--live）===')
  const PORT = 9222
  let page = null
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`)
    const targets = await r.json()
    page = targets.find((t) => t.type === 'page' && String(t.url).includes('renderer/index.html'))
  } catch (e) {
    fail(`连不上 ${PORT}`, '桌宠要带 --remote-debugging-port=9222 启动')
  }
  if (!page) fail('没找到渲染层页面')

  if (page) {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
    })
    const evaluate = (expression) =>
      new Promise((res) => {
        const myId = ++id
        pending.set(myId, (m) => res(m.result?.result?.value))
        ws.send(
          JSON.stringify({
            id: myId,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
      })

    console.log(`  页面 URL：${page.url}`)
    const info = JSON.parse(
      await evaluate(`JSON.stringify({
        hasModel: !!window.petModel,
        keys: window.petModel ? Object.keys(window.petModel).length : 0,
        ready: null,
        emotion: window.petModel?.emotion ?? null,
        // 静态立绘的 DOM 特征
        staticImgs: document.querySelectorAll('.static-pet-img').length,
        staticStage: !!document.querySelector('.static-pet-stage'),
        // Live2D 的 canvas 是不是还显示着
        canvasShown: (() => {
          const c = document.getElementById('pet-canvas')
          return !!c && c.style.display !== 'none'
        })(),
        errorShown: !document.getElementById('error-overlay')?.hidden,
        errorText: document.getElementById('error-detail')?.textContent ?? '',
        // ★ 界面骨架还在不在。
        //   静态立绘的 createStaticPet() 会先清空 host（host.innerHTML = ''），
        //   如果 host 传错（比如传了 <body>）就会把整个 UI 删光，而且**不报任何错** ——
        //   实测踩过一次，所以这里逐项点名检查。
        //   注意：这段是嵌在模板字符串里的，注释里不能再出现反引号。
        ui: {
          inputBar: !!document.getElementById('input-bar'),
          chatLog: !!document.getElementById('chat-log'),
          historyPanel: !!document.getElementById('history-panel'),
          subtitle: !!document.getElementById('subtitle'),
          bodyChildren: document.body.children.length,
        },
      })`),
    )
    const readyVal = await evaluate('Promise.resolve(window.petModel?.ready).then(v => v === true)')
    info.ready = readyVal === true

    const isStatic = info.staticImgs > 0 || info.staticStage
    console.log(`  渲染器：${isStatic ? '静态立绘' : 'Live2D'}`)
    console.log(`  petModel 方法数=${info.keys}  ready=${info.ready}  emotion=${info.emotion}`)
    console.log(`  静态立绘 DOM：img=${info.staticImgs} stage=${info.staticStage}`)
    console.log(`  Live2D canvas 显示中=${info.canvasShown}`)
    const uiNames = Object.keys(info.ui).filter((k) => k !== 'bodyChildren')
    console.log(
      '  界面骨架：' + uiNames.map((k) => k + '=' + (info.ui[k] ? '在' : '没了')).join('  '),
    )
    if (info.errorShown) console.log(`  ⚠️ 错误浮层：${info.errorText}`)

    if (info.errorShown) fail('界面显示了错误浮层', info.errorText || '（浮层文字是空的 —— 可能元素已经被删掉了）')
    else ok('没有错误浮层')
    if (info.hasModel && info.keys > 0) ok(`window.petModel 就绪（${info.keys} 个成员）`)
    else fail('window.petModel 不存在或为空')
    if (info.ready) ok('ready 解析为 true')
    else fail('ready 不是 true', '模型/立绘没加载成功')

    // 界面骨架 —— 渲染器切换最容易悄悄搞坏的东西
    const missingUi = Object.entries(info.ui).filter(([k, v]) => k !== 'bodyChildren' && !v)
    if (!missingUi.length) ok('界面骨架完整（输入栏 / 对话 / 历史 / 字幕都在）')
    for (const [k] of missingUi) {
      fail(`界面元素被删掉了：${k}`, '渲染器初始化时把不属于自己的 DOM 清掉了')
    }

    // 当前用哪种，就检查那种的特征
    if (page.url.includes('renderer=static')) {
      if (isStatic) ok('静态立绘真的建起来了（DOM 里有 stage + img）')
      else fail('URL 要静态立绘，但 DOM 里没有静态立绘节点')
      if (!info.canvasShown) ok('Live2D 的空画布已隐藏')
      else fail('Live2D 画布还显示着', '会和立绘叠在一起')
    } else if (info.canvasShown) {
      ok('Live2D 画布正常显示')
    } else {
      fail('Live2D 模式下画布被隐藏了')
    }
    ws.close()
  }
}

console.log(`\n${bad ? `❌ ${bad} 项问题` : '✅ 两个渲染器接口一致'}`)
process.exit(bad ? 1 : 0)
