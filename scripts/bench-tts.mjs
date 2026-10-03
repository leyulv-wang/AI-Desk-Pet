/**
 * GPT-SoVITS 延迟调优 —— 找出「够好听」和「够快」的平衡点
 *   node scripts/bench-tts.mjs
 *
 * 变两个量：
 *   · sample_steps（v4 的 CFM 采样步数）—— 32 是官方默认，步数越少越快
 *   · 参考音频长度                        —— 参考越长，prompt 越长，越慢
 *
 * 注意：参考音频长度不是「随便截短」就行的，
 * prompt_text 必须和音频严格对齐，硬截会把音色带歪。
 * 所以这里只测「库里已有的不同时长参考」，不做截断。
 */
import { createRequire } from 'node:module'
import { readFileSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

const OUT = join(ROOT, '.userdata-dev', 'tts-bench')
mkdirSync(OUT, { recursive: true })

const TEXT = '今天天气不错，要不要一起出去走走？'

async function timeOnce(steps, clipId, tag) {
  const tts = createTts({
    config: {
      enabled: true,
      backend: 'gptsovits',
      gptsovits: { sampleSteps: steps, speedFactor: 1.0 },
      cache: { enabled: false }, // 基准测试不吃缓存
    },
    root: ROOT,
    cacheDir: join(OUT, tag),
    resolveKey: () => null,
  })
  const r = await tts.speak({ text: TEXT, category: '平静' })
  if (!r.ok) throw new Error(r.error)

  // 用第二轮覆盖掉参考选择，强制指定参考
  const lib = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))
  const clip = lib.clips.find((c) => c.id === clipId)
  return { ms: r.ms, clip, steps }
}

console.log('=== A. sample_steps 对延迟的影响 ===\n')
console.log('（同一句文本、同一条参考，各跑 2 次取第 2 次 —— 第 1 次含预热）\n')

const stepsList = [8, 12, 16, 24, 32]
const stepRows = []
for (const s of stepsList) {
  const runs = []
  for (let i = 0; i < 2; i++) {
    const r = await timeOnce(s, '3ccfe5d9a50edb43', `steps-${s}-${i}`)
    runs.push(r)
  }
  const ms = runs[1].ms
  stepRows.push({ steps: s, ms })
  console.log(`  sample_steps=${String(s).padStart(2)}  →  ${String(ms).padStart(5)}ms`)
}

console.log('\n=== B. 参考音频长度对延迟的影响 ===\n')
console.log('（sample_steps 固定 24）\n')

const lib = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))
const byLen = lib.clips.slice().sort((a, b) => a.seconds - b.seconds)
const picks = [byLen[0], byLen[Math.floor(byLen.length / 3)], byLen[Math.floor((byLen.length * 2) / 3)], byLen[byLen.length - 1]]

const lenRows = []
for (const clip of picks) {
  const runs = []
  for (let i = 0; i < 2; i++) {
    const r = await timeOnce(24, clip.id, `len-${clip.id}-${i}`)
    runs.push(r)
  }
  const ms = runs[1].ms
  lenRows.push({ seconds: clip.seconds, chars: clip.chars, ms, id: clip.id })
  console.log(`  参考 ${clip.seconds}s / ${clip.chars}字  →  ${String(ms).padStart(5)}ms   ${clip.text.slice(0, 20)}…`)
}

console.log('\n=== 结论 ===')
const fastest = stepRows.reduce((a, b) => (a.ms < b.ms ? a : b))
console.log(`  sample_steps 从 32 → ${fastest.steps}，延迟 ${stepRows[0].ms ? '' : ''}`)
for (const r of stepRows) {
  const base = stepRows.find((x) => x.steps === 32)
  console.log(`    steps=${String(r.steps).padStart(2)}  ${String(r.ms).padStart(5)}ms  ${base && r.steps !== 32 ? `(${(((base.ms - r.ms) / base.ms) * 100).toFixed(0)}% 更快)` : ''}`)
}
console.log('\n  参考长度相关性：')
const shortest = lenRows[0]
const longest = lenRows[lenRows.length - 1]
console.log(`    最短 ${shortest.seconds}s → ${shortest.ms}ms`)
console.log(`    最长 ${longest.seconds}s → ${longest.ms}ms`)
console.log(`    每多 1 秒参考音频，大约多花 ${Math.round((longest.ms - shortest.ms) / Math.max(0.1, longest.seconds - shortest.seconds))}ms`)

console.log(`\n试听样本在 ${join(OUT)} 下，可以直接对比不同 steps 的音质。`)
