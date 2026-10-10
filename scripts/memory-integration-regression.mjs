import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { createMemoryScope } from '../electron/services/memory-scope.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-memory-integration-'))
const database = new ZSenseDatabase(directory)
const seed = database.loadWorkspace().bots.find((bot) => bot.id === 'atlas')
const checks = []
let botSequence = 0
const bot = () => {
  const id = `memory-regression-${++botSequence}`
  database.createBot({ ...seed, id, name: id, memories: [] }, { returnWorkspace: false })
  return id
}
const proposal = (excerpt, overrides = {}) => ({ action: 'add', title: excerpt, excerpt, evidence: excerpt,
  type: 'fact', confidence: 0.95, ...overrides })
const store = (botId, content, scope = {}, overrides = {}, options = {}) => database.upsertAutoMemories(botId,
  [proposal(content, overrides)], { ...scope, evidenceText: content, ...options })
const scopeA = createMemoryScope({ channel: 'gateway', connectionId: 'verified-connection', userId: 'user-a' })
const scopeB = createMemoryScope({ channel: 'gateway', connectionId: 'verified-connection', userId: 'user-b' })
const local = createMemoryScope()
const projectA = createMemoryScope({ workspacePath: path.join(directory, 'project-a') })
const projectB = createMemoryScope({ workspacePath: path.join(directory, 'project-b') })

