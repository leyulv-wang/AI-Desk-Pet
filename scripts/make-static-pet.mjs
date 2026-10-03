/**
 * 生成静态立绘的示例素材（占位图 + 清单）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要有这个脚本
 * ─────────────────────────────────────────────────────────────────────
 * 静态立绘这条路的问题是「没有图就是白屏」。用户切到 static 之后
 * 手里一张图都没有 —— 得先画 8 张表情差分才能看到效果，门槛太高，
 * 大概率就放弃了。
 *
 * 所以给一套**能立刻跑起来的占位图**：形状简陋但表情确实不一样，
 * 切情绪能看出换图了。之后把自己的画（或 AI 生成的图）覆盖同名文件即可。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么用 SVG 而不是 PNG
 * ─────────────────────────────────────────────────────────────────────
 *   ① Node 没有内置 PNG 编码器 —— 要么拉个依赖，要么手写编码器，都不值
 *   ② SVG 就是文本，可以**直接拼字符串**生成，零依赖
 *   ③ `<img src>` 对 SVG 的支持和 PNG 一样（含 drawImage / naturalWidth，
 *      所以点击的像素级命中判定照样работает）
 *   ④ 矢量图放大不糊，窗口拉大也清楚
 *
 * 唯一要注意的是 SVG 必须有**显式的 width/height** —— 否则 `<img>` 拿不到
 * intrinsic size，`naturalWidth` 是 0，像素命中判定会直接返回 false。
 *
 * 用法：
 *   node scripts/make-static-pet.mjs                 # 生成到 assets/models/StaticDemo/
 *   node scripts/make-static-pet.mjs --name MyPet    # 指定名字
 *   node scripts/make-static-pet.mjs --force         # 覆盖已有文件
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODELS = path.join(ROOT, 'assets', 'models')

const argv = process.argv.slice(2)
const argOf = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const NAME = argOf('--name') || 'StaticDemo'
const FORCE = argv.includes('--force')
const OUT = path.join(MODELS, NAME)

/**
 * 8 个情绪，和 emotion.js 的中文类别一一对应。
 * 键用中文 —— static-pet.js 的 ALIAS 表两套都认（中文或 happy/sad 这种英文），
 * 这里用中文是为了让「键和情绪类别同名」这件事一眼可见。
 */
const EMOTIONS = [
  { key: '平静', color: '#8fb8d8', eye: 'round', mouth: 'line' },
  { key: '开心', color: '#f7c948', eye: 'happy', mouth: 'smile' },
  { key: '得意', color: '#f08a5d', eye: 'smug', mouth: 'smirk' },
  { key: '惊讶', color: '#a29bfe', eye: 'wide', mouth: 'o' },
  { key: '生气', color: '#e05c5c', eye: 'angry', mouth: 'frown' },
  { key: '难过', color: '#6c8ebf', eye: 'sad', mouth: 'sad' },
  { key: '温柔', color: '#f2a6c0', eye: 'gentle', mouth: 'smile' },
  { key: '无奈', color: '#9aa5b1', eye: 'wry', mouth: 'wry' },
]

const W = 420
const H = 640

/** 眼睛。每种情绪一对，参数化位置省得写 8 份坐标 */
function eyes(kind) {
  const L = 150
  const R = 270
  const Y = 250
  const dot = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#2b2b33"/>`
  switch (kind) {
    case 'happy':
      // 弯月眼：两条上凸的弧
      return `<path d="M${L - 26},${Y + 8} q26,-34 52,0" stroke="#2b2b33" stroke-width="9" fill="none" stroke-linecap="round"/>
              <path d="M${R - 26},${Y + 8} q26,-34 52,0" stroke="#2b2b33" stroke-width="9" fill="none" stroke-linecap="round"/>`
    case 'smug':
      return `${dot(L, Y, 15)}${dot(R, Y, 15)}
              <path d="M${L - 30},${Y - 34} l56,10" stroke="#2b2b33" stroke-width="8" stroke-linecap="round"/>
              <path d="M${R - 26},${Y - 34} l56,4" stroke="#2b2b33" stroke-width="8" stroke-linecap="round"/>`
    case 'wide':
      return `${dot(L, Y, 22)}${dot(R, Y, 22)}
              <circle cx="${L}" cy="${Y}" r="7" fill="#fff"/><circle cx="${R}" cy="${Y}" r="7" fill="#fff"/>`
    case 'angry':
      return `${dot(L, Y + 4, 15)}${dot(R, Y + 4, 15)}
              <path d="M${L - 32},${Y - 40} l60,22" stroke="#2b2b33" stroke-width="9" stroke-linecap="round"/>
              <path d="M${R + 32},${Y - 40} l-60,22" stroke="#2b2b33" stroke-width="9" stroke-linecap="round"/>`
    case 'sad':
      return `${dot(L, Y + 6, 14)}${dot(R, Y + 6, 14)}
              <path d="M${L - 30},${Y - 36} l56,-12" stroke="#2b2b33" stroke-width="8" stroke-linecap="round"/>
              <path d="M${R + 30},${Y - 36} l-56,-12" stroke="#2b2b33" stroke-width="8" stroke-linecap="round"/>`
    case 'gentle':
      return `<path d="M${L - 26},${Y} q26,-24 52,0" stroke="#2b2b33" stroke-width="8" fill="none" stroke-linecap="round"/>
              <path d="M${R - 26},${Y} q26,-24 52,0" stroke="#2b2b33" stroke-width="8" fill="none" stroke-linecap="round"/>`
    case 'wry':
      return `${dot(L, Y, 13)}${dot(R, Y, 13)}
              <path d="M${L - 28},${Y - 30} l54,-8" stroke="#2b2b33" stroke-width="7" stroke-linecap="round"/>
              <path d="M${R + 28},${Y - 30} l-54,14" stroke="#2b2b33" stroke-width="7" stroke-linecap="round"/>`
    default:
      return `${dot(L, Y, 15)}${dot(R, Y, 15)}`
  }
}

