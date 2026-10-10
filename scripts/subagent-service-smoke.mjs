import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SubagentService } from '../electron/services/subagent-service.mjs'

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-subagents-'))
const context = { requestId: 'parent-request-1234', conversationId: 'conversation-1', botId: 'atlas', workspaceRoot: temporaryDirectory, modelProvider: 'custom', model: 'test-model', reasoningEffort: 'high' }
const tick = () => new Promise((resolve) => setImmediate(resolve))
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await tick()
  }
  assert.fail('子 Agent 状态未及时到达预期。')
}

try {
  const resolvers = new Map()
  const cancelled = []
  const service = new SubagentService({ rootPath: temporaryDirectory, maxConcurrent: 2, maxPerParent: 4 })
  service.setRunner({
    run: ({ task, requestId, onEvent }) => new Promise((resolve, reject) => {
      resolvers.set(task.id, { resolve, reject, requestId })
      onEvent({ type: 'tool', name: 'search_files', status: 'complete', durationMs: 8, detail: '搜索完成' })
    }),
    cancel: (requestId) => { cancelled.push(requestId); for (const item of resolvers.values()) if (item.requestId === requestId) item.reject(new Error('已停止生成。')) },
  })

  const first = await service.create({ title: '任务一', task: '检查模块一' }, context)
  const second = await service.create({ title: '任务二', task: '检查模块二' }, context)
  const third = await service.create({ title: '任务三', task: '检查模块三' }, context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(service.inspect().running, 2)
  assert.equal(service.inspect().queued, 1)

  resolvers.get(first.id).resolve({ output: '任务一完成' })
  const firstResult = await service.status({ taskId: first.id, waitMs: 2_000 }, context)
  assert.equal(firstResult.status, 'completed')
  assert.equal(firstResult.toolCallCount, 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(service.inspect().running, 2)

  await service.cancel({ taskId: third.id }, context)
  const thirdResult = await service.status({ taskId: third.id, waitMs: 2_000 }, context)
  assert.equal(thirdResult.status, 'cancelled')
  assert.equal(cancelled.length, 1)
  resolvers.get(second.id).resolve({ output: '任务二完成' })
  await service.status({ taskId: second.id, waitMs: 2_000 }, context)
  service.shutdown()

  const statePath = path.join(temporaryDirectory, 'capabilities', 'delegations.json')
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  persisted.push({ id: 'delegate-interrupted', title: '中断任务', task: '恢复测试', status: 'running', parentRequestId: context.requestId, conversationId: context.conversationId, botId: context.botId, workspacePath: temporaryDirectory, modelProvider: 'custom', model: 'test-model', reasoningEffort: 'high', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: '', durationMs: 0, toolCallCount: 0, toolEvents: [], output: '', error: '' })
  fs.writeFileSync(statePath, JSON.stringify(persisted, null, 2), 'utf8')
  const restored = new SubagentService({ rootPath: temporaryDirectory })
  const interrupted = await restored.status({ taskId: 'delegate-interrupted' }, context)
  assert.equal(interrupted.status, 'interrupted')
  restored.shutdown()

  // Default manual delegation can fill all five slots; its per-parent cap stays five.
  const parallelDirectory = path.join(temporaryDirectory, 'parallel')
  const parallelService = new SubagentService({ rootPath: parallelDirectory })
  const branchResolvers = new Map()
  let activeBranches = 0
  let peakBranches = 0
  assert.equal(parallelService.inspect().maxConcurrent, 5)
  assert.equal(parallelService.inspect().maxPerTurn, 5)
  assert.equal(parallelService.inspect().maxDepth, 4)
  parallelService.setRunner({
    run: async ({ task }) => {
      activeBranches += 1
      peakBranches = Math.max(peakBranches, activeBranches)
      await new Promise((resolve) => branchResolvers.set(task.id, resolve))
      activeBranches -= 1
      return { output: `${task.title} 完成`, toolCallCount: 0 }
    },
    cancel: () => undefined,
  })
  const branches = await Promise.all([1, 2, 3, 4, 5].map((index) => parallelService.create({ title: `并行分支 ${index}`, task: `处理分片 ${index}` }, context)))
  await waitFor(() => branchResolvers.size === 5)
  assert.equal(peakBranches, 5, '默认委派没有同时运行五个子任务')
  assert.equal(parallelService.inspect().running, 5)
  await assert.rejects(parallelService.create({ task: '手动委派第六个子任务' }, context), /单轮最多创建 5 个/u)
  for (const resolve of branchResolvers.values()) resolve()
  for (const branch of branches) await parallelService.status({ taskId: branch.id, waitMs: 5_000 }, context)
  assert.equal(parallelService.inspect().completed, 5)
  parallelService.shutdown()

  // Plans retain six total tasks, but a higher requested concurrency is capped at five.
  const queueService = new SubagentService({ rootPath: path.join(temporaryDirectory, 'five-slots'), maxConcurrent: 9 })
  const queueResolvers = new Map()
  const queueCancellations = []
  let activeQueuedBranches = 0
  let peakQueuedBranches = 0
  queueService.setRunner({
    run: async ({ task, requestId }) => {
      activeQueuedBranches += 1
      peakQueuedBranches = Math.max(peakQueuedBranches, activeQueuedBranches)
      try { return await new Promise((resolve, reject) => queueResolvers.set(task.id, { resolve, reject, requestId })) }
      finally { activeQueuedBranches -= 1 }
    },
    cancel: (requestId) => { queueCancellations.push(requestId) },
  })
  const planContext = { ...context, requestId: 'six-task-plan', orchestrationPlanId: 'fixture-plan' }
  const sixBranches = await Promise.all(Array.from({ length: 6 }, (_, index) => queueService.create({ task: `计划分支 ${index + 1}` }, planContext)))
  await waitFor(() => queueResolvers.size === 5)
  assert.equal(queueService.inspect().maxConcurrent, 5)
  assert.equal(queueService.inspect().running, 5)
  assert.equal(queueService.inspect().queued, 1)
  assert.equal(queueResolvers.has(sixBranches[5].id), false, '第六个子任务必须等待空闲槽位')
  await assert.rejects(queueService.create({ task: '计划第七个子任务' }, planContext), /单轮最多创建 6 个/u)
  await queueService.cancel({ taskId: sixBranches[0].id }, planContext)
  await tick()
  assert.equal(queueCancellations.length, 1)
  assert.equal(queueService.inspect().running, 5, '取消请求不能提前释放尚未退出的执行槽位')
  assert.equal(queueService.inspect().queued, 1)
  queueResolvers.get(sixBranches[0].id).reject(new Error('fixture cancelled'))
  await waitFor(() => queueResolvers.size === 6)
  assert.equal(peakQueuedBranches, 5)
  assert.equal(queueService.inspect().running, 5)
  assert.equal((await queueService.status({ taskId: sixBranches[0].id }, planContext)).status, 'cancelled')
  for (const branch of sixBranches.slice(1)) queueResolvers.get(branch.id).resolve({ output: 'fixture complete' })
  for (const branch of sixBranches.slice(1)) assert.equal((await queueService.status({ taskId: branch.id, waitMs: 2_000 }, planContext)).status, 'completed')
  queueService.shutdown()

  const treeDirectory = path.join(temporaryDirectory, 'tree')
  const treeResolvers = new Map()
  const steered = []
  const treeService = new SubagentService({ rootPath: treeDirectory, maxConcurrent: 1, maxPerParent: 4, maxDepth: 4 })
  treeService.setRunner({
    run: ({ task, requestId }) => new Promise((resolve) => treeResolvers.set(task.id, { resolve, requestId })),
    cancel: () => undefined,
    steer: async (requestId, message) => { steered.push({ requestId, message }); return { accepted: true } },
  })
  const treeContext = { ...context, requestId: 'tree-root-request', rootRequestId: 'tree-root-request', delegationDepth: 0 }
  const parent = await treeService.create({ title: '父任务', task: '管理子任务' }, treeContext)
  await new Promise((resolve) => setImmediate(resolve))
  const parentContext = { ...treeContext, requestId: treeResolvers.get(parent.id).requestId, parentTaskId: parent.id, delegationDepth: 1 }
  const child = await treeService.create({ title: '子任务', task: '执行二级检查' }, parentContext)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(treeService.inspect().running, 1, '未让位的父任务不能绕过并发上限启动子任务')
  assert.equal(treeService.inspect().queued, 1)
  const childWait = treeService.status({ taskId: child.id, waitMs: 2_000 }, parentContext)
  await waitFor(() => treeResolvers.has(child.id))
  assert.equal(treeService.inspect().running, 2, '父 Agent 等待子 Agent 时不应因基础并发限制发生死锁')
  assert.equal(treeService.inspect().running - treeService.waitingParents.size, 1)
  let parentResumed = false
  const parentResume = treeService.waitForExecutionSlot(parent.id).then(() => { parentResumed = true })
  await tick()
  assert.equal(parentResumed, false, '子任务占用槽位时父任务不能提前恢复')
  const childState = await treeService.status({ taskId: child.id }, treeContext)
  assert.equal(childState.parentTaskId, parent.id)
  assert.equal(childState.rootRequestId, treeContext.rootRequestId)
  assert.equal(childState.depth, 2)
  assert((await treeService.status({ taskId: parent.id }, treeContext)).childTaskIds.includes(child.id))

  await treeService.message({ taskId: child.id, message: '从根任务追加给子 Agent' }, treeContext)
  await treeService.message({ message: '子 Agent 向父 Agent 汇报' }, { ...treeContext, requestId: treeResolvers.get(child.id).requestId, parentTaskId: child.id, delegationDepth: 2 })
  await treeService.message({ message: '父 Agent 向根 Agent 汇报' }, { ...treeContext, requestId: treeResolvers.get(parent.id).requestId, parentTaskId: parent.id, delegationDepth: 1 })
  assert(steered.some((item) => item.requestId === treeResolvers.get(child.id).requestId && item.message.includes('追加给子')))
  assert(steered.some((item) => item.requestId === treeResolvers.get(parent.id).requestId && item.message.includes('向父 Agent')))
  assert(steered.some((item) => item.requestId === treeContext.rootRequestId && item.message.includes('向根 Agent')))
  treeResolvers.get(child.id).resolve({ output: '子任务完成' })
  await childWait // delegate_message may wake status before final completion.
  assert.equal((await treeService.status({ taskId: child.id, waitMs: 2_000 }, treeContext)).status, 'completed')
  await parentResume
  assert.equal(parentResumed, true)
  treeResolvers.get(parent.id).resolve({ output: '父任务完成' })
  await treeService.status({ taskId: parent.id, waitMs: 2_000 }, treeContext)
  treeService.shutdown()

  // A nested child cannot become a sixth active worker while all five parents run.
  const nestedService = new SubagentService({ rootPath: path.join(temporaryDirectory, 'nested-five') })
  const nestedResolvers = new Map()
  nestedService.setRunner({ run: ({ task, requestId }) => new Promise((resolve) => nestedResolvers.set(task.id, { resolve, requestId })), cancel: () => undefined })
  const nestedContext = { ...context, requestId: 'nested-root', rootRequestId: 'nested-root' }
  const parents = await Promise.all(Array.from({ length: 5 }, (_, index) => nestedService.create({ task: `父分支 ${index}` }, nestedContext)))
  await waitFor(() => nestedResolvers.size === 5)
  const yieldingParentContext = { ...nestedContext, requestId: nestedResolvers.get(parents[0].id).requestId, parentTaskId: parents[0].id, delegationDepth: 1 }
  const nestedChild = await nestedService.create({ task: '嵌套分支' }, yieldingParentContext)
  await tick()
  assert.equal(nestedResolvers.has(nestedChild.id), false)
  assert.equal(nestedService.inspect().running, 5)
  const nestedWait = nestedService.status({ taskId: nestedChild.id, waitMs: 2_000 }, yieldingParentContext)
  await waitFor(() => nestedResolvers.has(nestedChild.id))
  assert.equal(nestedService.inspect().running - nestedService.waitingParents.size, 5, '等待父任务让位后仍只允许五个活跃执行槽位')
  let nestedParentResumed = false
  const nestedResume = nestedService.waitForExecutionSlot(parents[0].id).then(() => { nestedParentResumed = true })
  await tick()
  assert.equal(nestedParentResumed, false)
  nestedResolvers.get(nestedChild.id).resolve({ output: '嵌套完成' })
  assert.equal((await nestedWait).status, 'completed')
  await nestedResume
  assert.equal(nestedParentResumed, true)
  assert.equal(nestedService.inspect().running - nestedService.waitingParents.size, 5)
  for (const branch of parents) nestedResolvers.get(branch.id).resolve({ output: '父分支完成' })
  for (const branch of parents) await nestedService.status({ taskId: branch.id, waitMs: 2_000 }, nestedContext)
  nestedService.shutdown()

  console.log(JSON.stringify({ ok: true, parallelLimit: 5, parallelBranches: true, sixthQueued: true, cancellation: true, persistence: true, restartRecovery: true, taskTree: true, nestedWorkerLimit: true, agentMessaging: true }))
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
