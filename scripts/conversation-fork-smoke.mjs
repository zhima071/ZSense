// 消息分支：真实 DB / IPC / preload / HTTPS 桥 / Agent Core 均只运行隔离夹具。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { registerIpcHandlers } from '../electron/ipc.mjs'
import { AgentCapabilityService } from '../electron/services/agent-capability-service.mjs'
import { NATIVE_BOT_ID, ZSenseDatabase } from '../electron/services/database.mjs'
import { createPreloadBridge, WebBridgeService } from '../electron/services/web-bridge-service.mjs'
import { ZSenseAgentCore } from '../electron/services/zsense-agent-core.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-conversation-fork-'))
const fixturePath = (name) => {
  const value = path.join(directory, name)
  fs.mkdirSync(value, { recursive: true })
  return value
}
app.setPath('userData', fixturePath('electron'))
const dataPath = fixturePath('database')
const workspacePath = fixturePath('workspace')
const runtimePath = fixturePath('runtime')
const attachmentPath = path.join(workspacePath, 'reference.txt')
fs.writeFileSync(attachmentPath, '分支只引用此附件，不复制、改写或删除文件。', 'utf8')
let database = new ZSenseDatabase(dataPath)
let capabilities = null
let webBridge = null
let modelServer = null
let exitCode = 0
const rows = (sql, ...args) => database.db.prepare(sql).all(...args).map((row) => ({ ...row }))
const messages = (id) => rows('SELECT * FROM messages WHERE conversation_id=? ORDER BY datetime(created_at), rowid', id)
const sourceSnapshot = (id) => ({ conversation: rows('SELECT * FROM conversations WHERE id=?', id)[0], messages: messages(id) })
const databaseSnapshot = () => ({ conversations: rows('SELECT * FROM conversations ORDER BY rowid'), messages: rows('SELECT * FROM messages ORDER BY rowid') })
const fileSnapshot = () => {
  const stat = fs.statSync(attachmentPath)
  return { hash: createHash('sha256').update(fs.readFileSync(attachmentPath)).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs, files: fs.readdirSync(workspacePath) }
}
const historicalFields = ({ id: _id, conversation_id: _conversation, external_message_id: _external, hermes_message_id: _hermes, ...rest }) => rest
const request = (port, route, { cookie = '', body } = {}) => new Promise((resolve, reject) => {
  const encoded = body === undefined ? null : JSON.stringify(body)
  const pending = https.request({ hostname: '127.0.0.1', port, path: route, method: encoded ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}) }, rejectUnauthorized: false, agent: false }, (response) => {
    let result = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => { result += chunk })
    response.on('end', () => {
      try { resolve({ status: response.statusCode, headers: response.headers, payload: JSON.parse(result) }) }
      catch (error) { reject(error) }
    })
  })
  pending.on('error', reject)
  pending.setTimeout(10_000, () => pending.destroy(new Error('分支夹具请求超时')))
  pending.end(encoded)
})

