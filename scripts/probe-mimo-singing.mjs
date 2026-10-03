/**
 * MiMo 唱歌探针
 *
 * 要回答的问题只有一个：**能不能用芙宁娜的克隆音色「唱」出来。**
 *
 * 官方 skill 文档说唱歌只挂在预置音色模型（`mimo-v2.5-tts`）上，
 * `mimo-v2.5-tts-voiceclone` 那一行是空的。但文档经常比实际保守 ——
 * 一个 `(唱歌)` 标签的事，实测比读文档可靠。
 *
 * 三组对照，缺一不可：
 *   A. voiceclone + 普通文本   → 基线。确认克隆本身是通的（不然 B 失败分不清是哪个原因）
 *   B. voiceclone + (唱歌)     → ★ 关键。成 → 芙宁娜真的能唱
 *   C. 预置音色 + (唱歌)       → 对照组。确认「唱歌」这个能力本身可用
 *
 * 用法：
 *   node scripts/probe-mimo-singing.mjs              # 列模型 + 跑三组
 *   node scripts/probe-mimo-singing.mjs --models     # 只列模型
 *   node scripts/probe-mimo-singing.mjs --base https://api.xiaomimimo.com/v1
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.userdata-dev', 'mimo-sing')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------- key

/**
 * 找 key。顺序和 main.js 保持一致：config.json → 进程环境变量 → 用户级注册表。
 *
 * 为什么要读注册表：用户是刚用 setx 设的，而 DSH 这个进程是在那之前启动的，
 * 环境变量根本没继承进来。main.js 里 readUserEnvVar 那段就是为这种情况写的，
 * 这里必须同样处理，否则「明明设了却说没有」。
 */
function readUserEnvVar(name) {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    })
    const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

const cfg = loadConfig()
const mimoCfg = cfg?.tts?.mimo || {}

const key = (mimoCfg.apiKey || '').trim()
  || (process.env.MIMO_API_KEY || '').trim()
  || readUserEnvVar('MIMO_API_KEY')
  || ''

if (!key) {
  console.error('没找到 MIMO_API_KEY。')
  console.error('  · config.json 的 tts.mimo.apiKey，或')
  console.error('  · 用户级环境变量（setx MIMO_API_KEY "..."）')
  process.exit(1)
}

/** tp- 开头的 key 只认 Token Plan 端点，别的走按量端点 */
const argv = process.argv.slice(2)
const argOf = (n) => {
  const i = argv.indexOf(n)
  return i !== -1 ? argv[i + 1] : (argv.find((a) => a.startsWith(n + '=')) || '').split('=')[1]
}
const base = (argOf('--base') || mimoCfg.baseUrl
  || (key.startsWith('tp-') ? 'https://token-plan-cn.xiaomimimo.com/v1' : 'https://api.xiaomimimo.com/v1'))
  .replace(/\/+$/, '')

console.log('=== MiMo 唱歌探针 ===')
console.log(`Key    ${key.slice(0, 6)}…（${key.length} 字符，${key.startsWith('tp-') ? 'Token Plan' : '按量计费'}）`)
console.log(`端点   ${base}`)
console.log(`输出   ${OUT}`)
console.log('')

// ---------------------------------------------------------------- 列模型

async function listModels() {
  console.log('--- GET /models ---')
  try {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
    const text = await res.text()
    console.log(`HTTP ${res.status}`)
    try {
      const j = JSON.parse(text)
      const ids = (j.data || j.models || []).map((m) => m.id || m.name || m).filter(Boolean)
      if (ids.length) {
        for (const id of ids) console.log(`  ${id}`)
      } else {
        console.log('  ' + JSON.stringify(j).slice(0, 500))
      }
      return ids
    } catch {
      console.log('  原始返回：' + text.slice(0, 400))
      return []
    }
  } catch (e) {
    console.log(`  失败：${e.name}: ${e.message}`)
    return []
  }
}

// ---------------------------------------------------------------- 合成

/** 参考音频 → data URL。MiMo 要求 base64 ≤10MB、mp3/wav */
function loadSample() {
  const cands = [
    mimoCfg.voiceSample,
    '.userdata/clone-source.wav',
    'assets/voice/clips',
  ].filter(Boolean)
  for (const c of cands) {
    const p = resolve(ROOT, c)
    if (!existsSync(p)) continue
    let file = p
    if (!extname(p)) {
      // 目录 → 挑第一条 wav
      const fs = require('node:fs')
      const first = fs.readdirSync(p).find((f) => f.endsWith('.wav'))
      if (!first) continue
      file = join(p, first)
    }
    const buf = readFileSync(file)
    if (buf.length > 7 * 1024 * 1024) continue
    const mime = /\.mp3$/i.test(file) ? 'mpeg' : 'wav'
    console.log(`参考音频 ${file}（${(buf.length / 1024).toFixed(0)} KB）`)
    return `data:audio/${mime};base64,${buf.toString('base64')}`
  }
  return ''
}

/**
 * 打一次合成。
 *
 * 接口是**对话式**的（不是传统 /tts）：
 *   user      = 风格指令 / 导演模式描述
 *   assistant = 要唱/念的文本
 *   audio.voice = base64 样本（克隆）或音色名（预置音色）
 */
