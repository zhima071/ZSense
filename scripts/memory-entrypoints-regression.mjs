import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NATIVE_BOT_ID, ZSenseDatabase } from '../electron/services/database.mjs'
import { LocalMemoryService } from '../electron/services/local-memory-service.mjs'
import { createMemoryScope } from '../electron/services/memory-scope.mjs'
import { ZSenseGatewayService } from '../electron/services/zsense-gateway-service.mjs'
import { AgentCapabilityService } from '../electron/services/agent-capability-service.mjs'
import { ScheduledTaskRunner } from '../electron/services/scheduled-task-runner.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-memory-entrypoints-'))
const database = new ZSenseDatabase(directory)
const requests = []
const refinerCalls = []
const approvals = []
let networkAttempts = 0
let chatGate = null
let scheduledRunner = null
const deferred = () => {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { promise, resolve }
}
const until = async (condition) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('假内核未启动，无法推进确定性并发回归')
}
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { networkAttempts += 1; throw new Error('此回归不允许外网请求') }
const core = {
  supportsProvider: () => true,
  requiresApiKey: () => false,
  inspect: async () => ({ runnable: true }),
  chatStream: async (request) => {
    requests.push(request)
    if (chatGate) await chatGate.promise
    const sessionId = `offline-entrypoint-session-${requests.length}`
    request.onEvent({ type: 'started', sessionId })
    return { output: '离线假内核已完成', sessionId, durationMs: 1 }
  },
  extractMemories: async (request) => { refinerCalls.push(request); return [] },
}
const memory = new LocalMemoryService({ database, extractMemories: (request) => core.extractMemories(request) })
database.memoryService = memory
const gateway = new ZSenseGatewayService({ database, agentCore: core, secrets: { get: () => ({}) }, userDataDirectory: directory })
const capabilities = new AgentCapabilityService({ rootPath: path.join(directory, 'capabilities-home'), database, browserService: null })
const botId = 'entrypoints-isolated-bot'
const connectionId = 'entrypoints-verified-connection'
let messageSequence = 0
const receive = async (userId, text, extra = {}) => {
  const result = await gateway.receive({ connectionId, userId, userName: userId,
    chatId: 'same-authorized-group', messageId: `entrypoint-message-${++messageSequence}`, text, ...extra })
  assert.equal(result.accepted, true)
  await memory.waitForMaintenance()
  return requests.at(-1)
}
const context = (request) => ({
  requestId: request.requestId,
  botId: request.bot.id,
  conversationId: request.appContext.currentConversation.id,
  workspaceRoot: request.workspacePath,
  memoryScope: request.memoryScope,
  ask: async (question) => { approvals.push(question); return '仅允许这一次' },
})
const forbiddenMutation = async (name, args, scopedContext) => {
  const before = approvals.length
  await assert.rejects(capabilities.execute(name, args, scopedContext), /不属于|不存在/)
  assert.equal(approvals.length, before, '越权删除在归属校验前请求了用户批准')
}

