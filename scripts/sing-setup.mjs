/**
 * 唱歌环境体检。
 *
 * 以前这个脚本是「建 singing/.venv + 装 RVC 依赖」。RVC 那条路已经废弃
 * （公开的芙宁娜 RVC 模型训练不足，实测音色/咬字/稳定性全面不如 DDSP），
 * 现在 Python 侧只有一个手搭好的环境 `.venv-ddsp`，不需要脚本去创建。
 *
 * 所以这里改成**只检查、不动手**：把所有依赖逐项验一遍，缺什么就说清楚怎么补。
 * 比「点了按钮没反应」强得多。
 *
 * 用法：npm run sing:setup
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SING = path.join(ROOT, 'singing')

/** 权重都放 D 盘，项目目录保持干净 */
const MODELS = 'D:\\models\\DDSP-SVC'

let bad = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const no = (m, how) => {
  bad++
  console.log(`  ❌ ${m}`)
  if (how) console.log(`     → ${how}`)
}
const warn = (m) => console.log(`  ⚠️  ${m}`)

console.log('=== 1) Python 环境 ===')
const py = [
  process.env.PET_SINGING_PYTHON,
  path.join(SING, '.venv-ddsp', 'Scripts', 'python.exe'),
  path.join(SING, '.venv-ddsp', 'bin', 'python'),
].filter(Boolean).find((p) => fs.existsSync(p))

if (!py) {
  no(
    '找不到 singing/.venv-ddsp',
    '见 singing/README.md 的「环境」一节（torch 用本地 wheel 装，避开 3.4G 下载）',
  )
} else {
  ok(`Python：${py}`)
  // 一次问完所有依赖，省得反复起进程（每次起 torch 要好几秒）
  const probe = `
import json, sys
r = {"py": sys.version.split()[0], "mods": {}, "cuda": None, "gpu": None, "torch": None}
for m in ["torch","torchaudio","librosa","numpy","soundfile","scipy","pyworld","parselmouth","torchcrepe","transformers","demucs"]:
    try:
        mod = __import__(m)
        r["mods"][m] = getattr(mod, "__version__", "ok")
    except Exception as e:
        r["mods"][m] = "MISSING:%s" % type(e).__name__
try:
    import torch
    r["torch"] = torch.__version__
    r["cuda"] = bool(torch.cuda.is_available())
    if r["cuda"]:
        r["gpu"] = torch.cuda.get_device_name(0)
except Exception as e:
    r["cuda"] = "ERR:%s" % e
print(json.dumps(r))
`
  let info = null
  try {
    const out = execFileSync(py, ['-c', probe], { encoding: 'utf8', timeout: 240000 })
    info = JSON.parse(out.trim().split(/\r?\n/).pop())
  } catch (e) {
    no(`跑不起来：${String(e.message).split('\n')[0]}`, '环境可能坏了，见 singing/README.md')
  }
  if (info) {
    console.log(`     Python ${info.py}  |  torch ${info.torch ?? '?'}`)
    if (info.cuda === true) ok(`CUDA 可用：${info.gpu}`)
    else no(`CUDA 不可用（${info.cuda}）`, '唱歌必须跑 GPU，CPU 会慢几十倍')

    for (const m of ['torch', 'torchaudio', 'librosa', 'numpy', 'soundfile', 'demucs']) {
      const v = info.mods[m]
      if (v && !String(v).startsWith('MISSING')) ok(`${m.padEnd(13)} ${v}`)
      else no(`${m.padEnd(13)} 缺失`, '在 .venv-ddsp 里装上它')
    }
    for (const m of ['scipy', 'pyworld', 'parselmouth', 'torchcrepe', 'transformers']) {
      const v = info.mods[m]
      if (v && !String(v).startsWith('MISSING')) console.log(`  ·  ${m.padEnd(13)} ${v}`)
      else warn(`${m.padEnd(13)} 缺失（部分 F0 提取算法会不可用）`)
    }
  }
}

console.log('\n=== 2) 音色模型 ===')
const voicesDir = path.join(MODELS, 'voices')
if (!fs.existsSync(voicesDir)) {
  no(`找不到 ${voicesDir}`, '音色模型放这里，每个音色一个子目录')
} else {
  const voices = fs
    .readdirSync(voicesDir)
    .filter((d) => fs.statSync(path.join(voicesDir, d)).isDirectory())
  if (!voices.length) no(`${voicesDir} 下没有音色`, '至少放一个（需要 model.pt + config.yaml）')
  for (const v of voices) {
    const pt = path.join(voicesDir, v, 'model.pt')
    const cfg = path.join(voicesDir, v, 'config.yaml')
    const hasPt = fs.existsSync(pt)
    const hasCfg = fs.existsSync(cfg)
    if (hasPt && hasCfg) ok(`${v}  ${(fs.statSync(pt).size / 1e6).toFixed(1)} MB`)
    else no(`${v} 不完整（model.pt=${hasPt} config.yaml=${hasCfg}）`, '两个都要有')
  }
}

console.log('\n=== 3) 预训练权重 ===')
for (const [label, rel] of [
  ['ContentVec 编码器', 'pretrain\\contentvec\\pytorch_model.bin'],
  ['NSF-HiFiGAN 声码器', 'pretrain\\nsf_hifigan\\model'],
  ['RMVPE 音高提取', 'pretrain\\rmvpe\\model.pt'],
]) {
  const p = path.join(MODELS, rel)
  if (fs.existsSync(p)) ok(`${label.padEnd(20)} ${(fs.statSync(p).size / 1e6).toFixed(1)} MB`)
  else no(`${label.padEnd(20)} 缺 ${p}`, '见 singing/README.md')
}

console.log('\n=== 4) 管线代码 ===')
for (const f of ['ddsp_cover.py', 'repos\\DDSP-SVC\\reflow\\vocoder.py']) {
  const p = path.join(SING, f)
  if (fs.existsSync(p)) ok(f)
  else no(f, '代码缺失，见 singing/README.md')
}

console.log('\n=== 5) 下一步 ===')
console.log('  以上都通过的话，跑一次真实转换验证整条链：')
console.log('     node scripts/test-singing.mjs            # 用 songs/ 里第一首')
console.log('     node scripts/test-singing.mjs --force    # 跳过缓存重跑')

console.log(`\n${bad ? `❌ ${bad} 项问题` : '✅ 环境完好，可以唱歌'}`)
process.exit(bad ? 1 : 0)