try {
  assert.notEqual(scopeA.ownerKey, scopeB.ownerKey)
  assert.notEqual(projectA.projectKey, projectB.projectKey)
  assert.throws(() => createMemoryScope({ channel: 'gateway', connectionId: 'verified-connection' }), /归属/)
  assert.throws(() => createMemoryScope({ channel: 'peer' }), /归属/)
  assert.throws(() => database.listMemories(seed.id, { ownerKey: 'user-a' }), /归属/)

  const identityBot = bot()
  const identity = '我叫小王'
  const first = store(identityBot, identity, scopeA, { factKey: 'identity.name', ownerKey: scopeB.ownerKey,
    conversationId: 'spoofed-conversation', messageId: 'spoofed-message' }, { conversationId: 'verified-conversation', messageId: 'verified-message' })
  const second = store(identityBot, identity, scopeB, { factKey: 'identity.name' })
  assert.equal(first.created, 1)
  assert.equal(second.created, 1, '相同事实在不同用户间错误合并')
  const memoryA = database.getMemory(identityBot, first.memoryIds[0])
  assert.equal(memoryA.ownerKey, scopeA.ownerKey, '模型输出篡改了用户归属')
  assert.equal(memoryA.conversationId, 'verified-conversation')
  assert.equal(memoryA.messageId, 'verified-message')
  assert.equal(memoryA.locked, false)
  assert.equal(database.getMemory(identityBot, memoryA.id, scopeB), null)
  assert.deepEqual(database.listMemories(identityBot, scopeA).map((memory) => memory.id), [memoryA.id])
  assert.deepEqual(database.recallMemories(identityBot, identity, scopeA).memories.map((memory) => memory.id), [memoryA.id])
  assert.equal(database.recallMemories(identityBot, identity).memories.length, 0, '本地入口召回了外部渠道用户记忆')
  assert.equal(database.searchMemories(identityBot, identity, 8, scopeB)[0].id, second.memoryIds[0])
  assert.equal(database.listMemories(identityBot).length, 2, '管理入口应能查看全部用户的条目')
  checks.push('authenticatedOwnerAndProvenance')

  const projectBot = bot()
  const projectFact = '我的项目代号是天琴'
  const a = store(projectBot, projectFact, projectA, { scope: 'project', factKey: 'project.name' })
  const b = store(projectBot, projectFact, projectB, { scope: 'project', factKey: 'project.name' })
  const global = store(projectBot, '以后默认使用简体中文回答', local, { type: 'preference', factKey: 'answer.language' })
  assert.equal(a.created, 1)
  assert.equal(b.created, 1)
  assert.equal(global.created, 1)
  assert.deepEqual(new Set(database.listMemories(projectBot, projectA).map((memory) => memory.id)), new Set([a.memoryIds[0], global.memoryIds[0]]))
  assert.equal(database.getMemory(projectBot, b.memoryIds[0], projectA), null)
  assert.deepEqual(database.listMemories(projectBot, local).map((memory) => memory.id), [global.memoryIds[0]])
  const crossing = store(projectBot, '我的项目代号改为海燕', projectA,
    { action: 'update', matchId: b.memoryIds[0], scope: 'project', factKey: 'project.name' })
  assert.equal(crossing.updated, 0, '项目 A 修订了项目 B 的记忆')
  const crossOwner = store(identityBot, '我叫小李', scopeA, { action: 'update', matchId: second.memoryIds[0], factKey: 'identity.name' })
  assert.equal(crossOwner.updated, 0, '用户 A 修订了用户 B 的记忆')
  checks.push('projectIsolationAndGlobalPreferences')

  const evidenceBot = bot()
  const invalid = database.upsertAutoMemories(evidenceBot, [proposal('我叫小李')], { ...local, evidenceText: '我叫小王' })
  assert.equal(invalid.created, 0, '未经当前原话支持的证据被存储')
  assert.equal(store(evidenceBot, '我叫小王', local, { confidence: 0.4 }).created, 0)
  assert.equal(store(evidenceBot, '我叫小王', local, { factKey: 'model-controlled-custom-key' }).created, 0)
  checks.push('evidenceAndFactKeyValidation')

  const correctionBot = bot()
  const chinese = store(correctionBot, '以后默认使用简体中文回答', local, { factKey: 'answer.language', type: 'preference' })
  const initial = database.getMemory(correctionBot, chinese.memoryIds[0])
  // Warm retrieval before a correction to verify that the index is invalidated.
  database.recallMemories(correctionBot, '中文回答', local)
  const english = store(correctionBot, '以后改为默认使用英文回答', local,
    { action: 'update', matchId: initial.id, factKey: 'answer.language', type: 'preference' }, { messageId: 'english-correction' })
  assert.equal(english.updated, 1, '明确纠正被误判为相似重复')
  const corrected = database.getMemory(correctionBot, initial.id)
  assert.equal(corrected.excerpt, '以后改为默认使用英文回答')
  assert.equal(corrected.messageId, 'english-correction')
  assert.equal(corrected.revision, initial.revision + 1)
  assert(corrected.history.some((memory) => memory.excerpt === initial.excerpt), '修订后没有保留旧结论的历史')
  const recalled = database.recallMemories(correctionBot, '回答语言', local)
  assert.equal(recalled.memories.length, 1)
  assert.equal(recalled.memories[0].excerpt, corrected.excerpt, '召回缓存仍注入被替代的旧语言偏好')
  const firstRecall = database.recallMemories(correctionBot, '回答语言', local).memories[0]
  const secondRecall = database.recallMemories(correctionBot, '回答语言', local).memories[0]
  assert.equal(secondRecall.recallCount, firstRecall.recallCount + 1, '缓存导致召回次数停留在旧快照')
  checks.push('explicitCorrectionHistoryAndIndexInvalidation')

  // Editing an automatic record in the manager protects the edited value.
  database.updateMemory(correctionBot, { ...corrected, excerpt: '用户手动确认：只使用英文回答', locked: true, updatedAt: new Date().toISOString() })
  const locked = database.getMemory(correctionBot, corrected.id)
  assert.equal(locked.locked, true)
  const blocked = store(correctionBot, '以后又改为使用中文回答', local,
    { action: 'update', matchId: corrected.id, type: 'preference', factKey: 'answer.language' })
  assert.equal(blocked.updated, 0)
  assert.equal(blocked.reason, 'manual-protected')
  assert.equal(database.getMemory(correctionBot, corrected.id).excerpt, locked.excerpt)
  checks.push('manualEditProtection')

  const generation = database.getMemoryVersion(correctionBot)
  database.updateMemory(correctionBot, { ...locked, excerpt: '用户新修订：默认英文且简短', updatedAt: new Date().toISOString() })
  const stale = store(correctionBot, '我的职业是工程师', local, { factKey: 'identity.profession' }, { expectedVersion: generation })
  assert.equal(stale.created, 0)
  assert.equal(stale.reason, 'stale-version', '旧异步请求在用户编辑后仍能新增记忆')
  checks.push('staleGenerationRejected')

  const deletionBot = bot()
  const deleted = store(deletionBot, identity, scopeA, { factKey: 'identity.name' })
  database.recallMemories(deletionBot, identity, scopeA)
  database.deleteMemory(deletionBot, deleted.memoryIds[0])
  assert.equal(database.getMemory(deletionBot, deleted.memoryIds[0]), null)
  assert.equal(database.recallMemories(deletionBot, identity, scopeA).memories.length, 0, '删除后缓存仍召回旧内容')
  assert.equal(store(deletionBot, identity, scopeA, { factKey: 'identity.name' }).reason, 'previously-forgotten', '被删除的原话被自动重新入库')
  assert.equal(store(deletionBot, '我的名字是小王', scopeA, { factKey: 'identity.name' }).created, 0, '改写同一删除事实绕过了遗忘标记')
  assert.equal(store(deletionBot, identity, scopeB, { factKey: 'identity.name' }).created, 1, '甲的遗忘标记错误阻止了乙保存自己的事实')
  checks.push('scopedDeletionTombstones')

  const capacityBot = bot()
  let firstCapacityId
  for (let index = 0; index < 50; index += 1) {
    const token = createHash('sha256').update(`independent-capacity-${index}`).digest('hex')
    const result = store(capacityBot, token, local, { title: token }, { maxItems: 50 })
    assert.equal(result.created, 1, `容量填充第 ${index + 1} 条错误合并或拒绝`)
    firstCapacityId ||= result.memoryIds[0]
  }
  const atCapacity = store(capacityBot, 'capacity-overflow-new-unique-fact', local, {}, { maxItems: 50 })
  assert.equal(atCapacity.created, 0)
  assert.equal(atCapacity.capacityReached, true, '容量满没有可观察状态')
  const editable = database.getMemory(capacityBot, firstCapacityId)
  const atCapacityCorrection = store(capacityBot, 'capacity-correction-existing-unique-fact', local,
    { action: 'update', matchId: firstCapacityId, title: editable.title }, { maxItems: 50 })
  assert.equal(atCapacityCorrection.updated, 1, '容量满时错误阻止了既有记忆修订')
  database.updateMemory(capacityBot, { ...database.getMemory(capacityBot, firstCapacityId), locked: true, updatedAt: new Date().toISOString() })
  const afterLock = store(capacityBot, 'capacity-overflow-after-protection', local, {}, { maxItems: 50 })
  assert.equal(afterLock.capacityReached, true, '手动保护自动记忆不应绕过容量上限')
  checks.push('observableCapacityAndCorrectionAtLimit')

  const budgetBot = bot()
  const longPreference = `以后默认详细解释数据库迁移方案 ${'数据库迁移验证方案'.repeat(800)}`
  store(budgetBot, longPreference, local, { title: '数据库迁移解释偏好', type: 'preference', evidence: '以后默认详细解释数据库迁移方案' })
  const budget = database.recallMemories(budgetBot, '数据库迁移', { ...local, characterBudget: 50_000 })
  assert(budget.memories.length > 0)
  assert(budget.usedCharacters <= 5_000, '入口传入超大预算突破了统一召回上限')
  checks.push('sharedRecallBudget')

  console.log(JSON.stringify({ ok: true, temporaryDatabaseOnly: true, noExternalModel: true, checks }))
} finally {
  database.close()
  fs.rmSync(directory, { recursive: true, force: true })
}
