/**
 * 拉取运行时资源到本地，让桌宠之后可以完全离线运行。
 *
 *   node scripts/fetch-assets.mjs
 *
 * 下载两类东西：
 *   1) vendor/  —— 三个前端库（PixiJS / Live2D Cubism Core / pixi-live2d-display）
 *   2) assets/models/<名字>/ —— Live2D 模型本体（默认 Hiyori，Cubism 官方示例）
 *
 * 已存在的文件会跳过，可以反复执行。
 */
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- 配置

const VENDOR = [
  {
    file: 'pixi.min.js',
    url: 'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
    note: 'PixiJS 6（pixi-live2d-display 0.4.0 要求 v6，不能升 v7/v8）',
  },
  {
    file: 'unsafe-eval.min.js',
    url: 'https://cdn.jsdelivr.net/npm/@pixi/unsafe-eval@6.5.10/dist/browser/unsafe-eval.min.js',
    note: '让 Pixi 6 在禁止 eval 的 CSP 下也能编译着色器（MIT）',
  },
  {
    file: 'live2dcubismcore.min.js',
    url: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
    note: 'Live2D Cubism Core（专有文件，仅供本机自用，切勿提交到公开仓库）',
  },
  {
    file: 'cubism4.min.js',
    url: 'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js',
    note: 'pixi-live2d-display 的 Cubism 4 完整包（UMD，挂到 PIXI.live2d）',
  },
]

const MODEL = {
  name: process.env.PET_MODEL || 'Hiyori',
  // Live2D 官方 CubismWebSamples 里的示例模型，Cubism 4 格式
  base: `https://cdn.jsdelivr.net/gh/Live2D/CubismWebSamples@develop/Samples/Resources/${
    process.env.PET_MODEL || 'Hiyori'
  }/`,
}

// ---------------------------------------------------------------- 工具

async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

async function download(url, dest, label) {
  if (await exists(dest)) {
    console.log(`  = 已存在，跳过  ${label}`)
    return
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}  ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buf)
  console.log(`  + ${(buf.length / 1024).toFixed(0).padStart(6)} KB  ${label}`)
}

/** 从 model3.json 里把所有相对资源路径挖出来（不写死字段名，兼容各种模型） */
function collectAssetPaths(node, out = new Set()) {
  if (typeof node === 'string') {
    const looksLikeAsset = /\.(moc3|png|jpe?g|webp|json)$/i.test(node)
    const isRelative = !/^(https?:)?\/\//i.test(node) && !node.startsWith('data:')
    if (looksLikeAsset && isRelative) out.add(node.replace(/^\.\//, ''))
  } else if (Array.isArray(node)) {
    for (const v of node) collectAssetPaths(v, out)
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectAssetPaths(v, out)
  }
  return out
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log('\n[1/2] 前端库 → vendor/')
  for (const v of VENDOR) {
    await download(v.url, join(ROOT, 'vendor', v.file), `${v.file}  (${v.note})`)
  }

  console.log(`\n[2/2] Live2D 模型「${MODEL.name}」→ assets/models/${MODEL.name}/`)
  const settingsUrl = `${MODEL.base}${MODEL.name}.model3.json`
  const res = await fetch(settingsUrl)
  if (!res.ok) throw new Error(`拿不到 ${settingsUrl} (HTTP ${res.status})`)
  const settings = await res.json()

  const modelDir = join(ROOT, 'assets', 'models', MODEL.name)
  // 设置文件本身也要存
  await mkdir(modelDir, { recursive: true })
  await writeFile(join(modelDir, `${MODEL.name}.model3.json`), JSON.stringify(settings, null, 2))

  const assets = [...collectAssetPaths(settings)].sort()
  console.log(`  （设置文件引用了 ${assets.length} 个资源）`)
  for (const rel of assets) {
    await download(MODEL.base + rel, join(modelDir, rel), `${MODEL.name}/${rel}`)
  }

  // 写一份清单，渲染层靠它知道当前装的是哪个模型
  await writeFile(
    join(ROOT, 'assets', 'models', 'index.json'),
    JSON.stringify({ model: MODEL.name, path: `${MODEL.name}/${MODEL.name}.model3.json` }, null, 2)
  )
  console.log(`  + 清单  assets/models/index.json`)

  console.log('\n完成。接下来：\n  npm start\n')
  console.log('提示：模型为 Live2D 官方示例素材，依 Live2D 官方条款使用；')
  console.log('      live2dcubismcore.min.js 是专有文件，仅供本机运行，不要提交到公开仓库。\n')
}

main().catch((e) => {
  console.error('\n拉取失败：', e.message)
  console.error('可以重跑 `npm run setup`，已下载的会跳过。\n')
  process.exit(1)
})
