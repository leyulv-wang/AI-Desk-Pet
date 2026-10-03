/**
 * 命令行跑一遍唱歌管线（不开桌宠）。
 *
 * 存在的意义是**排错**：唱歌这条链路有三段（分离 / 转换 / 混音）和两个运行时
 * （node + python）。出问题时，先确认「命令行能不能跑通」能把问题一刀切成两半 ——
 * 是管线本身不行，还是桌宠把它接坏了。
 *
 * 这个脚本只是 `singing/ddsp_cover.py` 的薄包装：找对 Python、转好路径、
 * 把参数原样透传。真正的逻辑都在 Python 里，这里不重复实现。
 *
 * 用法：
 *   npm run sing -- "songs/某首歌.mp3"
 *   npm run sing -- "<音乐目录>\某首.mp3" --chord 30          # 参数原样透传给 ddsp_cover.py
 *   npm run sing -- "songs/某首.mp3" --skip-separate        # 复用已有分离结果
 *   npm run sing -- --help                                  # 看 Python 侧全部参数
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SING = join(ROOT, 'singing')
const PIPELINE = join(SING, 'ddsp_cover.py')

const PY = [
  process.env.PET_SINGING_PYTHON,
  join(SING, '.venv-ddsp', 'Scripts', 'python.exe'),
  join(SING, '.venv-ddsp', 'bin', 'python'),
].filter(Boolean).find((p) => existsSync(p))

if (!existsSync(PIPELINE)) {
  console.error(`❌ 找不到管线：${PIPELINE}`)
  process.exit(1)
}
if (!PY) {
  console.error('❌ 找不到 singing/.venv-ddsp。先跑 `npm run sing:setup` 看缺什么。')
  process.exit(1)
}

const argv = process.argv.slice(2)

// 第一个位置参数当歌曲路径，补上 --song（ddsp_cover.py 要求显式参数）。
// 其余参数原样透传：Python 那边才是唯一的事实来源，这里不做二次解析
// （以前这里自己解析所有参数再拼命令行，两边一改就不同步）。
const args = [PIPELINE]
if (argv.length && !argv[0].startsWith('-')) {
  // 相对路径按**项目根**解析，而不是子进程的 cwd（singing/）。
  // 否则 `npm run sing -- songs/x.mp3` 会被解析成 singing/songs/x.mp3，找不到文件。
  const song = isAbsolute(argv[0]) ? argv[0] : resolve(ROOT, argv[0])
  if (!existsSync(song)) {
    console.error(`❌ 找不到歌曲：${song}`)
    process.exit(1)
  }
  args.push('--song', song, ...argv.slice(1))
} else {
  args.push(...argv)
}

console.log(`  Python  ${PY}`)
console.log(`  管线    ${PIPELINE}`)
console.log(`  参数    ${args.slice(1).join(' ') || '（无，会报缺 --song）'}`)
console.log('')

const child = spawn(PY, args, {
  cwd: SING, // rmvpe 用的是相对路径，必须在仓库同级跑
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  },
})

child.on('error', (e) => {
  console.error(`❌ 起不来 Python：${e.message}`)
  process.exit(1)
})
child.on('close', (code) => {
  if (code === 0) {
    console.log(`\n✅ 完成。产物在歌曲旁边的 <歌名>_ddsp\\ 目录（或 --outdir 指定的地方）`)
  } else {
    console.error(`\n❌ 管线退出码 ${code}`)
  }
  process.exit(code ?? 1)
})
