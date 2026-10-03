/**
 * 废片守卫的回归测试
 *   node scripts/test-dud-guard.mjs
 *
 * 守什么：**好音频不能被判成废片，废片不能漏过去。**
 *
 * 为什么需要它（这次误判的代价）：
 *   守卫里有一条 `有声占比 < 0.5 → 废片`。第一版的「有声占比」是**逐采样点**数的，
 *   而逐采样点的正常范围只有 35%~80%（语音波形每个周期都要过零）——
 *   于是约三分之一的好音频被判废片，每句白白重试 3 次。
 *   本地后端是白等几秒，云端后端是**白花三倍的钱**。
 *
 *   改成 10ms 窗取峰值之后正常范围变成 83%~99%，0.5 才落回该在的位置。
 *   这个脚本用合成音频把两个边界钉死，免得以后又改回去。
 *
 * 为什么用合成音频而不是真音频：
 *   真音频没法进仓库（是别人的声音），而且合成音频能把「正常」和「废片」
 *   造得**可控**——真实废片长什么样是随机的，造不出来。
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { inspectWav, postProcessWav, DUD } = require(join(ROOT, 'src', 'tts.js'))

/**
 * 用**模块里的真实阈值**判废片，别在这里写死数字。
 * 写死过一次 0.5，结果模块把阈值改成 0.3 之后，测试还在按 0.5 报「2 个被误判」——
 * 测的不是实际行为，等于白测。
 */
const isDud = (st) => st.rms < DUD.DUD_MIN_RMS || st.voiceRatio < DUD.DUD_MIN_VOICE_RATIO || st.seconds < DUD.DUD_MIN_SECONDS

console.log(`阈值：RMS ≥ ${DUD.DUD_MIN_RMS}  有声窗占比 ≥ ${DUD.DUD_MIN_VOICE_RATIO}  时长 ≥ ${DUD.DUD_MIN_SECONDS}s\n`)

let pass = 0
const fails = []
const ok = (cond, label, extra = '') => {
  if (cond) pass++
  else fails.push(`${label}${extra ? ` —— ${extra}` : ''}`)
}

const SR = 32000

