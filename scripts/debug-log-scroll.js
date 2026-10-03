/**
 * 量一下聊天日志的滚动状态 —— 为什么回放完没滚到底
 *   npx electron . --js-file=scripts/debug-log-scroll.js --js-delay=6000
 *
 * 注意：--js-file 只会打印这个脚本的**返回值**（`[js] ...`），
 * 里面的 console.log 会走渲染层控制台，不在 --dev 模式下看不到。
 *
 * 而且主进程是用 `(async () => { <你的代码> })()` 包的 ——
 * 所以**不能自己再包一层 IIFE**：那样返回值只到内层函数就丢了，
 * 外面拿到的是 undefined。直接写顶层语句，最后 `return` 就行。
 */
const out = []
const log = document.getElementById('chat-log')

if (!log) {
  return '找不到 #chat-log'
}

const msgs = [...log.querySelectorAll('.msg')]
const cs = getComputedStyle(log)

out.push('=== #chat-log ===')
out.push(`display=${cs.display} dir=${cs.flexDirection} overflowY=${cs.overflowY} minHeight=${cs.minHeight}`)
out.push(`scrollTop=${log.scrollTop} scrollHeight=${log.scrollHeight} clientHeight=${log.clientHeight}`)
out.push(`可滚动=${log.scrollHeight > log.clientHeight} 可滚距离=${log.scrollHeight - log.clientHeight}`)

const parent = log.parentElement
const pcs = getComputedStyle(parent)
out.push(`=== 父元素 ${parent.id || parent.className} ===`)
out.push(`display=${pcs.display} overflow=${pcs.overflow} 高=${Math.round(parent.getBoundingClientRect().height)}`)

out.push(`=== 气泡（最后 3 个，共 ${msgs.length}）===`)
for (const m of msgs.slice(-3)) {
  const s = getComputedStyle(m)
  out.push(
    `  ${m.className} offsetH=${m.offsetHeight} scrollH=${m.scrollHeight} ` +
      `flex=${s.flexGrow}/${s.flexShrink}/${s.flexBasis} overflow=${s.overflow} minH=${s.minHeight} ` +
      `文本="${(m.textContent || '').slice(0, 16)}"`
  )
}

const last = msgs[msgs.length - 1]
if (last) {
  const r = last.getBoundingClientRect()
  const lr = log.getBoundingClientRect()
  out.push('=== 位置 ===')
  out.push(`最后气泡 top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} 高=${Math.round(r.height)}`)
  out.push(`日志视口 top=${Math.round(lr.top)} bottom=${Math.round(lr.bottom)} 高=${Math.round(lr.height)}`)
  out.push(`气泡完整可见=${r.bottom <= lr.bottom + 1 && r.top >= lr.top - 1}`)
}

const before = log.scrollTop
log.scrollTop = log.scrollHeight
out.push('=== 手动滚底 ===')
out.push(`之前=${before} 之后=${log.scrollTop}（上限 ${log.scrollHeight - log.clientHeight}）`)

return out.join('\n')
