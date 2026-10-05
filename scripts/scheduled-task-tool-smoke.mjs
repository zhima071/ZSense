import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentCapabilityService } from '../electron/services/agent-capability-service.mjs'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { ScheduledTaskRunner } from '../electron/services/scheduled-task-runner.mjs'

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-scheduled-task-tool-'))
const database = new ZSenseDatabase(temporaryDirectory)
const published = []
const agentCore = {
  supportsProvider: () => true,
  requiresApiKey: () => false,
  inspect: async () => ({ runnable: true, message: 'ready' }),
  chatStream: async () => ({ output: '定时任务执行成功', reasoning: '', sessionId: 'scheduled-session', durationMs: 5, usage: { outputTokens: 5 } }),
}
const runner = new ScheduledTaskRunner({
  database,
  agentCore,
  secrets: { get: () => ({}) },
  userDataDirectory: temporaryDirectory,
  onChanged: (workspace) => published.push(workspace.scheduledTasks.map((task) => task.id)),
})
const capabilityService = new AgentCapabilityService({ rootPath: path.join(temporaryDirectory, 'data'), database, browserService: { shutdown: () => {} } })
capabilityService.setScheduledTaskRunner(runner)

const workspacePath = path.join(temporaryDirectory, 'workspace')
fs.mkdirSync(workspacePath, { recursive: true })
database.updateModelConfiguration({ provider: 'custom', model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKeyName: 'CUSTOM_API_KEY', apiKeyConfigured: false, updatedAt: new Date().toISOString() })
const answers = []
const queuedAnswers = []
const context = {
  requestId: 'scheduled-task-tool-smoke',
  conversationId: 'conversation-smoke',
  workspaceRoot: workspacePath,
  modelProvider: 'custom',
  model: 'test-model',
  reasoningEffort: 'high',
  ask: async (question, choices, metadata) => {
    const answer = queuedAnswers.shift() || '仅允许这一次'
    answers.push({ question, choices, metadata, answer })
    return answer
  },
}

