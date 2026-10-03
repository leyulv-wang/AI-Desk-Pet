/**
 * 深入探测硅基流动的 TTS：预置音色 + 音色克隆能力
 *   node scripts/probe-tts-voices.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function regVar(n) {
  try {
    const o = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', n], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    const m = o.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/); return m ? m[1].trim() : null
  } catch { return null }
}
function dshCred(n) {
  const p = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(p)) return null
  const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${n}\\s*:\\s*(\\S+)\\s*$`, 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}
const grab = (n) => process.env[n] || regVar(n) || dshCred(n)
const KEY = grab('EMBEDDING_API_KEY')
const BASE = 'https://api.siliconflow.cn/v1'
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }

async function speech(model, voice, extra = {}) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model, input: '你好呀，我是你的桌面小宠物。', voice, response_format: 'mp3', ...extra }),
  })
  const ms = Date.now() - t0
  if (res.ok) {
    const b = Buffer.from(await res.arrayBuffer())
    return { ok: true, ms, kb: b.length / 1024, buf: b }
  }
  return { ok: false, ms, err: `${res.status} ${(await res.text()).slice(0, 140)}` }
}

console.log('=== 1. CosyVoice2 的预置音色 ===')
const PRESETS = [
  'alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana',
  'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer',
  'FunAudioLLM/CosyVoice2-0.5B:alex',
]
let good = null
for (const v of PRESETS) {
  const r = await speech('FunAudioLLM/CosyVoice2-0.5B', v)
  if (r.ok) {
    console.log(`  ✅ voice="${v}"  ${r.ms}ms  ${r.kb.toFixed(1)} KB`)
    if (!good) good = v
  } else {
    console.log(`  ✗  voice="${v}"  ${r.err.slice(0, 80)}`)
  }
}

console.log('\n=== 2. 音色克隆：上传参考音频 ===')
// 硅基流动的音色上传端点
const endpoints = [
  ['POST', '/uploads/audio/voice'],
  ['POST', '/audio/voice'],
  ['GET', '/audio/voice/list'],
]
for (const [method, path] of endpoints) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: method === 'POST' ? { Authorization: `Bearer ${KEY}` } : { Authorization: `Bearer ${KEY}` },
    })
    const t = (await res.text()).slice(0, 160)
    console.log(`  ${method} ${path} → ${res.status}  ${t.replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`  ${method} ${path} → ERR ${e.message}`)
  }
}

console.log('\n=== 3. MOSS-TTSD 试一下 ===')
for (const v of ['alloy', 'david', 'alex']) {
  const r = await speech('fnlp/MOSS-TTSD-v0.5', v)
  console.log(`  voice="${v}" → ${r.ok ? `✅ ${r.ms}ms ${r.kb.toFixed(1)}KB` : '✗ ' + r.err.slice(0, 90)}`)
}

console.log('\n=== 4. 用阿里百炼试 CosyVoice（另一条路）===')
const ALI = grab('ALIYUN_API_KEY')
if (!ALI) {
  console.log('  没有阿里 Key')
} else {
  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ALI}` },
    body: JSON.stringify({ model: 'cosyvoice-v2', input: '你好呀', voice: 'longxiaochun_v2' }),
  })
  console.log(`  cosyvoice-v2 → ${res.status}  ${(await res.text()).slice(0, 200).replace(/\s+/g, ' ')}`)
}

if (good) {
  console.log(`\n可用音色示例：${good}`)
}
