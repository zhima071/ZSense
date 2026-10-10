#!/usr/bin/env node
// Counts actual bundled CLI work using generated fixtures; never touches user files.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'
import { runOfficeCommand } from '../electron/services/office-command-runner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-office-cache-'))
const tool = path.join(root, 'bundled-tools', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'officecli.exe' : 'officecli')
const cli = (args) => execFileSync(tool, args, { env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' }, encoding: 'utf8' })
let failed = false
const calls = []
const countedRunner = async (executable, args, options) => { calls.push([...args]); return runOfficeCommand(executable, args, options) }
try {
  const files = Object.fromEntries(['xlsx', 'docx', 'pptx'].map((extension) => [extension, path.join(temporary, `fixture.${extension}`)]))
  for (const file of Object.values(files)) cli(['create', file, '--json'])
  cli(['add', files.docx, '/body', '--type', 'paragraph', '--prop', 'text=Cached Word text', '--json'])
  cli(['add', files.pptx, '/', '--type', 'slide', '--prop', 'title=Cached presentation', '--json'])
  const controlCalls = []
  const control = new OfficeWorkspaceService({ userDataDirectory: path.join(temporary, 'control'), toolPaths: [tool],
    commandRunner: async (executable, args, options) => { controlCalls.push([...args]); return runOfficeCommand(executable, args, options) } })
  await control.getWorkbook({ filePath: files.xlsx })
  await control.getWord({ filePath: files.docx })
  await control.getPresentation({ filePath: files.pptx })
  const service = new OfficeWorkspaceService({ userDataDirectory: path.join(temporary, 'parallel'), toolPaths: [tool], commandRunner: countedRunner })
  const started = performance.now()
  const groups = await Promise.all([
    Promise.all(Array.from({ length: 6 }, () => service.getWorkbook({ filePath: files.xlsx }))),
    Promise.all(Array.from({ length: 6 }, () => service.getWord({ filePath: files.docx }))),
    Promise.all(Array.from({ length: 6 }, () => service.getPresentation({ filePath: files.pptx }))),
  ])
  const coldMs = performance.now() - started
  assert.equal(calls.length, controlCalls.length, '18 concurrent reads must invoke no more CLI processes than one read per format')
  for (const group of groups) assert.equal(new Set(group.map((session) => session.sessionId)).size, 1, 'concurrent readers must share a session')
  assert.equal(service.workbookLoads.size, 0)
  assert.equal(service.wordLoads.size, 0)
  const cachedCount = calls.length
  const warmStarted = performance.now()
  await Promise.all(Array.from({ length: 12 }, async () => {
    await service.getWorkbook({ filePath: files.xlsx })
    await service.getWord({ filePath: files.docx })
    await service.getPresentation({ filePath: files.pptx })
  }))
  const warmMs = performance.now() - warmStarted
  assert.equal(calls.length, cachedCount, 'unchanged repeated reads must not spawn another Office CLI process')

  const textCount = calls.length
  const firstText = await Promise.all(Array.from({ length: 6 }, () => service.readWordForAgent({ filePath: files.docx })))
  assert.equal(calls.length - textCount, 1, 'concurrent Agent reads must extract Word text only once per revision')
  assert(firstText.every((result) => result.content.includes('Cached Word text')))
  const cachedTextCount = calls.length
  await service.readWordForAgent({ filePath: files.docx, maxCharacters: 2000 })
  assert.equal(calls.length, cachedTextCount, 'changing read limits must reuse cached Word text')
  const current = await service.getWord({ filePath: files.docx })
  await service.stageWordOperations({ filePath: files.docx, expectedContentHash: current.baseContentHash, expectedRevision: current.sessionRevision,
    operations: [{ action: 'setText', path: '/body/p[1]', text: 'New revision text' }] })
  const afterChange = calls.length
  const changed = await service.readWordForAgent({ filePath: files.docx })
  assert.match(changed.content, /New revision text/)
  assert.equal(calls.length - afterChange, 1, 'changed Word revision must invalidate only the text cache once')
  await service.readWordForAgent({ filePath: files.docx })
  assert.equal(calls.length, afterChange + 1)

  const presentation = await service.getPresentation({ filePath: files.pptx })
  const stagedPresentation = await service.stagePresentation({ filePath: files.pptx, expectedRevision: presentation.sessionRevision,
    expectedContentHash: presentation.baseContentHash, operations: [{ path: presentation.slides[0].elements[0].path, properties: { text: 'Save reuses this preview' } }] })
  const beforePresentationSave = calls.length
  const originalFsync = fs.fsyncSync, originalRename = fs.renameSync, originalCopy = fs.copyFileSync
  const persistenceEvents = []
  let savedPresentation
  try {
    fs.fsyncSync = (descriptor) => { persistenceEvents.push('fsync'); return originalFsync(descriptor) }
    fs.renameSync = (from, to) => { if (to === fs.realpathSync.native(files.pptx)) persistenceEvents.push('rename'); return originalRename(from, to) }
    fs.copyFileSync = (from, to, flags) => { if (/\.zsense-.*\.pptx$/.test(to)) assert.equal(flags, fs.constants.COPYFILE_FICLONE, 'PPT atomic save must attempt copy-on-write'); return originalCopy(from, to, flags) }
    savedPresentation = await service.savePresentation({ filePath: files.pptx, expectedContentHash: stagedPresentation.baseContentHash, expectedRevision: stagedPresentation.sessionRevision })
  } finally { fs.fsyncSync = originalFsync; fs.renameSync = originalRename; fs.copyFileSync = originalCopy }
  assert.equal(calls.length - beforePresentationSave, 1, 'PPT save should run only its required validity check, not get/view the unchanged working copy again')
  assert.equal(calls.at(-1)[0], 'get')
  assert.deepEqual(persistenceEvents, ['fsync', 'rename'], 'the replacement file must be flushed before atomic rename')
  assert.equal(savedPresentation.document.previewUrl, stagedPresentation.document.previewUrl, 'PPT save must preserve the valid preview URL and viewport')
  assert.equal(savedPresentation.dirty, false)
  await service.getPresentation({ filePath: files.pptx })
  assert.equal(calls.length, beforePresentationSave + 1)

  // Hold a real command immediately before launch, cancel the opener, then release
  // it: production runner receives the actual aborted signal and must reject.
  let reachedView, releaseView
  const viewReached = new Promise((resolve) => { reachedView = resolve })
  const viewReleased = new Promise((resolve) => { releaseView = resolve })
  let capturedSignal
  const cancellable = new OfficeWorkspaceService({ userDataDirectory: path.join(temporary, 'cancelled'), toolPaths: [tool],
    commandRunner: async (executable, args, options) => {
      if (args[0] === 'view') { capturedSignal = options.signal; reachedView(); await viewReleased }
      return runOfficeCommand(executable, args, options)
    } })
  const requestId = 'isolated-cancellable-presentation'
  const opening = cancellable.open(files.pptx, { requestId })
  const rejection = assert.rejects(opening, /已切换|取消|abort/i)
  let reachTimeout
  try { await Promise.race([viewReached, new Promise((_, reject) => { reachTimeout = setTimeout(() => reject(new Error('cancel test did not reach preview work')), 10_000) })]) }
  finally { clearTimeout(reachTimeout) }
  assert.equal(cancellable.openRequests.size, 1)
  assert.equal(cancellable.previewLeases.size, 1)
  cancellable.cancelOpen(requestId)
  assert.equal(capturedSignal.aborted, true, 'open cancellation must propagate into CLI execution')
  assert.equal(cancellable.previewLeases.size, 0)
  releaseView(); await rejection
  assert.equal(cancellable.openRequests.size, 0)
  assert.equal(cancellable.previewLeases.size, 0)
  assert.equal(cancellable.previewTokens.size, 0, 'cancelled preview must not register a stale preview URL')
  assert.equal(cancellable.presentationWorkspace.sessions.size, 0)
  assert.equal(fs.readdirSync(cancellable.presentationWorkspace.root).length, 0, 'failed preview working directories must be cleaned')

  // Cached opens finish before cancelOpen can abort anything: their lease still
  // needs explicit removal when the pane leaves.
  await service.open(files.pptx, { requestId: 'completed-open' })
  assert.equal(service.openRequests.size, 0)
  assert.equal(service.previewLeases.size, 1)
  service.cancelOpen('completed-open')
  assert.equal(service.previewLeases.size, 0)
  console.log(JSON.stringify({ ok: true, controlCliCalls: controlCalls.length, parallel18ReadCliCalls: cachedCount, unchanged36ReadExtraCalls: 0,
    coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), scenarios: ['load coalescing', 'unchanged cache reuse', 'Agent Word revision text cache', 'PPT preview reuse and durable CoW save', 'cancelled and completed preview lease cleanup'] }))
} catch (error) { failed = true; console.error(error.stack); process.exitCode = 1 }
finally { if (!failed) fs.rmSync(temporary, { recursive: true, force: true }); else console.error(`QA artifacts: ${temporary}`) }
