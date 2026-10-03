/**
 * 验证「API Key 解析 + 真实对话」这条链路。
 *   node scripts/check-llm.mjs
 *
 * 用的是和 src/main.js 完全一样的查找顺序，方便定位问题出在哪一层。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NAMES = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY', 'ZHIPUAI_API_KEY']

function readUserEnvVar(name) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    })
    const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

// ---- 1. 配置
let baseUrl = 'https://api.deepseek.com/v1'
let model = 'deepseek-chat'
let key = ''
let source = ''

const cfgPath = join(ROOT, 'config.json')
if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  baseUrl = cfg.baseUrl || baseUrl
  model = cfg.model || model
  if (cfg.apiKey && cfg.apiKey.trim()) { key = cfg.apiKey.trim(); source = 'config.json' }
}

if (!key) {
  for (const n of NAMES) {
    if (process.env[n]?.trim()) { key = process.env[n].trim(); source = `进程环境变量 ${n}`; break }
  }
}
if (!key) {
  for (const n of NAMES) {
    const v = readUserEnvVar(n)
    if (v) { key = v; source = `用户环境变量（注册表） ${n}`; break }
  }
}

console.log('=== 1. API Key 解析 ===')
console.log('  找到 :', key ? '是' : '否')
console.log('  来源 :', source || '（无）')
console.log('  前缀 :', key ? key.slice(0, 7) + '…' + key.slice(-4) : '（无）')
console.log('  接口 :', baseUrl)
console.log('  模型 :', model)

if (!key) {
  console.log('\n❌ 没找到 Key —— 应用会进演示模式。')
  process.exit(1)
}

// ---- 2. 真实调用
console.log('\n=== 2. 真实流式对话 ===')
const t0 = Date.now()
const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    stream: true,
    temperature: 0.8,
    messages: [
      { role: 'system', content: '你是一只桌面小宠物，说话简短俏皮，一句话以内。' },
      { role: 'user', content: '你好呀，你是谁？' },
    ],
  }),
})

console.log('  HTTP :', res.status, res.statusText)
if (!res.ok) {
  console.log('  响应 :', (await res.text()).slice(0, 400))
  process.exit(1)
}

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''
let out = ''
let firstDeltaAt = null

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buf += decoder.decode(value, { stream: true })
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      const delta = JSON.parse(payload).choices?.[0]?.delta?.content
      if (delta) {
        if (firstDeltaAt === null) firstDeltaAt = Date.now() - t0
        out += delta
      }
    } catch { /* 忽略 */ }
  }
}

console.log('  首字延迟:', firstDeltaAt, 'ms')
console.log('  总耗时 :', Date.now() - t0, 'ms')
console.log('  回复   :', out)
console.log('\n✅ 链路通。')
