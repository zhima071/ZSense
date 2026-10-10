import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-office-preview-lifecycle-'))
let renderGate = null
let renderStarted = () => undefined
const service = new OfficeWorkspaceService({ userDataDirectory: temporaryRoot, toolPaths: [process.execPath], commandRunner: async (_executable, args) => {
  // Cache lifecycle fixtures: actual copied files, deterministic local HTML.
  assert.equal(args[0], 'view')
  renderStarted()
  if (renderGate) await renderGate
  fs.writeFileSync(args[args.indexOf('-o') + 1], '<!doctype html><html><body>Preview fixture</body></html>')
  return { stdout: '', stderr: '' }
} })
const expired = Date.now() - 4 * 60 * 60 * 1_000
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const tokenFrom = (document) => new URL(document.previewUrl).pathname.slice(1)

try {
  const imagePath = path.join(temporaryRoot, 'visible.png')
  const pdfPath = path.join(temporaryRoot, 'visible.pdf')
  const triggerPath = path.join(temporaryRoot, 'trigger.png')
  fs.writeFileSync(imagePath, imageBytes)
  fs.writeFileSync(pdfPath, '%PDF-1.4\n%%EOF\n')
  fs.writeFileSync(triggerPath, imageBytes)
  const image = await service.open(imagePath, { requestId: 'visible-image' })
  const pdf = await service.open(pdfPath, { requestId: 'visible-pdf' })
  const imageToken = tokenFrom(image)
  const pdfToken = tokenFrom(pdf)
  for (const token of [imageToken, pdfToken]) service.previewTokens.get(token).lastAccess = expired
  await service.open(triggerPath)
  assert.equal(service.previewResponse(image.previewUrl).status, 200, 'A visible image token must survive idle expiration')
  assert.equal(service.previewResponse(pdf.previewUrl).status, 200, 'A visible PDF token must survive idle expiration')

  // Count pressure must evict inactive tokens, never either visible document.
  for (let index = 0; index < 260; index += 1) {
    service.previewTokens.set(`inactive-${index}`, { kind: 'image', filePath: triggerPath, lastAccess: Date.now() - 1_000 })
  }
  for (const token of [imageToken, pdfToken]) service.previewTokens.get(token).lastAccess = expired
  await service.open(triggerPath)
  assert.equal(service.previewTokens.has(imageToken), true)
  assert.equal(service.previewTokens.has(pdfToken), true)
  assert.ok(service.previewTokens.size <= 257, 'Inactive cache pressure must be bounded (plus the current open)')

  service.cancelOpen('visible-image')
  service.cancelOpen('visible-pdf')
  for (const token of [imageToken, pdfToken]) service.previewTokens.get(token).lastAccess = expired
  await service.open(triggerPath)
  assert.equal(service.previewResponse(image.previewUrl).status, 404, 'Released expired images should become evictable')
  assert.equal(service.previewResponse(pdf.previewUrl).status, 404, 'Released expired PDFs should become evictable')
  assert.deepEqual(fs.readFileSync(imagePath), imageBytes, 'Cache eviction must never delete or alter the original image')
  assert.equal(fs.readFileSync(pdfPath, 'utf8'), '%PDF-1.4\n%%EOF\n', 'Cache eviction must never delete or alter the original PDF')

  const csvFiles = []
  for (let index = 0; index < 18; index += 1) {
    const filePath = path.join(temporaryRoot, `agent-read-${index}.csv`)
    fs.writeFileSync(filePath, 'value\n1\n')
    csvFiles.push(fs.realpathSync.native(filePath))
    await service.getWorkbook({ filePath })
  }
  assert.ok(service.workbookSessions.size <= 12, 'Agent-only workbook reads must obey the clean-session cache bound')

  const visibleCsv = csvFiles.at(-1)
  const dirtyCsv = csvFiles.at(-2)
  const savingCsv = csvFiles.at(-3)
  await service.open(visibleCsv, { requestId: 'visible-sheet' })
  const workbook = await service.getWorkbook({ filePath: dirtyCsv })
  await service.stageCells({ filePath: dirtyCsv, changes: [{ sheet: workbook.sheets[0].sheet, cell: 'A1', value: 'draft' }] })
  service.saveQueues.set(savingCsv, Promise.resolve())
  for (const filePath of [visibleCsv, dirtyCsv, savingCsv]) service.workbookSessions.get(filePath).lastAccess = expired
  await service.getWorkbook({ filePath: csvFiles.at(-4) })
  for (const filePath of [visibleCsv, dirtyCsv, savingCsv]) assert.ok(service.workbookSessions.has(filePath), 'Visible, dirty, and saving sessions must survive TTL cleanup')
  service.cancelOpen('visible-sheet')
  service.saveQueues.delete(savingCsv)
  service.workbookSessions.get(visibleCsv).lastAccess = expired
  service.workbookSessions.get(savingCsv).lastAccess = expired
  await service.getWorkbook({ filePath: csvFiles.at(-4) })
  assert.equal(service.workbookSessions.has(visibleCsv), false)
  assert.equal(service.workbookSessions.has(savingCsv), false)
  assert.equal(service.workbookSessions.has(dirtyCsv), true)

  for (let index = 0; index < 18; index += 1) {
    const filePath = path.join(temporaryRoot, `agent-read-${index}.docx`)
    fs.writeFileSync(filePath, `Isolated Word fixture ${index}`)
    await service.getWord({ filePath })
  }
  assert.ok(service.wordSessions.size <= 12, 'Agent-only Word reads must obey the clean-session cache bound')
  assert.ok(fs.readdirSync(service.wordSessionRoot).length <= 24, 'Evicted Word working and baseline copies must be reclaimed')

  const loadingWord = path.join(temporaryRoot, 'in-flight.docx')
  fs.writeFileSync(loadingWord, 'Isolated in-flight Word fixture')
  const loadingPath = fs.realpathSync.native(loadingWord)
  let releaseRender
  renderGate = new Promise((resolve) => { releaseRender = resolve })
  const started = new Promise((resolve) => { renderStarted = resolve })
  const loading = service.getWord({ filePath: loadingWord })
  await started
  const inFlightSession = service.wordSessions.get(loadingPath)
  inFlightSession.lastAccess = expired
  await service.getWorkbook({ filePath: csvFiles.at(-4) })
  assert.equal(service.wordSessions.get(loadingPath), inFlightSession, 'An in-flight load must not be evicted by unrelated completed loads')
  assert.ok(fs.existsSync(inFlightSession.workingFilePath), 'In-flight Word rendering must retain its working copy')
  assert.ok(fs.existsSync(inFlightSession.baselineFilePath))
  releaseRender()
  await loading
  renderGate = null
  console.log('Office preview lifecycle regression passed: visible image/PDF lease TTL/pressure, Agent-only Word/workbook cache bounds, dirty/saving/visible preservation, in-flight working-copy protection and source-file safety')
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
