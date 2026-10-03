/**
 * 安装一个 Live2D 模型
 *   node scripts/install-model.mjs <源目录> <目标名字> [--set-default]
 *
 * 例：node scripts/install-model.mjs "<你的Live2D模型目录>" Furina --set-default
 *
 * 为什么需要这个脚本，而不是手动拷贝：
 *
 * ① **文件名要转 ASCII**。模型里的文件名常带中文，而渲染层是通过自定义
 *    `pet://app/...` 协议加载的，中文要经过 URL 百分号编码再解码，
 *    不同环节对编码的处理不完全一致 —— 与其赌，不如统一转成 ASCII。
 *    转换必须同步改 model3.json 里所有引用，手改容易漏。
 *
 * ② **要补 Expressions / Motions 登记**。VTS 用的模型经常只在磁盘上放着
 *    .exp3.json / .motion3.json，而 model3.json 里**没有**这两段
 *    （VTS 读它自己的 .vtube.json 热键配置）。但 pixi-live2d-display 只认
 *    model3.json —— 不补的话表情和动作全用不了。
 *
 * ③ 顺手把 VTS 专属文件（.vtube.json、items_pinned_to_model.json）剔掉。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2]
const NAME = process.argv[3]
const SET_DEFAULT = process.argv.includes('--set-default')

if (!SRC || !NAME) {
  console.error('用法：node scripts/install-model.mjs <源目录> <目标名字> [--set-default]')
  process.exit(1)
}
if (!existsSync(SRC)) {
  console.error(`源目录不存在：${SRC}`)
  process.exit(1)
}

const DEST = join(ROOT, 'assets', 'models', NAME)

// ---------------------------------------------------------------- 找 model3.json

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = walk(SRC)
const model3Path = files.find((f) => f.toLowerCase().endsWith('.model3.json'))
if (!model3Path) {
  console.error(`在 ${SRC} 里找不到 .model3.json`)
  process.exit(1)
}
const srcDir = dirname(model3Path)
const manifest = JSON.parse(readFileSync(model3Path, 'utf8'))
console.log(`源模型：${basename(model3Path)}`)
console.log(`目标：  assets/models/${NAME}\n`)

// ---------------------------------------------------------------- 转 ASCII 名字

/** 已知的中文文件名 → ASCII。没在表里的走通用兜底 */
const KNOWN = {
  笔芯: 'heart-eyes',
  爱心眼: 'heart-eyes',
  脸红: 'blush',
  害羞: 'blush',
  生气: 'angry',
  愤怒: 'angry',
  挥手: 'wave',
  微笑: 'smile',
  开心: 'happy',
  难过: 'sad',
  悲伤: 'sad',
  惊讶: 'surprised',
  平静: 'neutral',
  芙宁娜: 'furina',
  フリーナ: 'furina',
  furina: 'furina',
}

/**
 * 拆出「主名 + 扩展名」，**双扩展名要当成一个整体**。
 * 例如 笔芯.exp3.json 的扩展名是 `.exp3.json`、主名是 `笔芯`。
 * 不这么处理的话主名会变成「笔芯.exp3」，查表查不到，兜底又把它削成 `exp3`。
 */
const COMPOUND_EXT = ['.exp3.json', '.motion3.json', '.model3.json', '.physics3.json', '.pose3.json', '.cdi3.json', '.vtube.json']
function splitName(file) {
  const lower = file.toLowerCase()
  for (const ext of COMPOUND_EXT) {
    if (lower.endsWith(ext)) return { stem: file.slice(0, -ext.length), ext: file.slice(-ext.length) }
  }
  const ext = extname(file)
  return { stem: basename(file, ext), ext }
}

/** 把任意名字转成 ASCII 主名（查表优先，兜底削字符） */
function asciiStem(stem) {
  if (KNOWN[stem]) return KNOWN[stem]
  const cleaned = stem
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned
}

/**
 * 目录名也转 ASCII。
 * 贴图目录常叫「xxx.4096」——末尾的 `.4096` 是分辨率标记，去掉更干净。
 */
function asciiDirName(dir) {
  const stripped = dir.replace(/\.\d{3,4}$/, '')
  const base = asciiStem(stripped) || 'textures'
  return base
}

/** 同一个源目录永远映射到同一个目标目录（用独立的去重表，别和文件名混用） */
const dirTargets = new Map()
const usedDirs = new Set()
function targetDir(srcRelDir) {
  const key = srcRelDir.split(/[\\/]/).join('/')
  if (dirTargets.has(key)) return dirTargets.get(key)
  const parts = key ? key.split('/') : []
  const mapped = parts.map((p) => {
    if (/^[\x20-\x7E]+$/.test(p) && !/\.\d{3,4}$/.test(p)) return p
    return asciiDirName(p)
  })
  let out = mapped.join('/')
  // 目录级去重，避免两个不同中文目录撞成同名
  let candidate = out
  let i = 2
  while (usedDirs.has(candidate.toLowerCase())) candidate = `${out}-${i++}`
  usedDirs.add(candidate.toLowerCase())
  dirTargets.set(key, candidate)
  return candidate
}


