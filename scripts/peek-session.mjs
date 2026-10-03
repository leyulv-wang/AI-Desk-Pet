/**
 * 在 DSH 会话日志里搜「思考块」和「正文块」的实际结构
 *   node scripts/peek-session.mjs [会话文件]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'session_projcache', 'sessions')
let file = process.argv[2]
if (!file) {
  const all = readdirSync(dir).filter((f) => f.endsWith('.json'))
  all.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
  file = join(dir, all[0])
}
const text = readFileSync(file, 'utf8')
console.log(`会话文件：${file}  (${(text.length / 1024).toFixed(0)} KB)\n`)

for (const needle of ['"reasoning"', '"kind":"text"', '"kind": "text"', '"blocks"', 'reasoning_content']) {
  const n = text.split(needle).length - 1
  console.log(`  ${needle.padEnd(22)} 出现 ${n} 次`)
}

// 找到第一处 "reasoning" 的上下文
const i = text.indexOf('reasoning')
if (i < 0) {
  console.log('\n日志里没有 reasoning —— 说明 DSH 没把思考过程存进这个文件')
} else {
  console.log('\n=== 第一处 reasoning 附近 600 字 ===')
  console.log(text.slice(Math.max(0, i - 200), i + 400).replace(/\\n/g, '⏎'))
}

// 打印 record 的顶层形状
const raw = JSON.parse(text)
const rec = raw.record
console.log('\n=== record 的形状 ===')
if (Array.isArray(rec)) {
  console.log(`  数组，${rec.length} 项`)
  const kinds = {}
  for (const it of rec) {
    const k = it?.kind ?? it?.type ?? it?.role ?? '?'
    kinds[k] = (kinds[k] || 0) + 1
  }
  console.log('  种类分布：', JSON.stringify(kinds))
  const sample = rec.find((it) => (it?.kind ?? it?.type ?? it?.role) === 'assistant') || rec[0]
  console.log('  样例键：', Object.keys(sample || {}).join(', '))
} else if (rec && typeof rec === 'object') {
  console.log('  键：', Object.keys(rec).join(', '))
  for (const k of Object.keys(rec).slice(0, 8)) {
    const v = rec[k]
    console.log(`    ${k}: ${Array.isArray(v) ? `数组(${v.length})` : typeof v}`)
  }
}