async function synth({ model, text, voice, context, tag }) {
  const body = {
    model,
    messages: [
      { role: 'user', content: context || '' },
      { role: 'assistant', content: text },
    ],
    audio: { format: 'wav', voice },
  }
  const t0 = Date.now()
  let res, raw
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    })
    raw = await res.text()
  } catch (e) {
    return { ok: false, why: `${e.name}: ${e.message}` }
  }
  const ms = Date.now() - t0

  if (!res.ok) return { ok: false, why: `HTTP ${res.status} ${raw.slice(0, 220)}`, ms }

  let j
  try { j = JSON.parse(raw) } catch { return { ok: false, why: `非 JSON：${raw.slice(0, 160)}`, ms } }

  const b64 = j.choices?.[0]?.message?.audio?.data
  if (!b64) {
    // 有些错误是 200 + error 字段，别吞掉
    const hint = j.error?.message || j.base_resp?.status_msg || JSON.stringify(j).slice(0, 260)
    return { ok: false, why: `返回里没有音频：${hint}`, ms }
  }
  const buf = Buffer.from(b64, 'base64')
  const file = join(OUT, `${tag}.wav`)
  writeFileSync(file, buf)

  // 用 ffprobe 量时长 —— 「有没有真的唱」不看文件大小，看时长和有没有声音
  let sec = null
  try {
    sec = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim())
  } catch { /* 没有 ffprobe 就算了 */ }

  return { ok: true, file, bytes: buf.length, sec, ms }
}

// ---------------------------------------------------------------- 主流程

const LYRICS = '(唱歌)弯弯的月亮小小的船，小小的船儿两头尖，我在小小的船里坐，只看见闪闪的星星蓝蓝的天。'
const PLAIN = '今天天气不错，我陪你待一会儿。'

async function main() {
  const ids = await listModels()
  console.log('')
  if (argv.includes('--models')) return

  const sample = loadSample()
  if (!sample) {
    console.error('没找到可用的参考音频（.userdata/clone-source.wav 或 assets/voice/clips/*.wav）')
    process.exit(1)
  }
  console.log('')

  /**
   * 挑模型 id。用户说现在有 2.6，所以别硬编码 2.5 ——
   * 从 /models 里按「最新版本 + 角色」匹配，匹配不到再退回写死的默认值。
   */
  const pick = (kind) => {
    const re = { clone: /tts.*(voiceclone|voice-clone|clone)/i, preset: /tts(?!.*(clone|design|voice))/i, design: /voicedesign|voice-design/i }[kind]
    const hit = ids.filter((i) => re?.test(i)).sort().reverse()
    return hit[0] || null
  }
  const clone = pick('clone') || mimoCfg.model || 'mimo-v2.5-tts-voiceclone'
  const preset = pick('preset') || 'mimo-v2.5-tts'
  console.log(`克隆模型 ${clone}`)
  console.log(`预置模型 ${preset}`)
  console.log('')

  const tests = [
    { tag: 'A-克隆-普通', model: clone, text: PLAIN, voice: sample,
      desc: '基线：克隆音色念一句普通话' },
    { tag: 'B-克隆-唱歌', model: clone, text: LYRICS, voice: sample,
      desc: '★ 关键：克隆音色 + (唱歌)' },
    { tag: 'B2-克隆-唱歌-指令', model: clone, text: '(唱歌)' + PLAIN, voice: sample,
      context: '用唱歌的方式把这句话唱出来，旋律轻快',
      desc: '变体：唱歌 + 自然语言指令' },
    { tag: 'C-预置-唱歌', model: preset, text: LYRICS, voice: mimoCfg.presetVoice && mimoCfg.presetVoice !== 'mimo_default' ? mimoCfg.presetVoice : '冰糖',
      desc: '对照组：预置音色 + (唱歌)' },
  ]

  const results = []
  for (const t of tests) {
    console.log(`--- ${t.tag} ---`)
    console.log(`  ${t.desc}`)
    console.log(`  model=${t.model}`)
    const r = await synth({ ...t })
    if (r.ok) {
      console.log(`  ✅ ${(r.bytes / 1024).toFixed(0)} KB / ${r.sec ? r.sec.toFixed(1) + 's' : '时长未知'} / ${r.ms}ms → ${t.tag}.wav`)
    } else {
      console.log(`  ❌ ${r.why}${r.ms ? `（${r.ms}ms）` : ''}`)
    }
    results.push({ ...t, ...r })
    console.log('')
  }

  console.log('=== 结论 ===')
  const A = results.find((r) => r.tag.startsWith('A-'))
  const B = results.find((r) => r.tag.startsWith('B-'))
  const C = results.find((r) => r.tag.startsWith('C-'))
  if (!A?.ok) {
    console.log('❗ 基线就失败了 —— 先解决克隆本身（key/样本/模型 id），下面的判断都不成立')
  } else if (B?.ok) {
    console.log('✅ 克隆音色 + (唱歌) 是通的 → 芙宁娜真的能唱，按这个做')
  } else {
    console.log('❌ 克隆音色不能唱歌（和文档一致）')
    console.log(C?.ok ? '   → 但预置音色能唱。二选一：换个嗓子唱，或用她的嗓子念歌词' : '   → 预置音色那条也失败了，看上面的报错')
  }
  console.log(`\n音频都在：${OUT}`)
}

main().catch((e) => {
  console.error('探针崩了：', e)
  process.exit(1)
})
