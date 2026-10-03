/**
 * 实测「零样本音色克隆」的完整 API 流程（硅基流动）
 *   node scripts/test-voice-clone.mjs
 *
 * 用一段音频当参考音色 → 上传建自定义音色 → 用这个音色合成新的话。
 *
 * 为了不依赖外部素材，参考音频就地用 TTS 生成一段（自产自销）——
 * 这只验证**接口链路通不通**，不代表克隆质量。
 * 真要用你的角色音色，把 ref.mp3 换成真人的干净录音即可。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
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
const MODEL = 'FunAudioLLM/CosyVoice2-0.5B'

const REF_TEXT = '你好呀，我是住在你电脑里的小伙伴，今天也要开开心心的哦。'

console.log('=== 1. 先合成一段参考音频 ===')
const t0 = Date.now()
const r1 = await fetch(`${BASE}/audio/speech`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: MODEL, input: REF_TEXT, voice: `${MODEL}:alex`, response_format: 'mp3' }),
})
if (!r1.ok) { console.log('  失败', r1.status, (await r1.text()).slice(0, 200)); process.exit(1) }
const refBuf = Buffer.from(await r1.arrayBuffer())
writeFileSync('ref-voice.mp3', refBuf)
console.log(`  ✅ ${Date.now() - t0}ms  ${(refBuf.length / 1024).toFixed(1)} KB → ref-voice.mp3`)

console.log('\n=== 2. 上传它作为自定义音色（这就是"克隆"） ===')
const form = new FormData()
form.append('file', new Blob([refBuf], { type: 'audio/mpeg' }), 'ref-voice.mp3')
form.append('model', MODEL)
form.append('customName', `pet-test-${Date.now().toString(36)}`)
form.append('text', REF_TEXT)

const t1 = Date.now()
const r2 = await fetch(`${BASE}/uploads/audio/voice`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}` },
  body: form,
})
const cloneMs = Date.now() - t1
const cloneText = await r2.text()
console.log(`  HTTP ${r2.status}  ${cloneMs}ms`)
console.log(`  响应: ${cloneText.slice(0, 300)}`)

let uri = null
try { uri = JSON.parse(cloneText).uri } catch { /* 忽略 */ }
if (!uri) {
  console.log('\n  ❌ 没拿到 uri —— 上传失败，看上面的报错')
  process.exit(1)
}
console.log(`  ✅ 自定义音色 uri = ${uri}`)

console.log('\n=== 3. 用这个自定义音色合成新的话 ===')
const NEW_TEXT = '主人你回来啦！我刚才一直在等你呢，要不要先喝口水休息一下？'
const t2 = Date.now()
const r3 = await fetch(`${BASE}/audio/speech`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: MODEL, input: NEW_TEXT, voice: uri, response_format: 'mp3' }),
})
if (!r3.ok) {
  console.log(`  ❌ ${r3.status} ${(await r3.text()).slice(0, 200)}`)
} else {
  const out = Buffer.from(await r3.arrayBuffer())
  writeFileSync('cloned-voice.mp3', out)
  console.log(`  ✅ ${Date.now() - t2}ms  ${(out.length / 1024).toFixed(1)} KB → cloned-voice.mp3`)
  console.log(`  首包耗时 ${Date.now() - t2}ms（这个数会直接加在她"开口"之前）`)
}

console.log('\n=== 4. 列出已有的自定义音色 ===')
const r4 = await fetch(`${BASE}/audio/voice/list`, { headers: { Authorization: `Bearer ${KEY}` } })
const listText = await r4.text()
console.log(`  HTTP ${r4.status}  ${listText.slice(0, 400)}`)

console.log('\n=== 5. 对比预置音色 vs 克隆音色的延迟 ===')
for (const [label, v] of [['预置 alex', `${MODEL}:alex`], ['克隆音色', uri]]) {
  const times = []
  for (let i = 0; i < 3; i++) {
    const s = Date.now()
    const r = await fetch(`${BASE}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, input: '测试一下延迟。', voice: v, response_format: 'mp3' }),
    })
    if (r.ok) { await r.arrayBuffer(); times.push(Date.now() - s) } else { times.push(-1) }
  }
  console.log(`  ${label.padEnd(10)} ${times.map((t) => (t < 0 ? 'ERR' : t + 'ms')).join(' / ')}`)
}

console.log('\n完成。ref-voice.mp3 / cloned-voice.mp3 可以直接放来听。')
