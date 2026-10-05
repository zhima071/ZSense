import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { composeAgentRuntimeStatus, parseDsmlToolCalls, queryWebSearch, validateOfficeCliArguments, ZSenseAgentCore } from '../electron/services/zsense-agent-core.mjs'
import { AgentProgressGuard, AgentRunCursorStore, buildToolDependencyGraph, closeInterruptedToolCalls, executeToolDependencyGraph, normalizeToolCallIds, validateToolCall } from '../electron/services/agent-loop-runtime.mjs'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { AgentCapabilityService } from '../electron/services/agent-capability-service.mjs'

const workspacePath = mkdtempSync(path.join(tmpdir(), 'zsense-agent-core-'))
const temporaryDirectoryForApproval = mkdtempSync(path.join(tmpdir(), 'zsense-agent-approval-'))
fs.writeFileSync(path.join(workspacePath, 'hello.txt'), '来自 ZSense 工作区', 'utf8')
for (let index = 1; index <= 90; index += 1) fs.writeFileSync(path.join(workspacePath, `progress-${index}.txt`), `已完成第 ${index} 项`, 'utf8')
const coreSource = fs.readFileSync(new URL('../electron/services/zsense-agent-core.mjs', import.meta.url), 'utf8')
const removedWeatherToolName = ['get', 'weather'].join('_')
const removedWeatherProviderName = ['Open', 'Meteo'].join('-')
let delegateRunner = null
new ZSenseAgentCore({ capabilityService: { setDelegateRunner: (runner) => { delegateRunner = runner } } })
assert.equal(typeof delegateRunner?.run, 'function')
assert.equal(typeof delegateRunner?.cancel, 'function')

