import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SubagentService } from '../electron/services/subagent-service.mjs'

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-subagents-'))
const context = { requestId: 'parent-request-1234', conversationId: 'conversation-1', botId: 'atlas', workspaceRoot: temporaryDirectory, modelProvider: 'custom', model: 'test-model', reasoningEffort: 'high' }

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

  // 并行支线：多个互不依赖的子任务同时跑，总耗时应该接近最慢的一条而不是相加
  const parallelDirectory = path.join(temporaryDirectory, 'parallel')
  const parallelService = new SubagentService({ rootPath: parallelDirectory, maxConcurrent: 3, maxPerParent: 4 })
  let activeBranches = 0
  let peakBranches = 0
  parallelService.setRunner({
    run: async ({ task }) => {
      activeBranches += 1
      peakBranches = Math.max(peakBranches, activeBranches)
      await new Promise((resolve) => setTimeout(resolve, 300))
      activeBranches -= 1
      return { output: `${task.title} 完成`, durationMs: 300, toolCallCount: 0 }
    },
    cancel: () => undefined,
  })
  const parallelStartedAt = Date.now()
  const branches = await Promise.all([1, 2, 3].map((index) => parallelService.create({ title: `并行分支 ${index}`, task: `处理分片 ${index}` }, context)))
  for (const branch of branches) await parallelService.status({ taskId: branch.id, waitMs: 5_000 }, context)
  const parallelElapsed = Date.now() - parallelStartedAt
  assert.equal(peakBranches, 3, '三个互不依赖的子任务没有并行执行')
  assert(parallelElapsed < 700, `三条支线并行总耗时应该接近单条（300ms），实际 ${parallelElapsed}ms`)
  assert.equal(parallelService.inspect().completed, 3)
  parallelService.shutdown()

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
  const child = await treeService.create({ title: '子任务', task: '执行二级检查' }, { ...treeContext, requestId: treeResolvers.get(parent.id).requestId, parentTaskId: parent.id, delegationDepth: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(treeService.inspect().running, 2, '父 Agent 等待子 Agent 时不应因基础并发限制发生死锁')
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
  await treeService.status({ taskId: child.id, waitMs: 2_000 }, treeContext)
  treeResolvers.get(parent.id).resolve({ output: '父任务完成' })
  await treeService.status({ taskId: parent.id, waitMs: 2_000 }, treeContext)
  treeService.shutdown()

  console.log(JSON.stringify({ ok: true, parallelLimit: true, parallelBranches: true, cancellation: true, persistence: true, restartRecovery: true, taskTree: true, agentMessaging: true }))
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
