import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runOfficeCommand, officeRunnerDiagnostics } from '../electron/services/office-command-runner.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-office-runner-'))
const fixture = path.resolve('scripts/fixtures/office-runner-process.mjs')
const log = path.join(root, 'commands.jsonl')
const run = (name, duration, signal) => runOfficeCommand(process.execPath, [fixture, path.join(root, `${name}.xlsx`), String(duration), log], { signal })
try {
  const results = await Promise.all(Array.from({ length: 7 }, (_, index) => run(`parallel-${index}`, 140)))
  for (const result of results) { const data = JSON.parse(result.stdout); assert.equal(data.noResident, '1'); assert.equal(data.flush, 'each') }
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  let active = 0, peak = 0
  for (const event of events) { active += event.type === 'start' ? 1 : -1; peak = Math.max(peak, active); assert(active >= 0 && active <= 3) }
  assert.equal(peak, 3); assert.equal(active, 0)

  const first = run('ordered', 500)
  const controller = new AbortController()
  const started = Date.now()
  const second = run('ordered', 100, controller.signal)
  setTimeout(() => controller.abort(new Error('cancel queued')), 30)
  await assert.rejects(second, /cancel queued/)
  assert(Date.now() - started < 350, 'Queue cancellation must return without waiting for the predecessor')
  const third = run('ordered', 100)
  const [firstResult, thirdResult] = await Promise.all([first, third])
  assert(JSON.parse(thirdResult.stdout).started >= JSON.parse(firstResult.stdout).ended, 'Cancellation must not break per-file ordering')
  const ordered = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((item) => item.filePath.endsWith('/ordered.xlsx'))
  assert.equal(ordered.length, 4, 'Cancelled queued command must not spawn')

  const runningAbort = new AbortController()
  const running = run('running-abort', 5_000, runningAbort.signal)
  setTimeout(() => runningAbort.abort(new Error('cancel running')), 180)
  await assert.rejects(running, /cancel running/)
  const fresh = await run('running-abort', 5)
  assert(fresh.stdout)
  assert.deepEqual(officeRunnerDiagnostics(), { active: 0, waiting: 0, queuedFiles: 0, maxProcesses: 3 })
  console.log('Office runner regression passed: bounded 3 processes, consistent persistence, ordered cancellation, killed running command and queue recovery')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
