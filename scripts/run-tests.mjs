/** 离线回归入口。真实AI、TTS和GPU推理仍使用各自显式的集成测试命令。 */
import { spawnSync } from 'node:child_process'
const suites = [
  ['--test', 'scripts/test-regressions.cjs'],
  ['scripts/test-ui.mjs'],
  ...['test-splitter.mjs', 'test-spoken.mjs', 'test-card.mjs', 'test-decay-loop.mjs',
    'test-embedding-switch.mjs', 'test-lore.mjs', 'check-wiring.mjs', 'check-pet-renderers.mjs']
    .map(file => ['scripts/' + file]),
]
let failed = 0
for (const args of suites) {
  console.log('\nRunning ' + args.join(' '))
  const result = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url), stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) { failed++; console.error(result.error?.message || `Suite exit code ${result.status}`) }
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed`)
process.exit(failed ? 1 : 0)
