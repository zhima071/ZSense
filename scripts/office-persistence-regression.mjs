import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'
import { runOfficeCommand, officeRunnerDiagnostics } from '../electron/services/office-command-runner.mjs'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-office-persistence-'))
const toolPath = path.resolve(`bundled-tools/${process.platform}-${process.arch}/officecli${process.platform === 'win32' ? '.exe' : ''}`)
const hash = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const cli = async (...args) => JSON.parse((await runOfficeCommand(toolPath, [...args, '--json'])).stdout)
let batchCalls = 0
let failSecondBatch = false
const service = new OfficeWorkspaceService({ userDataDirectory: temporaryRoot, toolPaths: [toolPath], commandRunner: async (executable, args, options) => {
  if (args[0] === 'batch') {
    batchCalls += 1
    if (failSecondBatch && batchCalls === 2) throw new Error('Injected second batch failure')
  }
  return runOfficeCommand(executable, args, options)
} })

try {
  const filePath = path.join(temporaryRoot, 'save-regression.xlsx')
  await cli('create', filePath)
  await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A1', value: 'baseline' }] })
  await service.saveWorkbook({ filePath })
  const baselineHash = hash(filePath)
  await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A1', value: 'edited', style: { bold: true } }] })
  const undo = await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A1', value: 'baseline', style: {}, styleSnapshot: true }] })
  assert.equal(undo.pendingCount, 0, 'Undo must remove stale backend content and style deltas')
  assert.equal(undo.dirty, false)
  assert.equal((await service.saveWorkbook({ filePath })).saved, 0)
  assert.equal(hash(filePath), baselineHash)

  await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A1', value: 'merged' }] })
  await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A1', contentChanged: false, style: { bold: true } }] })
  await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A1', contentChanged: false, style: { italic: true } }] })
  await service.saveWorkbook({ filePath })
  await service.discardWorkbook({ filePath })
  const merged = (await service.getSheet({ filePath, sheet: 'Sheet1' })).cells.A1
  assert.equal(merged.value, 'merged')
  assert.equal(merged.style.bold, true)
  assert.equal(merged.style.italic, true, 'Partial sequential deltas must merge, not replace')
  await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A1', value: 'temporary', style: { bold: true, italic: true }, styleSnapshot: true }] })
  const formattedUndo = await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A1', value: 'merged', style: { bold: true, italic: true }, styleSnapshot: true }] })
  assert.equal(formattedUndo.pendingCount, 0, 'CLI empty style strings and missing UI style values must have the same default semantics')

  const beforeInvalid = await service.getWorkbook({ filePath })
  await assert.rejects(service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'A2', value: 'must-not-stage' }, { sheet: 'Missing', cell: 'A1', value: 'bad' }] }), /不存在/)
  assert.equal((await service.getWorkbook({ filePath })).pendingCount, beforeInvalid.pendingCount)
  assert.equal((await service.getSheet({ filePath, sheet: 'Sheet1' })).cells.A2, undefined)

  const changes = Array.from({ length: 205 }, (_, index) => ({ sheet: 'Sheet1', cell: `B${index + 1}`, value: index + 1 }))
  await service.stageCells({ filePath, changes })
  await service.stageOperations({ filePath, operations: [{ action: 'insertRows', sheet: 'Sheet1', index: 0, count: 1 }] })
  const beforeBatch = hash(filePath)
  batchCalls = 0; failSecondBatch = true
  await assert.rejects(service.saveWorkbook({ filePath }), /Injected second batch failure/)
  assert.equal(hash(filePath), beforeBatch, 'A later batch failure must leave original bytes untouched')
  assert.equal((await service.getWorkbook({ filePath })).pendingCount, 206)
  assert.equal(fs.readdirSync(temporaryRoot).filter((name) => name.startsWith('.save-regression.zsense-')).length, 0, 'Failed transaction temporary file must be removed')
  batchCalls = 0; failSecondBatch = false
  assert.equal((await service.saveWorkbook({ filePath })).saved, 206)
  await service.discardWorkbook({ filePath })
  const grid = await service.getSheet({ filePath, sheet: 'Sheet1' })
  assert.equal(grid.cells.A1, undefined)
  assert.equal(grid.cells.A2.value, 'merged', 'Retry must insert only one row, not repeat a partial original edit')
  assert.equal(grid.cells.B205.value, '205')

  await service.stageCells({ filePath, changes: [{ sheet: 'Sheet1', cell: 'C1', value: 'draft' }] })
  await cli('set', filePath, '/Sheet1/C1', '--prop', 'value=external')
  const externalHash = hash(filePath)
  await assert.rejects(service.saveWorkbook({ filePath }), /其他程序修改/)
  assert.equal(hash(filePath), externalHash)
  assert.equal((await service.getWorkbook({ filePath })).dirty, true, 'External conflict must preserve draft')
  await assert.rejects(service.runOfficeCommand(['set', filePath, '/Sheet1/D1', '--prop', 'value=raw']), /尚未保存/)
  await assert.rejects(service.runOfficeCommand(['--json', 'create', path.basename(filePath), '--force'], { cwd: temporaryRoot }), /尚未保存/)
  assert.equal(hash(filePath), externalHash, 'Leading global flags must not bypass draft or atomicity guards')
  await assert.rejects(service.runOfficeCommand(['create', '--force', path.basename(filePath)], { cwd: temporaryRoot }), /文件路径必须紧跟/)
  await service.discardWorkbook({ filePath })
  await service.runOfficeCommand(['set', filePath, '/Sheet1/D1', '--prop', 'value=raw'])
  assert.equal((await service.getSheet({ filePath, sheet: 'Sheet1' })).cells.D1.value, 'raw')
  const beforeRawFailure = hash(filePath)
  await assert.rejects(service.runOfficeCommand(['batch', filePath, '--commands', JSON.stringify([{ command: 'set', path: '/Sheet1/E1', props: { value: 'partial-must-not-commit' } }, { command: 'set', path: '/Missing/A1', props: { value: 'invalid' } }]), '--json']))
  assert.equal(hash(filePath), beforeRawFailure, 'Raw Agent CLI failure must also leave original bytes untouched')

  const csvPath = path.join(temporaryRoot, 'save-regression.csv')
  fs.writeFileSync(csvPath, 'title,value\r\nfirst,1\r\n')
  const csv = await service.getWorkbook({ filePath: csvPath })
  const sheet = csv.sheets[0].sheet
  await service.stageCells({ filePath: csvPath, changes: [{ sheet, cell: 'B2', value: 2 }] })
  await service.stageCells({ filePath: csvPath, changes: [{ sheet, cell: 'B2', value: 1 }] })
  assert.equal((await service.saveWorkbook({ filePath: csvPath })).saved, 0)
  await service.stageCells({ filePath: csvPath, changes: [{ sheet, cell: 'B2', value: 3 }] })
  await service.saveWorkbook({ filePath: csvPath })
  assert.equal(fs.readFileSync(csvPath, 'utf8'), 'title,value\r\nfirst,3\r\n')
  assert.deepEqual(officeRunnerDiagnostics(), { active: 0, waiting: 0, queuedFiles: 0, maxProcesses: 3 })
  console.log('Office persistence regression passed: undo/style merge, invalid requests, atomic batch failure/retry, conflicts, raw Agent synchronization and CSV')
} finally {
  // Only isolated files created by this test.
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
