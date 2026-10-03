/**
 * 量字幕（#subtitle / .sub-line）—— 用户看到的那个「对话框」其实是它
 *   npx electron . --js-file=scripts/debug-subtitle.js --js-delay=6000
 *
 * 踩过的坑：一开始以为用户说的是聊天日志气泡（#chat-log），
 * 结果那个面板默认是**隐藏**的（offsetHeight=0），量了半天全是 0。
 * 真正显示回复的是底部字幕 .sub-line。
 *
 * --js-file 的代码会被 `(async () => { ... })()` 包起来，
 * 所以别自己再包 IIFE（返回值会丢），顶层写、最后 return。
 */
const out = []

function dump(sel, label) {
  const el = document.querySelector(sel)
  if (!el) {
    out.push(`${label} ${sel} —— 找不到`)
    return
  }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const lineH = parseFloat(cs.lineHeight) || 0
  out.push(`${label} ${sel}`)
  out.push(
    `  font-size=${cs.fontSize} line-height=${cs.lineHeight} max-height=${cs.maxHeight} overflow=${cs.overflow}`
  )
  out.push(
    `  盒子高=${Math.round(r.height)} 内容高=${el.scrollHeight} 可见高=${el.clientHeight} ` +
      `能放几行=${lineH ? (r.height / lineH).toFixed(2) : '?'}`
  )
  out.push(
    `  ⚠️ 内容被裁=${el.scrollHeight > el.clientHeight + 1}` +
      `（超出 ${Math.max(0, el.scrollHeight - el.clientHeight)}px）`
  )
  const t = (el.textContent || '').trim()
  out.push(`  文本(${t.length} 字，换行 ${(t.match(/\n/g) || []).length} 个)：`)
  for (const [i, line] of t.split('\n').entries()) out.push(`     ${i}: ${line.slice(0, 46)}`)
}

const sub = document.getElementById('subtitle')
out.push('=== #subtitle ===')
if (sub) {
  const cs = getComputedStyle(sub)
  const r = sub.getBoundingClientRect()
  out.push(`  hidden=${sub.classList.contains('hidden')} display=${cs.display} bottom=${cs.bottom}`)
  out.push(`  位置 top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} 高=${Math.round(r.height)}`)
  out.push(`  窗口高=${window.innerHeight}`)
} else {
  out.push('  找不到')
}

dump('.sub-line.pet', '=== 她说的话 ===')
dump('.sub-line.me', '=== 用户那句 ===')

return out.join('\n')
