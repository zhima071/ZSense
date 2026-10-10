import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { LocalMemoryService } from '../electron/services/local-memory-service.mjs'
import { createMemoryScope } from '../electron/services/memory-scope.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-memory-maintenance-'))
const database = new ZSenseDatabase(directory)
const notifications = []
const service = new LocalMemoryService({ database, onChanged: (_botId, result) => notifications.push(result) })
database.memoryService = service
const modelContext = { model: 'fixture-model', modelProvider: 'custom' }
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function refinement(arguments_, title = '模型精炼后的姓名') {
  const proposal = arguments_.trustedProposals[0]
  const existing = arguments_.existingMemories.find((item) => item.factKey === proposal.factKey)
  return [{ ...proposal, action: 'update', matchId: existing.id, title, confidence: 0.99 }]
}

try {
  let calls = 0
  service.setModelRefiner(async () => { calls += 1; return [] })
  await service.retainUserMessage('atlas', '我叫小王', { modelContext })
  await service.waitForMaintenance()
  assert.equal(calls, 0, '默认本地模式不得调用外部模型')
  database.updateSettings({ memoryModelRefinement: true, memoryPeriodicReview: false })

  const alice = createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'alice' })
  const bob = createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'bob' })
  await service.retainUserMessage('atlas', '我叫小乙', bob)
  let held = deferred()
  let captured
  service.setModelRefiner(async (arguments_) => { captured = arguments_; return held.promise })
  const retained = await service.retainUserMessage('atlas', '我叫小甲。本条消息中的无关背景文本。', { ...alice, modelContext })
  assert.equal(retained.stored, true, '回复流程只等待本地入库，不等待模型')
  assert.equal(retained.modelRefinement, 'queued')
  await tick()
  assert(captured.existingMemories.every((item) => item.ownerKey === alice.ownerKey), '模型上下文不能包含其他渠道用户')
  assert.equal(captured.recentUserMessages.length, 0, '精炼不得发送历史聊天')
  assert.equal(captured.message, '我叫小甲', '服务注入边界也只能发送本地已筛选的候选证据')
  const original = database.listMemories('atlas', alice).find((item) => item.factKey === 'identity.name')
  database.deleteMemory('atlas', original.id)
  held.resolve(refinement(captured))
  await service.waitForMaintenance()
  assert.equal(database.listMemories('atlas', alice).length, 0, '直接数据库删除后迟到模型结果不能复活已删除事实')

  const carol = createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'carol' })
  held = deferred()
  captured = null
  await service.retainUserMessage('atlas', '我叫小丙', { ...carol, modelContext })
  await tick()
  assert(captured)
  const forgotten = await service.retainUserMessage('atlas', '忘记我的名字', carol)
  assert.equal(forgotten.forgotten, 1)
  assert.equal(forgotten.stored, true)
  held.resolve(refinement(captured))
  await service.waitForMaintenance()
  assert.equal(database.listMemories('atlas', carol).length, 0, '显式遗忘后迟到模型结果不能复活记忆')

  const dave = createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'dave' })
  held = deferred()
  captured = null
  await service.retainUserMessage('atlas', '我叫小丁', { ...dave, modelContext })
  await tick()
  const beforeDisable = database.listMemories('atlas', dave)[0]
  database.updateSettings({ memoryModelRefinement: false })
  service.cancelAllMaintenance()
  database.updateSettings({ memoryModelRefinement: true })
  held.resolve(refinement(captured, '关闭后迟到结果'))
  await service.waitForMaintenance()
  assert.equal(captured.signal.aborted, true, '关闭精炼必须中止已运行请求')
  assert.equal(database.getMemory('atlas', beforeDisable.id).title, beforeDisable.title, '关后重开也不能接纳旧请求结果')
  const longChatGeneration = service.captureRetentionGeneration()
  const longChatVersion = database.getMemoryVersion('atlas')
  database.updateSettings({ autoExtractMemory: false })
  service.cancelAllMaintenance()
  database.updateSettings({ autoExtractMemory: true })
  const staleRetention = await service.retainUserMessage('atlas', '我叫关闭前聊天用户', { ...createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'long-chat' }),
    expectedGeneration: longChatGeneration, expectedVersion: longChatVersion })
  assert.equal(staleRetention.reason, 'stale-generation', '聊天开始后关再开记忆，结束时旧聊天仍不能本地新增')
  const oldVersion = database.getMemoryVersion('atlas')
  database.updateMemory('atlas', { ...database.getMemory('atlas', beforeDisable.id), title: '用户手动编辑姓名', updatedAt: new Date().toISOString() })
  assert.equal((await service.retainUserMessage('atlas', '我叫迟到用户', { ...dave, expectedVersion: oldVersion })).reason, 'stale-version', '手动编辑后迟到本地任务也必须拒绝')

  const cancelled = createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'cancelled' })
  const notificationCount = notifications.length
  service.setModelRefiner(async ({ signal }) => {
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('取消请求')), { once: true }))
    return []
  })
  await service.retainUserMessage('atlas', '我叫小辛', { ...cancelled, modelContext })
  await tick()
  service.cancelAllMaintenance()
  await service.waitForMaintenance()
  assert.equal(notifications.length, notificationCount, '主动取消不是后台失败，不应发出错误状态')
  service.setModelRefiner(async (arguments_) => { captured = arguments_; return held.promise })

  const eve = createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'eve' })
  held = deferred()
  captured = null
  await service.retainUserMessage('atlas', '我叫小戊', { ...eve, modelContext })
  await tick()
  const beforeStop = database.listMemories('atlas', eve)[0]
  await service.stop()
  await service.start()
  held.resolve(refinement(captured, '停止后迟到结果'))
  await service.waitForMaintenance()
  assert.equal(database.getMemory('atlas', beforeStop.id).title, beforeStop.title, '服务重启后也不能接纳停止前的请求结果')

  service.setModelRefiner(async () => { throw new Error('模拟包含敏感原话的服务异常') })
  await service.retainUserMessage('atlas', '我叫小己', { ...createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'error' }), modelContext })
  await service.waitForMaintenance()
  assert(notifications.some((result) => result.reason === 'maintenance-failed'), '后台失败须有可观察的状态')
  assert(!JSON.stringify(notifications).includes('敏感原话'), '异常通知不能透传原文或服务凭据')

  const constrained = createMemoryScope({ channel: 'gateway', connectionId: 'fixture', userId: 'constrained' })
  service.setModelRefiner(async (arguments_) => {
    const proposal = arguments_.trustedProposals[0]
    return [{ ...proposal, title: '姓名精炼标题', excerpt: '模型猜测用户是管理员', confidence: 0.99 }]
  })
  await service.retainUserMessage('atlas', '我叫小壬', { ...constrained, modelContext })
  await service.waitForMaintenance()
  assert.equal(database.listMemories('atlas', constrained).length, 1, '模型不得把同一证据扩大成新猜测事实')
  assert(database.listMemories('atlas', constrained).every((item) => !item.excerpt.includes('管理员')), '模型语义内容必须固定于本地候选')

  const jobs = []
  let active = 0
  let peak = 0
  service.setModelRefiner(async () => {
    active += 1
    peak = Math.max(peak, active)
    const job = deferred()
    jobs.push(job)
    await job.promise
    active -= 1
    return []
  })
  const atlas = database.loadWorkspace().bots.find((bot) => bot.id === 'atlas')
  for (let index = 0; index < 5; index += 1) {
    const id = `maintenance-fixture-${index}`
    database.createBot({ ...atlas, id, name: id, memories: [], memoryCount: 0, memorySize: '0 KB', conversations: 0 })
    await service.retainUserMessage(id, '我叫小庚', { modelContext })
    await tick()
  }
  assert.equal(peak, 2, '模型精炼全局最多两项并发')
  assert.equal(jobs.length, 2, '超出并发槽的任务应等待，不应发出更多模型请求')
  for (let released = 0; released < 5; released += 1) {
    jobs[released].resolve([])
    await tick()
  }
  await service.waitForMaintenance()
  assert.equal(peak, 2)
  assert.equal(service.generations.size, 0, '完成队列必须释放用户世代键')
  jobs.length = 0
  const boundedResults = []
  for (let index = 0; index < 17; index += 1) {
    const id = `bounded-maintenance-fixture-${index}`
    database.createBot({ ...atlas, id, name: id, memories: [], memoryCount: 0, memorySize: '0 KB', conversations: 0 })
    boundedResults.push(await service.retainUserMessage(id, '我叫小癸', { modelContext }))
    await tick()
  }
  assert.equal(service.pending.size, 16, '后台队列必须限制驻留任务数量')
  assert.equal(boundedResults.at(-1).modelRefinement, 'queue-full', '超出队列上限需给出可观察状态')
  assert.equal(jobs.length, 2, '队列上限测试也不能越过模型全局并发限制')
  for (let released = 0; released < 16; released += 1) { jobs[released].resolve([]); await tick() }
  await service.waitForMaintenance()
  assert.equal(service.pending.size, 0)
  assert.equal(service.generations.size, 0)
  service.setModelRefiner(null)
  database.updateSettings({ memoryModelRefinement: false, memoryMaxItems: 50, memoryPeriodicReview: true, memoryReviewInterval: 2 })
  const capacityBot = 'maintenance-capacity-fixture'
  database.createBot({ ...atlas, id: capacityBot, name: capacityBot, memories: [], memoryCount: 0, memorySize: '0 KB', conversations: 0 })
  for (let index = 0; index < 50; index += 1) {
    assert.equal((await service.retainUserMessage(capacityBot, `remember item_${index} scenario_${index}`)).created, 1)
  }
  const capacity = await service.retainUserMessage(capacityBot, '我叫容量测试')
  assert.equal(capacity.capacityReached, true, '容量需使用有效设置值，不能硬编码500')
  assert.equal(capacity.reason, 'capacity-reached', '容量不足不能静默当成重复')
  database.updateSettings({ memoryMaxItems: 51 })
  await service.retainUserMessage(capacityBot, 'remember item_0 scenario_0')
  await service.waitForMaintenance()
  assert(database.listMemories(capacityBot).some((memory) => memory.factKey === 'identity.name'), '提高容量后本地周期维护可重试仍有效候选')
  assert.equal((await service.retainUserMessage(capacityBot, '我的公司叫容量测试公司')).capacityReached, true)
  database.updateSettings({ memoryMaxItems: 52 })
  await service.retainUserMessage(capacityBot, '以后默认JSON格式输出')
  await service.waitForMaintenance()
  assert(database.listMemories(capacityBot).some((memory) => memory.factKey === 'output.format'))
  assert(database.listMemories(capacityBot).every((memory) => memory.factKey !== 'identity.company'), '版本已变化的旧容量候选不得复活')
  console.log(JSON.stringify({ ok: true, localDefault: true, backgroundRefinement: true, scopedContext: true,
    noLateResurrection: true, disableReenableCancellation: true, stopRestartCancellation: true, sanitizedFailure: true, configuredCapacity: true, globalConcurrency: 2 }))
} finally {
  await service.stop()
  database.close()
  fs.rmSync(directory, { recursive: true, force: true })
}
