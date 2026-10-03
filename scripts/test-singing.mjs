/**
 * 唱歌链路端到端自检。
 *
 * 接线检查（check-wiring.mjs）只能验证「函数名对得上」，验证不了「真能唱出来」。
 * 这个脚本把 src/singing.js 当成主进程那样调一遍，走完整条链：
 *
 *     歌曲 → Python 管线 → 分离 → DDSP 转换 → 混音 → meta.json → 缓存命中
 *
 * 用法：
 *     node scripts/test-singing.mjs                      # 用 songs/ 里第一个音频
 *     node scripts/test-singing.mjs --song "D:\x.mp3"    # 指定（会自动复制进 songs/）
 *     node scripts/test-singing.mjs --force              # 跳过缓存重跑
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const { createSinging } = require(path.join(ROOT, 'src', 'singing.js'))

const argv = process.argv.slice(2)
const argOf = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const force = argv.includes('--force')
const userDataDir = path.join(ROOT, '.userdata-dev')
fs.mkdirSync(userDataDir, { recursive: true })

const sing = createSinging({
  root: ROOT,
  userDataDir,
  config: {},
  log: (m) => console.log(`  ${m}`),
})

// ---------------------------------------------------------------- 挑一首歌
// singing.js 只认 songs/ 下的文件名（挡掉路径穿越），所以外部文件要先拷进去。
const songsDir = path.join(ROOT, 'songs')
let file = argOf('--song')
if (file) {
  file = path.basename(file)
  if (!fs.existsSync(path.join(songsDir, file))) {
    const abs = path.resolve(argOf('--song'))
    if (!fs.existsSync(abs)) {
      console.error(`找不到：${argOf('--song')}`)
      process.exit(1)
    }
    fs.mkdirSync(songsDir, { recursive: true })
    fs.copyFileSync(abs, path.join(songsDir, file))
    console.log(`已复制到 songs/${file}`)
  }
} else {
  const list = sing.listSongs()
  if (!list.length) {
    console.error(`songs/ 里没有音频：${songsDir}`)
    process.exit(1)
  }
  file = list[0].file
  console.log(`songs/ 里第一首：${file}`)
}

// ---------------------------------------------------------------- 1) 体检
console.log('\n=== 1) 环境体检 ===')
const env = sing.probe()
console.log(`  ok=${env.ok}  ${env.detail}`)
if (!env.ok) {
  console.error('  环境不过，后续会失败')
  process.exit(1)
}

// ---------------------------------------------------------------- 2) 起任务
console.log(`\n=== 2) 起任务${force ? '（--force 跳过缓存）' : ''}：${file} ===`)
const t0 = Date.now()
let seen = ''
const res = await sing.start({
  file,
  force,
  onProgress: (p) => {
    const line = `${String(p.pct).padStart(3)}%  ${p.stage}`
    if (line !== seen) {
      seen = line
      console.log(`  ${line}`)
    }
  },
})
const ms = Date.now() - t0

// ---------------------------------------------------------------- 3) 结果
console.log('\n=== 3) 结果 ===')
if (!res.ok) {
  console.error(`  ❌ 失败：${res.error}`)
  process.exit(1)
}
console.log(`  ok=${res.ok}  cached=${res.cached === true}  总耗时 ${(ms / 1000).toFixed(1)}s`)
console.log(`  key=${res.key}`)

const r = res.result
if (r) {
  console.log(`  成品  ${r.url}`)
  console.log(`  口型  ${r.mouthUrl ?? '（无 → 嘴不会动）'}`)
  console.log(`  目录  ${r.dir}`)
  for (const f of ['mixed.wav', 'vocal_converted.wav', 'vocal_raw.wav', 'accompaniment.wav', 'meta.json']) {
    const p = path.join(r.dir, f)
    const ok = fs.existsSync(p) && fs.statSync(p).size > 0
    console.log(`  ${ok ? '✅' : '❌'} ${f.padEnd(20)} ${ok ? (fs.statSync(p).size / 1e6).toFixed(2) + ' MB' : ''}`)
    if (!ok) process.exitCode = 1
  }
  const m = r.meta ?? {}
  console.log(`  meta  engine=${m.engine} voice=${m.voice} spkId=${m.spkId} seed=${m.seed} dur=${m.duration}s`)
  if (!r.mouthUrl) {
    console.error('  ❌ mouthUrl 为空 —— 桌宠唱歌时嘴不会动')
    process.exitCode = 1
  }
} else {
  console.error('  ❌ 没有 result 对象')
  process.exitCode = 1
}

// ---------------------------------------------------------------- 4) 缓存
console.log('\n=== 4) 再跑一次（应命中缓存，不启 Python）===')
const t1 = Date.now()
const res2 = await sing.start({ file })
const ms2 = Date.now() - t1
console.log(`  cached=${res2.cached === true}  耗时 ${ms2}ms`)
if (res2.cached !== true) {
  console.error('  ❌ 没命中缓存 —— meta.json 大概没写成功')
  process.exitCode = 1
} else if (ms2 > 3000) {
  console.error('  ⚠️ 命中了但 >3s，可能没走纯缓存路径')
} else {
  console.log('  ✅ 缓存路径正常（毫秒级）')
}

console.log(`\n${process.exitCode ? '❌ 有失败项' : '✅ 唱歌链路端到端通过'}`)
