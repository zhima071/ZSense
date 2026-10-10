import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appAsar = process.argv.find((argument) => argument.startsWith('--app-asar='))?.slice('--app-asar='.length) || ''
if (appAsar && (!path.isAbsolute(appAsar) || !appAsar.endsWith('.asar'))) throw new Error('包内测试需要绝对 app.asar 路径。')
const runtimeModule = (name) => appAsar ? pathToFileURL(path.join(appAsar, 'electron', 'services', name)).href : new URL(`../electron/services/${name}`, import.meta.url).href
const originalFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = async () => { fetchCalls += 1; throw new Error('记忆升级夹具禁止外发请求。') }
const { NATIVE_BOT_ID, ZSenseDatabase } = await import(runtimeModule('database.mjs'))
const { classifyLegacyMemory, MEMORY_UPGRADE_VERSION, MemoryUpgradeService } = await import(runtimeModule('memory-upgrade-service.mjs'))
const { LocalMemoryService } = await import(runtimeModule('local-memory-service.mjs'))
const { createMemoryScope } = await import(runtimeModule('memory-scope.mjs'))
const { ZSenseGatewayService } = await import(runtimeModule('zsense-gateway-service.mjs'))
if (!appAsar) {
  const mainSource = fs.readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8')
  const databaseStart = mainSource.indexOf('database = new ZSenseDatabase(')
  const upgradeStart = mainSource.indexOf('await new MemoryUpgradeService({ database }).run()')
  assert(databaseStart >= 0 && upgradeStart > databaseStart && upgradeStart < mainSource.indexOf('agentCore = new ZSenseAgentCore('), '旧设备整理必须先于模型与网关启动')
  assert(upgradeStart < mainSource.indexOf('await createWindow()'), '旧设备整理必须先于主窗口开放聊天')
}