/** 造一段「像语音」的 wav：一串有声段 + 段间静音 */
function makeWav({ seconds = 3, voicedRatio = 1.0, amp = 0.5, sr = SR, gaps = false } = {}) {
  const n = Math.round(seconds * sr)
  const pcm = Buffer.alloc(n * 2)
  const voicedSamples = Math.round(n * voicedRatio)
  for (let i = 0; i < n; i++) {
    let v = 0
    if (i < voicedSamples) {
      // 基频 180Hz + 谐波
      const t = i / sr
      v = amp * (0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 540 * t) + 0.1 * Math.sin(2 * Math.PI * 1200 * t))
      // 可选：每 200ms 插一小段停顿，模拟词间空隙
      if (gaps && Math.floor(t / 0.2) % 4 === 3) v = 0
    }
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sr, 24)
  h.writeUInt32LE(sr * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

// ---------------------------------------------------------------- 正常音频

console.log('=== 正常音频不该被判废片 ===\n')
for (const amp of [0.15, 0.3, 0.5, 0.9]) {
  // 先归一化再测 —— 守卫的绝对阈值只在归一化之后才有意义
  const { buf } = postProcessWav(makeWav({ amp }), { trim: false, loudness: true, targetRms: 0.09 })
  const st = inspectWav(buf)
  ok(st.voiceRatio >= 0.8, `振幅 ${amp} 归一化后 有声占比 ≥ 0.8`, `实际 ${st.voiceRatio.toFixed(3)}`)
  ok(st.rms >= 0.02, `振幅 ${amp} 归一化后 RMS ≥ 0.02`, `实际 ${st.rms.toFixed(4)}`)
}

// 合成音频只能证明「边界没搞反」，**证明不了当初那个误判**：
// 纯音（哪怕是 180Hz+谐波）的过零次数远少于真实语音，
// 逐采样点数和窗口级数出来几乎一样（实测 63.8% vs 65.0%）。
// 真实语音里逐采样点只有 35%~80%，差异是在**真实语料**上才显出来的 —— 见下面那一段。

// ---------------------------------------------------------------- 废片

console.log('\n=== 废片必须被抓到 ===\n')
for (const [label, amp] of [['近乎全零', 0.0005], ['极轻', 0.002], ['只有三成有声', null]]) {
  let buf
  if (amp != null) {
    buf = makeWav({ amp, seconds: 2 }) // 不做归一化，模拟「原始就是废片」
  } else {
    // 三成有声 + 归一化（gain 上限 8 也救不回来）
    buf = makeWav({ amp: 0.004, voicedRatio: 0.3, seconds: 2 })
    buf = postProcessWav(buf, { trim: false, loudness: true }).buf
  }
  const st = inspectWav(buf)
  const dud = isDud(st)
  ok(dud, `${label} 判为废片`, `rms=${st.rms.toFixed(4)} 有声占比=${st.voiceRatio.toFixed(3)}`)
}

// 太短的
{
  const st = inspectWav(makeWav({ seconds: 0.15, amp: 0.5 }))
  ok(isDud(st), '太短的判为废片', `${st.seconds.toFixed(2)}s`)
}

// ---------------------------------------------------------------- 真实音频（关键回归）
//
// **这一段才是真正守着那个 bug 的。**
// 仓库里的合成音频造不出「真实语音那种过零密度」，所以误判只能在真实语料上复现：
//   修复前：逐采样点数 → 正常范围 35%~80%，配 0.5 阈值 → 约三成好音频被判废片
//   修复后：窗口级数  → 正常范围 83%~99%，配 0.5 阈值 → 误判率个位数
// 所以这里断言「误判率 < 10%」—— 谁要是把实现改回逐采样点，这条立刻红。

const realDir = join(ROOT, '.userdata-dev', 'tts-cache')
try {
  const fs = require('node:fs')
  const files = fs.readdirSync(realDir).filter((f) => f.endsWith('.wav')).slice(0, 60)
  if (files.length >= 10) {
    console.log(`\n=== 真实音频抽查（${files.length} 个）===\n`)
    const flagged = []
    const ratios = []
    for (const f of files) {
      const st = inspectWav(fs.readFileSync(join(realDir, f)))
      if (!st) continue
      ratios.push(st.voiceRatio)
      if (isDud(st)) flagged.push({ f, st })
    }
    ratios.sort((a, b) => a - b)
    const rate = (flagged.length / files.length) * 100
    console.log(`  有声占比：最小 ${(ratios[0] * 100).toFixed(0)}%  中位 ${(ratios[Math.floor(ratios.length / 2)] * 100).toFixed(0)}%  最大 ${(ratios[ratios.length - 1] * 100).toFixed(0)}%`)
    console.log(`  被判废片的：${flagged.length}/${files.length}（${rate.toFixed(0)}%）`)
    for (const x of flagged.slice(0, 5)) {
      console.log(`     ${x.f}  rms=${x.st.rms.toFixed(4)} 占比=${x.st.voiceRatio.toFixed(3)}`)
    }
    ok(ratios[0] > 0.4, '真实音频的有声窗占比下限应当 > 0.4', `实际 ${ratios[0].toFixed(3)}`)
    ok(rate < 10, '真实音频里被判废片的应当 < 10%（这些大多是正常输出）', `${rate.toFixed(0)}%`)
  } else {
    console.log('\n（真实音频不足 10 个，跳过抽查 —— 跑几次自检就有了）')
  }
} catch {
  /* 没有真实音频就跳过 */
}

// ---------------------------------------------------------------- 结论

console.log('\n=== 结论 ===\n')
if (!fails.length) {
  console.log(`  ✅ ${pass} 项断言全过`)
} else {
  console.log(`  ❌ ${fails.length}/${pass + fails.length} 项没过：`)
  for (const f of fails) console.log(`     · ${f}`)
  process.exitCode = 1
}
