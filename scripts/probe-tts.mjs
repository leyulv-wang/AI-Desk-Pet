/**
 * 探测语音合成 API 的可用性。
 *   node scripts/probe-tts.mjs
 *
 * 重点看两件事：
 *   1) 你现有的 Key 能不能直接调 TTS（省掉本地跑模型）
 *   2) 支不支持「上传参考音频克隆音色」（这是"角色音色"的硬需求）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function regVar(name) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    })
    const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch { return null }
}
function dshCred(name) {
  const p = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  if (!existsSync(p)) return null
  try {
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm'))
    return m ? m[1].replace(/^["']|["']$/g, '') : null
  } catch { return null }
}
const grab = (n) => process.env[n] || regVar(n) || dshCred(n)

const SF_KEY = grab('EMBEDDING_API_KEY') || grab('SILICONFLOW_API_KEY')

console.log('=== 1. 硅基流动有哪些音频模型 ===')
if (!SF_KEY) {
  console.log('  没有 SiliconFlow Key，跳过')
} else {
  try {
    const res = await fetch('https://api.siliconflow.cn/v1/models?sub_type=text-to-speech', {
      headers: { Authorization: `Bearer ${SF_KEY}` },
    })
    console.log('  HTTP', res.status)
    if (res.ok) {
      const j = await res.json()
      const list = j.data || []
      console.log(`  共 ${list.length} 个 TTS 模型：`)
      for (const m of list) console.log(`    · ${m.id}`)
    } else {
      console.log('  ', (await res.text()).slice(0, 200))
    }
  } catch (e) {
    console.log('  失败:', e.message)
  }

  // 顺便把全部模型里带 audio / speech / voice 的挑出来
  try {
    const res = await fetch('https://api.siliconflow.cn/v1/models', {
      headers: { Authorization: `Bearer ${SF_KEY}` },
    })
    if (res.ok) {
      const j = await res.json()
      const all = (j.data || []).map((m) => m.id)
      const audio = all.filter((id) => /tts|speech|voice|audio|cosy|fish|index|vits|sovits/i.test(id))
      console.log(`\n  全部模型 ${all.length} 个，其中像音频的 ${audio.length} 个：`)
      for (const id of audio) console.log(`    · ${id}`)
    }
  } catch { /* 忽略 */ }
}

console.log('\n=== 2. 试一次最基础的 TTS 调用 ===')
if (SF_KEY) {
  const candidates = ['FunAudioLLM/CosyVoice2-0.5B', 'fishaudio/fish-speech-1.5']
  for (const model of candidates) {
    try {
      const t0 = Date.now()
      const res = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SF_KEY}` },
        body: JSON.stringify({
          model,
          input: '你好呀，我是你的桌面小宠物。',
          voice: 'alloy',
          response_format: 'mp3',
        }),
      })
      const ms = Date.now() - t0
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        console.log(`  ✅ ${model}  ${res.status}  ${ms}ms  ${(buf.length / 1024).toFixed(1)} KB`)
      } else {
        console.log(`  ✗  ${model}  ${res.status}  ${(await res.text()).slice(0, 160)}`)
      }
    } catch (e) {
      console.log(`  ✗  ${model}  ${e.message}`)
    }
  }
}

console.log('\n=== 3. 其他家的 Key 有没有 ===')
for (const n of ['MINIMAX_API_KEY', 'MINIMAX_GROUP_ID', 'VOLC_ACCESSKEY', 'ARK_API_KEY', 'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'ELEVENLABS_API_KEY', 'FISH_AUDIO_API_KEY', 'AZURE_SPEECH_KEY']) {
  const v = grab(n)
  if (v) console.log(`  · ${n} 有（${v.slice(0, 6)}…${v.slice(-4)}）`)
}
console.log('  （没列出来的就是没有）')