const automatic = (overrides = {}) => ({ source: 'ZSense 自动记忆（本地）', type: 'fact', locked: true, revision: 1, title: '旧自动记忆', excerpt: '', evidence: '', ...overrides })
const rejected = [
  automatic({ excerpt: '以后默认用英文吗？', type: 'preference' }),
  automatic({ excerpt: '请翻译：我叫小王' }),
  automatic({ excerpt: '他说我叫小王' }),
  automatic({ excerpt: '```text\n旧文件原文\n```' }),
  automatic({ excerpt: '本轮使用英文回答', type: 'preference' }),
  automatic({ excerpt: '当前运行状态正常' }),
  automatic({ excerpt: '工具输出：\n退出码: 0\n共扫描123个文件' }),
  automatic({ excerpt: '{"stdout":"构建成功","exitCode":0}' }),
  automatic({ excerpt: '请记住我的Token是fixture-secret' }),
  automatic({ excerpt: '{"password":"fixture-secret"}' }),
]
for (const memory of rejected) assert.equal(classifyLegacyMemory(memory).eligible, false, `旧自动噪声应退出自动召回：${memory.excerpt}`)
const preserved = [
  automatic({ excerpt: '我叫小王' }),
  automatic({ excerpt: '以后默认使用简体中文回答', type: 'preference' }),
  automatic({ excerpt: '以后执行脚本时始终记录stdout与退出码', type: 'preference' }),
  automatic({ excerpt: '数据库迁移前在副本演练' }),
  automatic({ excerpt: '这是用户保护的提问范例吗？', revision: 2 }),
  automatic({ source: '用户手动', excerpt: '请翻译这段文字？' }),
  automatic({ source: '来源未知', excerpt: '当前状态为完成' }),
]
for (const memory of preserved) assert.equal(classifyLegacyMemory(memory).eligible, true, `不确定或人工记录应保留：${memory.excerpt}`)
const immutable = automatic({ excerpt: '本轮使用英文回答', ownerKey: 'local', projectKey: '', factKey: '', history: [] })
const original = structuredClone(immutable)
classifyLegacyMemory(immutable)
assert.deepEqual(immutable, original, '分类器不得修改原文、归属或历史')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-memory-upgrade-'))
let database
let gateway
let electronApp = null
try {
  database = new ZSenseDatabase(directory)
  const freshService = new MemoryUpgradeService({ database })
  const fresh = await freshService.run()
  assert.equal(fresh.status, 'new-device', '新设备不应扫描默认或人工记忆')
  assert.equal(fresh.scanned, 0)
  database.close()
  database = new ZSenseDatabase(directory)
  const reopenedFresh = await new MemoryUpgradeService({ database }).run()
  assert.equal(reopenedFresh.scanned, 0, '新设备第二次启动也不应被误当作旧设备')
  database.close()
  database = null
  const legacyDirectory = path.join(directory, 'legacy-fixture')
  fs.mkdirSync(legacyDirectory)
  database = new ZSenseDatabase(legacyDirectory)
  const fixtureMemories = [...rejected, ...preserved].map((memory, index) => ({ ...memory, id: `upgrade-fixture-${index}`, title: `旧记忆 ${index}`, updatedAt: '2026-10-01T00:00:00.000Z' }))
  for (const memory of fixtureMemories) {
    database.createMemory('atlas', memory)
    if (Number(memory.revision || 1) > 1) database.updateMemory('atlas', memory)
  }
  const curated = fixtureMemories.at(-1)
  database.updateMemory('atlas', { ...curated, source: 'ZSense 自动记忆（本地）', title: '人工保护的旧自动记录', excerpt: '这是我人工编辑的提问范例吗？', locked: true, updatedAt: '2026-10-02T00:00:00.000Z' })
  const contentSnapshot = (memory) => ({ id: memory.id, title: memory.title, excerpt: memory.excerpt, source: memory.source, type: memory.type,
    ownerKey: memory.ownerKey, projectKey: memory.projectKey, locked: memory.locked, factKey: memory.factKey, evidence: memory.evidence, revision: memory.revision, history: memory.history })
  const before = fixtureMemories.map((memory) => contentSnapshot(database.getMemory('atlas', memory.id)))
  database.close()
  database = new ZSenseDatabase(legacyDirectory)
  const oldVersion = database.getMemoryVersion('atlas')
  let classified = 0
  assert.throws(() => database.applyMemoryUpgrade({ version: MEMORY_UPGRADE_VERSION, classify: (memory) => {
    classified += 1
    if (classified === 3) throw new Error('升级事务测试失败')
    return classifyLegacyMemory(memory)
  } }), /升级事务测试失败/)
  assert.equal(database.memoryUpgradeStatus(MEMORY_UPGRADE_VERSION), null, '失败不得写完成标记')
  assert.equal(database.getMemoryVersion('atlas'), oldVersion, '失败事务必须回滚记忆版本')
  assert(database.listMemories('atlas').every((memory) => memory.recallEligible), '失败事务必须回滚已写入的准入策略')
  const questionId = fixtureMemories[0].id
  assert(database.recallMemories('atlas', '英文').memories.some((memory) => memory.id === questionId), '先建立旧自动召回缓存')
  const service = new MemoryUpgradeService({ database })
  const upgraded = await service.run()
  assert.equal(upgraded.status, 'completed')
  assert.equal(upgraded.excluded, rejected.length, '旧锁定自动噪声也应参与非破坏性准入优化')
  assert(upgraded.scanned >= fixtureMemories.length)
  for (let index = 0; index < fixtureMemories.length; index += 1) assert.deepEqual(contentSnapshot(database.getMemory('atlas', fixtureMemories[index].id)), before[index], '升级不应修改原文、保护或历史')
  assert.equal(database.getMemory('atlas', questionId).recallEligible, false)
  assert(database.recallMemories('atlas', '英文').memories.every((memory) => memory.id !== questionId), '准入优化后应刷新旧自动索引')
  assert(database.searchMemories('atlas', '英文', 20).some((memory) => memory.id === questionId), '被排除记录仍可手动搜索')
  assert(database.listMemories('atlas').some((memory) => memory.id === questionId), '被排除记录仍在管理列表可见')
  assert.equal(database.getMemory('atlas', curated.id).recallEligible, true, '经过人工修改并保护的旧自动记录应保守保留')
  const completedMarker = database.memoryUpgradeStatus(MEMORY_UPGRADE_VERSION)
  const repeated = database.applyMemoryUpgrade({ version: MEMORY_UPGRADE_VERSION, classify: () => { throw new Error('不应该再次扫描') } })
  assert.equal(repeated.status, 'already-completed')
  assert.deepEqual(database.memoryUpgradeStatus(MEMORY_UPGRADE_VERSION), completedMarker, '重复启动不得改写完成标记')
  database.close()
  database = new ZSenseDatabase(legacyDirectory)
  assert.equal((await new MemoryUpgradeService({ database }).run()).status, 'already-completed', '重启后仍仅执行一次')
  assert.equal(database.getMemory('atlas', questionId).recallEligible, false, '准入优化结果必须持久化')
  const paused = database.getMemory('atlas', questionId)
  database.updateMemory('atlas', { ...paused, title: '人工确认后的英文偏好', excerpt: '以后默认用英文回答', updatedAt: new Date().toISOString() })
  assert.equal(database.getMemory('atlas', questionId).recallEligible, true, '手动保存确认后应恢复准入')
  assert(database.recallMemories('atlas', '英文').memories.some((memory) => memory.id === questionId), '人工恢复必须使旧自动索引失效')
  database.close()
  database = null

  for (const version of [43, 42]) {
    const schemaDirectory = path.join(directory, `schema-${version}`)
    fs.mkdirSync(schemaDirectory)
    database = new ZSenseDatabase(schemaDirectory)
    database.createMemory(NATIVE_BOT_ID, { ...automatic({ excerpt: '以后默认用英文吗？', type: 'preference' }), id: `schema-${version}-auto`, updatedAt: '2026-10-01T00:00:00.000Z' })
    database.createMemory('atlas', { ...automatic({ source: '用户手动', excerpt: '请翻译用户人工保存的例子？' }), id: `schema-${version}-manual`, updatedAt: '2026-10-01T00:00:00.000Z' })
    const legacyExternalConversation = database.createConversation('atlas', '旧Hermes外部会话', { channelId: 'dingtalk' })
    const localWebConversation = database.createConversation('atlas', '旧Hermes本机会话', { channelId: 'web' })
    const boundOwner = createMemoryScope({ channel: 'gateway', connectionId: 'legacy-hermes', userId: 'verified-owner' })
    for (const [suffix, botId, scope, conversationId] of [
      ['external', 'atlas', { ownerKey: 'local' }, legacyExternalConversation],
      ['unattributed', 'atlas', { ownerKey: 'local' }, ''],
      ['bound', 'atlas', boundOwner, legacyExternalConversation],
      ['web', 'atlas', { ownerKey: 'local' }, localWebConversation],
      ['native', NATIVE_BOT_ID, { ownerKey: 'local' }, ''],
    ]) database.createMemory(botId, { ...automatic({ source: 'Hermes · 自动记忆', excerpt: `以后默认使用中文回答Hermes ${suffix}`, type: 'preference' }),
      ...scope, conversationId, id: `schema-${version}-hermes-${suffix}`, updatedAt: '2026-10-01T00:00:00.000Z' })
    database.db.exec('ALTER TABLE memories DROP COLUMN auto_recall_eligible; ALTER TABLE memories DROP COLUMN auto_recall_reason;')
    if (version === 42) database.db.exec('ALTER TABLE memories DROP COLUMN locked')
    database.db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(version))
    database.close()
    database = new ZSenseDatabase(schemaDirectory)
    assert.equal(database.getMemory(NATIVE_BOT_ID, `schema-${version}-auto`).locked, true, '真实旧schema迁移不得解除原有保护')
    assert.equal(database.getMemory('atlas', `schema-${version}-manual`).locked, true, '旧schema人工记录必须受保护')
    const result = await new MemoryUpgradeService({ database }).run()
    assert.equal(result.status, 'completed')
    assert.equal(database.getMemory(NATIVE_BOT_ID, `schema-${version}-auto`).recallEligible, false)
    assert.equal(database.getMemory('atlas', `schema-${version}-manual`).recallEligible, true)
    assert(database.recallMemories(NATIVE_BOT_ID, '英文').memories.every((memory) => memory.id !== `schema-${version}-auto`), '原生AI空间也必须过滤旧噪声')
    for (const suffix of ['external', 'unattributed']) {
      const id = `schema-${version}-hermes-${suffix}`
      assert.equal(database.getMemory('atlas', id).ownerKey, 'legacy-unattributed', '旧Hermes未证明归属的外部记忆必须隔离')
      assert(database.listMemories('atlas').some((memory) => memory.id === id), '隔离记忆仍须在管理界面可见')
      assert(database.searchMemories('atlas', 'Hermes', 20, { ownerKey: 'legacy-unattributed' }).some((memory) => memory.id === id), '隔离记忆仍须支持对应归属下的手动搜索')
      assert(database.recallMemories('atlas', 'Hermes 中文').memories.every((memory) => memory.id !== id), '旧外部Hermes记忆不得被本机自动召回')
    }
    assert.equal(database.getMemory('atlas', `schema-${version}-hermes-bound`).ownerKey, boundOwner.ownerKey, '旧schema迁移不得覆盖已验证的渠道用户归属')
    assert(database.recallMemories('atlas', 'Hermes 中文', boundOwner).memories.some((memory) => memory.id === `schema-${version}-hermes-bound`), '已有可信渠道归属仍须正常召回')
    assert.equal(database.getMemory('atlas', `schema-${version}-hermes-web`).ownerKey, 'local', 'web本机Hermes记忆不应被误隔离')
    assert(database.recallMemories('atlas', 'Hermes 中文').memories.some((memory) => memory.id === `schema-${version}-hermes-web`), 'web本机Hermes记忆应正常召回')
    assert(database.recallMemories(NATIVE_BOT_ID, 'Hermes 中文').memories.some((memory) => memory.id === `schema-${version}-hermes-native`), '本机原生Hermes记忆应正常召回')
    database.close()
    database = null
  }

  const scopedDirectory = path.join(directory, 'scoped-legacy')
  const workspaceA = path.join(scopedDirectory, 'project-a')
  const workspaceB = path.join(scopedDirectory, 'project-b')
  fs.mkdirSync(workspaceA, { recursive: true })
  fs.mkdirSync(workspaceB)
  database = new ZSenseDatabase(scopedDirectory)
  const aliceA = createMemoryScope({ channel: 'gateway', connectionId: 'upgrade-gateway', userId: 'alice', workspacePath: workspaceA })
  const bobA = createMemoryScope({ channel: 'gateway', connectionId: 'upgrade-gateway', userId: 'bob', workspacePath: workspaceA })
  const aliceB = createMemoryScope({ channel: 'gateway', connectionId: 'upgrade-gateway', userId: 'alice', workspacePath: workspaceB })
  const localA = createMemoryScope({ workspacePath: workspaceA })
  for (const [id, botId, scope, excerpt] of [
    ['alice-noise', 'atlas', aliceA, 'alpha项目以后默认用英文吗？'],
    ['alice-good', 'atlas', aliceA, '以后默认使用简体中文回答alpha项目'],
    ['bob-noise', 'atlas', bobA, 'beta项目以后默认用英文吗？'],
    ['bob-good', 'atlas', bobA, '以后默认使用英文回答beta项目'],
    ['alice-project-b', 'atlas', aliceB, '以后默认使用英文回答其它项目'],
    ['local-noise', 'atlas', localA, '以后默认用英文吗？'],
    ['native-noise', NATIVE_BOT_ID, localA, '以后默认用英文吗？'],
  ]) database.createMemory(botId, { ...automatic({ excerpt, type: 'preference' }), ...scope, id, updatedAt: '2026-10-01T00:00:00.000Z' })
  database.createMemory('atlas', { ...automatic({ excerpt: '以后默认用英文吗？', type: 'preference', locked: false }), id: 'trusted-restore', factKey: 'answer.language', updatedAt: '2026-10-01T00:00:00.000Z' })
  database.db.exec('ALTER TABLE memories DROP COLUMN auto_recall_eligible; ALTER TABLE memories DROP COLUMN auto_recall_reason;')
  database.db.prepare("UPDATE meta SET value='43' WHERE key='schema_version'").run()
  database.close()
  database = new ZSenseDatabase(scopedDirectory)
  await new MemoryUpgradeService({ database }).run()
  const memoryService = new LocalMemoryService({ database })
  database.memoryService = memoryService
  for (const [scope, expected, disallowed] of [[aliceA, 'alice-good', ['alice-noise', 'bob-good', 'bob-noise', 'alice-project-b']], [bobA, 'bob-good', ['bob-noise', 'alice-good', 'alice-noise', 'alice-project-b']]]) {
    const recalled = (await memoryService.recallMemories('atlas', '英文项目', scope)).memories
    assert(recalled.some((memory) => memory.id === expected))
    assert(recalled.every((memory) => !disallowed.includes(memory.id)), '升级准入和用户/项目隔离必须同时生效')
  }
  assert(database.searchMemories('atlas', '英文', 20, aliceA).some((memory) => memory.id === 'alice-noise'))
  assert(database.searchMemories('atlas', '英文', 20, aliceA).every((memory) => memory.id !== 'bob-noise'))
  assert((await memoryService.recallMemories('atlas', '英文', localA)).memories.every((memory) => memory.id !== 'local-noise'))
  assert((await memoryService.recallMemories(NATIVE_BOT_ID, '英文', localA)).memories.every((memory) => memory.id !== 'native-noise'))
  const patch = (excerpt) => ({ action: 'update', matchId: 'trusted-restore', factKey: 'answer.language', title: '回答语言', excerpt, evidence: excerpt, type: 'preference', confidence: 0.99 })
  database.upsertAutoMemories('atlas', [patch('以后默认使用英文回答')])
  assert.equal(database.getMemory('atlas', 'trusted-restore').recallEligible, false, '没有可信原话的修订不能恢复旧暂停项')
  database.upsertAutoMemories('atlas', [patch('以后默认用中文吗？')], { evidenceText: '以后默认用中文吗？' })
  assert.equal(database.getMemory('atlas', 'trusted-restore').recallEligible, false, '问句不能恢复旧暂停项')
  database.upsertAutoMemories('atlas', [patch('请记住密码是fixture-secret')], { evidenceText: '请记住密码是fixture-secret' })
  assert.equal(database.getMemory('atlas', 'trusted-restore').recallEligible, false, '凭据不能恢复旧暂停项')
  const restored = await memoryService.retainUserMessage('atlas', '以后默认使用简体中文回答')
  assert.equal(restored.updated, 1)
  assert.equal(database.getMemory('atlas', 'trusted-restore').recallEligible, true, '可信新原话应恢复被暂停的旧自动记忆')
  assert(database.getMemory('atlas', 'trusted-restore').history.some((memory) => memory.excerpt.includes('吗')), '恢复时仍须保留旧版本历史')
  assert((await memoryService.recallMemories('atlas', '简体中文')).memories.some((memory) => memory.id === 'trusted-restore'))

  database.updateSettings({ defaultWorkspacePath: workspaceA, autoExtractMemory: false })
  database.updateModelConfiguration({ provider: 'custom', model: 'fixture-model', baseUrl: 'http://127.0.0.1:1/v1', apiKeyName: 'FIXTURE_KEY', apiKeyConfigured: false, updatedAt: new Date().toISOString() })
  const coreCalls = []
  const agentCore = { inspect: () => ({ runnable: true }), supportsProvider: () => true, requiresApiKey: () => false,
    chatStream: async (request) => { coreCalls.push(request); return { output: '夹具回复', sessionId: `fixture:${request.bot.id}`, durationMs: 1, agentSteps: [] } } }
  const secrets = { get: () => ({}) }
  database.upsertGatewayConnection({ id: 'upgrade-gateway', provider: 'dingtalk', name: '升级回归网关', botId: 'atlas', profileName: 'fixture', status: 'connected', latency: 'local', messages: 0,
    configured: true, config: {}, secretKeys: [], secretScope: 'gateway:upgrade-gateway', updatedAt: new Date().toISOString() })
  gateway = new ZSenseGatewayService({ database, agentCore, secrets, userDataDirectory: scopedDirectory })
  const inbound = { connectionId: 'upgrade-gateway', userId: 'alice', userName: '夹具用户', chatId: 'fixture-chat', messageId: 'fixture-message', text: 'alpha英文项目' }
  assert.equal((await gateway.receive(inbound)).reason, 'authorization-pending')
  gateway.approvePairing('upgrade-gateway', gateway.listPendingPairings('upgrade-gateway')[0].requestId)
  assert.equal((await gateway.receive(inbound)).accepted, true)
  assert(coreCalls[0].memories.some((memory) => memory.id === 'alice-good'))
  assert(coreCalls[0].memories.every((memory) => !['alice-noise', 'bob-noise', 'bob-good', 'alice-project-b'].includes(memory.id)), '真实网关自动注入也应执行升级准入与scope过滤')
  await gateway.shutdown()
  gateway = null

  if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== '1' && !appAsar) {
    const { app } = await import('electron')
    electronApp = app
    const electronRoot = path.join(directory, 'electron-ipc')
    fs.mkdirSync(electronRoot)
    app.setPath('userData', electronRoot)
    const { registerIpcHandlers } = await import('../electron/ipc.mjs')
    const handlers = new Map()
    registerIpcHandlers({ ipcMain: { removeHandler: (name) => handlers.delete(name), handle: (name, handler) => handlers.set(name, handler) }, database, agentCore, secrets,
      deviceLinkService: {}, officeWorkspace: { discoverArtifacts: () => [] }, auth: { requireUser: () => ({ id: 'fixture-owner', role: 'admin' }) }, notify: () => undefined })
    const event = { sender: { id: 1, isDestroyed: () => false, send: () => undefined } }
    for (const native of [false, true]) {
      const call = await handlers.get('zsense:chat:send')(event, { requestId: `upgrade-ipc-${native}`, native, botId: 'atlas', message: '英文', workspacePath: workspaceA })
      assert.equal(call.ok, true, call.error)
      assert(coreCalls.at(-1).memories.every((memory) => memory.id !== (native ? 'native-noise' : 'local-noise')), '真实桌面/原生IPC聊天也应执行升级准入')
    }
  }
  await memoryService.stop()
  database.close()
  database = null
  assert.equal(fetchCalls, 0, '全部本地升级与回归不得发出任何网络请求')
  console.log(JSON.stringify({ ok: true, version: MEMORY_UPGRADE_VERSION, localClassifier: true, lockedLegacyNoiseFiltered: true,
    manualAndProtectedPreserved: true, nonDestructive: true, freshDeviceSkipped: true, atomicFailureRetry: true, persistentOneTimeUpgrade: true,
    automaticRecallImproved: true, manualSearchPreserved: true, schemas: [43, 42], hermesLegacyIsolation: true, scopedRecallAndGateway: true, trustedRestore: true,
    ipc: Boolean(electronApp), networkRequests: fetchCalls, runtime: appAsar ? 'packaged-asar' : 'source' }))
} finally {
  await gateway?.shutdown()
  database?.close()
  globalThis.fetch = originalFetch
  fs.rmSync(directory, { recursive: true, force: true })
  electronApp?.quit()
}
