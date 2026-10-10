#!/usr/bin/env node
// Real bundled OfficeCLI, real shared transactions and Agent dispatch, isolated files only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'
import { runOfficeCommand } from '../electron/services/office-command-runner.mjs'
import { ZSenseAgentCore } from '../electron/services/zsense-agent-core.mjs'

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-office-cancellation-')))
const workspace = path.join(root, 'workspace')
const outside = path.join(root, 'outside')
fs.mkdirSync(workspace)
fs.mkdirSync(outside)
const tool = path.resolve(`bundled-tools/${process.platform}-${process.arch}/officecli${process.platform === 'win32' ? '.exe' : ''}`)
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const cli = (...args) => runOfficeCommand(tool, [...args, '--json'])
const originals = { fsync: fs.fsyncSync, rename: fs.renameSync, write: fs.writeFileSync }
const models = new Map()
let server
let count = 0

async function fixture(kind, name, directory = workspace) {
  const filePath = path.join(directory, `${name}.${kind}`)
  fs.copyFileSync(path.join(root, `base.${kind}`), filePath)
  const service = new OfficeWorkspaceService({ userDataDirectory: path.join(root, `data-${name}`), toolPaths: [tool] })
  if (kind === 'docx') await service.stageWordOperations({ filePath, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Retained draft', baseText: 'Baseline' }] })
  else if (kind === 'pptx') {
    const session = await service.getPresentation({ filePath })
    await service.stagePresentation({ filePath, operations: [{ path: session.slides[0].elements[0].path, properties: { text: 'Retained draft' } }] })
  } else {
    const session = await service.getWorkbook({ filePath })
    await service.stageCells({ filePath, changes: [{ sheet: session.sheets[0].sheet, cell: 'A1', value: 'Retained draft' }] })
  }
  const get = () => kind === 'docx' ? service.getWord({ filePath }) : kind === 'pptx' ? service.getPresentation({ filePath }) : service.getWorkbook({ filePath })
  const save = () => kind === 'docx' ? service.saveWord({ filePath }) : kind === 'pptx' ? service.savePresentation({ filePath }) : service.saveWorkbook({ filePath })
  return { filePath, service, get, save, before: hash(filePath) }
}

async function cancelledBeforeCommit(kind) {
  const current = await fixture(kind, `before-${kind}`)
  const controller = new AbortController()
  let reached = false
  if (kind === 'csv') fs.writeFileSync = (file, ...args) => {
    const result = originals.write(file, ...args)
    if (String(file).startsWith(`${current.filePath}.zsense-`)) { reached = true; controller.abort(new Error('cancel before commit')) }
    return result
  }
  else fs.fsyncSync = (descriptor) => { const result = originals.fsync(descriptor); reached = true; controller.abort(new Error('cancel before commit')); return result }
  try { await assert.rejects(current.service.runWithSignal(controller.signal, current.save), /cancel before commit/) }
  finally { fs.fsyncSync = originals.fsync; fs.writeFileSync = originals.write }
  assert.ok(reached, `the real ${kind} transaction must reach its commit gate`)
  assert.equal(hash(current.filePath), current.before)
  assert.equal((await current.get()).dirty, true, 'Pre-commit cancellation must keep the existing draft')
  assert.equal(current.service.saveQueues.size, 0)
  assert.equal(fs.readdirSync(path.dirname(current.filePath)).filter((name) => name.includes('.zsense-')).length, 0, 'Cancellation must remove only its transaction temporary files')
  count += 1
}

async function cancelledAfterCommit(kind) {
  const current = await fixture(kind, `after-${kind}`)
  const controller = new AbortController()
  let committed = false
  fs.renameSync = (from, to) => {
    const result = originals.rename(from, to)
    if (to === current.filePath) { committed = true; controller.abort(new Error('cancel after commit')) }
    return result
  }
  let result
  try { result = await current.service.runWithSignal(controller.signal, current.save) }
  finally { fs.renameSync = originals.rename }
  assert.ok(committed)
  assert.ok(result.saved > 0, 'Already-committed saves must finalize successfully, not report unsaved cancellation')
  assert.equal(result.dirty, false)
  assert.notEqual(hash(current.filePath), current.before)
  assert.equal((await current.get()).dirty, false)
  assert.equal(current.service.saveQueues.size, 0)
  count += 1
}

async function queuedCancellation(kind) {
  const current = await fixture(kind, `queued-${kind}`)
  const controller = new AbortController()
  const gate = deferred()
  current.service.saveQueues.set(current.filePath, gate.promise)
  const saving = current.service.runWithSignal(controller.signal, current.save)
  const rejection = assert.rejects(saving, /cancel queue/)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort(new Error('cancel queue'))
  await rejection
  assert.equal(hash(current.filePath), current.before, 'A cancelled queued operation must never execute')
  gate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await current.get()).dirty, true)
  assert.equal(current.service.saveQueues.size, 0)
  count += 1
}

