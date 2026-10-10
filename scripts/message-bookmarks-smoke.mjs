// 用户轮次书签：只改导航元数据，真实数据库 / IPC / HTTPS 网页桥均使用隔离夹具。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { registerIpcHandlers } from '../electron/ipc.mjs'
import { NATIVE_BOT_ID, ZSenseDatabase } from '../electron/services/database.mjs'
import { createPreloadBridge, WebBridgeService } from '../electron/services/web-bridge-service.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-message-bookmarks-'))
const fixturePath = (name) => {
  const result = path.join(directory, name)
  fs.mkdirSync(result, { recursive: true })
  return result
}
app.setPath('userData', fixturePath('electron'))
const sourcePath = fixturePath('source')
let database = new ZSenseDatabase(sourcePath)
let legacyDatabase = null
let importedDatabase = null
let service = null
let exitCode = 0

const row = (value) => ({ ...value })
const withoutBookmark = (value) => {
  const { bookmarked: _bookmarked, ...rest } = value
  return rest
}
const conversationRows = () => database.db.prepare('SELECT * FROM conversations ORDER BY rowid').all().map(row)
const messageRows = () => database.db.prepare('SELECT * FROM messages ORDER BY rowid').all().map((value) => withoutBookmark(row(value)))
const request = (port, route, { cookie = '', body } = {}) => new Promise((resolve, reject) => {
  const encoded = body === undefined ? null : JSON.stringify(body)
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}) }
  const pending = https.request({ hostname: '127.0.0.1', port, path: route, method: encoded ? 'POST' : 'GET', headers, rejectUnauthorized: false, agent: false }, (response) => {
    let result = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => { result += chunk })
    response.on('end', () => {
      try { resolve({ status: response.statusCode, headers: response.headers, payload: JSON.parse(result) }) }
      catch (error) { reject(error) }
    })
  })
  pending.on('error', reject)
  pending.setTimeout(10_000, () => pending.destroy(new Error('书签夹具请求超时')))
  pending.end(encoded)
})

