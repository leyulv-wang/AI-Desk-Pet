/**
 * 在 DSH 会话日志里按内容定位：某段文字落在 text 还是 reasoning 通道
 *   node scripts/where-is-text.mjs "要搜的短语"
 *
 * 这是「markdown 不渲染」的**决定性判据**：
 * 用户截图里那段正文如果出现在 reasoning 块里，就是模型把答案塞进了思考通道；
 * 如果在 text 块里，那渲染层才有问题。
 *
 * （前一版按「含 markdown 标记」统计不可靠 —— 思考里本来就常有 ** 和反引号。）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const splitFrames = (buf) => {
  const idx = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    idx.push(i)
    i += 4
  }
  return idx.map((s, n) => buf.subarray(s, idx[n + 1] ?? buf.length))
}

const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions', '--D-project-Personal_assistant--')
const all = readdirSync(dir).filter((d) => existsSync(join(dir, d, 'session.v3.jsonl.zstd')))
all.sort((a, b) => statSync(join(dir, b, 'session.v3.jsonl.zstd')).mtimeMs - statSync(join(dir, a, 'session.v3.jsonl.zstd')).mtimeMs)
const file = join(dir, all[0], 'session.v3.jsonl.zstd')

const needles = process.argv.slice(2)
if (!needles.length) needles.push('大量免费素材包', '你把素材丢进', '本轮文件改动')

const buf = readFileSync(file)
const events = []
for (const f of splitFrames(buf)) {
  try {
    const t = zlib.zstdDecompressSync(f).toString('utf8')
    for (const line of t.split('\n')) if (line.trim()) events.push(JSON.parse(line))
  } catch {
    /* 坏帧跳过 */
  }
}

// 收集所有 content block（带来源事件类型，便于回溯）
const blocks = []
const walk = (n, evType) => {
  if (n === null || typeof n !== 'object') return
  if (Array.isArray(n)) return n.forEach((x) => walk(x, evType))
  if (typeof n.type === 'string' && typeof n.text === 'string' && n.text.length && (n.type === 'text' || n.type === 'reasoning')) {
    blocks.push({ type: n.type, text: n.text, evType })
  }
  for (const k of Object.keys(n)) walk(n[k], evType)
}
for (const ev of events) walk(ev, ev.type)

console.log(`事件 ${events.length} 个，内容块 ${blocks.length} 个（text ${blocks.filter((b) => b.type === 'text').length} / reasoning ${blocks.filter((b) => b.type === 'reasoning').length}）\n`)

for (const needle of needles) {
  const hits = blocks.filter((b) => b.text.includes(needle))
  console.log(`=== 搜「${needle}」→ 命中 ${hits.length} 个块 ===`)
  if (!hits.length) {
    console.log('  （没找到 —— 日志可能不含完整正文，或该内容已被压缩）\n')
    continue
  }
  for (const h of hits.slice(-3)) {
    const i = h.text.indexOf(needle)
    console.log(`  通道 = ${h.type === 'reasoning' ? '⚠️ reasoning（思考）' : '✅ text（正文）'}  块长 ${h.text.length} 字  事件 ${h.evType}`)
    console.log(`    上下文：…${h.text.slice(Math.max(0, i - 60), i + 80).replace(/\n/g, '⏎')}…`)
  }
  console.log('')
}