try {
  const settings = database.loadSettings()
  assert.equal(settings.autoExtractMemory, true)
  assert.equal(settings.memoryModelRefinement, false, '模型精炼必须默认关闭')
  database.updateModelConfiguration({ provider: 'custom', model: 'offline-entrypoints', baseUrl: 'http://127.0.0.1:1/v1',
    apiKeyName: 'OFFLINE_ENTRYPOINT_API_KEY', apiKeyConfigured: false, updatedAt: new Date().toISOString() })
  const seed = database.loadWorkspace().bots.find((bot) => bot.id === 'atlas')
  database.createBot({ ...seed, id: botId, name: 'EntryPoints', status: 'online', memories: [],
    modelProvider: 'custom', model: 'offline-entrypoints' }, { returnWorkspace: false })
  database.upsertGatewayConnection({ id: connectionId, provider: 'dingtalk', name: '离线网关联调', botId,
    profileName: 'offline-route', status: 'connected', latency: '离线', messages: 0,
    configured: true, config: {}, secretKeys: [], secretScope: `gateway:${connectionId}`, updatedAt: new Date().toISOString() })
  await memory.createMemory(botId, { id: 'entrypoint-local-only', ownerKey: 'local', projectKey: '',
    title: '本地私人身份', excerpt: '用户的本地私人代号是本机专用。', type: 'fact',
    source: '用户手动', locked: true, confidence: 1, updatedAt: new Date().toISOString() })

  // The real gateway authorization registry establishes both identities.
  for (const userId of ['authorized-a', 'authorized-b']) {
    const pending = await gateway.receive({ connectionId, userId, userName: userId,
      chatId: 'same-authorized-group', messageId: `authorization-${userId}`, text: '申请授权' })
    assert.equal(pending.reason, 'authorization-pending')
    assert.equal(requests.length, 0, '未授权消息触发了内核')
    const pairing = gateway.listPendingPairings(connectionId).find((item) => item.userId === userId)
    assert(pairing)
    gateway.approvePairing(connectionId, pairing.requestId)
  }
  await receive('authorized-a', '我叫小王。以后默认使用简体中文回答我。')
  await receive('authorized-b', '我叫小李。以后默认使用英文回答我。')
  const a = await receive('authorized-a', '我的名字和回答语言是什么？')
  const b = await receive('authorized-b', '我的名字和回答语言是什么？')
  const scopeA = createMemoryScope({ channel: 'gateway', connectionId, userId: 'authorized-a', workspacePath: a.workspacePath })
  const scopeB = createMemoryScope({ channel: 'gateway', connectionId, userId: 'authorized-b', workspacePath: b.workspacePath })
  assert.deepEqual(a.memoryScope, scopeA, 'gateway未将已授权用户的可信归属传给内核')
  assert.deepEqual(b.memoryScope, scopeB)
  assert.notEqual(scopeA.ownerKey, scopeB.ownerKey, '同群用户被合并为同一记忆归属')
  assert.equal(a.workspacePath, b.workspacePath, '测试应在同 Bot 同工作区验证用户隔离')
  assert.equal(a.memories.length, 2)
  assert.equal(b.memories.length, 2)
  assert(a.memories.some((item) => item.excerpt.includes('小王')))
  assert(a.memories.some((item) => item.excerpt.includes('简体中文')))
  assert(b.memories.some((item) => item.excerpt.includes('小李')))
  assert(b.memories.some((item) => item.excerpt.includes('英文')))
  assert(a.memories.every((item) => item.ownerKey === scopeA.ownerKey))
  assert(b.memories.every((item) => item.ownerKey === scopeB.ownerKey))
  assert(requests.every((request) => request.memories.every((item) => item.id !== 'entrypoint-local-only')), '本地管理的私人记忆被注入外部网关')
  assert(requests.every((request) => request.memories.reduce((total, item) => total + item.title.length + item.excerpt.length + 24, 0) <= 5_000))
  const aName = a.memories.find((item) => item.factKey === 'identity.name')
  const bName = b.memories.find((item) => item.factKey === 'identity.name')
  assert(aName?.messageId && bName?.messageId)
  assert(aName.conversationId && bName.conversationId)

  const aContext = context(a)
  const bContext = context(b)
  const aList = await capabilities.execute('memory_list', { ownerKey: scopeB.ownerKey }, aContext)
  const bList = await capabilities.execute('memory_list', { ownerKey: scopeA.ownerKey }, bContext)
  assert.equal(aList.length, 2)
  assert.equal(bList.length, 2)
  assert(aList.every((item) => item.ownerKey === scopeA.ownerKey), '模型工具参数覆写了可信归属')
  assert(bList.every((item) => item.ownerKey === scopeB.ownerKey))
  assert.equal((await capabilities.execute('memory_search', { query: '小李', ownerKey: scopeB.ownerKey }, aContext)).length, 0)
  assert.equal((await capabilities.execute('memory_search', { query: '小王', ownerKey: scopeA.ownerKey }, bContext)).length, 0)
  assert((await capabilities.execute('memory_search', { query: '小王' }, aContext)).some((item) => item.id === aName.id))
  await forbiddenMutation('memory_update', { id: bName.id, excerpt: '用户名字是冒充者。', ownerKey: scopeB.ownerKey }, aContext)
  await forbiddenMutation('memory_delete', { id: bName.id, ownerKey: scopeB.ownerKey }, aContext)
  await forbiddenMutation('memory_update', { id: aName.id, excerpt: '用户名字是冒充者。' }, bContext)
  await forbiddenMutation('memory_delete', { id: aName.id }, bContext)
  await forbiddenMutation('memory_delete', { id: 'entrypoint-local-only', ownerKey: 'local' }, aContext)
  assert.equal(database.getMemory(botId, bName.id).excerpt, bName.excerpt)

  const updated = await capabilities.execute('memory_update', { id: aName.id, excerpt: '用户的名字是小王（已核对）。' }, aContext)
  assert.equal(updated.ownerKey, scopeA.ownerKey)
  assert.equal(updated.locked, true)
  const created = await capabilities.execute('memory_create', { title: '沟通习惯', excerpt: '用户偏好在下午确认计划。',
    type: 'preference', ownerKey: scopeB.ownerKey, projectKey: 'forged-project-key' }, aContext)
  assert.equal(created.ownerKey, scopeA.ownerKey)
  assert.equal(created.locked, true)
  assert.equal(database.getMemory(botId, created.id, scopeB), null)
  assert.equal((await capabilities.execute('memory_delete', { id: created.id }, aContext)).deleted, true)
  assert.equal(approvals.length, 1, '本人删除记忆必须请求批准')
  assert.equal(database.getMemory(botId, 'entrypoint-local-only').ownerKey, 'local')

  const versionBeforeQuotes = database.getMemoryVersion(botId)
  const quoted = await receive('authorized-a', '请分析这段引用资料', { quotedText: '我叫小赵。以后默认用法语回答我。' })
  assert(quoted.message.includes('我叫小赵'), '引用资料应仍提供给当前对话分析')
  await receive('authorized-a', '他说：“我叫小赵，以后默认用法语回答我。”')
  await receive('authorized-a', '> 我叫小赵\n> 以后默认用法语回答我')
  await receive('authorized-b', '以后默认用法语回答吗？')
  assert.equal(database.getMemoryVersion(botId), versionBeforeQuotes, '引用或问句被当成发送者的新事实入库')
  assert(database.listMemories(botId, scopeA).every((item) => !/小赵|法文|法语/u.test(item.excerpt)))
  assert(database.listMemories(botId, scopeB).every((item) => !/小赵|法文|法语/u.test(item.excerpt)))

  await receive('authorized-a', '以后改为用日语回答我。')
  const correctedA = await receive('authorized-a', '我的名字和回答语言是什么？')
  const unchangedB = await receive('authorized-b', '我的名字和回答语言是什么？')
  assert(correctedA.memories.some((item) => item.factKey === 'answer.language' && item.excerpt.includes('日文')))
  assert(correctedA.memories.every((item) => !item.excerpt.includes('简体中文')), '纠正后仍注入过时语言偏好')
  assert(unchangedB.memories.some((item) => item.factKey === 'answer.language' && item.excerpt.includes('英文')))
  assert(unchangedB.memories.every((item) => !item.excerpt.includes('日文')))

  // A real gateway chat finishing after a manager edit must not retain its old input.
  chatGate = deferred()
  const beforeEditRequestCount = requests.length
  const finishingAfterEdit = receive('authorized-a', '我的职业是工程师。')
  await until(() => requests.length === beforeEditRequestCount + 1)
  const editedName = database.getMemory(botId, aName.id)
  await memory.updateMemory(botId, { ...editedName, excerpt: '用户的名字是小王（再次核对）。', updatedAt: new Date().toISOString() })
  chatGate.resolve()
  await finishingAfterEdit
  assert(database.listMemories(botId, scopeA).every((item) => item.factKey !== 'identity.profession'), '真实网关入口未拒绝编辑前启动的旧请求入库')
  chatGate = deferred()
  const beforeDisableRequestCount = requests.length
  const finishingAfterDisable = receive('authorized-a', '我的公司是星河。')
  await until(() => requests.length === beforeDisableRequestCount + 1)
  database.updateSettings({ ...database.loadSettings(), autoExtractMemory: false })
  memory.cancelAllMaintenance()
  database.updateSettings({ ...database.loadSettings(), autoExtractMemory: true })
  chatGate.resolve()
  await finishingAfterDisable
  chatGate = null
  assert(database.listMemories(botId, scopeA).every((item) => item.factKey !== 'identity.company'), '关闭重开后真实网关仍接受关闭前的旧请求')

  const capacityBotId = 'entrypoints-capacity-bot'
  database.createBot({ ...seed, id: capacityBotId, name: 'CapacityBoundary', memories: [] }, { returnWorkspace: false })
  const fact = (text, extra = {}) => ({ title: text, excerpt: text, evidence: text, type: 'fact', confidence: 1, ...extra })
  for (let index = 0; index < 50; index += 1) {
    const token = createHash('sha256').update(`entrypoints-capacity-${index}`).digest('hex')
    assert.equal(database.upsertAutoMemories(capacityBotId, [fact(token)], { maxItems: 50 }).created, 1)
  }
  await memory.createMemory(capacityBotId, { id: 'unlocked-manual-forget', title: '职业', excerpt: '用户职业是工程师。',
    type: 'fact', factKey: 'identity.profession', source: '用户手动', locked: false, updatedAt: new Date().toISOString() })
  const forgetManualAtLimit = database.upsertAutoMemories(capacityBotId, [
    fact('忘记我的职业', { action: 'forget', matchId: 'unlocked-manual-forget', factKey: 'identity.profession' }),
    fact('new-unique-fact-after-manual-forget'),
  ], { maxItems: 50 })
  assert.equal(forgetManualAtLimit.forgotten, 1)
  assert.equal(forgetManualAtLimit.created, 0, '遗忘人工条目错误释放了自动记忆额度')
  assert.equal(forgetManualAtLimit.capacityReached, true)
  await memory.createMemory(capacityBotId, { id: 'unlocked-manual-update', title: '公司', excerpt: '用户公司是星河。',
    type: 'fact', factKey: 'identity.company', source: '用户手动', locked: false, updatedAt: new Date().toISOString() })
  const updateManualAtLimit = database.upsertAutoMemories(capacityBotId, [
    fact('用户公司改为图灵。', { action: 'update', matchId: 'unlocked-manual-update', factKey: 'identity.company' }),
    fact('new-unique-fact-after-manual-update'),
  ], { maxItems: 50 })
  assert.equal(updateManualAtLimit.updated, 1)
  assert.equal(updateManualAtLimit.created, 0)
  assert.equal(updateManualAtLimit.capacityReached, true)
  assert.equal(database.getMemory(capacityBotId, 'unlocked-manual-update').source, '用户手动', '修订解锁人工条目改变了其容量分类')
  assert.equal(database.listMemories(capacityBotId).filter((item) => item.source.startsWith('ZSense 自动记忆')).length, 50)

  await memory.createMemory(NATIVE_BOT_ID, { id: 'scheduled-local-memory', title: '计划阅读偏好', excerpt: '本机用户偏好简洁的计划说明。',
    type: 'preference', source: '用户手动', updatedAt: new Date().toISOString() })
  scheduledRunner = new ScheduledTaskRunner({ database, agentCore: core, secrets: { get: () => ({}) }, userDataDirectory: directory })
  const scheduled = scheduledRunner.create({ name: '离线任务scope联调', frequency: 'daily', timeOfDay: '09:00', weekday: 1,
    modelProvider: 'custom', model: 'offline-entrypoints', prompt: '生成简洁计划说明。', skillIds: [],
    deliveryTarget: 'local', repeatCount: 0, enabled: false, memoryEnabled: true })
  const scheduledTask = scheduled.scheduledTasks.find((item) => item.name === '离线任务scope联调')
  scheduledRunner.runNow(scheduledTask.id)
  await scheduledRunner.shutdown()
  const scheduledRequest = requests.find((request) => request.source === 'zsense-scheduled')
  assert(scheduledRequest, '定时执行器没有成功进入假内核')
  assert.deepEqual(scheduledRequest.memoryScope, createMemoryScope({ workspacePath: scheduledTask.workspacePath }), '定时内核请求未绑定可信local/project归属')
  assert.equal(scheduledRequest.bot.id, NATIVE_BOT_ID)
  assert(scheduledRequest.memories.some((item) => item.id === 'scheduled-local-memory'))
  assert(scheduledRequest.memories.every((item) => !String(item.ownerKey || '').startsWith('gateway:')), '定时任务注入了外部用户的记忆')

  const lifecycleBotId = 'entrypoints-reused-bot-id'
  database.createBot({ ...seed, id: lifecycleBotId, name: 'BeforeLifecycle', memories: [{ id: 'before-lifecycle-memory',
    title: '旧项目名称', excerpt: '旧项目代号是天琴。', type: 'fact', source: '用户手动', updatedAt: new Date().toISOString() }] }, { returnWorkspace: false })
  assert(database.recallMemories(lifecycleBotId, '旧项目名称').memories.some((item) => item.id === 'before-lifecycle-memory'))
  database.deleteBot(lifecycleBotId)
  database.createBot({ ...seed, id: lifecycleBotId, name: 'AfterLifecycle', memories: [] }, { returnWorkspace: false })
  assert.equal(database.listMemories(lifecycleBotId).length, 0)
  assert.equal(database.recallMemories(lifecycleBotId, '旧项目名称').memories.length, 0, '同ID重建 Bot 后索引复活了旧内容')

  const migrationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-memory-migration-entrypoint-'))
  let migrationDatabase = new ZSenseDatabase(migrationDirectory)
  try {
    const legacyConversation = migrationDatabase.createConversation('atlas', '旧外部会话', { channelId: 'dingtalk' })
    const oldMemory = { type: 'fact', updatedAt: '2026-09-01T00:00:00.000Z', confidence: 1 }
    migrationDatabase.createMemory('atlas', { ...oldMemory, id: 'legacy-external-auto', title: '旧名字', excerpt: '用户的名字是旧姓名。',
      source: 'ZSense 自动记忆', conversationId: legacyConversation })
    migrationDatabase.createMemory('atlas', { ...oldMemory, id: 'legacy-no-owner-auto', title: '旧职业', excerpt: '用户职业是旧工程师。',
      source: 'Hindsight 自动记忆' })
    migrationDatabase.createMemory('atlas', { ...oldMemory, id: 'legacy-manual', title: '保留人工偏好', excerpt: '用户手动偏好清晰说明。', source: '用户手动' })
    migrationDatabase.close()
    migrationDatabase = null
    const legacyFile = new DatabaseSync(path.join(migrationDirectory, 'zsense.sqlite3'))
    try {
      // Recreate the actual pre-43 memories layout, only inside this fixture.
      legacyFile.exec('DROP INDEX IF EXISTS memories_owner_project')
      for (const column of ['owner_key', 'project_key', 'fact_key', 'locked', 'revision', 'message_id', 'state']) {
        legacyFile.exec(`ALTER TABLE memories DROP COLUMN ${column}`)
      }
      legacyFile.prepare("UPDATE meta SET value='42' WHERE key='schema_version'").run()
    } finally { legacyFile.close() }
    migrationDatabase = new ZSenseDatabase(migrationDirectory)
    assert.equal(migrationDatabase.getMemory('atlas', 'legacy-external-auto').ownerKey, 'legacy-unattributed')
    assert.equal(migrationDatabase.getMemory('atlas', 'legacy-no-owner-auto').ownerKey, 'legacy-unattributed')
    assert(migrationDatabase.listMemories('atlas').some((item) => item.id === 'legacy-external-auto'), '迁移后来源不明条目应仍能在管理界面查看')
    assert(migrationDatabase.listMemories('atlas').some((item) => item.id === 'legacy-no-owner-auto'))
    const localLegacyRecall = migrationDatabase.recallMemories('atlas', '旧名字旧职业', { ownerKey: 'local' })
    assert(localLegacyRecall.memories.every((item) => !item.id.startsWith('legacy-external') && !item.id.startsWith('legacy-no-owner')), '迁移后的来源不明旧记忆进入了local上下文')
    assert.equal(migrationDatabase.recallMemories('atlas', '旧名字旧职业', scopeA).memories.length, 0, '迁移时把未知旧渠道条目错误归给当前用户')
    const legacyManual = migrationDatabase.getMemory('atlas', 'legacy-manual')
    assert.equal(legacyManual.ownerKey, 'local')
    assert.equal(legacyManual.locked, true, '旧人工条目迁移后失去了保护')
  } finally {
    migrationDatabase?.close()
    fs.rmSync(migrationDirectory, { recursive: true, force: true })
  }
  assert.equal(refinerCalls.length, 0, '默认本地模式仍调用了模型提取接口')
  assert.equal(networkAttempts, 0, '隔离回归意外发起外网请求')
  console.log(JSON.stringify({ ok: true, realGatewayAuthorization: true, sameBotSameGroupIsolatedOwners: true,
    trustedCoreScope: true, realCapabilityListSearchAndMutationIsolation: true, localPrivateMemoryExcluded: true,
    referencesExcludedFromRetention: true, correctionIsolation: true, gatewayStaleInputRejected: true,
    manualQuotaBoundaries: true, trustedScheduledScope: true, lifecycleCacheReset: true,
    unattributedLegacyMigration: true, defaultModelCalls: refinerCalls.length,
    externalNetworkRequests: networkAttempts }))
} finally {
  chatGate?.resolve()
  await scheduledRunner?.shutdown()
  capabilities.shutdown()
  await gateway.shutdown()
  await memory.stop()
  await memory.waitForMaintenance()
  database.close()
  globalThis.fetch = originalFetch
  fs.rmSync(directory, { recursive: true, force: true })
}