try {
  const bookmarkColumn = database.db.prepare('PRAGMA table_info(messages)').all().find((column) => column.name === 'bookmarked')
  assert(bookmarkColumn, '新数据库缺少书签字段')
  assert.equal(bookmarkColumn.notnull, 1)
  assert.equal(bookmarkColumn.dflt_value, '0')

  const conversationId = database.createNativeConversation('书签会话', { runtimeEngine: 'zsense-core', runtimeSessionId: 'fixture-running-session', workspacePath: sourcePath })
  const otherConversationId = database.createNativeConversation('另一条会话')
  const botConversationId = database.createConversation('atlas', 'Bot 隔离会话')
  const firstId = database.addMessage(conversationId, 'user', '第一轮问题', { createdAt: '2026-10-01T01:02:03Z', attachments: [{ id: 'fixture-file', name: 'reference.txt', path: '/fixture/reference.txt', size: 12, mimeType: 'text/plain', kind: 'file' }] })
  const assistantId = database.addMessage(conversationId, 'assistant', '第一轮回答', { reasoning: '只属于夹具的推理', agentSteps: [{ step: 1, content: '结果' }], toolEvents: [{ name: 'fixture-tool', status: 'success' }], modelProvider: 'deepseek', model: 'fixture-model', durationMs: 1234, outputTokens: 27, createdAt: '2026-10-01T01:02:04Z' })
  const systemId = database.addMessage(conversationId, 'system', '夹具状态', { createdAt: '2026-10-01T01:02:05Z' })
  const secondId = database.addMessage(conversationId, 'user', '第二轮问题', { createdAt: '2026-10-01T01:02:06Z' })
  const otherId = database.addMessage(otherConversationId, 'user', '隔离消息')
  const botMessageId = database.addMessage(botConversationId, 'user', 'Bot 消息')
  database.reorderConversations(NATIVE_BOT_ID, [otherConversationId, conversationId])
  database.db.prepare("UPDATE conversations SET updated_at='2026-10-01T10:00:00Z', usage_json=? WHERE id=?").run(JSON.stringify({ contextUsed: 234, contextMax: 8000, running: true }), conversationId)

  const beforeConversations = conversationRows()
  const beforeMessages = messageRows()
  const beforeOrder = database.loadWorkspace().conversations.map((conversation) => conversation.id)
  const beforeContext = database.loadConversationMessages(conversationId)
  assert(database.getConversation(conversationId).messages.every((message) => message.bookmarked === false), '新消息默认不能带书签')

  const originalLoad = database.loadWorkspace.bind(database)
  const originalGet = database.getConversation.bind(database)
  database.loadWorkspace = () => { throw new Error('书签操作不应加载工作区') }
  database.getConversation = () => { throw new Error('书签操作不应加载会话历史') }
  assert.deepEqual(database.setConversationMessageBookmark(conversationId, firstId, true), { conversationId, messageId: firstId, bookmarked: true })
  assert.deepEqual(database.setConversationMessageBookmark(conversationId, firstId, true), { conversationId, messageId: firstId, bookmarked: true }, '重复设置应幂等')
  database.loadWorkspace = originalLoad
  database.getConversation = originalGet
  assert.equal(database.getConversation(conversationId).messages[0].bookmarked, true, '单会话加载遗漏书签')
  assert.equal(database.loadWorkspace().conversations.find((conversation) => conversation.id === conversationId).messages[0].bookmarked, true, '完整快照遗漏书签')
  assert.deepEqual(conversationRows(), beforeConversations, '书签改变了会话时间、排序、归档或运行状态')
  assert.deepEqual(messageRows(), beforeMessages, '书签改变了正文、推理、工具、附件、顺序或模型元数据')
  assert.deepEqual(database.loadWorkspace().conversations.map((conversation) => conversation.id), beforeOrder, '书签改变了会话排序')
  assert.deepEqual(database.loadConversationMessages(conversationId), beforeContext, '书签进入了模型可读取的消息上下文')

  for (const value of [undefined, null, 0, 1, 'true', 'false', [], {}, new Boolean(true)]) {
    assert.throws(() => database.setConversationMessageBookmark(conversationId, firstId, value), /布尔值/, '书签不能隐式转换为布尔值')
  }
  for (const id of [assistantId, systemId]) assert.throws(() => database.setConversationMessageBookmark(conversationId, id, true), /用户消息/)
  for (const [owner, id] of [[otherConversationId, firstId], [conversationId, otherId], [conversationId, botMessageId], ['missing-conversation', firstId], [conversationId, 'missing-message']]) {
    assert.throws(() => database.setConversationMessageBookmark(owner, id, true), /不存在.*不属于/, '错误归属不能修改书签')
  }
  assert.equal(database.getConversation(otherConversationId).messages[0].bookmarked, false)
  assert.equal(database.getConversation(botConversationId).messages[0].bookmarked, false)
  assert.deepEqual(conversationRows(), beforeConversations, '校验失败不能修改会话')
  assert.deepEqual(messageRows(), beforeMessages, '校验失败不能修改消息')

  database.close()
  database = new ZSenseDatabase(sourcePath)
  assert.equal(database.getConversation(conversationId).messages[0].bookmarked, true, '重启后书签丢失')
  assert.deepEqual(database.setConversationMessageBookmark(conversationId, firstId, false), { conversationId, messageId: firstId, bookmarked: false })
  database.close()
  database = new ZSenseDatabase(sourcePath)
  assert.equal(database.getConversation(conversationId).messages[0].bookmarked, false, '清除书签后重启又恢复了旧标记')

  // 真实旧版消息表：去掉新字段、保留现有消息，升级后默认0且原数据不变。
  const legacyPath = fixturePath('legacy')
  legacyDatabase = new ZSenseDatabase(legacyPath)
  const legacyConversationId = legacyDatabase.createNativeConversation('旧库夹具')
  const legacyMessageId = legacyDatabase.addMessage(legacyConversationId, 'user', '迁移不能改正文', { createdAt: '2026-01-01T00:00:00Z' })
  const legacyBefore = withoutBookmark(row(legacyDatabase.db.prepare('SELECT * FROM messages WHERE id=?').get(legacyMessageId)))
  legacyDatabase.close()
  legacyDatabase = null
  const rawLegacy = new DatabaseSync(path.join(legacyPath, 'zsense.sqlite3'))
  try {
    rawLegacy.exec('ALTER TABLE messages DROP COLUMN bookmarked')
    rawLegacy.prepare("UPDATE meta SET value='41' WHERE key='schema_version'").run()
  } finally { rawLegacy.close() }
  legacyDatabase = new ZSenseDatabase(legacyPath)
  const migrated = row(legacyDatabase.db.prepare('SELECT * FROM messages WHERE id=?').get(legacyMessageId))
  assert.equal(migrated.bookmarked, 0, '迁移消息默认不是未标记')
  assert.deepEqual(withoutBookmark(migrated), legacyBefore, '加列迁移改变了历史消息')
  legacyDatabase.setConversationMessageBookmark(legacyConversationId, legacyMessageId, true)
  legacyDatabase.close()
  legacyDatabase = new ZSenseDatabase(legacyPath)
  assert.equal(legacyDatabase.getConversation(legacyConversationId).messages[0].bookmarked, true, '迁移库的书签没有持久化')

  // 当前快照的JSON导出保留标记；外部历史导入只接受 user + 严格true，重复同步不覆盖本地标记。
  database.setConversationMessageBookmark(conversationId, firstId, true)
  const exported = JSON.parse(JSON.stringify(database.loadWorkspace())).conversations.find((conversation) => conversation.id === conversationId).messages
  assert.equal(exported[0].bookmarked, true)
  importedDatabase = new ZSenseDatabase(fixturePath('imported'))
  const imported = importedDatabase.importExternalMessages([{ botId: 'atlas', channelId: 'dingtalk', externalThreadId: 'bookmark-fixture', messages: exported.map((message, index) => ({ ...message, externalMessageId: `fixture-import-${index}`, ...(message.role === 'assistant' ? { bookmarked: true } : {}) })) }])
  const importedConversation = imported.workspace.conversations.find((conversation) => conversation.externalThreadId === 'bookmark-fixture')
  assert.equal(importedConversation.messages[0].bookmarked, true, '导入丢失用户消息书签')
  assert(importedConversation.messages.filter((message) => message.role !== 'user').every((message) => message.bookmarked === false), '导入不能给非用户消息设置书签')
  importedDatabase.setConversationMessageBookmark(importedConversation.id, importedConversation.messages[0].id, false)
  importedDatabase.importExternalMessages([{ botId: 'atlas', channelId: 'dingtalk', externalThreadId: 'bookmark-fixture', messages: [{ role: 'user', content: '原消息同步', externalMessageId: 'fixture-import-0', bookmarked: true }, { role: 'user', content: '不能转换字符串', externalMessageId: 'fixture-string-boolean', bookmarked: 'true' }] }])
  assert.equal(importedDatabase.getConversation(importedConversation.id).messages[0].bookmarked, false, '重复同步覆盖了本地清除书签')
  assert.equal(importedDatabase.getConversation(importedConversation.id).messages.at(-1).bookmarked, false, '导入字符串被隐式转换为书签')

  // 跑真实 IPC 的 safeHandle：禁止锁定期间操作，并验证 preload 只映射明确书签操作。
  const handlers = new Map()
  let locked = false
  let authChecks = 0
  registerIpcHandlers({ ipcMain: { removeHandler: (name) => handlers.delete(name), handle: (name, handler) => handlers.set(name, handler) }, database, deviceLinkService: {}, auth: { requireUser: () => { authChecks += 1; if (locked) throw new Error('fixture security lock'); return { id: 'fixture-owner', role: 'admin' } } } })
  const bridge = createPreloadBridge(path.join(projectRoot, 'electron/preload.cjs'))
  assert(bridge.paths.includes('conversations.bookmarkMessage'))
  const call = bridge.resolveCall('conversations.bookmarkMessage', [conversationId, secondId, true])
  assert.equal(call.channel, 'zsense:conversations:bookmark-message')
  assert.deepEqual(JSON.parse(JSON.stringify(call.payload)), { conversationId, messageId: secondId, bookmarked: true })
  const event = { sender: { id: 1 } }
  locked = true
  assert.deepEqual(await handlers.get(call.channel)(event, call.payload), { ok: false, error: 'fixture security lock' }, '书签绕过了safeHandle鉴权')
  assert.equal(database.getConversation(conversationId).messages.at(-1).bookmarked, false)
  locked = false
  const ipcResult = await handlers.get(call.channel)(event, call.payload)
  assert.deepEqual(ipcResult, { ok: true, data: { conversationId, messageId: secondId, bookmarked: true } }, 'IPC应返回窄结果而不是快照')
  assert(authChecks >= 2)
  assert.equal((await handlers.get(call.channel)(event, { ...call.payload, bookmarked: 'true' })).ok, false)
  assert.equal((await handlers.get(call.channel)(event, { ...call.payload, conversationId: otherConversationId })).ok, false)
  assert.equal((await handlers.get(call.channel)(event, { ...call.payload, messageId: assistantId })).ok, false)

  const bridgeRoot = fixturePath('bridge')
  const staticDirectory = fixturePath('bridge/dist')
  fs.writeFileSync(path.join(staticDirectory, 'index.html'), '<!doctype html><html><body>书签夹具</body></html>')
  const freePort = await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
  })
  fs.mkdirSync(path.join(bridgeRoot, 'web-bridge'))
  fs.writeFileSync(path.join(bridgeRoot, 'web-bridge/state.json'), JSON.stringify({ port: freePort }))
  service = new WebBridgeService({ rootPath: bridgeRoot, staticDirectory, preloadPath: path.join(projectRoot, 'electron/preload.cjs'), handlers })
  const status = await service.setEnabled(true)
  const body = { path: 'conversations.bookmarkMessage', args: [conversationId, secondId, false] }
  assert.equal((await request(status.port, '/bridge/invoke', { body })).status, 401, '未登录网页不能改书签')
  const login = await request(status.port, '/bridge/login', { body: { code: status.accessCode } })
  assert.equal(login.status, 200)
  const cookie = login.headers['set-cookie'][0].split(';')[0]
  const manifest = await request(status.port, '/bridge/manifest', { cookie })
  assert(manifest.payload.data.paths.includes('conversations.bookmarkMessage'))
  const webResult = await request(status.port, '/bridge/invoke', { cookie, body })
  assert.equal(webResult.status, 200)
  assert.equal(webResult.headers['cache-control'], 'no-store')
  assert.deepEqual(webResult.payload, { ok: true, data: { conversationId, messageId: secondId, bookmarked: false } })
  locked = true
  const blockedByLock = await request(status.port, '/bridge/invoke', { cookie, body: { ...body, args: [conversationId, secondId, true] } })
  assert.deepEqual(blockedByLock.payload, { ok: false, error: 'fixture security lock' }, '网页书签绕过了安全锁鉴权')
  assert.equal(database.getConversation(conversationId).messages.at(-1).bookmarked, false)
  locked = false
  assert.equal((await request(status.port, '/bridge/invoke', { cookie, body: { path: 'auth.users.list', args: [] } })).status, 403, '新方法不能放宽账号管理禁用通道')
  assert.equal((await request(status.port, '/bridge/invoke', { cookie, body: { path: 'conversations.bookmarkAll', args: [] } })).status, 400, '不存在的书签方法不能被泛化放行')
  service.revokeSession(service.inspect().sessions[0].token)
  assert.equal((await request(status.port, '/bridge/invoke', { cookie, body })).status, 401, '会话撤销后不能继续改书签')
  assert.deepEqual(conversationRows(), beforeConversations, 'IPC或网页书签改变了会话运行状态和排序')
  assert.deepEqual(messageRows(), beforeMessages, 'IPC或网页书签改变了消息内容')

  database.deleteConversationMessage(conversationId, firstId)
  assert.equal(database.db.prepare('SELECT id FROM messages WHERE id=?').get(firstId), undefined, '删除消息后残留书签记录')
  assert.throws(() => database.setConversationMessageBookmark(conversationId, firstId, true), /不存在/)
  database.setConversationMessageBookmark(otherConversationId, otherId, true)
  database.deleteConversation(otherConversationId)
  assert.equal(database.db.prepare('SELECT id FROM messages WHERE id=?').get(otherId), undefined, '删除会话没有级联清除已标记消息')

  console.log(JSON.stringify({ ok: true, isolatedFixtures: true, freshAndMigration: true, survivesRestart: true, clearPersists: true, strictBoolean: true, userRoleAndOwnershipGuard: true, contentOrderRuntimeUnchanged: true, contextUnchanged: true, importPreservesUserBookmarks: true, deletionCleanup: true, narrowIpc: true, securityLockGuard: true, authenticatedWebBridge: true, revokedSessionDenied: true, noStore: true }))
} catch (error) {
  exitCode = 1
  console.error(error)
} finally {
  try { await service?.setEnabled(false) } catch { /* 保留原失败信息。 */ }
  for (const instance of [database, legacyDatabase, importedDatabase]) { try { instance?.close() } catch { /* 可能已经在重开前关闭。 */ } }
  fs.rmSync(directory, { recursive: true, force: true })
  app.exit(exitCode)
}
