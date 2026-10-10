#!/usr/bin/env node
// Synthetic loopback model, real Agent dispatch, real bundled CLI, isolated documents only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OfficeWorkspaceService } from '../electron/services/office-workspace-service.mjs'
import { ZSenseAgentCore } from '../electron/services/zsense-agent-core.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tool = path.join(project, 'bundled-tools', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'officecli.exe' : 'officecli')
assert.ok(fs.existsSync(tool), 'the platform bundled OfficeCLI is required for this integration test')
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-agent-office-')))
const workspace = path.join(temporary, 'workspace')
const outside = path.join(temporary, 'outside')
fs.mkdirSync(workspace)
fs.mkdirSync(outside)
const environment = { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' }
const cli = (...args) => execFileSync(tool, [...args, '--json'], { env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const service = new OfficeWorkspaceService({ userDataDirectory: path.join(temporary, 'user-data'), toolPaths: [tool] })
const sessionEvents = []
const unsubscribe = service.onSessionEvent((event) => sessionEvents.push(event))
const scenarios = new Map()
const errors = []
const officeTools = ['read_word_document', 'edit_word_document', 'save_word_document', 'read_presentation', 'edit_presentation', 'save_presentation']
let server

function fixture(directory, name) {
  const word = path.join(directory, `${name}.docx`)
  const presentation = path.join(directory, `${name}.pptx`)
  cli('create', word)
  cli('add', word, '/body', '--type', 'paragraph', '--prop', 'text=Alpha ')
  cli('add', word, '/body/p[1]', '--type', 'run', '--prop', 'text=Beta', '--prop', 'bold=true')
  cli('add', word, '/body/p[1]', '--type', 'hyperlink', '--prop', 'text= Link', '--prop', 'url=https://example.com')
  cli('create', presentation)
  cli('add', presentation, '/', '--type', 'slide', '--prop', 'title=Unchanged title')
  cli('add', presentation, '/slide[1]', '--type', 'shape', '--prop', 'text=Original', '--prop', 'x=2cm', '--prop', 'y=3cm', '--prop', 'width=8cm', '--prop', 'height=2cm')
  return { word, presentation, wordHash: hash(word), presentationHash: hash(presentation) }
}

function capability(approval) {
  return {
    setDelegateRunner: () => undefined,
    expandReferences: async (message) => ({ message, references: [] }),
    projectContext: () => '',
    activeState: () => ({}),
    runHook: async () => undefined,
    definitions: () => [],
    toolExecutionProfile: () => ({ parallelSafe: false, risk: 'write' }),
    ...(approval ? { requestApproval: approval } : {}),
  }
}

function stream(response, delta) {
  // This fixture validates Agent/tool dispatch, not HTTP connection pooling.
  // Synchronous CLI fixture creation between scenarios can delay idle-socket
  // events under a concurrent suite; do not reuse those loopback connections.
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' })
  response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
}

function output(body, callId) {
  const result = body.messages.findLast((message) => message.role === 'tool' && message.tool_call_id === callId)
  assert.ok(result, `actual Agent execution must return tool output for ${callId}`)
  try { return JSON.parse(result.content) } catch { return result.content }
}

async function runScenario(name, steps, { approval, allowedTools = true, skills = [{ name: 'officecli', content: '使用已分配的本地 Office 工具。' }], attachments = [], expectedErrors = 0 } = {}) {
  const scenario = { name, steps, index: 0, lastCall: '', requests: [], allowedTools }
  scenarios.set(name, scenario)
  const events = []
  const core = new ZSenseAgentCore({ officeWorkspace: service, officeToolPaths: [tool], capabilityService: capability(approval) })
  const result = await core.chatStream({
    requestId: `zsense-agent-office-${name}`,
    bot: { id: 'atlas', name: 'Atlas' },
    message: '仅处理隔离测试文件：按要求修改并保存，未授权的外部写入必须拒绝。',
    model: 'test-model', modelProvider: 'custom',
    baseUrl: `http://127.0.0.1:${server.address().port}/${name}`,
    workspacePath: workspace, skills, attachments,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => events.push(event),
  })
  assert.deepEqual(errors, [], 'synthetic model assertions failed')
  assert.equal(result.output, `${name}: verified`)
  assert.equal(scenario.index, steps.length)
  assert.equal(events.filter((event) => event.type === 'tool' && event.status === 'error').length, expectedErrors)
  assert.deepEqual(events.filter((event) => event.type === 'tool' && event.status !== 'running').map((event) => event.name), steps.map((step) => step.name))
  console.log(`Agent Office scenario passed: ${name} (${steps.length} actual tool calls).`)
  return { events, requests: scenario.requests }
}

function wordSteps(files, target = path.basename(files.word), { saved = true, failurePattern, reread = false } = {}) {
  return [
    { name: 'read_word_document', args: { path: target }, verify: (result) => {
      assert.match(result.content, /Alpha Beta Link/)
      assert.equal(result.dirty, false)
      assert.equal(result.baseContentHash, files.wordHash)
    } },
    { name: 'edit_word_document', args: { path: target, operations: [{ action: 'setText', path: '/body/p[1]', text: 'Alpha Beta! Link', baseText: 'Alpha Beta Link' }] }, verify: async (result) => {
      assert.equal(result.dirty, true)
      assert.ok(result.pendingCount > 0)
      assert.equal(hash(files.word), files.wordHash, 'staging must not mutate the source DOCX')
      const session = await service.getWord({ filePath: files.word })
      assert.equal(session.sessionRevision, result.revision)
      assert.equal(session.operations[0].text, 'Alpha Beta! Link', 'the editor and Agent share the same Word draft')
    } },
    ...(reread ? [{ name: 'read_word_document', args: { path: target }, verify: (result) => {
      assert.equal(result.dirty, true)
      assert.match(result.content, /Alpha Beta! Link/, 'Agent reread must observe the unsaved working copy, not original disk bytes')
      assert.equal(hash(files.word), files.wordHash)
    } }] : []),
    { name: 'save_word_document', args: { path: target }, verify: async (result) => {
      if (!saved) {
        assert.match(result, failurePattern)
        assert.equal(hash(files.word), files.wordHash, 'denied saves must keep external DOCX byte-identical')
        assert.equal((await service.getWord({ filePath: files.word })).dirty, true, 'denied saves retain the draft')
        return
      }
      assert.equal(result.dirty, false)
      assert.equal(result.saved, 1)
      assert.equal(result.contentHash, hash(files.word))
      const paragraph = JSON.parse(cli('get', files.word, '/body/p[1]', '--depth', '2')).data.results[0]
      assert.equal(paragraph.text, 'Alpha Beta! Link')
      assert.equal(paragraph.children.find((child) => child.text === 'Beta!')?.format.bold, true, 'Agent edit preserves bold runs')
      assert.equal(paragraph.children.find((child) => child.text === ' Link')?.format.url, 'https://example.com', 'Agent edit preserves hyperlinks')
      assert.equal((await service.getWord({ filePath: files.word })).dirty, false)
    } },
  ]
}

function presentationSteps(files, target = path.basename(files.presentation), { saved = true, failurePattern, reread = false } = {}) {
  let elementPath = ''
  return [
    { name: 'read_presentation', args: { path: target, startSlide: 1, endSlide: 1 }, verify: (result) => {
      assert.equal(result.dirty, false)
      assert.equal(result.baseContentHash, files.presentationHash)
      const element = result.slides[0].elements.find((item) => item.text === 'Original')
      assert.ok(element)
      assert.match(element.path, /@id=/, 'structured PPT read exposes stable OOXML IDs')
      elementPath = element.path
    } },
    { name: 'edit_presentation', args: () => ({ path: target, operations: [{ path: elementPath, properties: { text: 'Agent revised', x: '3cm', width: '7cm' } }] }), verify: async (result) => {
      assert.equal(result.dirty, true)
      assert.equal(result.pendingCount, 1)
      assert.equal(hash(files.presentation), files.presentationHash, 'staging must not mutate the source PPTX')
      const session = await service.getPresentation({ filePath: files.presentation })
      assert.equal(session.sessionRevision, result.revision)
      assert.equal(session.slides[0].elements.find((item) => item.path === elementPath).text, 'Agent revised')
      assert.ok(session.slides[0].elements.some((item) => item.text === 'Unchanged title'))
    } },
    ...(reread ? [{ name: 'read_presentation', args: { path: target }, verify: (result) => {
      assert.equal(result.dirty, true)
      assert.equal(result.slides[0].elements.find((item) => item.path === elementPath).text, 'Agent revised')
      assert.equal(hash(files.presentation), files.presentationHash)
    } }] : []),
    { name: 'save_presentation', args: { path: target }, verify: async (result) => {
      if (!saved) {
        assert.match(result, failurePattern)
        assert.equal(hash(files.presentation), files.presentationHash, 'denied saves must keep external PPTX byte-identical')
        assert.equal((await service.getPresentation({ filePath: files.presentation })).dirty, true)
        return
      }
      assert.equal(result.dirty, false)
      assert.equal(result.saved, 1)
      const element = JSON.parse(cli('get', files.presentation, elementPath)).data.results[0]
      assert.equal(element.text, 'Agent revised')
      assert.equal(element.format.x, '3cm')
      assert.equal(element.format.width, '7cm')
      assert.equal((await service.getPresentation({ filePath: files.presentation })).dirty, false)
    } },
  ]
}

function checkSharedEvents(name, files, saved) {
  for (const file of [files.word, files.presentation]) {
    const events = sessionEvents.filter((event) => event.sourceClientId === `agent-zsense-agent-office-${name}` && event.filePath === file)
    assert.deepEqual(events.map((event) => event.kind), saved ? ['changed', 'saved'] : ['changed'])
    assert.ok(events.every((event) => event.source === 'agent'), 'sidebar synchronizes from real Agent session events')
    assert.equal(events[0].dirty, true)
    if (saved) assert.equal(events[1].dirty, false)
  }
}

try {
  server = http.createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      const parsed = JSON.parse(body)
      const name = request.url.split('/')[1]
      const scenario = scenarios.get(name)
      assert.ok(scenario, `unexpected model request ${request.url}`)
      scenario.requests.push(parsed)
      const available = new Set((parsed.tools || []).map((entry) => entry.function.name))
      for (const name of officeTools) assert.equal(available.has(name), scenario.allowedTools)
      if (scenario.lastCall) await scenario.steps[scenario.index - 1].verify?.(output(parsed, scenario.lastCall))
      if (scenario.index === scenario.steps.length) return stream(response, { content: `${name}: verified` })
      const step = scenario.steps[scenario.index]
      scenario.lastCall = `${name}-${++scenario.index}`
      stream(response, { tool_calls: [{ index: 0, id: scenario.lastCall, function: { name: step.name, arguments: JSON.stringify(typeof step.args === 'function' ? step.args() : step.args) } }] })
    } catch (error) {
      errors.push(error.stack || error.message)
      response.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' })
      response.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const local = fixture(workspace, 'local')
  await runScenario('local', [...wordSteps(local, path.basename(local.word), { reread: true }), ...presentationSteps(local, local.presentation, { reread: true })])
  checkSharedEvents('local', local, true)

  const approved = fixture(outside, 'approved')
  const approvals = []
  await runScenario('approved', [...wordSteps(approved, approved.word), ...presentationSteps(approved, approved.presentation)], { approval: async (_context, options) => {
    assert.equal(options.category, 'filesystem:external-write')
    assert.ok([approved.word, approved.presentation].includes(options.operationKey))
    assert.ok(options.question.includes(options.operationKey))
    assert.equal(hash(options.operationKey), options.operationKey === approved.word ? approved.wordHash : approved.presentationHash, 'original bytes must remain unchanged until approval')
    approvals.push(options)
    return { approved: true, mode: 'once' }
  } })
  assert.equal(approvals.length, 2, 'only external saves require approval, not reads or staging')
  checkSharedEvents('approved', approved, true)

  const unavailable = fixture(outside, 'unavailable')
  await runScenario('unavailable', [...wordSteps(unavailable, unavailable.word, { saved: false, failurePattern: /无法显示审批界面/ }), ...presentationSteps(unavailable, unavailable.presentation, { saved: false, failurePattern: /无法显示审批界面/ })], { expectedErrors: 2 })
  checkSharedEvents('unavailable', unavailable, false)

  const denied = fixture(outside, 'denied')
  let deniedCount = 0
  await runScenario('denied', [...wordSteps(denied, denied.word, { saved: false, failurePattern: /测试用户拒绝/ }), ...presentationSteps(denied, denied.presentation, { saved: false, failurePattern: /测试用户拒绝/ })], { expectedErrors: 2, approval: async () => { deniedCount += 1; throw new Error('测试用户拒绝工作区外写入。') } })
  assert.equal(deniedCount, 2)
  checkSharedEvents('denied', denied, false)

  await runScenario('not-assigned', [], { skills: [], allowedTools: false })
  await runScenario('attachment-assigned', [], { skills: [], attachments: [{ name: path.basename(local.word), path: local.word }] })
  console.log('Agent Office integration passed: six real tools, working-copy reads, rich-text fidelity, stable PPT edits, shared events, external approval/deny, and assignment gating.')
} finally {
  unsubscribe()
  if (server) await new Promise((resolve) => server.close(resolve))
  fs.rmSync(temporary, { recursive: true, force: true })
}