/** 嘴 */
function mouth(kind) {
  const X = 210
  const Y = 320
  switch (kind) {
    case 'smile':
      return `<path d="M${X - 42},${Y - 6} q42,44 84,0" stroke="#2b2b33" stroke-width="9" fill="none" stroke-linecap="round"/>`
    case 'smirk':
      return `<path d="M${X - 36},${Y} q40,26 78,-14" stroke="#2b2b33" stroke-width="9" fill="none" stroke-linecap="round"/>`
    case 'o':
      return `<ellipse cx="${X}" cy="${Y + 8}" rx="20" ry="26" fill="#2b2b33"/>`
    case 'frown':
      return `<path d="M${X - 42},${Y + 14} q42,-40 84,0" stroke="#2b2b33" stroke-width="9" fill="none" stroke-linecap="round"/>`
    case 'sad':
      return `<path d="M${X - 38},${Y + 12} q38,-34 76,0" stroke="#2b2b33" stroke-width="8" fill="none" stroke-linecap="round"/>`
    case 'wry':
      return `<path d="M${X - 34},${Y + 4} l68,0" stroke="#2b2b33" stroke-width="9" stroke-linecap="round"/>`
    default:
      return `<path d="M${X - 32},${Y} l64,0" stroke="#2b2b33" stroke-width="8" stroke-linecap="round"/>`
  }
}

/**
 * 一张立绘。
 *
 * 注意 width/height 必须写死在 <svg> 上 —— 见文件头第 ④ 条，
 * 不然 <img> 的 naturalWidth 是 0，像素命中判定会失效。
 */
function svg(e) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="none"/>
  <!-- 身体 -->
  <path d="M210,392 C118,392 74,470 66,560 L60,640 L360,640 L354,560 C346,470 302,392 210,392 Z" fill="${e.color}" opacity="0.92"/>
  <!-- 头 -->
  <circle cx="210" cy="258" r="126" fill="${e.color}"/>
  <!-- 刘海，给个「有头发」的暗示 -->
  <path d="M92,238 C104,140 172,116 210,116 C248,116 316,140 328,238 C300,196 262,176 210,176 C158,176 120,196 92,238 Z" fill="#2b2b33" opacity="0.18"/>
  ${eyes(e.eye)}
  ${mouth(e.mouth)}
  <!-- 腮红 -->
  <ellipse cx="132" cy="300" rx="24" ry="13" fill="#ff8fb0" opacity="0.35"/>
  <ellipse cx="288" cy="300" rx="24" ry="13" fill="#ff8fb0" opacity="0.35"/>
  <text x="210" y="620" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC',sans-serif"
        font-size="30" fill="#ffffff" opacity="0.85">${e.key}</text>
</svg>
`
}

// ---------------------------------------------------------------- 执行
fs.mkdirSync(OUT, { recursive: true })

let made = 0
let skipped = 0
const images = {}
for (const e of EMOTIONS) {
  const file = `${e.key}.svg`
  images[e.key] = file
  const dest = path.join(OUT, file)
  if (fs.existsSync(dest) && !FORCE) {
    skipped++
    continue
  }
  fs.writeFileSync(dest, svg(e), 'utf8')
  made++
}

console.log(`素材目录：${path.relative(ROOT, OUT)}`)
console.log(`  生成 ${made} 张，跳过 ${skipped} 张（已存在；要覆盖加 --force）`)

// ---------------------------------------------------------------- 清单
//
// index.json 同时装两件事：
//   · path / model —— Live2D 那条路用的（哪个模型）
//   · static       —— 静态立绘这条路用的（图片在哪、哪个是默认）
// 两条路互不干扰：用哪条由 config.json 的 renderer 决定。
const indexPath = path.join(MODELS, 'index.json')
let index = {}
if (fs.existsSync(indexPath)) {
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  } catch {
    console.warn('  ⚠️ 现有 index.json 解析失败，将重建')
  }
}

index.staticDir = NAME
index.static = {
  _说明: '静态立绘的图片清单。键用中文情绪类别或 happy/sad/angry 这类英文名（两种都认）。',
  _default: '平时显示哪张（键名）',
  default: '平静',
  images,
  _talk: '可选：说话时显示哪张（不写就沿用当前情绪图）',
  talk: null,
  _idleEmotions: '待机时随机切这几张，做出「活着」的感觉',
  idleEmotions: ['开心', '得意', '温柔', '惊讶'],
  _idleIntervalSec: '待机切换的间隔区间（秒）',
  idleIntervalSec: [12, 25],
}

fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log(`清单已更新：${path.relative(ROOT, indexPath)}`)
console.log('')
console.log('下一步：把 config.json 里的 renderer 改成 "static"，然后重启桌宠。')
console.log('换成自己的画时，覆盖同名文件即可 —— 或者把 index.json 里 static.images 改成你的文件名。')
