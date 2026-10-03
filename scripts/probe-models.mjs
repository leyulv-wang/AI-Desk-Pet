/** 探测可用的模型名 —— 有些网关会用 deepseek-flash 这类别名 */
import { execFileSync } from 'node:child_process'

function key() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'DEEPSEEK_API_KEY'], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    })
    const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch { return null }
}

const K = key()
const BASE = 'https://api.deepseek.com/v1'

console.log('=== 1. /models 列出的可用模型 ===')
try {
  const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${K}` } })
  console.log('HTTP', r.status)
  const j = await r.json()
  for (const m of j.data || []) console.log('  -', m.id)
} catch (e) { console.log('  失败:', e.message) }

console.log('\n=== 2. 逐个试 chat/completions（正常长度）===')
for (const m of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat']) {
  const t0 = Date.now()
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${K}` },
      body: JSON.stringify({
        model: m,
        messages: [{ role: 'user', content: '用一句话介绍你自己' }],
        max_tokens: 120,
      }),
    })
    const j = await r.json()
    const ms = Date.now() - t0
    if (r.ok) {
      const c = j.choices?.[0]?.message?.content
      const reasoning = j.choices?.[0]?.message?.reasoning_content
      console.log(`  ${String(r.status).padEnd(4)} ${m.padEnd(18)} ${String(ms).padStart(5)}ms`)
      console.log(`       content  : ${JSON.stringify(c)}`)
      if (reasoning) console.log(`       reasoning: ${JSON.stringify(String(reasoning).slice(0, 60))}…`)
      console.log(`       usage    : ${JSON.stringify(j.usage)}`)
    } else {
      console.log(`  ${String(r.status).padEnd(4)} ${m.padEnd(18)} ${JSON.stringify(j.error)}`)
    }
  } catch (e) {
    console.log(`  ERR  ${m.padEnd(18)} ${e.message}`)
  }
}

console.log('\n=== 3. 抽取任务实测：能不能稳定吐 JSON ===')
const prompt = `从下面这段对话里抽取关于用户的持久事实，输出 JSON 数组，每项 {"text":"...","subject":"user|pet|relationship","importance":1-5}。
只输出 JSON，不要解释。没有值得记的就输出 []。

对话：
用户：我最近在做一个 AI 桌宠项目，主要是 Electron 加 Live2D
助手：听起来很有意思呀
用户：不过我显卡只有 8G 显存，跑本地模型有点吃力`

for (const m of ['deepseek-flash', 'deepseek-chat']) {
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${K}` },
      body: JSON.stringify({
        model: m,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 500,
      }),
    })
    const j = await r.json()
    const raw = j.choices?.[0]?.message?.content ?? ''
    let parsed = null
    try {
      parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
    } catch { /* 保持 null */ }
    console.log(`  ${m}: ${parsed ? `✅ 解析出 ${parsed.length} 条` : '❌ 不是合法 JSON'}`)
    console.log(`     ${JSON.stringify(parsed ?? raw).slice(0, 300)}`)
  } catch (e) {
    console.log(`  ${m}: ERR ${e.message}`)
  }
}
