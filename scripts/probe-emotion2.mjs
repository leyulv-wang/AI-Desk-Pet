/**
 * 重测：SenseVoice 的真实速度 + LLM 打标签（给足 max_tokens）
 *   node scripts/probe-emotion2.mjs
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

const SF = grab('EMBEDDING_API_KEY')
const DS = grab('DEEPSEEK_API_KEY')
const DIR = 'D:\\下载\\原神语音包\\Furina'

// ---------------------------------------------------------------- SenseVoice 速度
console.log('=== SenseVoice 速度重测（3 次，看冷启动 vs 热）===\n')
const samples = ['9748118594ebf75c', 'e4ecad5306561756', '401b15cd66e41121']
const times = []
for (const [i, name] of samples.entries()) {
  const p = join(DIR, name + '.wav')
  if (!existsSync(p)) { console.log(`  跳过 ${name}`); continue }
  const buf = readFileSync(p)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'a.wav')
  form.append('model', 'FunAudioLLM/SenseVoiceSmall')
  const t0 = Date.now()
  try {
    const res = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${SF}` }, body: form,
    })
    const ms = Date.now() - t0
    times.push(ms)
    const j = await res.json()
    console.log(`  第 ${i + 1} 条  ${String(ms).padStart(6)}ms  → ${JSON.stringify(j.text)}`)
  } catch (e) {
    console.log(`  第 ${i + 1} 条  失败: ${e.message}`)
  }
}
if (times.length) {
  const avg = times.reduce((a, b) => a + b) / times.length
  console.log(`\n  平均 ${Math.round(avg)}ms/条`)
  console.log(`  1139 条预计 ${(avg * 1139 / 60000).toFixed(1)} 分钟（若顺序跑）`)
  console.log(`  并发 8 路预计 ${(avg * 1139 / 60000 / 8).toFixed(1)} 分钟`)
}

// ---------------------------------------------------------------- LLM 打标签
console.log('\n=== LLM 给转写文本打情绪标签（max_tokens 给足）===\n')

const LABELS = ['开心', '生气', '悲伤', '惊讶', '厌恶', '平静', '得意', '温柔', '无奈', '紧张']

async function classify(items) {
  const t0 = Date.now()
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS}` },
    body: JSON.stringify({
      model: 'deepseek-flash',
      temperature: 0.1,
      max_tokens: 4000,
      messages: [
        {
          role: 'system',
          content:
            `你是情绪分类器。给每句话打语气标签，只能从这些里选：${LABELS.join('/')}。\n` +
            `同时给出强度 1-3（1=轻，3=强烈）。\n` +
            `输入是 JSON 数组 [{"i":序号,"t":"文本"}]，输出 JSON 数组 [{"i":序号,"e":"标签","v":强度}]。\n` +
            `只输出 JSON，不要任何解释。`,
        },
        { role: 'user', content: JSON.stringify(items) },
      ],
    }),
  })
  const j = await res.json()
  const ms = Date.now() - t0
  const raw = j.choices?.[0]?.message?.content ?? ''
  let parsed = null
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) } catch { /* 保持 null */ }
  return { ms, raw, parsed, usage: j.usage, reasoning: j.choices?.[0]?.message?.reasoning_content ? '有' : '无' }
}

const testItems = [
  { i: 0, t: '呵呵，审判你们的理由当然有，而且显而易见吧？' },
  { i: 1, t: '太「普通」了！哼，这种缺乏特色的料理得不到我的认可！' },
  { i: 2, t: '我…我怎么知道会出现这种情况…不要盯着我看了…' },
  { i: 3, t: '或许我也曾向往过这种力量，但那更像是一种讽刺。' },
  { i: 4, t: '琳妮特的表演也是，完全超出了我的预期。' },
  { i: 5, t: '你们这些家伙，真是让我伤透了脑筋。' },
  { i: 6, t: '谢谢你一直陪着我。' },
  { i: 7, t: '哦？这可真是出乎我的意料。' },
  { i: 8, t: '别过来！' },
  { i: 9, t: '那就这样吧，随你们便。' },
]

const r = await classify(testItems)
console.log(`  HTTP 200  ${r.ms}ms  reasoning=${r.reasoning}  usage=${JSON.stringify(r.usage)}`)
console.log(`  解析结果: ${r.parsed ? '✅ ' + r.parsed.length + ' 条' : '❌ 解析失败'}`)
if (r.parsed) {
  for (const x of r.parsed) {
    const src = testItems.find((t) => t.i === x.i)
    console.log(`    ${String(x.i).padStart(2)}  ${String(x.e).padEnd(4)} v${x.v}  「${src?.t?.slice(0, 26)}」`)
  }
} else {
  console.log('  原始返回:', r.raw.slice(0, 400))
}

const per = (r.usage?.total_tokens || 0) / testItems.length
console.log(`\n  每条 ${per.toFixed(0)} token → 1139 条约 ${Math.round(per * 1139 / 1000)}k token`)
console.log(`  按每批 20 条算，共 ${Math.ceil(1139 / 20)} 次调用`)
