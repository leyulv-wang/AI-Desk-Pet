import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')
const spec = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'furina-static.json'), 'utf8'))
const models = path.join(root, 'assets/models')
const out = path.join(models, spec.staticDir)
await fs.mkdir(out, { recursive: true })
for (const image of spec.sources.images) {
  const target = path.join(out, image.file)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const existing = await fs.readFile(target).catch(e => { if (e.code !== 'ENOENT') throw e })
  if (existing?.subarray(0, 8).equals(signature) && !process.argv.includes('--refresh')) continue
  let data
  try {
    const response = await fetch(image.source, { signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error(`Download failed: ${image.file} (${response.status})`)
    data = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    // 系统 curl 可使用 Windows 已配置的代理；Node fetch 在部分网络下会重置连接。
    const temporary = target + '.download'
    try {
      await promisify(execFile)(process.platform === 'win32' ? 'curl.exe' : 'curl',
        ['--location', '--fail', '--retry', '2', '--connect-timeout', '10', '--max-time', '45', '--output', temporary, image.source], { windowsHide: true })
      data = await fs.readFile(temporary)
    } finally { await fs.rm(temporary, { force: true }) }
  }
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Not a PNG: ${image.file}`)
  await fs.writeFile(target, data)
}
await fs.writeFile(path.join(out, 'sources.json'), JSON.stringify(spec.sources, null, 2) + '\n')
const indexFile = path.join(models, 'index.json')
let manifest = {}
try {
  const raw = await fs.readFile(indexFile, 'utf8')
  manifest = JSON.parse(raw.replace(/^\uFEFF/, ''))
  const backup = path.join(models, 'index-before-furina-static.json')
  await fs.writeFile(backup, raw, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e })
} catch (e) { if (e.code !== 'ENOENT') throw e }
Object.assign(manifest, { staticDir: spec.staticDir, static: spec.static })
await fs.writeFile(indexFile, JSON.stringify(manifest, null, 2) + '\n')
if (process.argv.includes('--activate')) {
  const configFile = path.join(root, 'config.json')
  let config
  try { config = JSON.parse((await fs.readFile(configFile, 'utf8')).replace(/^\uFEFF/, '')) }
  catch (e) {
    if (e.code !== 'ENOENT') throw e
    config = JSON.parse(await fs.readFile(path.join(root, 'config.example.json'), 'utf8'))
  }
  config.renderer = 'static'
  await fs.writeFile(configFile, JSON.stringify(config, null, 2) + '\n')
}
console.log('Installed 7 Furina PNGs. Restart the pet to apply renderer changes.')
