/**
 * 对比 deepseek-flash（推理模型）与 deepseek-chat 在「桌宠闲聊」场景下的表现。
 * 关键指标是「用户看到第一个字之前的等待」—— 推理模型会先默默想一大段。
 */
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

const SYSTEM =
  '你是一只桌面小宠物，名字叫小雫。你说话简短、口语化、有点俏皮。每次回复控制在 1-3 句话以内。'
const USER = '今天写代码写得好累啊'

async function bench(model, maxTokens) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${K}` },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.8,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ],
    }),
  })
  if (!res.ok) return { model, err: `${res.status} ${(await res.text()).slice(0, 100)}` }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let content = ''
  let reasoning = ''
  let firstReasonAt = null
  let firstContentAt = null
  let usage = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (p === '[DONE]') continue
      try {
        const j = JSON.parse(p)
        if (j.usage) usage = j.usage
        const d = j.choices?.[0]?.delta
        if (!d) continue
        if (d.reasoning_content) {
          if (firstReasonAt === null) firstReasonAt = Date.now() - t0
          reasoning += d.reasoning_content
        }
        if (d.content) {
          if (firstContentAt === null) firstContentAt = Date.now() - t0
          content += d.content
        }
      } catch { /* 忽略 */ }
    }
  }
  return { model, firstReasonAt, firstContentAt, total: Date.now() - t0, content, reasoning, usage }
}

const MODELS = [
  ['deepseek-chat', null],
  ['deepseek-flash', null],
  ['deepseek-v4-pro', null],
]

console.log('场景：用户说「今天写代码写得好累啊」，流式输出\n')
console.log('模型              首字(用户可见)   想到何时   总耗时   推理token  回答token')
console.log('─'.repeat(78))

for (const [m, mt] of MODELS) {
  try {
    const r = await bench(m, mt)
    if (r.err) { console.log(`${m.padEnd(18)} 失败: ${r.err}`); continue }
    const u = r.usage || {}
    console.log(
      `${m.padEnd(18)}${String(r.firstContentAt ?? '—').padStart(8)}ms` +
        `${String(r.firstReasonAt ?? '—').padStart(11)}ms` +
        `${String(r.total).padStart(9)}ms` +
        `${String(u.completion_tokens_details?.reasoning_tokens ?? 0).padStart(10)}` +
        `${String(u.completion_tokens ?? 0).padStart(12)}`
    )
    console.log(`   回答: ${r.content.replace(/\n/g, ' ').slice(0, 90)}`)
    if (!r.content) console.log('   ⚠️  回答是空的！')
    console.log()
  } catch (e) {
    console.log(`${m.padEnd(18)} ERR ${e.message}\n`)
  }
}
