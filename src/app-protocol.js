const fs = require('node:fs')
const path = require('node:path')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' }
const inside = (base, target) => { const rel = path.relative(base, target); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) }
function resolvePetFile(rawUrl, { root, ttsDir, singingDir }) {
  let url, rel
  try { url = new URL(rawUrl); rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') }
  catch { return { status: 400 } }
  if (url.protocol !== 'pet:' || url.host !== 'app') return { status: 404 }
  if (rel.includes('\\') || rel.includes('\0') || rel.split('/').some(p => p === '..' || p === '.')) return { status: 403 }
  const routes = [
    ['src/renderer/', path.join(root, 'src/renderer'), new Set(['.html', '.js', '.css'])],
    ['vendor/', path.join(root, 'vendor'), new Set(['.js'])],
    ['assets/models/', path.join(root, 'assets/models'), new Set(['.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.moc3'])],
    ['audio/tts/', ttsDir, new Set(['.wav', '.mp3', '.ogg'])],
    ['audio/singing/', singingDir, new Set(['.wav', '.mp3', '.ogg'])],
  ]
  const route = routes.find(([prefix]) => rel.startsWith(prefix))
  if (!route) return { status: 403 }
  const [prefix, base, extensions] = route
  const file = path.resolve(base, rel.slice(prefix.length))
  if (!inside(path.resolve(base), file) || !extensions.has(path.extname(file).toLowerCase())) return { status: 403 }
  try {
    if (!fs.statSync(file).isFile()) return { status: 404 }
    if (!inside(fs.realpathSync(base), fs.realpathSync(file))) return { status: 403 }
  } catch { return { status: 404 } }
  return { status: 200, file, type: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }
}
module.exports = { resolvePetFile }
