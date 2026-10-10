import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { buildMacScreenPermission } from './build-mac-screen-permission.mjs'

if (process.platform !== 'darwin') {
  console.log('macOS screen permission load-only regression skipped on non-macOS.')
} else {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-screen-permission-load-test-'))
  try {
    const report = buildMacScreenPermission({ outputPath: path.join(temporaryDirectory, 'screen-permission.node') })
    const loadOnlyScript = `
      const assert = require('node:assert/strict');
      const permission = require(${JSON.stringify(report.outputPath)});
      assert.deepEqual(Reflect.ownKeys(permission), ['requestScreenCapturePermission']);
      assert.equal(typeof permission.requestScreenCapturePermission, 'function');
      console.log('load-only OK; no permission function called');
    `
    const electronPath = createRequire(import.meta.url)('electron')
    for (const [name, executable, environment] of [
      ['Node', process.execPath, { ...process.env }],
      ['Electron Node runtime', electronPath, { ...process.env, ELECTRON_RUN_AS_NODE: '1' }],
    ]) {
      const result = spawnSync(executable, ['-e', loadOnlyScript], { encoding: 'utf8', env: environment, timeout: 30_000 })
      assert.equal(result.error, undefined, `${name}: ${result.error?.message}`)
      assert.equal(result.status, 0, `${name}: ${result.stderr}`)
      assert.match(result.stdout, /load-only OK; no permission function called/)
      console.log(`${name}: ${result.stdout.trim()}`)
    }
    assert.throws(() => buildMacScreenPermission({ arch: 'ia32' }), /Unsupported/)
    assert.throws(() => buildMacScreenPermission({ outputPath: path.join(temporaryDirectory, 'other.node') }), /must be named/)
    console.log(`macOS screen permission isolation regression passed (${report.arch}, N-API ${report.napiVersion}).`)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