try {
  const sourceId = database.createNativeConversation('分支源'.repeat(30), { channelId: 'dingtalk', externalThreadId: 'fixture-external-thread', runtimeEngine: 'zsense-core', runtimeSessionId: 'zsense-core:fixture-source-session', modelProvider: 'deepseek', model: 'fixture-model', reasoningEffort: 'max', workspacePath })
  const firstId = database.addMessage(sourceId, 'user', '首轮问题', { createdAt: '2026-10-01T01:00:03Z', bookmarked: true, externalMessageId: 'fixture-user-external', attachments: [{ id: 'fixture-attachment', name: 'reference.txt', path: attachmentPath, size: fs.statSync(attachmentPath).size, mimeType: 'text/plain', kind: 'file' }] })
  const targetId = database.addMessage(sourceId, 'assistant', '已保存的分支回复', { createdAt: '2026-10-01T01:00:03Z', reasoning: '历史推理', agentSteps: [{ step: 1, status: 'complete', content: '历史步骤', tools: [] }], toolEvents: [{ id: 'fixture-tool', name: 'read_file', status: 'success', output: '历史工具结果' }], externalMessageId: 'fixture-assistant-external', modelProvider: 'deepseek', model: 'fixture-model', durationMs: 1234, outputTokens: 32 })
  database.addMessage(sourceId, 'user', '不能进入分支的同秒后续问题', { createdAt: '2026-10-01T01:00:03Z' })
  database.addMessage(sourceId, 'assistant', '不能进入分支的后续回复', { createdAt: '2026-10-01T01:00:04Z' })
  const systemId = database.addMessage(sourceId, 'system', '插入较晚但时间较早的系统历史', { createdAt: '2026-10-01T01:00:01Z' })
  const emptyId = database.addMessage(sourceId, 'assistant', '  \n\t ', { createdAt: '2026-10-01T01:00:05Z' })
  database.db.prepare("UPDATE conversations SET hermes_session_id='fixture-hermes-thread', usage_json=?, archived=1, sort_order=19, group_id='fixture-group', updated_at='2026-10-01T10:00:00Z' WHERE id=?").run(JSON.stringify({ contextUsed: 55555, contextMax: 64000, inputTokens: 800, outputTokens: 900, totalTokens: 1700 }), sourceId)
  database.db.prepare("UPDATE messages SET hermes_message_id='fixture-hermes-message' WHERE conversation_id=?").run(sourceId)
  const botSourceId = database.createConversation('atlas', '网关 Bot 历史', { channelId: 'telegram', externalThreadId: 'fixture-bot-thread', runtimeEngine: 'legacy', modelProvider: 'openai', model: 'fixture-bot-model', reasoningEffort: 'low', workspacePath })
  database.addMessage(botSourceId, 'user', 'Bot 问题')
  const botTargetId = database.addMessage(botSourceId, 'assistant', 'Bot 回复')
  database.addMessage(botSourceId, 'user', 'Bot 后续问题')
  database.db.prepare("UPDATE conversations SET hermes_session_id='fixture-legacy-session' WHERE id=?").run(botSourceId)
  const originalSource = sourceSnapshot(sourceId)
  const originalBotSource = sourceSnapshot(botSourceId)
  const originalFiles = fileSnapshot()
  const beforeInvalid = databaseSnapshot()
  for (const [conversationId, messageId] of [[sourceId, firstId], [sourceId, systemId], [sourceId, emptyId], [sourceId, 'unsaved-optimistic-id'], [botSourceId, targetId], [sourceId, botTargetId], ['missing-conversation', targetId]]) {
    assert.throws(() => database.forkConversationMessage(conversationId, messageId), /不存在|助手回复|不属于/)
    assert.deepEqual(databaseSnapshot(), beforeInvalid, '校验失败不能新建会话或复制消息')
  }

  // 模拟复制中途 SQLite 错误，必须连新会话和先前已复制消息一起回滚。
  database.db.exec("CREATE TEMP TRIGGER fixture_fork_failure BEFORE INSERT ON messages WHEN NEW.content='已保存的分支回复' BEGIN SELECT RAISE(ABORT, 'fixture fork rollback'); END")
  assert.throws(() => database.forkConversationMessage(sourceId, targetId), /fixture fork rollback/)
  assert.deepEqual(databaseSnapshot(), beforeInvalid, '事务未回滚部分分支')
  database.db.exec('DROP TRIGGER fixture_fork_failure')

  capabilities = new AgentCapabilityService({ rootPath: runtimePath, database })
  const sourceContext = { botId: NATIVE_BOT_ID, conversationId: sourceId, workspaceRoot: workspacePath }
  await capabilities.execute('todo_manage', { action: 'add', title: 'source-only-todo' }, sourceContext)
  await capabilities.execute('goal_manage', { action: 'create', objective: 'source-only-goal' }, sourceContext)
  await capabilities.execute('loop_manage', { action: 'create', name: 'source-only-loop', prompt: 'source-only-loop-prompt' }, sourceContext)
  await capabilities.execute('heartbeat_manage', { action: 'create', prompt: 'source-only-heartbeat' }, sourceContext)
  const autonomyState = capabilities.state()
  autonomyState.todos[NATIVE_BOT_ID].push({ id: 'fixture-unowned-todo', title: 'unowned-legacy-todo' })
  autonomyState.goals[NATIVE_BOT_ID].push({ id: 'fixture-unowned-goal', objective: 'unowned-legacy-goal', status: 'active' })
  autonomyState.loops.push({ id: 'fixture-unowned-loop', scope: NATIVE_BOT_ID, name: 'unowned-legacy-loop', enabled: true })
  autonomyState.heartbeats.push({ id: 'fixture-unowned-heartbeat', scope: NATIVE_BOT_ID, prompt: 'unowned-legacy-heartbeat', enabled: true })
  capabilities.saveState(autonomyState)
  const beforeAutonomyFile = fs.readFileSync(capabilities.statePath, 'utf8')
  assert.deepEqual(Object.values(capabilities.activeState(sourceContext)).map((value) => value.length), [1, 1, 1, 1], '源会话只能注入自己的临时状态')
  assert.deepEqual(Object.values(capabilities.activeState({ botId: NATIVE_BOT_ID })).map((value) => value.length), [2, 2, 2, 2], '无会话后台场景应保持原Bot scope读取')
  assert.deepEqual(Object.values(capabilities.activeState({ botId: 'atlas', conversationId: sourceId })).map((value) => value.length), [0, 0, 0, 0], '会话归属过滤不能放宽Bot隔离')

  const core = new ZSenseAgentCore({ capabilityService: capabilities, runtimeRootPath: runtimePath })
  core.runCursors.upsert({ sessionId: originalSource.conversation.runtime_session_id, conversationId: sourceId, requestId: 'fixture-source-request', status: 'interrupted', phase: 'model', step: 7, canonicalMessages: [{ role: 'system', content: 'source-only-cached-context' }], reasoning: 'source-only-cached-reasoning', usage: { inputTokens: 800, outputTokens: 900, totalTokens: 1700 }, pendingSteering: [{ id: 'fixture-steering', content: 'source-only-pending-steering' }] })
  const originalCursor = JSON.parse(JSON.stringify(core.runCursors.resumable(originalSource.conversation.runtime_session_id, sourceId)))
  const beforeCursorFile = fs.readFileSync(core.runCursors.filePath, 'utf8')
  const forkResult = database.forkConversationMessage(sourceId, targetId)
  const forkId = forkResult.conversationId
  const fork = forkResult.workspace.conversations.find((conversation) => conversation.id === forkId)
  assert(fork && fork.id !== sourceId)
  assert.equal(fork.botId, NATIVE_BOT_ID)
  assert.equal(fork.kind, 'native')
  assert.equal(fork.title.length, 80)
  assert(fork.title.endsWith('（分支）'))
  assert.equal(fork.channelId, 'web')
  assert.equal(fork.externalThreadId, '')
  assert.equal(fork.runtimeEngine, '')
  assert.equal(fork.runtimeSessionId, '')
  assert.deepEqual([fork.modelProvider, fork.model, fork.reasoningEffort, fork.workspacePath], ['deepseek', 'fixture-model', 'max', workspacePath])
  assert.deepEqual([fork.archived, fork.groupId, fork.sortOrder], [false, '', 0])
  const forkRaw = sourceSnapshot(forkId)
  assert.deepEqual([forkRaw.conversation.external_thread_id, forkRaw.conversation.hermes_session_id, forkRaw.conversation.runtime_session_id, forkRaw.conversation.usage_json], ['', '', '', '{}'])
  const copied = originalSource.messages.slice(0, originalSource.messages.findIndex((message) => message.id === targetId) + 1)
  assert.deepEqual(copied.map((message) => message.id), [systemId, firstId, targetId], '夹具必须覆盖乱序插入和同秒rowid截断')
  assert.deepEqual(forkRaw.messages.map(historicalFields), copied.map(historicalFields), '分支改变了正文/推理/工具/附件/书签/模型/时间')
  assert.equal(fork.messageCount, copied.length)
  assert(forkRaw.messages.every((message) => !originalSource.messages.some((original) => original.id === message.id) && message.external_message_id === '' && message.hermes_message_id === ''))
  assert.equal(new Set(forkRaw.messages.map((message) => message.id)).size, copied.length)
  assert.deepEqual(capabilities.activeState({ ...sourceContext, conversationId: forkId }), { todos: [], goals: [], loops: [], heartbeats: [] }, '分支注入了源会话或无归属历史的自治状态')
  assert.equal(fs.readFileSync(capabilities.statePath, 'utf8'), beforeAutonomyFile, '分支创建修改了源自治存储')
  assert.equal(fs.readFileSync(core.runCursors.filePath, 'utf8'), beforeCursorFile, '分支创建复制或修改了源运行/压缩游标')
  assert.equal(core.runCursors.resumable(originalCursor.sessionId, forkId), null)
  const botForkResult = database.forkConversationMessage(botSourceId, botTargetId)
  const botFork = botForkResult.workspace.conversations.find((conversation) => conversation.id === botForkResult.conversationId)
  assert.deepEqual([botFork.botId, botFork.kind, botFork.channelId, botFork.modelProvider, botFork.model, botFork.reasoningEffort, botFork.runtimeSessionId, botFork.externalThreadId], ['atlas', 'bot', 'web', 'openai', 'fixture-bot-model', 'low', '', ''])
  assert.deepEqual(botFork.messages.map((message) => message.content), ['Bot 问题', 'Bot 回复'])
  assert.deepEqual(fileSnapshot(), originalFiles, '分支复制触碰了附件文件')

  // 真正运行分支首轮：本地模型夹具接收的上下文不得含旧游标、后续消息或源自治状态。
  const modelRequests = []
  modelServer = http.createServer(async (incoming, response) => {
    let body = ''
    for await (const chunk of incoming) body += chunk
    modelRequests.push(JSON.parse(body))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '分支后续回答。' } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
  const continued = await core.chatStream({ requestId: 'fixture-fork-first-turn', bot: { id: NATIVE_BOT_ID, name: 'Fixture Native' }, message: '继续分支', model: fork.model, modelProvider: fork.modelProvider, apiKey: 'fixture-local-key', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, reasoningEffort: fork.reasoningEffort, workspacePath: fork.workspacePath, runtimeSessionId: fork.runtimeSessionId, legacyMessages: fork.messages, settings: { contextAutoCompression: true }, appContext: { currentConversation: { id: forkId } } })
  assert(continued.sessionId.startsWith('zsense-core:') && continued.sessionId !== originalCursor.sessionId)
  assert.deepEqual([continued.usage.inputTokens, continued.usage.outputTokens, continued.usage.totalTokens], [7, 3, 10], '首轮使用量继承了源运行统计')
  assert.equal(modelRequests.length, 1)
  const submitted = JSON.stringify(modelRequests[0])
  for (const marker of ['source-only-', 'unowned-legacy-', '不能进入分支']) assert(!submitted.includes(marker), `分支首轮带入了 ${marker}`)
  assert(submitted.includes('首轮问题') && submitted.includes('已保存的分支回复') && submitted.includes('继续分支'))
  assert.deepEqual(core.runCursors.resumable(originalCursor.sessionId, sourceId), originalCursor, '新运行改变了源游标')
  await capabilities.execute('todo_manage', { action: 'add', title: 'fork-only-todo' }, { ...sourceContext, conversationId: forkId })
  assert.equal(capabilities.activeState({ ...sourceContext, conversationId: forkId }).todos[0].conversationId, forkId, '新todo没有记录会话归属')
  assert.equal(capabilities.activeState(sourceContext).todos[0].title, 'source-only-todo')

  const handlers = new Map()
  let locked = false
  let authChecks = 0
  registerIpcHandlers({ ipcMain: { removeHandler: (channel) => handlers.delete(channel), handle: (channel, handler) => handlers.set(channel, handler) }, database, deviceLinkService: {}, auth: { requireUser: () => { authChecks += 1; if (locked) throw new Error('fixture security lock'); return { id: 'fixture-owner', role: 'admin' } } } })
  const bridge = createPreloadBridge(path.join(projectRoot, 'electron/preload.cjs'))
  assert(bridge.paths.includes('conversations.forkMessage'))
  const call = bridge.resolveCall('conversations.forkMessage', [sourceId, targetId])
  assert.equal(call.channel, 'zsense:conversations:fork-message')
  assert.deepEqual(JSON.parse(JSON.stringify(call.payload)), { conversationId: sourceId, messageId: targetId })
  const beforeLocked = databaseSnapshot()
  locked = true
  assert.deepEqual(await handlers.get(call.channel)({ sender: { id: 1 } }, call.payload), { ok: false, error: 'fixture security lock' })
  assert.deepEqual(databaseSnapshot(), beforeLocked, '安全锁阻断后仍创建了分支')
  locked = false
  const ipcResult = await handlers.get(call.channel)({ sender: { id: 1 } }, call.payload)
  assert(ipcResult.ok && ipcResult.data.conversationId && ipcResult.data.workspace.conversations.some((conversation) => conversation.id === ipcResult.data.conversationId))
  assert(authChecks >= 2)
  for (const payload of [null, {}, { conversationId: sourceId, messageId: firstId }, { conversationId: botSourceId, messageId: targetId }, { conversationId: sourceId, messageId: 17 }]) assert.equal((await handlers.get(call.channel)({ sender: { id: 1 } }, payload)).ok, false)

  const bridgeRoot = fixturePath('bridge')
  const staticDirectory = fixturePath('bridge/dist')
  fs.writeFileSync(path.join(staticDirectory, 'index.html'), '<!doctype html><html><body>分支夹具</body></html>')
  const freePort = await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
  })
  fs.mkdirSync(path.join(bridgeRoot, 'web-bridge'))
  fs.writeFileSync(path.join(bridgeRoot, 'web-bridge/state.json'), JSON.stringify({ port: freePort }))
  webBridge = new WebBridgeService({ rootPath: bridgeRoot, staticDirectory, preloadPath: path.join(projectRoot, 'electron/preload.cjs'), handlers })
  const status = await webBridge.setEnabled(true)
  const body = { path: 'conversations.forkMessage', args: [sourceId, targetId] }
  assert.equal((await request(status.port, '/bridge/invoke', { body })).status, 401)
  const login = await request(status.port, '/bridge/login', { body: { code: status.accessCode } })
  assert.equal(login.status, 200)
  const cookie = login.headers['set-cookie'][0].split(';')[0]
  assert((await request(status.port, '/bridge/manifest', { cookie })).payload.data.paths.includes('conversations.forkMessage'))
  const webResult = await request(status.port, '/bridge/invoke', { cookie, body })
  assert.equal(webResult.status, 200)
  assert.equal(webResult.headers['cache-control'], 'no-store')
  assert(webResult.payload.ok && webResult.payload.data.conversationId)
  locked = true
  const beforeWebLock = databaseSnapshot()
  assert.deepEqual((await request(status.port, '/bridge/invoke', { cookie, body })).payload, { ok: false, error: 'fixture security lock' })
  assert.deepEqual(databaseSnapshot(), beforeWebLock)
  locked = false
  webBridge.revokeSession(webBridge.inspect().sessions[0].token)
  assert.equal((await request(status.port, '/bridge/invoke', { cookie, body })).status, 401)

  database.deleteConversationMessage(botFork.id, botFork.messages[0].id)
  assert.equal(database.getConversation(botSourceId).messages[0].content, 'Bot 问题', '删除分支消息影响了源消息')
  database.deleteConversation(botFork.id)
  assert.deepEqual(fileSnapshot(), originalFiles, '删除分支触碰了源附件')
  assert.deepEqual(sourceSnapshot(sourceId), originalSource, '创建/继续/删除分支修改了源会话或消息')
  assert.deepEqual(sourceSnapshot(botSourceId), originalBotSource, '分支修改了源Bot会话或消息')
  database.close()
  database = new ZSenseDatabase(dataPath)
  assert.deepEqual(sourceSnapshot(forkId), forkRaw, '分支历史或默认状态没有持久化')
  assert.deepEqual(sourceSnapshot(sourceId), originalSource, '重开后源会话被分支改写')
  assert.deepEqual(fileSnapshot(), originalFiles)
  console.log(JSON.stringify({ ok: true, isolatedFixtures: true, nativeAndBotOwnership: true, chronologicalInclusiveCutoff: true, sameTimestampRowid: true, freshConversationAndMessageIds: true, metadataPreserved: true, externalIdentifiersCleared: true, transactionRollback: true, sourceUnchanged: true, attachmentsUntouched: true, survivesRestart: true, freshRuntimeAndUsage: true, noSourceCachedContextOrSteering: true, conversationScopedAutonomy: true, legacyUnownedAutonomyExcluded: true, backgroundScopePreserved: true, authenticatedIpcAndWebBridge: true, securityLockGuard: true, revokedSessionDenied: true, noStore: true }))
} catch (error) {
  exitCode = 1
  console.error(error)
} finally {
  try { await webBridge?.setEnabled(false) } catch { /* 保留原始失败。 */ }
  try { if (modelServer?.listening) await new Promise((resolve) => modelServer.close(resolve)) } catch { /* 保留原始失败。 */ }
  try { capabilities?.shutdown() } catch { /* 保留原始失败。 */ }
  try { database.close() } catch { /* 可能已在重开前关闭。 */ }
  fs.rmSync(directory, { recursive: true, force: true })
  app.exit(exitCode)
}
