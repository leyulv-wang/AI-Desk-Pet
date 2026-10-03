/**
 * 探针：MiniMax 的音乐（翻唱）接口在这台机器、这个账号上到底能不能用。
 *
 * 为什么要单独写一个探针，而不是直接接进桌宠：
 *   MiniMax 官方文档里有一条服务调整公告 —— 音乐类接口对**新用户已经关闭**，
 *   免费的 music-cover-free 也标了停用。所以「接口存在」和「你能调」是两件事，
 *   必须用真实 key 打一次才知道，不能靠文档推断。
 *
 *   node scripts/probe-minimax-music.mjs
 *   node scripts/probe-minimax-music.mjs --audio "songs/某首歌.wav"
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 从 config.json 取 key。找不到就看环境变量 */
function loadKey() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
    const k = cfg?.tts?.minimax?.apiKey
    if (k && String(k).trim()) return { key: String(k).trim(), from: 'config.json' }
  } catch { /* 忽略 */ }
  const env = (process.env.MINIMAX_API_KEY || '').trim()
  if (env) return { key: env, from: '环境变量 MINIMAX_API_KEY' }
  return null
}

const argv = process.argv.slice(2)
const audioArg = (() => {
  const i = argv.indexOf('--audio')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--audio='))
  return eq ? eq.slice('--audio='.length) : null
})()

const audioPath = resolve(ROOT, audioArg || 'songs/测试曲-合成.wav')
if (!existsSync(audioPath)) {
  console.error(`找不到参考音频：${audioPath}\n用 --audio 指定一个 6 秒~6 分钟的带唱音频。`)
  process.exit(1)
}

const k = loadKey()
if (!k) {
  console.error('没找到 MiniMax API Key（config.json 的 tts.minimax.apiKey 或环境变量 MINIMAX_API_KEY）')
  process.exit(1)
}

const bytes = readFileSync(audioPath)
const b64 = bytes.toString('base64')
console.log('=== MiniMax 音乐接口探针 ===')
console.log(`Key      ${k.from}（${k.key.slice(0, 8)}…）`)
console.log(`参考音频 ${audioPath}（${(bytes.length / 1024 / 1024).toFixed(2)} MB）`)
console.log('')

/** 同时试国内站和国际站 —— 这个 key 是哪一家的只有打一次才知道 */
const BASES = [
  ['国内 api.minimaxi.com', 'https://api.minimaxi.com/v1'],
  ['国际 api.minimax.io', 'https://api.minimax.io/v1'],
]

/**
 * 打一次 music_cover_preprocess。
 *
 * 只看两件事：接口存不存在（404 vs 200/业务错误码）、账号有没有权限。
 * 所以哪怕返回的是业务错误也是有价值的 —— 那证明路由是通的。
 */
async function probePreprocess(base) {
  const body = { model: 'music-cover', audio_base64: b64 }
  const res = await fetch(`${base}/music_cover_preprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k.key}` },
    body: JSON.stringify(body),
  })
  const text = await res.text().catch(() => '')
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, text, json }
}

for (const [label, base] of BASES) {
  console.log(`--- ${label} ---`)
  try {
    const r = await probePreprocess(base)
    console.log(`HTTP ${r.status}`)
    if (r.json) {
      const br = r.json.base_resp
      if (br) console.log(`base_resp: ${br.status_code} ${br.status_msg || ''}`)
      if (r.json.cover_feature_id) {
        console.log(`✅ 通了！cover_feature_id = ${r.json.cover_feature_id}`)
        console.log(`   时长 ${r.json.audio_duration}s`)
        console.log(`   ASR 歌词：${String(r.json.formatted_lyrics || '').slice(0, 120).replace(/\n/g, ' / ')}`)
      } else if (r.json.data) {
        console.log(`data: ${JSON.stringify(r.json.data).slice(0, 200)}`)
      }
    } else {
      console.log(`原始返回：${r.text.slice(0, 300)}`)
    }
  } catch (e) {
    console.log(`请求失败：${e.name}: ${e.message}`)
  }
  console.log('')
}

console.log('判读方式：')
console.log('  · 200 + cover_feature_id  → 接口可用，可以直接做「上传原曲→翻唱」')
console.log('  · 404 / 路由不存在        → 这家站点没有音乐接口')
console.log('  · base_resp 提示无权限/需付费 → 接口在，但你的账号用不了（文档里那条关闭公告）')
console.log('  · 请求失败（超时/DNS）    → 网络到不了')
