/**
 * 读 DSH 原始会话日志（多帧 zstd），统计 assistant 内容块的类型
 *   node scripts/peek-blocks.mjs
 *
 * 坑：session.v3.jsonl.zstd 是**每行一个独立 zstd 帧**拼接的，
 * zlib.zstdDecompressSync 只解第一帧（解出来是 273 字节的会话头）。
 * 所以按 zstd 魔数 28 B5 2F FD 切帧，逐帧解。
 *
 * 目的：看正文到底走的是 text 通道还是 reasoning 通道 ——
 * 「markdown 不渲染」的根因就在这（toAssistantBlock 是 1:1 映射）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function splitFrames(buf) {
  const idx = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    idx.push(i)
    i += 4
  }
  return idx.map((start, n) => buf.subarray(start, idx[n + 1] ?? buf.length))
}

const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions', '--D-project-Personal_assistant--')
let file = process.argv[2]
if (!file) {
  const all = readdirSync(dir).filter((d) => existsSync(join(dir, d, 'session.v3.jsonl.zstd')))
  all.sort((a, b) => statSync(join(dir, b, 'session.v3.jsonl.zstd')).mtimeMs - statSync(join(dir, a, 'session.v3.jsonl.zstd')).mtimeMs)
  file = join(dir, all[0], 'session.v3.jsonl.zstd')
}
const buf = readFileSync(file)
const frames = splitFrames(buf)
console.log(`会话：${file}`)
console.log(`文件 ${(buf.length / 1024 / 1024).toFixed(1)} MB，切出 ${frames.length} 帧\n`)

const events = []
for (const f of frames) {
  try {
    const t = zlib.zstdDecompressSync(f).toString('utf8')
    for (const line of t.split('\n')) if (line.trim()) events.push(JSON.parse(line))
  } catch {
    /* 坏帧跳过 */
  }
}
console.log(`解出 ${events.length} 个事件`)

// ---- 收集所有 content block
const stats = {}
const reasoningMd = []
const textMd = []
const MD = /(\*\*[^\n]+\*\*|^#{1,6}\s|\n#{1,6}\s|```|\n\s*[-*]\s)/m

const walk = (n) => {
  if (n === null || typeof n !== 'object') return
  if (Array.isArray(n)) return n.forEach(walk)
  // content block 的特征：有 type 且有 text 字段
  if (typeof n.type === 'string' && typeof n.text === 'string' && n.text.length) {
    if (n.type === 'text' || n.type === 'reasoning') {
      stats[n.type] = (stats[n.type] || 0) + 1
      if (MD.test(n.text)) (n.type === 'reasoning' ? reasoningMd : textMd).push(n.text)
    }
  }
  for (const k of Object.keys(n)) walk(n[k])
}
events.forEach(walk)

console.log('\n=== content block 类型 ===')
for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`)
console.log(`\n  含 markdown 标记的：text ${textMd.length} 个 / reasoning ${reasoningMd.length} 个`)

if (reasoningMd.length) {
  console.log(`\n⚠️ **思考块里有 markdown 标记 —— 正文被塞进了思考通道**（这就是不渲染的根因）\n`)
  const s = reasoningMd.at(-1)
  console.log(`  最后一个（${s.length} 字）：\n  ` + s.slice(0, 280).replace(/\n/g, '\n  '))
} else if (textMd.length) {
  console.log(`\n✅ 含 markdown 的正文都走 text 通道 —— 渲染层没问题\n`)
  const s = textMd.at(-1)
  console.log(`  最后一个（${s.length} 字）：\n  ` + s.slice(0, 200).replace(/\n/g, '\n  '))
} else {
  console.log('\n（日志里没找到带 markdown 的内容块 —— 可能日志不含完整正文）')
}
