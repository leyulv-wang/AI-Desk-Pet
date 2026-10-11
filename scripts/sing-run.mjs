/** Explicit integration command: uploads the selected reference audio and may incur API charges. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createSinging } = createRequire(import.meta.url)('../src/singing')
const arg = process.argv[2]
if (!arg) { console.error('用法：npm run sing -- songs/歌曲.mp3 [--force]（提交到云端，可能收费）'); process.exit(1) }
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))
const singing = createSinging({ root, userDataDir: process.env.PET_USER_DATA || path.join(root, '.userdata'), config: config.singing,
  getProvider: () => config.tts?.minimax || {}, log: console.log })
const input = path.resolve(root, arg), target = path.join(singing.songsDir, path.basename(input))
if (input !== target) fs.copyFileSync(input, target, fs.constants.COPYFILE_EXCL)
process.on('SIGINT', () => singing.cancel())
const result = await singing.start({ file: path.basename(target), force: process.argv.includes('--force'), onProgress: p => console.log(p.stage) })
if (!result.ok) { console.error(result.error); process.exitCode = 1 }
else console.log('完成：' + result.result.file)
