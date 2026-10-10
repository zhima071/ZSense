import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { ScheduledTaskRunner } from '../electron/services/scheduled-task-runner.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(description)
}

const cases = []
const cancellations = []
const failures = []
const originalInfo = console.info
const originalWarn = console.warn
console.info = (...args) => cancellations.push(args)
console.warn = (...args) => failures.push(args)

async function scenario(name, check) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-scheduled-memory-race-'))
  const database = new ZSenseDatabase(directory)
  database.memoryService = { recallMemories: (botId, query, options) => database.recallMemories(botId, query, options) }
  database.updateModelConfiguration({ provider: 'custom', model: 'offline-fake', baseUrl: 'http://127.0.0.1:1/v1', apiKeyName: 'OFFLINE_FAKE_API_KEY', apiKeyConfigured: false, updatedAt: new Date().toISOString() })
  const summaries = []
  const executions = []
  let executionGate = null
  let cleaningUp = false
  const runner = new ScheduledTaskRunner({
    database,
    userDataDirectory: directory,
    secrets: { get: () => ({}) },
    agentCore: {
      supportsProvider: () => true,
      requiresApiKey: () => false,
      inspect: async () => ({ runnable: true }),
      chatStream: async () => {
        const output = `成功结果 ${executions.length + 1}`
        executions.push(output)
        if (executionGate) await executionGate.promise
        return { output, sessionId: `offline-session-${executions.length}` }
      },
      summarizeScheduledTaskMemory: (request) => {
        if (cleaningUp) return Promise.resolve('清理测试摘要')
        const gate = deferred()
        summaries.push({ request, gate })
        return gate.promise
      },
    },
  })
  const workspace = runner.create({ name, frequency: 'daily', timeOfDay: '09:00', weekday: 1,
    modelProvider: 'custom', model: 'offline-fake', prompt: '生成工作摘要。', skillIds: [],
    deliveryTarget: 'local', repeatCount: 0, enabled: false, memoryEnabled: true })
  const taskId = workspace.scheduledTasks.find((task) => task.name === name).id
  const run = async () => {
    runner.runNow(taskId)
    await runner.activePromise
    return database.loadWorkspace().scheduledTaskRuns.find((item) => item.taskId === taskId)
  }
  const summaryStarted = async (count) => until(() => summaries.length === count, `${name}: 后台摘要没有启动`)
  const settleSummaries = async () => {
    await Promise.allSettled([...runner.memorySummaryPromises.values()])
  }
  try {
    await check({ database, runner, taskId, run, summaries, executions, summaryStarted, settleSummaries,
      setExecutionGate: (gate) => { executionGate = gate } })
    cases.push(name)
  } finally {
    cleaningUp = true
    executionGate?.resolve()
    for (const summary of summaries) summary.gate.resolve('清理测试摘要')
    await runner.shutdown()
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

try {
  await scenario('原子提交校验', async ({ database, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    const source = await run()
    await summaryStarted(1)
    const revision = database.getScheduledTask(taskId).memoryRevision
    assert.equal(database.updateScheduledTaskMemorySummary(taskId, '陈旧版本', { expectedRevision: revision + 1, sourceRunId: source.id }), null, '数据库提交未拦截错误版本')
    assert.equal(database.updateScheduledTaskMemorySummary(taskId, '不存在的来源', { expectedRevision: revision, sourceRunId: 'missing-run' }), null, '数据库提交未拦截不存在的来源')
    assert.equal(database.getScheduledTask(taskId).memorySummary, '')
    summaries[0].gate.resolve('合法来源摘要')
    await settleSummaries()
    assert.equal(database.getScheduledTask(taskId).memorySummary, '合法来源摘要')
  })

  await scenario('删除来源运行', async ({ database, runner, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    const source = await run()
    await summaryStarted(1)
    const revision = database.getScheduledTask(taskId).memoryRevision
    runner.deleteRun(source.id)
    assert.equal(database.getScheduledTask(taskId).memoryRevision, revision + 1)
    summaries[0].gate.resolve('已经删除的成功结果')
    await settleSummaries()
    assert.equal(database.getScheduledTask(taskId).memorySummary, '', '已删除的结果被旧模型请求重新写入摘要')
    assert.equal(database.getScheduledTaskRun(source.id), null)
  })

  await scenario('删除任务', async ({ database, runner, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    const source = await run()
    await summaryStarted(1)
    runner.delete(taskId)
    summaries[0].gate.resolve('已经删除任务的结果')
    await settleSummaries()
    assert.equal(database.getScheduledTask(taskId), null)
    assert.equal(database.getScheduledTaskRun(source.id), null)
  })

  await scenario('删除运行取消队列', async ({ database, runner, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    await run()
    await summaryStarted(1)
    const latest = await run()
    assert.equal(summaries.length, 1, '同一任务摘要应串行处理')
    runner.deleteRun(latest.id)
    summaries[0].gate.resolve('删除前的旧摘要')
    await settleSummaries()
    assert.equal(summaries.length, 1, '已删除来源的排队请求仍被发送给摘要器')
    assert.equal(database.getScheduledTask(taskId).memorySummary, '')
  })

  await scenario('清空摘要', async ({ database, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    await run()
    await summaryStarted(1)
    const revision = database.getScheduledTask(taskId).memoryRevision
    database.updateScheduledTaskMemorySummary(taskId, '')
    assert.equal(database.getScheduledTask(taskId).memoryRevision, revision + 1, '清空摘要必须使旧请求失效')
    summaries[0].gate.resolve('清空前的旧摘要')
    await settleSummaries()
    assert.equal(database.getScheduledTask(taskId).memorySummary, '', '清空操作被旧模型摘要覆盖')
  })

  await scenario('手动编辑摘要', async ({ database, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    await run()
    await summaryStarted(1)
    const revision = database.getScheduledTask(taskId).memoryRevision
    database.updateScheduledTaskMemorySummary(taskId, '用户修订后的任务摘要')
    assert.equal(database.getScheduledTask(taskId).memoryRevision, revision + 1)
    summaries[0].gate.resolve('编辑前的旧摘要')
    await settleSummaries()
    assert.equal(database.getScheduledTask(taskId).memorySummary, '用户修订后的任务摘要')
  })

  await scenario('修改任务提示', async ({ database, runner, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    await run()
    await summaryStarted(1)
    const task = database.getScheduledTask(taskId)
    runner.update(taskId, { ...task, prompt: '生成财务日报。' })
    assert.equal(database.getScheduledTask(taskId).memoryRevision, task.memoryRevision + 1)
    summaries[0].gate.resolve('旧工作摘要任务的结果')
    await settleSummaries()
    assert.equal(database.getScheduledTask(taskId).memorySummary, '', '修改任务提示后仍合并了旧任务结果')
  })

  await scenario('关闭并重开任务记忆', async ({ database, runner, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    await run()
    await summaryStarted(1)
    const task = database.getScheduledTask(taskId)
    runner.update(taskId, { ...task, memoryEnabled: false })
    runner.update(taskId, { ...database.getScheduledTask(taskId), memoryEnabled: true })
    summaries[0].gate.resolve('关闭前的旧摘要')
    await settleSummaries()
    assert.equal(database.getScheduledTask(taskId).memorySummary, '', '重新开启后仍接受了关闭前的旧请求')
  })

  await scenario('执行中清空记忆', async ({ database, runner, taskId, summaries, executions, settleSummaries, setExecutionGate }) => {
    const gate = deferred()
    setExecutionGate(gate)
    runner.runNow(taskId)
    await until(() => executions.length === 1, '假内核未启动')
    database.updateScheduledTaskMemorySummary(taskId, '')
    gate.resolve()
    await runner.activePromise
    await settleSummaries()
    assert.equal(summaries.length, 0, '摘要必须绑定任务执行启动时的记忆版本')
    assert.equal(database.getScheduledTask(taskId).memorySummary, '')
  })

  await scenario('连续成功摘要', async ({ database, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    const initialRevision = database.getScheduledTask(taskId).memoryRevision
    await run()
    await summaryStarted(1)
    await run()
    assert.equal(summaries.length, 1)
    summaries[0].gate.resolve('第一次成功的滚动摘要')
    await summaryStarted(2)
    assert.equal(database.getScheduledTask(taskId).memorySummaryRunCount, 1, '尚未合并的排队结果提前进入摘要计数')
    assert.equal(summaries[1].request.previousSummary, '第一次成功的滚动摘要', '第二次摘要未继承第一次成功摘要')
    assert.equal(summaries[1].request.latestOutput, '成功结果 2')
    summaries[1].gate.resolve('连续两次成功的滚动摘要')
    await settleSummaries()
    const task = database.getScheduledTask(taskId)
    assert.equal(task.memorySummary, '连续两次成功的滚动摘要')
    assert.equal(task.memorySummaryRunCount, 2)
    assert.equal(task.memoryRevision, initialRevision, '正常摘要更新不应使后续排队摘要失效')
  })

  await scenario('摘要失败后恢复', async ({ database, taskId, run, summaries, summaryStarted, settleSummaries }) => {
    await run()
    await summaryStarted(1)
    await run()
    summaries[0].gate.reject(new Error('模拟摘要失败 API Key: sk-test-secret-value'))
    await summaryStarted(2)
    assert.equal(summaries[1].request.previousSummary, '', '失败摘要不应成为后续摘要的输入')
    summaries[1].gate.resolve('摘要失败后的新成功结果')
    await settleSummaries()
    assert.equal(database.getScheduledTask(taskId).memorySummary, '摘要失败后的新成功结果')
    assert(failures.some((entry) => entry.join(' ').includes('模拟摘要失败')), '摘要错误缺少可观察诊断')
    assert(failures.every((entry) => !entry.join(' ').includes('sk-test-secret-value')), '后台摘要错误日志泄漏了凭据')
  })

  assert(cancellations.length >= 7, '后台取消结果缺少可观察诊断')
  console.log(JSON.stringify({ ok: true, fakeCoreOnly: true, deterministicSummaryRaces: cases, observedCancellations: cancellations.length, observableRedactedErrors: failures.length > 0 }))
} finally {
  console.info = originalInfo
  console.warn = originalWarn
}
