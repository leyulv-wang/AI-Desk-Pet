/**
 * 手动启动本地 GPT-SoVITS 语音服务（桌宠的嗓子）
 *   node scripts/start-voice.mjs        （或 npm run voice）
 *
 * 桌宠自己也会在启动时顺手拉这个服务（config.json 的 tts.gptsovits.autoStart）。
 * 这个脚本是给两种场景用的：
 *   · 想先单独把服务起好、再开桌宠
 *   · 桌宠的自动启动失败了，想单独看看它到底报什么错
 *
 * 逻辑和主进程共用 src/voice-server.js —— 不重复实现一遍，
 * 否则两边的搜索路径和等待逻辑迟早会走偏。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { createVoiceServer } = require(join(ROOT, 'src', 'voice-server.js'))

const PORT = Number(process.env.GPTSOVITS_PORT) || 9880
const BASE = `http://127.0.0.1:${PORT}`

const server = createVoiceServer({
  config: { baseUrl: BASE },
  configPath: join(ROOT, 'voice', 'gptsovits.pet.yaml'),
  userDataDir: join(ROOT, '.userdata'),
  searchExtra: [join(ROOT, '..', 'GPT-SoVITS')],
  log: (m) => console.log(m),
})

const root = server.findVoiceRoot()
if (!root) {
  console.error('没找到 GPT-SoVITS 整合包。试过：')
  for (const c of require(join(ROOT, 'src', 'voice-server.js')).candidateRoots([join(ROOT, '..', 'GPT-SoVITS')])) {
    console.error('  - ' + c)
  }
  console.error('\n指定一下再跑：')
  console.error('  $env:GPTSOVITS_HOME = "X:\\某处\\GPT-SoVITS-xxxx"')
  process.exit(1)
}

if (await server.probe()) {
  console.log(`端口 ${PORT} 上已经有服务在跑了，不重复启动。`)
  console.log('（如果那不是 GPT-SoVITS，设 GPTSOVITS_PORT 换端口，并同步改 config.json 的 tts.gptsovits.baseUrl）')
  process.exit(0)
}

console.log(`整合包：${root}`)
console.log(`监听：  ${BASE}`)
console.log(`日志：  ${server.logFile}`)
console.log('启动中…（v4 底模要读进显存，第一次大约 10~30 秒）\n')

const r = await server.ensure()

if (r.ok) {
  console.log(`\n✅ ${r.detail}`)
  console.log('   这个窗口要一直开着；要停服务就 Ctrl+C。')
  console.log('   ⚠️ 别用任务管理器杀，也别杀外层的 node —— 见 README 里那个「管道断掉」的坑。')
  console.log('\n按 Ctrl+C 结束。')
  // 挂着不退出，等用户 Ctrl+C
  await new Promise(() => {})
} else {
  console.error(`\n❌ ${r.detail}`)
  process.exit(1)
}
