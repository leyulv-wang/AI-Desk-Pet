/**
 * 静态自检：确认渲染层引用的 DOM id 都在 HTML 里存在，
 * 且 preload 暴露的 IPC 通道在主进程都有 handler。
 *   node scripts/check-wiring.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const chat = read('src/renderer/chat.js')
const pet = read('src/renderer/pet.js')
const singing = read('src/renderer/singing.js')
const html = read('src/renderer/index.html')
const preload = read('src/preload.js')
const main = read('src/main.js')

let problems = 0
const fail = (msg) => { console.log(`  ✗ ${msg}`); problems++ }
const ok = (msg) => console.log(`  ✓ ${msg}`)

// ---------------------------------------------------------------- DOM id
console.log('=== chat.js / pet.js / singing.js 引用的 DOM id ===')
const ids = new Set()
for (const src of [chat, pet, singing]) {
  for (const m of src.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1])
  for (const m of src.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1])
}
const htmlIds = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
let missingIds = 0
for (const id of [...ids].sort()) {
  if (htmlIds.has(id)) ok(id)
  else { fail(`${id} —— 代码里用了但 HTML 里没定义`); missingIds++ }
}
if (!missingIds) console.log(`  （${ids.size} 个全部命中）`)

// ---------------------------------------------------------------- IPC
console.log('\n=== preload 暴露的 IPC 通道 ===')
const invoked = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]))
const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]))
for (const c of [...invoked].sort()) {
  if (handled.has(c)) ok(c)
  else fail(`${c} —— preload 调了但主进程没实现`)
}

// ---------------------------------------------------------------- 事件
console.log('\n=== 主进程 → 渲染层 的事件 ===')
const sent = new Set([...main.matchAll(/send\('([^']+)'/g)].map((m) => m[1]))
const listened = new Set([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]))
for (const e of [...sent].sort()) {
  if (listened.has(e)) ok(e)
  else fail(`${e} —— 主进程发了但 preload 没转发`)
}
for (const e of [...listened].sort()) {
  if (!sent.has(e)) console.log(`  · ${e}（preload 监听了，主进程本次未发送）`)
}

// ---------------------------------------------------------------- preload 方法 vs chat 调用
console.log('\n=== chat.js / singing.js 调用的 window.pet.* 是否都在 preload 暴露 ===')
const exposed = new Set([...preload.matchAll(/^\s{2}([A-Za-z]\w*):/gm)].map((m) => m[1]))
const used = new Set()
for (const src of [chat, singing]) {
  for (const m of src.matchAll(/window\.pet\.([A-Za-z]\w*)/g)) used.add(m[1])
}
for (const u of [...used].sort()) {
  if (exposed.has(u)) ok(u)
  else fail(`${u} —— chat.js 调了但 preload 没暴露`)
}

console.log(problems ? `\n❌ 发现 ${problems} 处问题` : '\n✅ 接线检查全部通过')
process.exit(problems ? 1 : 0)