async function agentCancellation(kind, mode) {
  const name = `agent-${mode}-${kind}`
  const current = await fixture(kind, name, mode === 'approval' || mode === 'denied' ? outside : workspace)
  const toolName = kind === 'docx' ? 'save_word_document' : kind === 'pptx' ? 'save_presentation' : 'save_spreadsheet'
  const gate = deferred(), entered = deferred(), finished = deferred()
  const toolEvents = []
  let capabilityService
  if (mode === 'approval' || mode === 'denied') capabilityService = {
    setDelegateRunner() {}, expandReferences: async (message) => ({ message, references: [] }), projectContext: () => '', activeState: () => ({}), runHook: async () => undefined,
    definitions: () => [], toolExecutionProfile: () => ({ parallelSafe: false }),
    requestApproval: async (_context, options) => {
      assert.equal(options.category, 'filesystem:external-write')
      assert.equal(options.operationKey, current.filePath)
      entered.resolve()
      await gate.promise
      if (mode === 'denied') throw new Error('test approval denied')
      return { approved: true, mode: 'once' }
    },
  }
  else {
    const method = kind === 'docx' ? 'saveWord' : kind === 'pptx' ? 'savePresentation' : 'saveWorkbook'
    const original = current.service[method].bind(current.service)
    current.service[method] = async (request) => {
      entered.resolve()
      await gate.promise
      try { return await original(request) } finally { finished.resolve() }
    }
  }
  models.set(name, { toolName, filePath: path.dirname(current.filePath) === workspace ? path.basename(current.filePath) : current.filePath, calls: 0 })
  const core = new ZSenseAgentCore({ officeWorkspace: current.service, officeToolPaths: [tool], capabilityService })
  const chatting = core.chatStream({ requestId: name, bot: { id: 'atlas', name: 'Atlas' }, message: 'Save only the isolated draft file.', model: 'synthetic-test', modelProvider: 'custom',
    baseUrl: `http://127.0.0.1:${server.address().port}/${name}`, workspacePath: workspace, skills: [{ name: 'officecli', content: 'Use shared Office tools.' }], settings: { responseLanguage: 'zh-CN' }, onEvent: (event) => { if (event.type === 'tool') toolEvents.push(event) },
  }).then((result) => ({ result }), (error) => ({ error: error.message }))
  await entered.promise
  if (mode !== 'denied') assert.equal(core.cancelChat(name).cancelled, true)
  gate.resolve()
  const result = await chatting
  if (mode === 'running') await finished.promise
  if (mode === 'denied') { assert.equal(result.result.output, 'verified'); assert.ok(toolEvents.some((event) => event.status === 'error' && event.output.includes('test approval denied'))) }
  else assert.match(result.error, /已停止生成/)
  assert.equal(hash(current.filePath), current.before, 'Cancelled or denied Agent saves must leave original bytes unchanged')
  assert.equal((await current.get()).dirty, true, 'Cancelled/denied saves retain the user draft')
  count += 1
}

try {
  for (const kind of ['docx', 'xlsx', 'pptx']) await cli('create', path.join(root, `base.${kind}`))
  await cli('add', path.join(root, 'base.docx'), '/body', '--type', 'paragraph', '--prop', 'text=Baseline')
  await cli('add', path.join(root, 'base.pptx'), '/', '--type', 'slide', '--prop', 'title=Baseline')
  fs.writeFileSync(path.join(root, 'base.csv'), 'Baseline\n')
  for (const kind of ['docx', 'xlsx', 'pptx', 'csv']) {
    await cancelledBeforeCommit(kind)
    await cancelledAfterCommit(kind)
    await queuedCancellation(kind)
  }
  const running = await fixture('xlsx', 'cli-running')
  const controller = new AbortController(), gate = deferred(), entered = deferred()
  const originalRunner = running.service.commandRunner
  let capturedSignal
  running.service.commandRunner = async (executable, args, options) => {
    if (args[0] === 'batch') { capturedSignal = options.signal; entered.resolve(); await gate.promise }
    return originalRunner(executable, args, options)
  }
  const saving = running.service.runWithSignal(controller.signal, running.save)
  const rejection = assert.rejects(saving, /cancel CLI gate/)
  await entered.promise
  controller.abort(new Error('cancel CLI gate'))
  assert.equal(capturedSignal.aborted, true, 'The shared signal must reach real CLI invocations')
  gate.resolve(); await rejection
  assert.equal(hash(running.filePath), running.before)
  assert.equal((await running.get()).dirty, true)
  count += 1

  server = http.createServer(async (request, response) => {
    for await (const chunk of request) {}
    const scenario = models.get(request.url.split('/')[1])
    assert.ok(scenario)
    const delta = scenario.calls++ === 0
      ? { tool_calls: [{ index: 0, id: 'isolated-save', function: { name: scenario.toolName, arguments: JSON.stringify({ path: scenario.filePath }) } }] }
      : { content: 'verified' }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  for (const kind of ['docx', 'pptx', 'xlsx']) {
    await agentCancellation(kind, 'running')
    await agentCancellation(kind, 'approval')
    await agentCancellation(kind, 'denied')
  }
  console.log(`Office cancellation regression passed: ${count} real transaction/Agent scenarios; queued, CLI/pre-commit, approval-wait/denied cancellations keep original hashes and drafts; post-commit cancellation completes saved bookkeeping`)
} finally {
  fs.fsyncSync = originals.fsync; fs.renameSync = originals.rename; fs.writeFileSync = originals.write
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
}