/** 递归遍历并建立 原相对路径 → 新相对路径 的映射 */
const map = new Map()
const usedNames = new Map() // 每个目标目录一份去重表
function planTree(rel = '') {
  const dir = join(srcDir, rel)
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // VTS 专属文件不需要
    if (/\.vtube\.json$/i.test(e.name) || /^items_pinned_to_model\.json$/i.test(e.name)) {
      console.log(`  跳过 VTS 专属文件 ${e.name}`)
      continue
    }
    const childRel = rel ? join(rel, e.name) : e.name
    if (e.isDirectory()) {
      planTree(childRel)
      continue
    }
    const newDir = targetDir(rel)
    const { stem, ext } = splitName(e.name)
    const base = asciiStem(stem) || 'file'
    if (!usedNames.has(newDir)) usedNames.set(newDir, new Set())
    const seen = usedNames.get(newDir)
    let name = base + ext
    let i = 2
    while (seen.has(name.toLowerCase())) name = `${base}-${i++}${ext}`
    seen.add(name.toLowerCase())
    map.set(childRel.split(/[\\/]/).join('/'), (newDir ? newDir + '/' : '') + name)
  }
}
planTree()

// 实际拷贝
rmSync(DEST, { recursive: true, force: true })
let bytes = 0
for (const [oldRel, newRel] of map) {
  const from = join(srcDir, oldRel)
  const to = join(DEST, newRel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  bytes += statSync(to).size
}
console.log(`\n复制 ${map.size} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB`)

// ---------------------------------------------------------------- 改写引用

/** 把原相对路径换成新相对路径（统一用 / 分隔） */
function remap(p) {
  if (!p) return p
  const key = p.split(/[\\/]/).join('/')
  return map.get(key) || key
}

const refs = manifest.FileReferences || {}
const newRefs = {
  Moc: remap(refs.Moc),
  Textures: (refs.Textures || []).map(remap),
}
if (refs.Physics) newRefs.Physics = remap(refs.Physics)
if (refs.Pose) newRefs.Pose = remap(refs.Pose)
if (refs.DisplayInfo) newRefs.DisplayInfo = remap(refs.DisplayInfo)

// --- 补 Expressions：磁盘上所有 .exp3.json 都登记上，名字取 ASCII 主名
const expFiles = [...map.entries()].filter(([old]) => old.toLowerCase().endsWith('.exp3.json'))
if (refs.Expressions?.length) {
  newRefs.Expressions = refs.Expressions.map((e) => ({ Name: e.Name, File: remap(e.File) }))
} else if (expFiles.length) {
  newRefs.Expressions = expFiles.map(([, nw]) => ({
    Name: basename(nw).replace(/\.exp3\.json$/i, ''),
    File: nw,
  }))
  console.log(`\n补上 ${newRefs.Expressions.length} 个表情登记（原 model3.json 里没有）：`)
  for (const e of newRefs.Expressions) console.log(`   ${e.Name}  →  ${e.File}`)
}

// --- 补 Motions：磁盘上所有 .motion3.json 登记进一个组
const motFiles = [...map.entries()].filter(([old]) => old.toLowerCase().endsWith('.motion3.json'))
if (refs.Motions && Object.keys(refs.Motions).length) {
  newRefs.Motions = {}
  for (const [g, list] of Object.entries(refs.Motions)) {
    newRefs.Motions[g] = list.map((m) => ({ ...m, File: remap(m.File) }))
  }
} else if (motFiles.length) {
  /**
   * 组名怎么定：这个模型只有「挥手」一个动作，放 Idle 里会变成每隔几秒挥一次手，很怪；
   * 放 TapBody 里就是「戳她一下，她挥手」—— 自然得多。
   * 所以单个动作的模型一律登记成 TapBody。
   */
  const group = motFiles.length === 1 ? 'TapBody' : 'Idle'
  newRefs.Motions = {
    [group]: motFiles.map(([, nw]) => ({ File: nw, FadeInTime: 0.4, FadeOutTime: 0.6 })),
  }
  console.log(`\n补上 ${motFiles.length} 个动作登记，组名「${group}」：`)
  for (const m of newRefs.Motions[group]) console.log(`   ${m.File}`)
  if (group === 'TapBody') console.log('   （只有一个动作，所以放 TapBody —— 戳她一下才挥手，比每隔几秒自动挥自然）')

  // VTS 的 hotkey 动画经常标成 Loop:true（VTS 自己控制播几次）。
  // pixi-live2d-display 会老老实实**一直循环**，挥手挥个不停。改成单次。
  for (const [, nw] of motFiles) {
    const p = join(DEST, nw)
    try {
      const mo = JSON.parse(readFileSync(p, 'utf8'))
      if (mo.Meta && mo.Meta.Loop === true) {
        mo.Meta.Loop = false
        writeFileSync(p, JSON.stringify(mo, null, 2) + '\n', 'utf8')
        console.log(`   把 ${nw} 的 Meta.Loop 从 true 改成 false（否则会一直循环挥手）`)
      }
    } catch (e) {
      console.log(`   ⚠️ 改 ${nw} 的 Loop 失败：${e.message}`)
    }
  }
}

const outManifest = {
  Version: manifest.Version ?? 3,
  FileReferences: newRefs,
  Groups: manifest.Groups || [],
}
const outPath = join(DEST, basename(remap(basename(model3Path))))
writeFileSync(outPath, JSON.stringify(outManifest, null, 2) + '\n', 'utf8')
console.log(`\n写出 ${outPath.replace(ROOT + '\\', '')}`)

// ---------------------------------------------------------------- 贴图降采样
//
// 为什么要做：这个模型的两个贴图是 4096²，解码后 134 MB 显存。
// 而窗口最宽也就 828px（180% 缩放）——纯浪费。实测降到 2048 之后
// 待机 CPU 从 59% 掉到 26.6%（单核），内存 661→478 MB，画质看不出差别。
//
// 所以写进安装流程。不然每次重装都会悄悄退回 4096，白白烧资源。

/** 从 PNG 的 IHDR 块读尺寸（固定在第 16~24 字节） */
function pngSize(file) {
  const b = readFileSync(file)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

const MAX_TEX = Number((process.argv.find((a) => a.startsWith('--max-texture=')) || '').split('=')[1]) || 2048
const SKIP_TEX = process.argv.includes('--keep-texture-size')

if (!SKIP_TEX) {
  const texes = newRefs.Textures.map((t) => join(DEST, t))
  const big = texes.filter((p) => {
    const s = pngSize(p)
    return s && (s.w > MAX_TEX || s.h > MAX_TEX)
  })
  if (big.length) {
    console.log(`\n贴图降采样到 ${MAX_TEX}²（原图备份到 orig/）：`)
    // 用 PowerShell 的 System.Drawing —— Node 没有内置图像库，为这一步装依赖不值得
    const script = big
      .map((p) => {
        const dir = dirname(p)
        const name = basename(p)
        return `
$dir = '${dir.replace(/'/g, "''")}'
$name = '${name.replace(/'/g, "''")}'
New-Item -ItemType Directory -Force -Path (Join-Path $dir 'orig') | Out-Null
$dst = Join-Path $dir "orig\\$name"
if (-not (Test-Path $dst)) { Copy-Item (Join-Path $dir $name) $dst }
$img = [System.Drawing.Image]::FromFile((Join-Path $dir $name))
$bmp = New-Object System.Drawing.Bitmap ${MAX_TEX}, ${MAX_TEX}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($img, 0, 0, ${MAX_TEX}, ${MAX_TEX})
$g.Dispose(); $img.Dispose()
$bmp.Save((Join-Path $dir $name), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "$name ok"
`
      })
      .join('\n')

    try {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Drawing\n${script}`],
        { encoding: 'utf8', timeout: 300000 }
      )
      for (const line of out.trim().split(/\r?\n/).filter(Boolean)) console.log(`   ${line}`)
      for (const p of big) {
        const s = pngSize(p)
        console.log(`   ${basename(p)} → ${s.w}x${s.h}  ${(statSync(p).size / 1024 / 1024).toFixed(2)} MB`)
      }
    } catch (e) {
      console.log(`   ⚠️ 降采样失败（不影响使用，只是费显存）：${e.message.slice(0, 200)}`)
      console.log('   可以手动缩，或加 --keep-texture-size 跳过')
    }
  }
}

// ---------------------------------------------------------------- 设为默认

if (SET_DEFAULT) {
  const idx = join(ROOT, 'assets', 'models', 'index.json')
  const rel = `${NAME}/${basename(remap(basename(model3Path)))}`
  writeFileSync(idx, JSON.stringify({ model: NAME, path: rel }, null, 2) + '\n', 'utf8')
  console.log(`已设为默认模型：assets/models/index.json → ${rel}`)
}

console.log('\n完成。')