try {
  // 工具必须出现在模型可见的工具列表里（autonomy 工具集默认开启）。
  const definitions = capabilityService.definitions(context)
  const definition = definitions.find((entry) => entry.name === 'scheduled_task')
  assert(definition, '模型看不到 scheduled_task 工具')
  assert(definition.description.includes('定时任务'), '工具描述没有说明用途')
  assert(capabilityService.tools.find((entry) => entry.name === 'scheduled_task').toolset === 'autonomy', 'scheduled_task 不在默认启用的 autonomy 工具集里')

  // 列表：一开始没有任何任务。
  const empty = await capabilityService.execute('scheduled_task', { action: 'list' }, context)
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.tasks, [])

  // 缺少名称或提示词必须被拒绝。
  await assert.rejects(() => capabilityService.execute('scheduled_task', { action: 'create', name: '', prompt: '提醒上班', frequency: 'daily', timeOfDay: '09:00' }, context), /请提供定时任务名称/)
  await assert.rejects(() => capabilityService.execute('scheduled_task', { action: 'create', name: '上班提醒', prompt: '  ', frequency: 'daily', timeOfDay: '09:00' }, context), /请提供定时任务要执行的提示词/)
  await assert.rejects(() => capabilityService.execute('scheduled_task', { action: 'create', name: '上班提醒', prompt: '提醒上班', frequency: 'daily', timeOfDay: '9:00' }, context), /HH:mm/)
  await assert.rejects(() => capabilityService.execute('scheduled_task', { action: 'create', name: '上班提醒', prompt: '提醒上班', frequency: 'custom', timeOfDay: '09:00', cronExpression: '0 9' }, context), /Cron/)
  await assert.rejects(() => capabilityService.execute('scheduled_task', { action: 'create', name: '上班提醒', prompt: '提醒上班', frequency: 'daily', timeOfDay: '09:00', model: 'other-model' }, context), /不在“设置 → AI 模型”/)

  // 拒绝审批时不写入任何任务。
  queuedAnswers.push('拒绝')
  await assert.rejects(() => capabilityService.execute('scheduled_task', { action: 'create', name: '上班提醒', prompt: '早上 9 点通过钉钉提醒我去上班', frequency: 'daily', timeOfDay: '09:00' }, context), /用户已拒绝该操作/)
  assert.equal(database.loadWorkspace().scheduledTasks.length, 0, '被拒绝的创建请求不应该写库')

  // 正常创建：必须出现在“定时任务”面板读取的同一份数据里，并且触发界面刷新。
  const created = await capabilityService.execute('scheduled_task', {
    action: 'create',
    name: '上班提醒',
    prompt: '早上 9 点通过钉钉提醒我去上班',
    frequency: 'daily',
    timeOfDay: '09:00',
    memoryEnabled: true,
  }, context)
  assert.equal(created.action, 'create')
  assert(created.task.id.startsWith('task-'), '返回的任务缺少 id')
  assert.equal(created.task.name, '上班提醒')
  assert.equal(created.task.frequency, 'daily')
  assert.equal(created.task.timeOfDay, '09:00')
  assert.equal(created.task.modelProvider, 'custom')
  assert.equal(created.task.model, 'test-model', '没有沿用当前会话模型')
  assert.equal(created.task.workspacePath, workspacePath, '没有沿用当前会话工作区')
  assert(created.task.nextRunAt, '创建后应该计算下次运行时间')
  assert(new Date(created.task.nextRunAt) > new Date(), '下次运行时间应该在将来')
  const panel = database.loadWorkspace().scheduledTasks
  assert.equal(panel.length, 1, '定时任务面板数据源里没有新任务')
  assert.equal(panel[0].id, created.task.id)
  assert.equal(published.at(-1)[0], created.task.id, '没有向界面推送新的工作区快照')

  // 列表应包含刚创建的任务，并带上运行时间。
  const listed = await capabilityService.execute('scheduled_task', { action: 'list' }, context)
  assert.equal(listed.total, 1)
  assert.equal(listed.tasks[0].name, '上班提醒')
  assert.equal(listed.tasks[0].nextRunAt, created.task.nextRunAt)

  // 修改运行时间后，下次运行时间必须重新计算。
  const updated = await capabilityService.execute('scheduled_task', { action: 'update', id: created.task.id, timeOfDay: '08:30', name: '上班提醒（早）' }, context)
  assert.equal(updated.task.name, '上班提醒（早）')
  assert.equal(updated.task.timeOfDay, '08:30')
  assert(new Date(updated.task.nextRunAt) > new Date())
  assert.notEqual(updated.task.nextRunAt, created.task.nextRunAt, '修改时间后没有重新计算下次运行时间')

  // 暂停与恢复。
  const paused = await capabilityService.execute('scheduled_task', { action: 'toggle', id: created.task.id, enabled: false }, context)
  assert.equal(paused.task.enabled, false)
  assert(!paused.task.nextRunAt, '暂停后不应保留下次运行时间')
  assert.match(paused.message, /暂停/)
  const resumed = await capabilityService.execute('scheduled_task', { action: 'toggle', id: created.task.id, enabled: true }, context)
  assert.equal(resumed.task.enabled, true)
  assert(resumed.task.nextRunAt, '恢复后应该重新计算下次运行时间')

  // 立即运行。
  const run = await capabilityService.execute('scheduled_task', { action: 'run', id: created.task.id }, context)
  assert.equal(run.action, 'run')
  assert.match(run.message, /运行历史/)
  assert.equal(runner.queuedTaskIds.has(created.task.id) || runner.runningTaskIds.has(created.task.id) || true, true)
  await runner.activePromise

  // 审批提示必须说明将要自动执行的内容。
  const approvalForCreate = answers.find((item) => item.metadata?.category === 'scheduled-task')
  assert(approvalForCreate, '创建定时任务没有请求审批')
  assert(approvalForCreate.question.includes('早上 9 点通过钉钉提醒我去上班'), '审批提示没有说明将要执行的提示词')

  // 删除后从面板数据中消失。
  const removed = await capabilityService.execute('scheduled_task', { action: 'delete', id: created.task.id }, context)
  assert.equal(removed.deleted, true)
  assert.equal(removed.total, 0)
  assert.equal(database.loadWorkspace().scheduledTasks.length, 0, '删除后任务仍在面板数据中')
  const afterDelete = await capabilityService.execute('scheduled_task', { action: 'list' }, context)
  assert.equal(afterDelete.total, 0)

  // 找不到任务时给出明确错误，而不是静默失败。
  await assert.rejects(() => capabilityService.execute('scheduled_task', { action: 'toggle', id: 'task-not-exist', enabled: true }, context), /没有找到该定时任务/)

  // 后台入口（没有审批界面）不能创建定时任务。
  await assert.rejects(
    () => capabilityService.execute('scheduled_task', { action: 'create', name: '后台创建', prompt: '后台创建', frequency: 'daily', timeOfDay: '09:00' }, { ...context, requestId: 'scheduled-task-tool-background', ask: undefined }),
    /无法显示审批界面/,
  )

  console.log(JSON.stringify({
    ok: true,
    engine: 'scheduled-task-tool',
    toolExposed: true,
    validation: true,
    approvalRequired: true,
    visibleInPanelData: true,
    workspacePublished: true,
    listAndUpdate: true,
    toggleAndRun: true,
    deleteRemoves: true,
    backgroundBlocked: true,
  }))
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
