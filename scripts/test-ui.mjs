import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ui-test-'))
const env = { ...process.env, PET_UI_TEST_DIR: dir }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [path.join(import.meta.dirname, 'test-ui-electron.cjs'), ...process.argv.slice(2)], {
  env, windowsHide: true, encoding: 'utf8', timeout: 30000,
})
process.stdout.write(result.stdout || '')
if (result.status !== 0) process.stderr.write(result.stderr || String(result.error || 'UI test failed'))
if (path.dirname(path.resolve(dir)) === path.resolve(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
process.exit(result.status ?? 1)
