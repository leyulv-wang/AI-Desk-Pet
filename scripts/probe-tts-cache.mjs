/**
 * 验证一个猜想：GPT-SoVITS 的参考音频特征是不是「单槽缓存」，
 * 也就是「换参考 = 每次都要重跑特征提取」。
 *   node scripts/probe-tts-cache.mjs
 *
 * 这决定了架构：如果换参考很贵，那「情绪匹配挑参考」这个功能
 * 每句都要额外付一次特征提取的钱，必须想办法把这一步藏到 LLM 生成期间去做。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createTts } = require(join(ROOT, 'src', 'tts.js'))

const lib = JSON.parse(readFileSync(join(ROOT, 'assets', 'voice', 'library.json'), 'utf8'))

function mk() {
  return createTts({
    config: { enabled: true, backend: 'gptsovits', gptsovits: { sampleSteps: 24, speedFactor: 1.05 }, cache: { enabled: false } },
    root: ROOT,
    cacheDir: join(ROOT, '.userdata-dev', 'tts-probe'),
    resolveKey: () => null,
  })
}
const tts = mk()

const TEXT = '嗯，我在听呢。'

async function run(label, ids) {
  const times = []
  for (const id of ids) {
    const r = await tts.speak({ text: TEXT, refId: id, noCache: true })
    if (!r.ok) {
      console.log(`  ${label} 失败：${r.error}`)
      return null
    }
    times.push(r.ms)
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
  console.log(`  ${label.padEnd(26)} ${times.map((t) => String(t).padStart(5)).join(' ')}   均值 ${avg}ms`)
  return { times, avg }
}

// 每条参考各跑 2 次，第 1 次是「换过去」的代价，第 2 次是「没换」的代价
const ids = lib.clips.slice(0, 4).map((c) => c.id)
const byCat = {}
for (const c of lib.clips) (byCat[c.category] = byCat[c.category] || []).push(c.id)

console.log('=== 预热（第一次调用含模型预热，丢掉）===')
await tts.speak({ text: TEXT, refId: ids[0], noCache: true })

console.log('\n=== A. 一直用同一条参考（从不切换）===')
const a = await run('同一参考 ×5', Array(5).fill(ids[0]))

console.log('\n=== B. 每条参考各用两次（切换 3 次）===')
await run('A→A B→B C→C D→D', [ids[0], ids[0], ids[1], ids[1], ids[2], ids[2], ids[3], ids[3]])

console.log('\n=== C. 每次都在换（模拟情绪在不同类别间跳）===')
const flip = []
for (let i = 0; i < 6; i++) flip.push(byCat['开心'][i % byCat['开心'].length])
await run('每次换参考 ×6', flip)

console.log('\n=== D. 同一个类别内部轮换（换参考但类别不变）===')
const rot = []
for (let i = 0; i < 6; i++) rot.push(byCat['平静'][i % byCat['平静'].length])
const d = await run('类别内轮换 ×6', rot)

console.log('\n=== 结论 ===')
if (a && d) {
  const switchCost = d.avg - a.avg
  console.log(`  不切换参考：${a.avg}ms`)
  console.log(`  每次切换：  ${d.avg}ms`)
  console.log(`  → 换一次参考大约多花 ${switchCost}ms`)
  if (switchCost > 400) {
    console.log('\n  ⚠️ 切换确实很贵。说明 prompt_cache 是单槽的（TTS.py:1092 只在 ref_audio_path 或')
    console.log('     prompt_text 变了才重算）。结论：要挑情绪参考，就得把这笔钱藏起来 ——')
    console.log('     在 LLM 还在生成回复的时候，就先用目标参考发一个极短请求把特征预热好。')
  } else {
    console.log('\n  切换开销可以忽略，不需要额外优化。')
  }
}
