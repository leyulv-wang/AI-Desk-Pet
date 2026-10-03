/**
 * 探测可用的「语音情绪识别」方案
 *   node scripts/probe-emotion.mjs
 *
 * 目标：给 1139 条参考音频各打一个情绪标签，供运行时按语气匹配。
 *
 * 三条候选路线：
 *   A. SenseVoice（音频 → 文本 + 情绪 + 事件）—— 硅基流动托管
 *   B. 用 LLM 给「转写文本」打情绪标签 —— 便宜快，但看不到说话方式
 *   C. 本地 librosa 类声学特征 —— 不需要模型，但只能粗略分（高能量/低能量）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
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

const SF = grab('EMBEDDING_API_KEY')
const DS = grab('DEEPSEEK_API_KEY')

const SAMPLE = 'D:\\project\\Personal_assistant\\desktop-pet\\assets\\voice\\ref1.wav'
const SAMPLE_ALT = 'D:\\下载\\原神语音包\\Furina\\9748118594ebf75c.wav'
const audioPath = existsSync(SAMPLE) ? SAMPLE : SAMPLE_ALT

console.log(`样本音频: ${audioPath}`)
console.log(`  ${
  existsSync(audioPath) ? (statSync(audioPath).size / 1024).toFixed(0) + ' KB' : '不存在'
}\n`)

// ---------------------------------------------------------------- A. SenseVoice
console.log('=== A. 硅基流动 SenseVoiceSmall（音频→文本+情绪）===')
if (!SF) {
  console.log('  没有 SiliconFlow Key，跳过')
} else {
  const buf = readFileSync(audioPath)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'sample.wav')
  form.append('model', 'FunAudioLLM/SenseVoiceSmall')

  for (const url of [
    'https://api.siliconflow.cn/v1/audio/transcriptions',
  ]) {
    try {
      const t0 = Date.now()
      const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${SF}` }, body: form })
      const ms = Date.now() - t0
      const text = await res.text()
      console.log(`  POST ${url.replace('https://api.siliconflow.cn', '')}  → ${res.status}  ${ms}ms`)
      console.log(`  ${text.slice(0, 500)}`)
    } catch (e) {
      console.log(`  失败: ${e.message}`)
    }
  }

  // 也试试 OpenAI 兼容的 audio/transcriptions 带额外参数
  try {
    const buf2 = readFileSync(audioPath)
    const f2 = new FormData()
    f2.append('file', new Blob([buf2], { type: 'audio/wav' }), 'sample.wav')
    f2.append('model', 'FunAudioLLM/SenseVoiceSmall')
    const res = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SF}` },
      body: f2,
    })
    console.log(`\n  原始响应头: ${JSON.stringify([...res.headers.entries()].slice(0, 5))}`)
  } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- B. LLM 打标签
console.log('\n=== B. LLM 给转写文本打情绪标签（对照组）===')
if (!DS) {
  console.log('  没有 DeepSeek Key，跳过')
} else {
  const t0 = Date.now()
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS}` },
    body: JSON.stringify({
      model: 'deepseek-flash',
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content:
            '你是情绪分类器。给每句话打一个语气标签，只能从这些里选：' +
            '开心/生气/悲伤/惊讶/害怕/厌恶/平静/得意/温柔/无奈。' +
            '输入是 JSON 数组，输出也是 JSON 数组，每项 {"i":序号,"e":"标签"}。只输出 JSON。',
        },
        {
          role: 'user',
          content: JSON.stringify([
            { i: 0, t: '呵呵，审判你们的理由当然有，而且显而易见吧？' },
            { i: 1, t: '太「普通」了！哼，这种缺乏特色的料理得不到我的认可！' },
            { i: 2, t: '我…我怎么知道会出现这种情况…不要盯着我看了…' },
            { i: 3, t: '或许我也曾向往过这种力量，但那更像是一种讽刺。' },
            { i: 4, t: '琳妮特的表演也是，完全超出了我的预期。' },
          ]),
        },
      ],
    }),
  })
  const j = await res.json()
  console.log(`  HTTP ${res.status}  ${Date.now() - t0}ms`)
  console.log(`  ${j.choices?.[0]?.message?.content?.slice(0, 400)}`)
  console.log(`  usage: ${JSON.stringify(j.usage)}`)
  console.log(`\n  5 条约 ${j.usage?.total_tokens} token → 1139 条约 ${Math.round((j.usage?.total_tokens || 0) / 5 * 1139)} token`)
}

// ---------------------------------------------------------------- C. 声学特征
console.log('\n=== C. 纯声学特征（不需要任何模型/网络）===')
console.log('  可以从 wav 直接算：RMS 能量、过零率、基频范围、语速（音节密度）')
console.log('  优点：零成本、离线、不受转写质量影响')
console.log('  缺点：只能分出「激动/平静/低沉」这种粗粒度，分不出「生气」和「开心」')