const requests = []
let mainChatRequestCount = 0
let loopLimitRequestCount = 0
let loopCapRequestCount = 0
let loopInvalidRequestCount = 0
let cursorFailureRequestCount = 0
let outsideSpreadsheetRequestCount = 0
let autoApprovalRequestCount = 0
let autoApprovalJudgeCount = 0
let autoApprovalToolRounds = 0
let autoApprovalTargetPath = ''
const outsideSpreadsheetPath = path.join(tmpdir(), `zsense-outside-${process.pid}.xlsx`)
let loopRepeatRequestCount = 0
let clarifyCancelRequestCount = 0
const clarifyCancelRequestId = 'zsense-core-clarify-cancel'
let summaryRetryRequestCount = 0
let summaryRetryFinalRounds = 0
let summaryEmptyRequestCount = 0
let summaryEmptyFinalRounds = 0
let loopFailureRequestCount = 0
let larkRequestCount = 0
let steeringRequestCount = 0
let transient429Requests = 0
const server = http.createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const parsed = JSON.parse(body)
  if (!request.url.includes('/transient-429/')) requests.push({ url: request.url, body: parsed })
  if (request.url.includes('/transient-429/')) {
    transient429Requests += 1
    if (transient429Requests === 1) {
      response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' })
      response.end(JSON.stringify({ error: { message: '临时限流' } }))
    } else {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '限流后恢复正常。' } }] })}\n\ndata: [DONE]\n\n`)
    }
    return
  }
  if (request.url.includes('/steering/')) {
    steeringRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (steeringRequestCount === 1) {
      response.flushHeaders()
      const timer = setTimeout(() => response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '这条旧推理不应完成。' } }] })}\n\ndata: [DONE]\n\n`), 2_000)
      timer.unref?.()
      response.once('close', () => clearTimeout(timer))
      return
    }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已按追加指令重新规划并完成。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/lark-run/')) {
    larkRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (larkRequestCount === 1) response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-lark-version', function: { name: 'run_lark_cli', arguments: '{"args":["--version"]}' } }] } }] })}\n\n`)
    else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '飞书 CLI 已内置并可用。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/loop-repeat/')) {
    loopRepeatRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (parsed.tools) response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-repeat-${loopRepeatRequestCount}`, function: { name: 'list_workspace', arguments: '{"recursive":false}' } }] } }] })}\n\n`)
    else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已停止重复调用并完成汇总。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/clarify-cancel/')) {
    clarifyCancelRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-clarify-${clarifyCancelRequestCount}`, function: { name: 'request_clarification', arguments: JSON.stringify({ question: '取消验证：请选择一个选项', choices: ['甲', '乙'] }) } }] } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/summary-retry/')) {
    summaryRetryRequestCount += 1
    const isFinalRound = !(parsed.tools || []).length
    if (isFinalRound) summaryRetryFinalRounds += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (!isFinalRound) response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-summary-${summaryRetryRequestCount}`, function: { name: 'list_workspace', arguments: '{"recursive":false}' } }] } }] })}\n\n`)
    // 第一次收尾轮故意返回空内容：验证 ZSense 会自动再要一次结论，而不是把“继续汇总”推给用户
    else if (summaryRetryFinalRounds === 1) response.write('')
    else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '自动重新生成最终结论成功。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/summary-empty/')) {
    summaryEmptyRequestCount += 1
    const isEmptyFinalRound = !(parsed.tools || []).length
    if (isEmptyFinalRound) summaryEmptyFinalRounds += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (!isEmptyFinalRound) response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-empty-${summaryEmptyRequestCount}`, function: { name: 'list_workspace', arguments: '{"recursive":false}' } }] } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/loop-limit/')) {
    loopLimitRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (loopLimitRequestCount <= 20) response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-loop-${loopLimitRequestCount}`, function: { name: 'read_text_file', arguments: JSON.stringify({ path: `progress-${loopLimitRequestCount}.txt` }) } }] } }] })}\n\n`)
    else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '超过旧版轮次上限后仍正常完成。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/auto-approval/')) {
    autoApprovalRequestCount += 1
    const looksLikeJudge = JSON.stringify(parsed.messages || []).includes('操作类别')
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (looksLikeJudge) {
      autoApprovalJudgeCount += 1
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"allow": true, "reason": "用户要求写这个文件"}' } }] })}\n\n`)
    } else if (parsed.tools && autoApprovalToolRounds === 0) {
      autoApprovalToolRounds += 1
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'auto-write-1', function: { name: 'write_text_file', arguments: JSON.stringify({ path: autoApprovalTargetPath, content: 'auto approved content' }) } }] } }] })}\n\n`)
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '文件已写入。' } }] })}\n\n`)
    }
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/outside-spreadsheet/')) {
    outsideSpreadsheetRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (parsed.tools && outsideSpreadsheetRequestCount <= 2) {
      const name = outsideSpreadsheetRequestCount === 1 ? 'read_spreadsheet' : 'save_spreadsheet'
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `outside-${outsideSpreadsheetRequestCount}`, function: { name, arguments: JSON.stringify({ path: outsideSpreadsheetPath }) } }] } }] })}\n\n`)
    } else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '工作区外的表格处理完成。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/loop-cap/')) {
    loopCapRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (parsed.tools && loopCapRequestCount <= 85) response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-cap-${loopCapRequestCount}`, function: { name: 'read_text_file', arguments: JSON.stringify({ path: `progress-${loopCapRequestCount}.txt` }) } }] } }] })}\n\n`)
    else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '85 轮后任务正常完成。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/loop-invalid/')) {
    loopInvalidRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (parsed.tools) response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-invalid-${loopInvalidRequestCount}`, function: { name: 'list_workspace', arguments: JSON.stringify({ marker: loopInvalidRequestCount }) } }] } }] })}\n\n`)
    else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已说明参数错误并停止。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/cursor-failure/')) {
    cursorFailureRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-write-unsafe', function: { name: 'write_text_file', arguments: JSON.stringify({ path: 'must-not-exist.txt', content: 'should not be written' }) } }] } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/loop-failure/')) {
    loopFailureRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (parsed.tools) response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-failure-${loopFailureRequestCount}`, function: { name: 'read_workspace', arguments: JSON.stringify({ path: `/outside-${loopFailureRequestCount}.txt` }) } }] } }] })}\n\n`)
    else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已停止无效重试并说明失败原因。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (request.url.includes('/fallback/')) {
    if (parsed.tools) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'This model does not support tools or function calling.' } }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '当前模型已安全降级为纯文本回答。' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  if (parsed.messages?.[0]?.content?.includes('周期性长期记忆复盘器')) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '[{"action":"create","matchId":"","title":"主题偏好","excerpt":"用户希望长期使用浅蓝色主题。","type":"preference","evidence":"以后一直使用浅蓝色主题","confidence":0.97}]' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (parsed.messages?.[0]?.content?.includes('长期记忆整理器')) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '[{"action":"create","matchId":"","title":"回复语言偏好","excerpt":"用户偏好使用简体中文交流。","type":"preference","evidence":"以后请一直用简体中文回复我","confidence":0.98}]' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  if (parsed.messages?.[0]?.content?.includes('定时任务滚动记忆整理器')) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '## 最新状态\n- 已合并本次成功结果\n- 下次只需继续跟踪变化' } }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  mainChatRequestCount += 1
  if (mainChatRequestCount === 1) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先查看工作区。' } }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool-list-1', function: { name: 'list_workspace', arguments: '{"recursive":false}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已经通过 ZSense Agent Core 找到 hello.txt。' } }], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } })}\n\n`)
  response.end('data: [DONE]\n\n')
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${address.port}`

try {
  const cursorRoot = path.join(workspacePath, '.cursor-test')
  const cursorStore = new AgentRunCursorStore(cursorRoot)
  cursorStore.upsert({ sessionId: 'zsense-core:cursor-test', requestId: 'cursor-request', conversationId: 'conversation-cursor', status: 'running', phase: 'tools', step: 12, canonicalMessages: [{ role: 'user', content: 'continue' }], agentSteps: [], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, pendingSteering: [{ id: 'steering-persisted', content: '补充读取附件', receivedAt: new Date().toISOString(), source: 'user', intent: 'supplement', attachments: [{ id: 'pdf-1', name: 'spec.pdf', path: path.join(workspacePath, 'spec.pdf'), size: 30_000_000, mimeType: 'application/pdf', kind: 'file' }] }], pendingToolCalls: [{ id: 'tool-write', name: 'write_file', arguments: { path: 'a.txt' } }] })
  const restoredCursor = new AgentRunCursorStore(cursorRoot).resumable('zsense-core:cursor-test', 'conversation-cursor')
  assert.equal(restoredCursor?.step, 12)
  assert.equal(restoredCursor?.pendingToolCalls?.[0]?.name, 'write_file')
  assert.equal(restoredCursor?.pendingSteering?.[0]?.attachments?.[0]?.size, 30_000_000)
  cursorStore.finish('zsense-core:cursor-test', 'complete')
  assert.equal(new AgentRunCursorStore(cursorRoot).resumable('zsense-core:cursor-test', 'conversation-cursor'), null)
  const duplicateCalls = normalizeToolCallIds([{ id: 'same', name: 'read_text_file' }, { id: 'same', name: 'read_pdf' }, { id: '', name: 'list_workspace' }])
  assert.equal(new Set(duplicateCalls.map((call) => call.id)).size, 3, '重复工具调用 ID 必须在执行前修复')
  const pendingHistory = closeInterruptedToolCalls([{ role: 'assistant', content: '', toolCalls: [{ id: 'pending-1', name: 'write_text_file', arguments: { path: 'x' } }] }], [{ id: 'pending-1', name: 'write_text_file', arguments: { path: 'x' } }])
  assert.equal(pendingHistory.at(-1).role, 'tool', '恢复时未完成的工具必须用未知结果关闭协议序列')
  assert(pendingHistory.at(-1).content.includes('不得盲目重放'))
  assert.match(validateToolCall({ name: 'list_workspace', arguments: { marker: 1 } }, { parameters: { type: 'object', properties: { recursive: { type: 'boolean' } }, additionalProperties: false } }), /不支持参数/)
  assert.match(validateToolCall({ name: 'write_text_file', arguments: null }, { parameters: { required: ['path'] } }), /完整的 JSON 对象/)
  assert.match(validateToolCall({ name: 'write_text_file', arguments: { path: 42 } }, { parameters: { type: 'object', properties: { path: { type: 'string' } } } }), /类型不正确/)
  assert.match(validateToolCall({ name: 'edit_canvas', arguments: { operations: [{ action: 'not-supported' }] } }, { parameters: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'delete'] } } } } } } }), /不在允许值中/)
  const progressGuard = new AgentProgressGuard()
  const successfulRound = (output) => [{ call: { name: 'read_text_file', arguments: { path: 'x' } }, toolEvent: { status: 'complete' }, output }]
  assert.equal(progressGuard.observe(successfulRound('first')).stalled, false)
  assert.equal(progressGuard.observe(successfulRound('second')).stalled, false)
  assert.equal(progressGuard.observe(successfulRound('second')).stalled, false)
  assert.equal(progressGuard.observe(successfulRound('second')).stalled, true, '只应在重复且无进展时停止')
  const mixedGuard = new AgentProgressGuard()
  const failure = { call: { name: 'read_text_file', arguments: { path: 'missing' } }, toolEvent: { status: 'error' }, output: '不存在' }
  assert.equal(mixedGuard.observe([failure, ...successfulRound('first')]).stalled, false)
  assert.equal(mixedGuard.observe([failure, ...successfulRound('second')]).stalled, false, '有新的成功结果时不能因为伴随的相同失败而强制收尾')

  const dependencyBatches = []
  let activeTools = 0
  let maximumActiveTools = 0
  const dependencyNodes = buildToolDependencyGraph([
    { id: 'read-a', name: 'read_a', arguments: {} },
    { id: 'read-b', name: 'read_b', arguments: {} },
    { id: 'write-c', name: 'write_c', arguments: {} },
    { id: 'read-d', name: 'read_d', arguments: {} },
  ], { profileFor: (call) => ({ parallelSafe: call.name.startsWith('read_') }) })
  const dependencyResults = await executeToolDependencyGraph(dependencyNodes, async (node) => {
    activeTools += 1
    maximumActiveTools = Math.max(maximumActiveTools, activeTools)
    await new Promise((resolve) => setTimeout(resolve, 8))
    activeTools -= 1
    return node.call.name
  }, { maxConcurrent: 4, onBatch: (batch) => dependencyBatches.push(batch.map((node) => node.call.name)) })
  assert.equal(maximumActiveTools, 2, '无依赖只读工具没有并行执行')
  assert.deepEqual(dependencyBatches, [['read_a', 'read_b'], ['write_c'], ['read_d']], '写入工具没有形成依赖屏障')
  assert.deepEqual(dependencyResults, ['read_a', 'read_b', 'write_c', 'read_d'], '并行工具结果没有按模型原始顺序回灌')
  let siblingSettled = false
  await assert.rejects(executeToolDependencyGraph(buildToolDependencyGraph([{ id: 'a', name: 'read_a' }, { id: 'b', name: 'read_b' }], { profileFor: () => ({ parallelSafe: true }) }), async ({ call }) => {
    if (call.name === 'read_a') throw new Error('first failed')
    await new Promise((resolve) => setTimeout(resolve, 15))
    siblingSettled = true
  }), /first failed/)
  assert.equal(siblingSettled, true, '并行批次出错时必须等待兄弟工具结束再跨越阶段边界')

  const parsedDsml = parseDsmlToolCalls('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="terminal"><｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="timeout" number="true">1200</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', [{ name: 'terminal' }])
  assert.equal(parsedDsml.answer, '')
  assert.equal(parsedDsml.toolCalls.length, 1)
  assert.deepEqual(parsedDsml.toolCalls[0].arguments, { command: 'pwd', timeout: 1200 })
  assert(!coreSource.includes(removedWeatherToolName) && !coreSource.includes(removedWeatherProviderName), 'ZSense Agent Core 不应再包含旧的专用天气实现')
  assert.deepEqual(validateOfficeCliArguments(['add', '文档.docx', '/body', '--type', 'paragraph']), ['add', '文档.docx', '/body', '--type', 'paragraph'])
  assert.deepEqual(validateOfficeCliArguments(['set', '演示文稿.pptx', '/slide[1]/shape[2]', '--prop', 'text=测试']), ['set', '演示文稿.pptx', '/slide[1]/shape[2]', '--prop', 'text=测试'])
  assert.throws(() => validateOfficeCliArguments(['view', '/etc/passwd', 'text']), /相对路径/)
  assert.throws(() => validateOfficeCliArguments(['view', '../文档.docx', 'text']), /相对路径/)

  const webSearchRequests = []
  const webSearch = await queryWebSearch('ZSense Agent Core 最新版本', 3, {
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      webSearchRequests.push({ url, init })
      assert.equal(url.hostname, 'mcp.exa.ai')
      return new Response(`data: ${JSON.stringify({ result: { content: [{ type: 'text', text: 'Title: ZSense Release\nURL: https://example.com/zsense\nHighlights:\nZSense Agent Core 发布了新版本。' }] } })}\n\n`, { status: 200 })
    },
  })
  assert.equal(webSearchRequests.length, 1)
  assert.equal(webSearch.source, 'Exa')
  assert.equal(webSearch.results[0].url, 'https://example.com/zsense')
  assert(webSearchRequests[0].init.body.includes('web_search_exa'))

  const core = new ZSenseAgentCore()
  const recovered = await core.chatStream({
    requestId: 'zsense-core-transient-429',
    bot: { id: 'atlas', name: 'Atlas' }, message: '测试短暂限流。', model: 'test-model',
    modelProvider: 'custom', baseUrl: `${baseUrl}/transient-429`, workspacePath,
    settings: { responseLanguage: 'zh-CN' }, onEvent: () => undefined,
  })
  assert.equal(recovered.output, '限流后恢复正常。')
  assert.equal(transient429Requests, 2, '明确 429 只能短退避重试一次')
  assert.equal('proposeSkillLearning' in core, false, 'Agent Core 不应再暴露自动技能学习接口')
  const events = []
  const result = await core.chatStream({
    requestId: 'zsense-core-smoke-0001',
    bot: { id: 'atlas', name: 'Atlas', role: '研究助手', prompt: '回答必须基于事实。' },
    message: '工作区有什么文件？',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl,
    workspacePath,
    skills: [{ id: 'test-skill', name: 'Test Skill', description: '测试技能', content: '# Test Skill' }],
    memories: [{ id: 'memory-1', title: '语言', excerpt: '用户偏好中文', type: 'preference' }],
    settings: { responseLanguage: 'zh-CN', contextAutoCompression: true },
    appContext: { bots: [{ id: 'atlas', name: 'Atlas', status: 'online' }] },
    onEvent: (event) => events.push(event),
  })

  assert.equal(result.engine, 'zsense-core')
  assert(result.sessionId.startsWith('zsense-core:'))
  assert.equal(result.output, '已经通过 ZSense Agent Core 找到 hello.txt。')
  assert.equal(result.usage.inputTokens, 220, '累计输入 Token 应保留全部 Agent Loop 轮次以供计费统计')
  assert.equal(result.usage.outputTokens, 23, '累计输出 Token 应保留全部 Agent Loop 轮次以供计费统计')
  assert.equal(result.usage.totalTokens, 243, '累计总 Token 应保留全部 Agent Loop 轮次')
  assert.equal(result.usage.contextUsed, 138, '上下文占用应使用单轮请求峰值，不能累计 Agent Loop 的每轮输入')
  assert.equal(requests.length, 2)
  assert(requests[0].body.messages[0].content.includes('只运行在 ZSense Agent Core'))
  assert(requests[0].body.messages[0].content.includes('天气时，必须调用 web_search 获取当前信息'))
  assert(!requests[0].body.tools.some((tool) => tool.function?.name === removedWeatherToolName), 'ZSense Agent Core 不应再暴露旧的专用天气工具')
  assert(requests[0].body.messages[0].content.includes('必须调用 web_search'))
  assert(requests[0].body.tools.some((tool) => tool.function?.name === 'web_search'), 'ZSense Agent Core 没有向模型暴露通用联网搜索工具')
  assert(requests[0].body.tools.find((tool) => tool.function?.name === 'web_search')?.function?.description.includes('天气'), '联网搜索工具应明确承接天气查询')
  assert(requests[0].body.messages[0].content.includes('用户偏好中文'))
  assert(requests[0].body.messages[0].content.includes('Office 文档修改工具成功后') && requests[0].body.messages[0].content.includes('同一错误连续出现两轮'), 'Office 简单编辑任务缺少防多轮重试约束')
  assert(requests[1].body.messages.some((message) => message.role === 'tool' && message.content.includes('hello.txt')))
  assert.deepEqual(events.filter((event) => event.type === 'tool').map((event) => event.status), ['running', 'complete'])
  assert(events.some((event) => event.type === 'reasoning'))
  assert.deepEqual(events.filter((event) => event.type === 'agent-step').map((event) => `${event.step}:${event.phase}`), ['1:started', '1:completed', '2:started', '2:completed'])
  assert.equal(result.agentSteps.length, 2)
  assert.equal(result.agentSteps[0].outcome, 'tool_calls')
  assert.equal(result.agentSteps[0].tools[0].name, 'list_workspace')
  assert.equal(result.agentSteps[1].outcome, 'final_answer')
  assert.equal(result.agentSteps[1].content, result.output)
  assert.equal(events.at(-1)?.type, 'done')

  // 设备互联：会话上下文里必须带上已配对设备，否则 Agent 只会回答“看不到”
  const deviceLinkEvents = []
  const deviceLinkResult = await core.chatStream({
    requestId: 'zsense-core-device-link',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '你现在能看到我在设备互联里连接的设备吗？',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/main`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    appContext: {
      deviceLink: {
        enabled: true,
        running: true,
        localDevice: { name: '本机 Mac', addresses: ['192.168.3.14'], port: 39072 },
        paired: [{ deviceId: 'peer-1', name: '客厅 Windows', platformLabel: 'Windows', online: true, allowStatus: true, allowTasks: false }],
        nearby: [{ name: '书房 Mac', platformLabel: 'macOS' }],
      },
    },
    onEvent: (event) => deviceLinkEvents.push(event),
  })
  const devicePrompt = requests.filter((item) => item.url.includes('/main/')).at(-1).body.messages[0].content
  assert(devicePrompt.includes('【设备互联】'), '系统提示词没有包含设备互联说明')
  assert(devicePrompt.includes('客厅 Windows') && devicePrompt.includes('可直接读取对方内容') && devicePrompt.includes('未授权执行任务'), '设备互联说明缺少设备与授权细节')
  assert(devicePrompt.includes('192.168.3.14') && devicePrompt.includes('39072'), '设备互联说明缺少本机地址与端口')
  assert(devicePrompt.includes('list_devices') && devicePrompt.includes('read_device_data') && devicePrompt.includes('run_task_on_device'), '设备互联说明没有告诉 Agent 用哪些工具查')
  assert(devicePrompt.includes('conversation') && devicePrompt.includes('file'), '设备互联说明没有说明可以读对话与文件内容')
  assert.equal(deviceLinkResult.engine, 'zsense-core')

  const steeringEvents = []
  const steeringPromise = core.chatStream({
    requestId: 'zsense-core-steering-test',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '先执行一个长推理。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/steering`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => steeringEvents.push(event),
  })
  while (steeringRequestCount < 1) await new Promise((resolve) => setTimeout(resolve, 5))
  const steeringAccepted = core.steerChat('zsense-core-steering-test', '改为直接给出结论。')
  assert.equal(steeringAccepted.accepted, true)
  assert.equal(steeringAccepted.intent, 'adjust')
  const steeringResult = await steeringPromise
  assert.equal(steeringRequestCount, 2, '追加指令没有中断当前模型请求并启动重新规划')
  assert.equal(steeringResult.output, '已按追加指令重新规划并完成。')
  assert(steeringEvents.some((event) => event.type === 'steering' && event.phase === 'queued' && event.intent === 'adjust'))
  assert(steeringEvents.some((event) => event.type === 'steering' && event.phase === 'applied'))
  assert(steeringEvents.some((event) => event.type === 'agent-step' && event.outcome === 'steered'))
  assert(requests.filter((item) => item.url.includes('/steering/')).at(-1).body.messages.some((item) => item.role === 'user' && String(item.content).includes('改为直接给出结论')))

  const limitEvents = []
  const limitResult = await core.chatStream({
    requestId: 'zsense-core-loop-limit',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '持续读取后汇总。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/loop-limit`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => limitEvents.push(event),
  })
  assert.equal(loopLimitRequestCount, 21, '正常有进展的任务应能超过旧版 16 轮上限并继续执行')
  assert.equal(limitResult.output, '超过旧版轮次上限后仍正常完成。')
  assert.equal(limitResult.agentSteps.length, 21)
  assert.equal(limitResult.agentSteps.at(-1).outcome, 'final_answer')
  assert(!limitEvents.some((event) => event.type === 'status' && event.phase === 'finalizing'), '有进展的长任务不应因轮次被强制收尾')
  assert(requests.filter((item) => item.url.includes('/loop-limit/')).at(-1).body.tools, '正常最终回答不应是禁用工具的强制汇总请求')
  // 长任务必须收到轮次经济性提醒（第 12 轮一次），并在界面上可见。
  const hintRequest = requests.filter((item) => item.url.includes('/loop-limit/')).find((item) => item.body.messages.some((message) => message.role === 'system' && String(message.content).includes('【ZSense 轮次控制】') && String(message.content).includes('12 轮')))
  assert(hintRequest, '第 12 轮没有注入轮次经济性提醒')
  assert(limitEvents.some((event) => event.type === 'status' && event.phase === 'round-economy'), '没有向界面提示轮次提醒')

  // 超过 80 轮的任务只要每轮取得新结果，就不能因固定轮数被截断。
  const capEvents = []
  const capResult = await core.chatStream({
    requestId: 'zsense-core-loop-cap',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '一直调用工具不要停。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/loop-cap`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => capEvents.push(event),
  })
  assert.equal(capResult.output, '85 轮后任务正常完成。')
  assert.equal(loopCapRequestCount, 86)
  assert.equal(capResult.agentSteps.at(-1).outcome, 'final_answer')
  assert(!capEvents.some((event) => event.type === 'status' && event.phase === 'finalizing'), '有进展的长任务不得强制收尾')
  assert(capEvents.some((event) => event.type === 'status' && event.phase === 'round-economy'), '长任务应收到非终止性的合并提醒')

  const invalidEvents = []
  const invalidResult = await core.chatStream({ requestId: 'zsense-core-invalid-loop', bot: { id: 'atlas', name: 'Atlas' }, message: '重复无效参数。', model: 'test-model', modelProvider: 'custom', baseUrl: `${baseUrl}/loop-invalid`, workspacePath, settings: { responseLanguage: 'zh-CN' }, onEvent: (event) => invalidEvents.push(event) })
  assert.equal(invalidResult.output, '已说明参数错误并停止。')
  assert.equal(loopInvalidRequestCount, 3, '重复的无效参数应在两轮错误后停止')
  assert(invalidEvents.some((event) => event.type === 'tool' && event.status === 'error' && event.output.includes('不支持参数')))
  assert(invalidEvents.some((event) => event.type === 'status' && event.phase === 'finalizing'))

  const repeatEvents = []
  const repeatResult = await core.chatStream({
    requestId: 'zsense-core-loop-repeat',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '不要重复同一个读取操作。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/loop-repeat`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => repeatEvents.push(event),
  })
  assert.equal(loopRepeatRequestCount, 4, '连续重复相同结果三轮后应进入最终汇总')
  assert.equal(repeatResult.output, '已停止重复调用并完成汇总。')
  assert.equal(repeatResult.agentSteps.length, 4)
  assert(repeatEvents.some((event) => event.type === 'status' && event.phase === 'finalizing' && event.message.includes('连续 3 轮')))

  const failClosedCore = new ZSenseAgentCore()
  failClosedCore.runCursors = { filePath: '/unwritable/agent-cursors.json', resumable: () => null, upsert: () => { throw new Error('disk full') }, finish: () => undefined }
  await assert.rejects(failClosedCore.chatStream({ requestId: 'zsense-core-cursor-failure', bot: { id: 'atlas', name: 'Atlas' }, message: '写文件。', model: 'test-model', modelProvider: 'custom', baseUrl: `${baseUrl}/cursor-failure`, workspacePath, settings: { responseLanguage: 'zh-CN' } }), /运行游标保存失败，已阻止工具执行/)
  assert.equal(cursorFailureRequestCount, 1)
  assert.equal(fs.existsSync(path.join(workspacePath, 'must-not-exist.txt')), false, '持久化失败后不得执行写入工具')

  // 运行被取消时，挂起的澄清问题必须通知界面，否则卡片会一直停在可点击状态
  const clarifyCancelEvents = []
  const clarifyCancelPromise = core.chatStream({
    requestId: clarifyCancelRequestId,
    bot: { id: 'atlas', name: 'Atlas' },
    message: '先问我一个问题。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/clarify-cancel`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => clarifyCancelEvents.push(event),
  })
  for (let attempt = 0; attempt < 200 && !clarifyCancelEvents.some((event) => event.type === 'clarify'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert(clarifyCancelEvents.some((event) => event.type === 'clarify'), '澄清请求没有送达界面')
  core.cancelChat(clarifyCancelRequestId)
  await assert.rejects(() => clarifyCancelPromise, /已停止生成/)
  const expiredEvents = clarifyCancelEvents.filter((event) => event.type === 'clarify-expired')
  assert.equal(expiredEvents.length, 1, '取消运行时应该把挂起的澄清标记为过期')
  assert.equal(expiredEvents[0].clarificationRequestId, clarifyCancelEvents.find((event) => event.type === 'clarify').clarification.requestId, '过期事件必须指向那个挂起的澄清请求')

  // 收尾轮空内容：应自动再要一次结论，而不是让用户手动发“继续汇总”
  const summaryRetryEvents = []
  const summaryRetryResult = await core.chatStream({
    requestId: 'zsense-core-summary-retry',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '收尾轮空内容时自动重试。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/summary-retry`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => summaryRetryEvents.push(event),
  })
  assert.equal(summaryRetryFinalRounds, 2, '收尾轮返回空内容后应自动重试一次（收尾轮共两次）')
  assert.equal(summaryRetryResult.output, '自动重新生成最终结论成功。')
  assert(summaryRetryEvents.some((event) => event.type === 'status' && event.phase === 'summary-retry'), '缺少自动重试的状态提示')
  assert(!summaryRetryResult.output.includes('继续汇总'), '自动重试成功后不应再提示用户继续汇总')
  assert(summaryRetryEvents.filter((event) => event.type === 'answer').map((event) => event.delta).join('') === '自动重新生成最终结论成功。', '自动重试的回答应以流式增量方式呈现')

  // 两次都拿不到内容时才回落到底部提示
  const summaryEmptyEvents = []
  const summaryEmptyResult = await core.chatStream({
    requestId: 'zsense-core-summary-empty',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '两次都空内容。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/summary-empty`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => summaryEmptyEvents.push(event),
  })
  assert.equal(summaryEmptyFinalRounds, 2, '两次收尾都为空时不应继续重试第三次')
  assert(summaryEmptyResult.output.includes('继续汇总'), '全部为空时应保留兜底说明')

  // 已结束的运行不再需要恢复：游标只保留末尾少量步骤，避免文件无限增长拖慢每轮保存
  const pruneCursorRoot = mkdtempSync(path.join(tmpdir(), 'zsense-cursor-prune-'))
  const pruneCursorStore = new AgentRunCursorStore(pruneCursorRoot)
  pruneCursorStore.upsert({
    sessionId: 'cursor-prune-session',
    requestId: 'cursor-prune-request',
    status: 'running',
    step: 30,
    canonicalMessages: [{ role: 'user', content: 'x'.repeat(2_000) }, { role: 'assistant', content: 'y'.repeat(2_000) }],
    agentSteps: Array.from({ length: 30 }, (_, index) => ({ step: index + 1, status: 'complete', outcome: 'tools', toolCallCount: 2, durationMs: 100, content: 'z'.repeat(600), tools: [{ name: 'terminal', durationMs: 10, output: 'o'.repeat(600) }] })),
  })
  const pruneCursorPath = path.join(pruneCursorRoot, 'runs', 'agent-cursors.json')
  const pruneBytesBeforeFinish = fs.statSync(pruneCursorPath).size
  pruneCursorStore.finish('cursor-prune-session', 'complete', { requestId: 'cursor-prune-request', step: 30 })
  const pruneBytesAfterFinish = fs.statSync(pruneCursorPath).size
  const prunedCursors = JSON.parse(fs.readFileSync(pruneCursorPath, 'utf8'))
  assert.equal(prunedCursors[0].agentSteps.length, 8, '已结束的运行只应保留末尾少量步骤')
  assert.equal(prunedCursors[0].canonicalMessages.length, 0, '已结束的运行不应再保留消息正文')
  assert(pruneBytesAfterFinish * 3 < pruneBytesBeforeFinish, `结束后游标文件应明显变小（${pruneBytesBeforeFinish} → ${pruneBytesAfterFinish}）`)

  const failureEvents = []
  const failureResult = await core.chatStream({
    requestId: 'zsense-core-loop-failure',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '尝试读取系统绝对路径。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl: `${baseUrl}/loop-failure`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: (event) => failureEvents.push(event),
  })
  assert.equal(loopFailureRequestCount, 3, '同一工具连续两轮返回相同错误后应停止重试并进入最终汇总')
  assert.equal(failureResult.output, '已停止无效重试并说明失败原因。')
  assert.equal(failureResult.agentSteps.length, 3)
  assert(failureEvents.some((event) => event.type === 'status' && event.phase === 'finalizing' && event.message.includes('相同错误')))

  const voiceRequestStart = requests.length
  await core.chatStream({
    requestId: 'zsense-core-voice-0001',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '简单告诉我现在该做什么。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl,
    workspacePath,
    interactionMode: 'voice',
    settings: { responseLanguage: 'zh-CN' },
  })
  const voicePrompt = requests.slice(voiceRequestStart)[0].body.messages[0].content
  assert(voicePrompt.includes('这是实时语音会话'))
  assert(voicePrompt.includes('默认只说一至三个短句'))
  assert(voicePrompt.includes('不要使用 Markdown'))

  const sanitizedHistoryStart = requests.length
  await core.chatStream({
    requestId: 'zsense-core-history-clean-0001',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '继续处理当前问题。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl,
    workspacePath,
    legacyMessages: [{ role: 'assistant', content: '请打开 https://accounts.feishu.cn/oauth/v1/device/verify 并输入用户码 ABCD-EFGH\n![飞书授权二维码](feishu-auth-qr.png)' }],
    settings: { responseLanguage: 'zh-CN' },
  })
  const sanitizedMessages = requests.slice(sanitizedHistoryStart)[0].body.messages
  assert(!JSON.stringify(sanitizedMessages).includes('accounts.feishu.cn/oauth/v1/device/verify'), '旧飞书授权链接仍被送入后续模型上下文')
  assert(!JSON.stringify(sanitizedMessages).includes('feishu-auth-qr.png'), '旧飞书授权二维码仍被送入后续模型上下文')
  assert(JSON.stringify(sanitizedMessages).includes('已移除这条历史回复中过期的第三方授权'), '清洗旧授权信息后没有给模型明确的禁止复用提示')

  if (process.platform !== 'win32') {
    const fakeOfficeTool = path.join(workspacePath, 'fake-officecli')
    const uploadedWorkbook = path.join(workspacePath, 'uploaded.xlsx')
    fs.writeFileSync(fakeOfficeTool, '#!/bin/sh\nprintf "Sheet1\\nA1\\t名称\\nB2\\tZSense 测试数据\\n"\n', 'utf8')
    fs.chmodSync(fakeOfficeTool, 0o755)
    fs.writeFileSync(uploadedWorkbook, 'fake workbook container', 'utf8')
    const officeRequestStart = requests.length
    const fakeOfficeWorkspace = {
      getWorkbook: async () => ({
        filePath: uploadedWorkbook,
        revision: 'test-session-7',
        sessionId: 'office-test-session',
        sessionRevision: 7,
        dirty: true,
        pendingCount: 1,
        sheets: [{ id: 'sheet-1', sheet: 'Sheet1', rowCount: 1000, columnCount: 26, usedRowCount: 2, usedColumnCount: 2, cells: { A1: { address: 'A1', value: '名称', display: '名称', formula: '', dataType: 'string' }, B2: { address: 'B2', value: 'ZSense 测试数据', display: 'ZSense 测试数据', formula: '', dataType: 'string' } } }],
      }),
      stageCells: async () => ({ filePath: uploadedWorkbook, sessionId: 'office-test-session', revision: 8, dirty: true, pendingCount: 2, changed: 1, message: '已暂存。' }),
      saveWorkbook: async () => ({ filePath: uploadedWorkbook, sessionId: 'office-test-session', revision: 9, dirty: false, pendingCount: 0, saved: 2, message: '已保存。' }),
    }
    const officeCore = new ZSenseAgentCore({ officeWorkspace: fakeOfficeWorkspace, officeToolPaths: [fakeOfficeTool] })
    await officeCore.chatStream({
      requestId: 'zsense-core-office-0001',
      bot: { id: 'atlas', name: 'Atlas' },
      message: '请读取这个 Excel。',
      model: 'test-model',
      modelProvider: 'custom',
      baseUrl,
      workspacePath,
      attachments: [{ id: 'workbook-1', name: 'uploaded.xlsx', path: uploadedWorkbook, workspaceRelativePath: 'uploaded.xlsx', size: 23, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'file' }],
      settings: { responseLanguage: 'zh-CN' },
    })
    const officeRequest = requests.slice(officeRequestStart)[0].body
    assert(officeRequest.messages.at(-1).content.includes('Excel 附件 uploaded.xlsx 已从 ZSense 实时本地会话读取'))
    assert(officeRequest.messages.at(-1).content.includes('有 1 项尚未保存修改'))
    assert(officeRequest.messages.at(-1).content.includes('ZSense 测试数据'))
    assert(officeRequest.tools.some((tool) => tool.function?.name === 'run_officecli'), 'Office attachment must expose the read tool even when skill assignment is missing')
    for (const name of ['read_spreadsheet', 'edit_spreadsheet_cells', 'save_spreadsheet']) {
      assert(officeRequest.tools.some((tool) => tool.function?.name === name), `${name} must be exposed for the shared workbook session`)
    }

    // 完全访问：共享表格会话可以直接读写工作区之外的表格（写回必须审批）
    const approvalCalls = []
    const saveCalls = []
    const outsideWorkspace = {
      getWorkbook: async ({ filePath }) => ({ filePath, revision: 'outside-1', sessionId: 'outside-session', sessionRevision: 1, dirty: false, pendingCount: 0, sheets: [] }),
      stageCells: async ({ filePath }) => ({ filePath, sessionId: 'outside-session', revision: 2, dirty: true, pendingCount: 1, changed: 1, message: '已暂存。' }),
      saveWorkbook: async ({ filePath }) => { saveCalls.push(filePath); return { filePath, sessionId: 'outside-session', revision: 3, dirty: false, pendingCount: 0, saved: 1, message: '已保存。' } },
    }
    fs.writeFileSync(outsideSpreadsheetPath, 'fake workbook container', 'utf8')
    const outsideStart = requests.length
    const outsideCore = new ZSenseAgentCore({
      officeWorkspace: outsideWorkspace,
      capabilityService: {
        setDelegateRunner: () => undefined,
        expandReferences: async (message) => ({ message, references: [] }),
        projectContext: () => '',
        activeState: () => ({}),
        runHook: async () => undefined,
        definitions: () => [],
        toolExecutionProfile: () => ({ parallelSafe: true, risk: 'read' }),
        requestApproval: async (_context, options) => { approvalCalls.push(options); return { approved: true, mode: 'once' } },
      },
    })
    const outsideResult = await outsideCore.chatStream({
      requestId: 'zsense-core-outside-spreadsheet',
      bot: { id: 'atlas', name: 'Atlas' },
      message: '读取并保存桌面上的表格。',
      model: 'test-model',
      modelProvider: 'custom',
      baseUrl: `${baseUrl}/outside-spreadsheet`,
      workspacePath,
      skills: [{ name: 'officecli', content: '使用已分配的本地 Office 工具。' }],
      settings: { responseLanguage: 'zh-CN' },
    })
    assert.equal(outsideResult.output, '工作区外的表格处理完成。')
    assert.equal(saveCalls.length, 1, '工作区外的表格没有被写回')
    assert.equal(saveCalls[0], fs.realpathSync.native(outsideSpreadsheetPath), '写回目标应是用户指定的那个文件')
    assert.equal(approvalCalls.length, 1, '只应针对工作区外的写回请求审批，读取不需要审批')
    assert.equal(approvalCalls[0].category, 'filesystem:external-write')
    assert(approvalCalls[0].question.includes(outsideSpreadsheetPath), '审批提示没有说明目标文件')
    const outsideMessages = JSON.stringify(requests.slice(outsideStart)[2]?.body?.messages || [])
    assert(!outsideMessages.includes('工具路径超出了当前会话工作区'), '完全访问下不应再因为路径在工作区之外而失败')

    // 自动审批：开启后需要审批的写入由模型判断，判断为同意就不再打扰用户
    if (process.platform !== 'win32') {
      const approvalDataRoot = path.join(temporaryDirectoryForApproval, 'agent-core')
      const approvalDatabase = new ZSenseDatabase(temporaryDirectoryForApproval)
      const capabilityService = new AgentCapabilityService({ rootPath: approvalDataRoot, database: approvalDatabase, browserService: { shutdown: () => undefined } })
      autoApprovalTargetPath = path.join(temporaryDirectoryForApproval, 'auto-approved.txt')
      const autoCore = new ZSenseAgentCore({ capabilityService })
      const autoEvents = []
      const autoResult = await autoCore.chatStream({
        requestId: 'zsense-core-auto-approval',
        bot: { id: 'atlas', name: 'Atlas' },
        message: '把这个文件写到桌面。',
        model: 'test-model',
        modelProvider: 'custom',
        baseUrl: `${baseUrl}/auto-approval`,
        workspacePath,
        settings: { responseLanguage: 'zh-CN', autoApprovalEnabled: true },
        onEvent: (event) => autoEvents.push(event),
      })
      assert.equal(autoResult.output, '文件已写入。')
      assert.equal(autoApprovalJudgeCount >= 1, true, '开启自动审批后应先调用审批模型')
      assert.equal(fs.readFileSync(autoApprovalTargetPath, 'utf8'), 'auto approved content', '模型同意后应直接写入')
      assert(!autoEvents.some((event) => event.type === 'clarify'), '自动审批通过时不应弹出人工确认')
      const autoState = capabilityService.inspect({ computerUseEnabled: false })
      assert.equal(autoState.approvals.autoApproval.recent[0].allow, true, '自动审批结果应写入审计')
      assert.equal(autoState.approvals.autoApproval.recent[0].category, 'filesystem:external-write')

      // 关闭开关时必须回到人工确认（这里用“无法显示审批界面”证明走了人工路径）
      autoApprovalTargetPath = path.join(temporaryDirectoryForApproval, 'manual-required.txt')
      autoApprovalToolRounds = 0
      const manualCore = new ZSenseAgentCore({ capabilityService: new AgentCapabilityService({ rootPath: approvalDataRoot, database: approvalDatabase, browserService: { shutdown: () => undefined } }) })
      const manualEvents = []
      let manualAsked = 0
      await manualCore.chatStream({
        requestId: 'zsense-core-auto-approval-off',
        bot: { id: 'atlas', name: 'Atlas' },
        message: '把这个文件写到桌面。',
        model: 'test-model',
        modelProvider: 'custom',
        baseUrl: `${baseUrl}/auto-approval`,
        workspacePath,
        settings: { responseLanguage: 'zh-CN' },
        approvalHandler: async () => { manualAsked += 1; return '拒绝' },
        onEvent: (event) => manualEvents.push(event),
      })
      assert.equal(manualAsked, 1, '关闭自动审批后应回到人工确认')
      assert.equal(fs.existsSync(autoApprovalTargetPath), false, '用户没有确认前不应写入')
      assert(!manualEvents.some((event) => event.type === 'clarify'), '有审批处理器时不应再走 clarify 事件')
    }

    // 没有审批入口（后台任务）时，工作区外写回必须被拒绝
    const outsideDeniedCore = new ZSenseAgentCore({
      officeWorkspace: outsideWorkspace,
      capabilityService: {
        setDelegateRunner: () => undefined,
        expandReferences: async (message) => ({ message, references: [] }),
        projectContext: () => '',
        activeState: () => ({}),
        runHook: async () => undefined,
        definitions: () => [],
        toolExecutionProfile: () => ({ parallelSafe: true, risk: 'read' }),
      },
    })
    outsideSpreadsheetRequestCount = 0
    const deniedStart = requests.length
    await outsideDeniedCore.chatStream({
      requestId: 'zsense-core-outside-spreadsheet-denied',
      bot: { id: 'atlas', name: 'Atlas' },
      message: '保存桌面上的表格。',
      model: 'test-model',
      modelProvider: 'custom',
      baseUrl: `${baseUrl}/outside-spreadsheet`,
      workspacePath,
      skills: [{ name: 'officecli', content: '使用已分配的本地 Office 工具。' }],
      settings: { responseLanguage: 'zh-CN' },
    })
    const deniedMessages = JSON.stringify(requests.slice(deniedStart).map((item) => item.body.messages))
    assert(deniedMessages.includes('无法显示审批界面'), '无审批入口时工作区外写回应被拒绝')
    assert.equal(outsideCore.officeWorkspace === outsideWorkspace, true)
    fs.rmSync(outsideSpreadsheetPath, { force: true })
    outsideSpreadsheetRequestCount = 0
    const missingCore = new ZSenseAgentCore({
      officeWorkspace: outsideWorkspace,
      capabilityService: {
        setDelegateRunner: () => undefined,
        expandReferences: async (message) => ({ message, references: [] }),
        projectContext: () => '',
        activeState: () => ({}),
        runHook: async () => undefined,
        definitions: () => [],
        toolExecutionProfile: () => ({ parallelSafe: true, risk: 'read' }),
        requestApproval: async () => ({ approved: true, mode: 'once' }),
      },
    })
    const missingStart = requests.length
    await missingCore.chatStream({
      requestId: 'zsense-core-outside-spreadsheet-missing',
      bot: { id: 'atlas', name: 'Atlas' },
      message: '读取不存在的表格。',
      model: 'test-model',
      modelProvider: 'custom',
      baseUrl: `${baseUrl}/outside-spreadsheet`,
      workspacePath,
      skills: [{ name: 'officecli', content: '使用已分配的本地 Office 工具。' }],
      settings: { responseLanguage: 'zh-CN' },
    })
    const missingMessages = JSON.stringify(requests.slice(missingStart).map((item) => item.body.messages))
    assert(missingMessages.includes('目标路径不存在或无法读取'), '工作区外文件不存在时应给出明确提示')

    const fakeKdocsTool = path.join(workspacePath, 'fake-kdocs-cli')
    fs.writeFileSync(fakeKdocsTool, '#!/bin/sh\nprintf "2.5.7\\n"\n', 'utf8')
    fs.chmodSync(fakeKdocsTool, 0o755)
    const kdocsRequestStart = requests.length
    const kdocsCore = new ZSenseAgentCore({ kdocsToolPaths: [fakeKdocsTool] })
    await kdocsCore.chatStream({
      requestId: 'zsense-core-kdocs-0001',
      bot: { id: 'atlas', name: 'Atlas' },
      message: '请查看我的金山文档。',
      model: 'test-model',
      modelProvider: 'custom',
      baseUrl,
      workspacePath,
      skills: [{ id: 'kdocs', name: 'kdocs', description: '金山文档技能', content: '# Kdocs' }],
      settings: { responseLanguage: 'zh-CN' },
    })
    const kdocsRequest = requests.slice(kdocsRequestStart)[0].body
    assert(kdocsRequest.tools.some((tool) => tool.function?.name === 'run_kdocs'), 'kdocs skill must expose the isolated run_kdocs tool')

    const fakeLarkTool = path.join(workspacePath, 'fake-lark-cli')
    fs.writeFileSync(fakeLarkTool, '#!/bin/sh\nprintf "lark-cli version 1.0.95\\n"\n', 'utf8')
    fs.chmodSync(fakeLarkTool, 0o755)
    const larkEvents = []
    const larkRequestStart = requests.length
    const larkCore = new ZSenseAgentCore({ larkToolPaths: [fakeLarkTool] })
    const larkResult = await larkCore.chatStream({
      requestId: 'zsense-core-lark-0001',
      bot: { id: 'atlas', name: 'Atlas' },
      message: '检查飞书 CLI 是否可用。',
      model: 'test-model',
      modelProvider: 'custom',
      baseUrl: `${baseUrl}/lark-run`,
      workspacePath,
      skills: [{ id: 'lark', name: 'lark', description: '统一飞书技能', content: '# 飞书统一技能' }],
      settings: { responseLanguage: 'zh-CN' },
      onEvent: (event) => larkEvents.push(event),
    })
    const larkRequests = requests.slice(larkRequestStart).filter((item) => item.url.includes('/lark-run/'))
    assert(larkRequests[0].body.tools.some((tool) => tool.function?.name === 'run_lark_cli'), '飞书技能没有暴露内置 run_lark_cli 工具')
    assert(larkEvents.some((event) => event.type === 'tool' && event.name === 'run_lark_cli' && String(event.output || '').includes('1.0.95')), 'run_lark_cli 没有实际执行内置命令')
    assert.equal(larkResult.output, '飞书 CLI 已内置并可用。')
  }

  const status = composeAgentRuntimeStatus(await core.inspect(), { managedByApp: true, expectedCount: 0, healthyCount: 0 }, { supported: true, provider: '测试语音', wakePhrase: '你好 ZSense' }, workspacePath)
  assert.equal(status.runnable, true)
  assert.equal(status.agentEngine, 'zsense-core')
  assert.equal(status.gatewayEngine, 'zsense-native')
  assert.equal(status.voiceEngine, 'zsense-native')
  assert(status.message.includes('消息网关与语音均由 ZSense 提供'))

  const beforeTransientMemory = requests.length
  assert.deepEqual(await core.extractMemories({ message: '继续', model: 'test-model', modelProvider: 'custom', baseUrl }), [])
  assert.equal(requests.length, beforeTransientMemory, '临时短指令不应发起记忆模型请求')
  const largeExistingMemories = Array.from({ length: 150 }, (_, index) => ({
    id: `irrelevant-memory-${index}`, title: `无关资料 ${index}`, excerpt: '临时资料'.repeat(300), type: 'fact', source: 'ZSense 自动记忆',
  }))
  const memoryProposals = await core.extractMemories({
    message: '以后请一直用简体中文回复我。',
    existingMemories: largeExistingMemories,
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl,
    strict: true,
  })
  assert.deepEqual(memoryProposals.map(({ title, type }) => ({ title, type })), [{ title: '回复语言偏好', type: 'preference' }])
  assert.equal(memoryProposals[0]?.evidence, '以后请一直用简体中文回复我')
  assert.equal(requests.at(-1).body.tools, undefined, 'memory extraction must not expose agent tools')
  assert(requests.at(-1).body.messages[1].content.length < 12_000, '提取提示不得注入整个记忆库')

  const reviewProposals = await core.reviewMemoryBank({
    recentUserMessages: [{ content: '以后一直使用浅蓝色主题。' }],
    existingMemories: [],
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl,
    strict: true,
  })
  assert.equal(reviewProposals[0]?.title, '主题偏好')
  assert.equal(reviewProposals[0]?.evidence, '以后一直使用浅蓝色主题')
  assert.equal(requests.at(-1).body.tools, undefined, 'periodic memory review must not expose agent tools')
  const beforeTransientReview = requests.length
  assert.deepEqual(await core.reviewMemoryBank({
    recentUserMessages: [{ content: '继续' }, { content: '今天天气怎么样？' }],
    model: 'test-model', modelProvider: 'custom', baseUrl,
  }), [])
  assert.equal(requests.length, beforeTransientReview, '仅包含临时请求的复盘不应发起模型请求')

  const scheduledSummary = await core.summarizeScheduledTaskMemory({
    taskName: '每日摘要',
    taskPrompt: '每天整理最新变化。',
    previousSummary: '## 旧状态\n- 已完成第一轮',
    latestOutput: '本次发现两项新变化。',
    model: 'test-model',
    modelProvider: 'custom',
    baseUrl,
  })
  assert.match(scheduledSummary, /已合并本次成功结果/)
  assert.equal(requests.at(-1).body.tools, undefined, 'scheduled memory summary must not expose agent tools')

  const fallbackEvents = []
  const fallback = await core.chatStream({
    requestId: 'zsense-core-smoke-fallback',
    bot: { id: 'atlas', name: 'Atlas' },
    message: '请说明当前模式。',
    model: 'gpt-5-test',
    modelProvider: 'openai',
    apiKey: 'test-key',
    baseUrl: `${baseUrl}/fallback`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    reasoningEffort: 'max',
    onEvent: (event) => fallbackEvents.push(event),
  })
  const fallbackRequests = requests.filter((item) => item.url.includes('/fallback/'))
  assert.equal(fallback.output, '当前模型已安全降级为纯文本回答。')
  assert.equal(fallbackRequests.length, 2)
  assert.equal(fallbackRequests[0].body.reasoning_effort, 'high', 'max must map to an OpenAI-compatible reasoning effort')
  assert(Array.isArray(fallbackRequests[0].body.tools))
  assert.equal(fallbackRequests[1].body.tools, undefined)
  assert(fallbackRequests[1].body.messages.at(-1).content.includes('不得声称已经读取'))
  assert(fallbackEvents.some((event) => event.phase === 'compatibility'))

  console.log(JSON.stringify({ ok: true, directStreaming: true, toolLoop: true, reasoning: true, usage: true, memoryExtraction: true, periodicMemoryReview: true, scheduledMemorySummary: true, toolFallback: true, weatherViaWebSearch: true, openMeteoRemoved: true, webSearch: true, webSearchHostRestricted: true, voiceConversationPrompt: true, kdocsToolConnected: true, larkToolConnected: process.platform !== 'win32', legacyAuthorizationCleaned: true, nativeDelegationBridge: true, zsenseNative: true }))
} finally {
  server.close()
  rmSync(workspacePath, { recursive: true, force: true })
}
