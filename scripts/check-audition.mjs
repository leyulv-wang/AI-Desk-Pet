/**
 * 检查试听页是不是完整的：页面上引用的每个音频文件是否真的存在。
 * 跑法：node scripts/check-audition.mjs
 *
 * 为什么需要：页面是「先合成、最后一次性写出 HTML」的，
 * 如果中途被打断，HTML 和磁盘上的 wav 可能对不上 —— 页面上有按钮但点了没声音。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, '.userdata-dev', 'audition')
const HTML = join(DIR, 'index.html')

if (!existsSync(HTML)) {
  console.log('还没有试听页（.userdata-dev/audition/index.html 不存在）')
  process.exit(0)
}

const html = readFileSync(HTML, 'utf8')
const srcs = [...html.matchAll(/<audio[^>]*src="([^"]+)"/g)].map((m) => m[1])
const uniq = [...new Set(srcs)]

const cards = [...html.matchAll(/<h2>候选\s*(\d+)/g)].length

console.log(`页面里 ${cards} 条候选，${srcs.length} 个音频元素（去重 ${uniq.length}）`)

const missing = uniq.filter((s) => !existsSync(join(DIR, s)))
const onDisk = existsSync(join(DIR, 'wav')) ? readdirSync(join(DIR, 'wav')).filter((f) => f.endsWith('.wav')) : []

console.log(`磁盘上实际有 ${onDisk.length} 个 wav`)

// 关键检查：每条候选的音频是不是真的不一样？
//
// 曾经踩过：候选是从**整个数据集**里挑的，而 tts.speak() 只能用
// assets/voice/library.json 里的参考（refId 查不到就回落到 sticky），
// 结果 6 条候选全部用了同一条参考 —— 页面上 6 张卡片听起来一模一样，
// 这份「试听页」毫无意义。所以必须逐条比对音频文件名。
console.log('\n每条候选实际用到的音频：')
const cardHtml = [...html.matchAll(/<section class="card">([\s\S]*?)<\/section>/g)].map((m) => m[1])
const perCard = cardHtml.map((c, i) => {
  const id = (c.match(/class="id">([^<]+)/) || [])[1]
  const list = [...c.matchAll(/<audio[^>]*src="([^"]+)"/g)].map((m) => m[1])
  console.log(`  候选${i + 1} ${id}  →  ${list.map((s) => s.replace(/^wav\//, '').replace(/\.wav$/, '').slice(0, 8)).join('  ')}`)
  return list.join('|')
})

const distinct = new Set(perCard).size
if (distinct < perCard.length) {
  console.log(`\n⚠️ ${perCard.length} 条候选里只有 ${distinct} 种不同的音频组合 —— **有候选是重复的**。`)
  console.log('   很可能是候选不在 library.json 里，refId 查不到、回落到同一条参考。')
  console.log('   这份试听页没法用来挑，需要修 audition-ref.mjs 再重新生成。')
} else {
  console.log('\n✅ 每条候选的音频都不同，可以横向对比')
}

if (missing.length) {
  console.log(`\n❌ 缺失 ${missing.length}/${uniq.length} 个：`)
  for (const m of missing.slice(0, 8)) console.log(`   ${m}`)
  if (missing.length > 8) console.log(`   …还有 ${missing.length - 8} 个`)
  console.log('\n→ 页面是**残缺**的：大部分试听按钮点了没声音。' + '\n   重新生成（需要语音服务在跑）：node scripts/audition-ref.mjs 6')
} else {
  console.log('\n✅ 页面完整，可以直接用浏览器打开听')
}

// 最后写出来的时间，用来判断是不是旧版本
const st = readFileSync(HTML)
console.log(`\n页面路径：${HTML}`)
console.log(`大小：${(st.length / 1024).toFixed(1)} KB`)
