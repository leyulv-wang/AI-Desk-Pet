/**
 * 把 library.json 里挑中的 24 条参考音频「收进项目里」。
 *   node scripts/vendor-voice-clips.mjs
 *
 * 为什么要这一步：
 * library.json 原来只记了源数据集里的文件名，音频还在 <语音包目录>\Furina。
 * 那个目录哪天清理掉 / 挪走，桌宠就哑了。24 条 wav 加起来才 2 MB 左右，
 * 直接复制进 assets/voice/clips/ 更省心，顺便让 pet:// 能直接喂给渲染层。
 *
 * 幂等：同 id 已存在且大小一致就跳过。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'assets', 'voice', 'library.json')
const OUT_DIR = join(ROOT, 'assets', 'voice', 'clips')

const lib = JSON.parse(readFileSync(LIB, 'utf8'))
const src = lib.source
mkdirSync(OUT_DIR, { recursive: true })

let copied = 0
let skipped = 0
const problems = []

for (const clip of lib.clips) {
  const from = join(src, `${clip.id}.wav`)
  const rel = `clips/${clip.id}.wav`
  const to = join(OUT_DIR, `${clip.id}.wav`)

  if (!existsSync(from)) {
    problems.push(`${clip.id} 源文件不见了：${from}`)
    continue
  }

  if (existsSync(to) && statSync(to).size === statSync(from).size) {
    skipped++
  } else {
    copyFileSync(from, to)
    copied++
  }

  // 保留出处，方便以后想换/想扩库时回溯
  clip.file = rel
  clip.srcFile = `${clip.id}.wav`
}
if (problems.length) {
  console.error('有文件对不上，先别改 library.json：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

// 清掉不再被引用的旧音频 —— 重建库之后如果不清理，
// clips/ 会越攒越多（每条约 0.5 MB），而且容易误以为它们还在用
const keep = new Set(lib.clips.map((c) => `${c.id}.wav`))
let removed = 0
for (const f of readdirSync(OUT_DIR)) {
  if (f.endsWith('.wav') && !keep.has(f)) {
    unlinkSync(join(OUT_DIR, f))
    removed++
  }
}

lib.vendoredAt = new Date().toISOString()
lib.vendorDir = 'assets/voice/clips'
writeFileSync(LIB, JSON.stringify(lib, null, 2) + '\n', 'utf8')

const total = lib.clips.reduce((a, c) => a + statSync(join(OUT_DIR, `${c.id}.wav`)).size, 0)
console.log(`复制 ${copied} 条，已存在跳过 ${skipped} 条，清掉失效的 ${removed} 条`)
console.log(`收进 assets/voice/clips/ 共 ${lib.clips.length} 条，${(total / 1024 / 1024).toFixed(2)} MB`)
console.log('library.json 已改指向 clips/<id>.wav')
