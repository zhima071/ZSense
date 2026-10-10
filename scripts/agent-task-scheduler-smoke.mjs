import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_CONCURRENT_SUBAGENTS, normalizeTaskPlan, normalizeWriteResource, runTaskPlan, shouldPlanTask, writeResourcesConflict } from '../electron/services/agent-task-scheduler.mjs'

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-task-scheduler-')))
const workspaceRoot = path.join(fixture, 'workspace')
fs.mkdirSync(workspaceRoot)
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'
const node = (id, overrides = {}) => ({ id, title: `任务 ${id}`, goal: `完成 ${id}`, task: `检查 ${id} 并报告结果`, dependencies: [], expectedOutputs: [`${id} 报告`], writeResources: [], ...overrides })
const plan = (...tasks) => normalizeTaskPlan({ tasks }, { workspaceRoot })
const tick = () => new Promise((resolve) => setImmediate(resolve))
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await tick()
  }
  assert.fail('调度状态未及时到达预期。')
}
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

try {
  // Prompt length, pasted code/logs, and questions about parallelism are not gates.
  for (const input of [
    '', '你好', '什么是并行任务？', '请解释并行处理和串行处理的区别。', 'Explain how to run in parallel.',
    '帮我将按钮标题改为“并行任务”。', '修改 src/App.tsx 里的一个按钮颜色。',
    '帮我将按钮标题改为“并行执行”。',
    `请解释下面日志：\n${'后端和前端同步并行处理完成\n'.repeat(1000)}`,
    `解释以下代码：\n\`\`\`js\n${'// 请并行处理前端和后端\n'.repeat(1000)}\`\`\``,
    '比较前端和后端的区别。', '帮我翻译下面文本：\n请并行检查代码和测试。',
    '请解释前端和后端的区别。', '帮我介绍如何修复跨模块问题。', 'How do I fix the frontend and backend?',
    '帮我分析这个表格。', '请解释多 Agent 是怎么工作的。', '请总结这段文档：\n1. 资料检索\n2. 表格分析\n3. 文档草稿',
    '帮我修改一个设计稿的颜色和字体。',
    `下面是非请求的原始内容\n${'示例说明\n'.repeat(1000)}1. 检查模块 A\n2. 生成文档`,
  ]) assert.equal(shouldPlanTask(input), false, `简单请求误触发规划：${input.slice(0, 80)}`)
  for (const input of [
    '请并行检查代码质量和测试覆盖率。', '并行分析这三个独立模块。',
    'Please review the frontend and backend in parallel.', 'Use up to 3 subagents to inspect the repository.',
    '分别检查代码和测试，两个任务独立完成。', '实现前端和后端的配套协议。',
    '修复跨模块会话状态同步。', '1. 检查模块 A\n2. 生成模块 B 的文档',
    '帮我做资料检索、表格分析、文档草稿，最后整合报告',
    '请检索竞品资料和撰写方案草稿。', '帮我设计海报、分析表格数据，最后生成报告。',
    '帮我分析数据和修复代码。', '请实现以下需求：\n1. 登录页面\n2. 消息接口',
    '需求清单：\n1. 资料检索\n2. 表格分析\n3. 文档草稿',
  ]) assert.equal(shouldPlanTask(input), true, `复杂请求没有触发规划：${input}`)
  assert.equal(shouldPlanTask({ content: '请并行审查两个模块。' }), true)
  assert.equal(shouldPlanTask({ content: [{ text: '并行运行' }] }), false)

  // Paths are canonicalized without touching files or creating missing outputs.
  fs.mkdirSync(path.join(workspaceRoot, 'real', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(workspaceRoot, 'sibling'))
  fs.mkdirSync(path.join(fixture, 'outside'))
  fs.symlinkSync(path.join(workspaceRoot, 'real', 'deep'), path.join(workspaceRoot, 'alias'), directoryLinkType)
  fs.symlinkSync(path.join(fixture, 'outside'), path.join(workspaceRoot, 'escape'), directoryLinkType)
  fs.symlinkSync(path.join(workspaceRoot, 'absent'), path.join(workspaceRoot, 'dangling'), directoryLinkType)
  const physical = normalizeWriteResource('real/deep/file.txt', workspaceRoot)
  assert.equal(normalizeWriteResource('alias/file.txt', workspaceRoot), physical)
  assert.equal(normalizeWriteResource('alias/../shared.txt', workspaceRoot), path.join(workspaceRoot, 'real', 'shared.txt'))
  assert.equal(normalizeWriteResource('new/nested/file.txt', workspaceRoot), path.join(workspaceRoot, 'new', 'nested', 'file.txt'))
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'new')), false)
  assert.equal(writeResourcesConflict([physical], [normalizeWriteResource('alias/file.txt', workspaceRoot)]), true)
  assert.equal(writeResourcesConflict([normalizeWriteResource('real', workspaceRoot)], [physical]), true)
  assert.equal(writeResourcesConflict([physical], [normalizeWriteResource('real/deep/file.txt.bak', workspaceRoot)]), false)
  assert.equal(writeResourcesConflict(['*'], []), true)
  assert.equal(writeResourcesConflict([], []), false)
  const hardlinkSource = path.join(workspaceRoot, 'hardlink-source')
  const hardlinkAlias = path.join(workspaceRoot, 'hardlink-alias')
  fs.writeFileSync(hardlinkSource, 'fixture only')
  fs.linkSync(hardlinkSource, hardlinkAlias)
  assert.equal(writeResourcesConflict([hardlinkSource], [hardlinkAlias]), true)
  assert.equal(normalizeWriteResource('*', workspaceRoot), '*')
  assert.throws(() => normalizeWriteResource('dangling/file', workspaceRoot), /符号链接/u)
  for (const invalid of ['', 'https://example.com/a', '~/file', 'src/*.mjs', 'file\nname', ...(process.platform === 'win32' ? [] : ['C:\\temp\\file'])]) assert.throws(() => normalizeWriteResource(invalid, workspaceRoot))
  assert.throws(() => writeResourcesConflict(['relative'], [physical]), /绝对路径/u)

  // Bad plans fail before any callback or task can run.
  const invalidPlans = [
    null, {}, { tasks: [] }, { tasks: Array.from({ length: 7 }, (_, i) => node(`n${i}`)) },
    { tasks: [node('a'), node('a')] }, { tasks: [node('a', { dependencies: ['missing'] })] },
    { tasks: [node('a', { dependencies: ['a'] })] },
    { tasks: [node('a', { dependencies: ['b'] }), node('b', { dependencies: ['a'] })] },
    { tasks: [node('a', { goal: ' ' })] }, { tasks: [node('a', { task: '' })] },
    { tasks: [node('a', { dependencies: ['b', 'b'] }), node('b')] },
    { tasks: [node('a', { writeResources: ['../outside/file'] })] },
    { tasks: [node('a', { writeResources: ['escape/file'] })] },
    { tasks: [node('a', { writeResources: null })] },
  ]
  for (const invalid of invalidPlans) assert.throws(() => normalizeTaskPlan(invalid, { workspaceRoot }))
  assert.throws(() => normalizeTaskPlan({ tasks: [node('a')] }, { workspaceRoot: 'relative' }))
  const missingDeclaration = node('unknown')
  delete missingDeclaration.writeResources
  assert.deepEqual(plan(missingDeclaration).tasks[0].writeResources, ['*'])
  const rawPlan = { tasks: [node('a', { writeResources: ['real', 'real'] })] }
  const rawJson = JSON.stringify(rawPlan)
  const normalized = normalizeTaskPlan(rawPlan, { workspaceRoot })
  assert.equal(normalized.tasks[0].writeResources.length, 1)
  assert.equal(JSON.stringify(rawPlan), rawJson, '规范化不得修改调用者计划。')
  let invalidRuns = 0
  await assert.rejects(runTaskPlan({ workspaceRoot, tasks: [node('a', { dependencies: ['missing'] })] }, { runTask: () => { invalidRuns += 1 } }))
  assert.equal(invalidRuns, 0)

  // Five independent tasks start; the sixth waits even with a higher option.
  assert.equal(MAX_CONCURRENT_SUBAGENTS, 5)
  const pending = new Map()
  let running = 0
  let peak = 0
  const updates = []
  const parallel = runTaskPlan(plan(...Array.from({ length: 6 }, (_, i) => node(`p${i}`))), {
    maxConcurrent: 9,
    onUpdate: (snapshot) => updates.push(snapshot),
    runTask: async (task) => {
      running += 1
      peak = Math.max(peak, running)
      const wait = deferred()
      pending.set(task.id, wait)
      const value = await wait.promise
      running -= 1
      return value
    },
  })
  await waitFor(() => pending.size === 5)
  assert.equal(peak, 5)
  assert.deepEqual([...pending.keys()], ['p0', 'p1', 'p2', 'p3', 'p4'])
  assert.equal(updates.at(-1).tasks[5].status, 'pending')
  pending.get('p0').resolve({ output: 'p0' })
  await waitFor(() => pending.size === 6)
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) pending.get(id).resolve({ output: id })
  const parallelResult = await parallel
  assert.equal(peak, 5)
  assert.equal(parallelResult.status, 'completed')
  assert.equal(parallelResult.tasks.every((task) => task.status === 'completed' && task.startedAt && task.finishedAt && task.durationMs >= 0), true)
  assert.equal(updates[0].tasks.every((task) => task.status === 'pending'), true)
  assert.equal(updates.at(-1).status, 'completed')

  // The default limit is also five; conflicts and cancellation retain their slots.
  const fiveController = new AbortController()
  const fiveWaits = new Map()
  const fiveUpdates = []
  let fiveFinished = false
  const fiveCancelled = runTaskPlan(plan(...Array.from({ length: 6 }, (_, i) => node(`c${i}`, { writeResources: [`isolated-${i}.txt`] }))), {
    signal: fiveController.signal,
    onUpdate: (snapshot) => fiveUpdates.push(snapshot),
    runTask: (task) => { const wait = deferred(); fiveWaits.set(task.id, wait); return wait.promise },
  }).then((result) => { fiveFinished = true; return result })
  await waitFor(() => fiveWaits.size === 5)
  fiveController.abort()
  await tick()
  assert.equal(fiveFinished, false, '取消不能提前释放运行中的五个写入任务')
  assert.deepEqual(fiveUpdates.at(-1).tasks.map((task) => task.status), ['running', 'running', 'running', 'running', 'running', 'cancelled'])
  for (const wait of fiveWaits.values()) wait.resolve({ output: 'late fixture result' })
  assert.equal((await fiveCancelled).tasks.every((task) => task.status === 'cancelled'), true)
  assert.equal(fiveWaits.size, 5, '取消后第六个任务不能启动')

  const lockedWaits = new Map()
  const lockedUpdates = []
  const lockedAtFive = runTaskPlan(plan(...Array.from({ length: 6 }, (_, i) => node(`lock${i}`, { writeResources: i < 2 ? ['real/shared-five.txt'] : [] }))), {
    onUpdate: (snapshot) => lockedUpdates.push(snapshot),
    runTask: (task) => { const wait = deferred(); lockedWaits.set(task.id, wait); return wait.promise },
  })
  await waitFor(() => lockedWaits.size === 5)
  assert.deepEqual([...lockedWaits.keys()], ['lock0', 'lock2', 'lock3', 'lock4', 'lock5'])
  assert.equal(lockedUpdates.at(-1).tasks[1].phase, 'waiting_resources', '五路并发也不能绕过同文件写入锁')
  lockedWaits.get('lock0').resolve({ output: 'first writer finished' })
  await waitFor(() => lockedWaits.has('lock1'))
  for (const [id, wait] of lockedWaits) if (id !== 'lock0') wait.resolve({ output: id })
  assert.equal((await lockedAtFive).status, 'completed')

  // Dependents receive only completed direct prerequisites, not unrelated output.
  const order = []
  const dagUpdates = []
  const a = deferred()
  const dag = runTaskPlan(plan(node('a'), node('b', { dependencies: ['a'] }), node('c')), {
    onUpdate: (snapshot) => dagUpdates.push(snapshot),
    runTask: async (task, { dependencies }) => {
      order.push(task.id)
      if (task.id === 'a') return a.promise
      if (task.id === 'b') {
        assert.deepEqual(dependencies.map((item) => [item.id, item.status, item.output]), [['a', 'completed', 'a result']])
        dependencies[0].output = 'callback mutation'
      }
      return { output: `${task.id} result` }
    },
  })
  await waitFor(() => order.length === 2)
  assert.deepEqual(order, ['a', 'c'])
  assert.equal(dagUpdates.some((snapshot) => snapshot.tasks[1].status === 'pending' && snapshot.tasks[1].phase === 'waiting_dependencies'), true)
  a.resolve({ output: 'a result' })
  const dagResult = await dag
  assert.deepEqual(order, ['a', 'c', 'b'])
  assert.equal(dagResult.tasks[0].output, 'a result')

  const failedStarts = []
  const failed = await runTaskPlan(plan(node('a'), node('b', { dependencies: ['a'] }), node('c', { dependencies: ['b'] }), node('d')), {
    runTask: async (task) => {
      failedStarts.push(task.id)
      if (task.id === 'a') throw new Error('fixture failure')
      return { output: task.id }
    },
  })
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.tasks.map((item) => item.status), ['failed', 'blocked', 'blocked', 'completed'])
  assert.deepEqual(failedStarts, ['a', 'd'])
  assert.equal(failed.tasks[1].startedAt, '')
  const returnedFailure = await runTaskPlan(plan(node('a'), node('b', { dependencies: ['a'] })), { runTask: async () => ({ status: 'failed', output: 'partial', error: 'runner failed' }) })
  assert.equal(returnedFailure.tasks[0].error, 'runner failed')
  assert.equal(returnedFailure.tasks[1].status, 'blocked')

  // Exact, parent/child, and symlink aliases serialize; disjoint siblings proceed.
  for (const [left, right] of [['real/file', 'real/file'], ['real', 'real/deep/file'], ['alias/file', 'real/deep/file'], ['alias/../shared', 'real/shared'], [hardlinkSource, hardlinkAlias], ['*', 'sibling/file']]) {
    const wait = deferred()
    const started = []
    const conflictUpdates = []
    const conflicts = runTaskPlan(plan(node('a', { writeResources: [left] }), node('b', { writeResources: [right] }), node('c', { writeResources: left === '*' ? [] : ['sibling/other'] })), {
      onUpdate: (snapshot) => conflictUpdates.push(snapshot),
      runTask: async (task) => {
        started.push(task.id)
        if (task.id === 'a') return wait.promise
        return { output: task.id }
      },
    })
    await waitFor(() => started.includes('a'))
    await tick()
    assert.equal(started.includes('b'), false, `资源冲突被并行启动：${left} / ${right}`)
    assert.equal(conflictUpdates.some((snapshot) => snapshot.tasks[1].status === 'pending' && snapshot.tasks[1].phase === 'waiting_resources'), true)
    assert.equal(started.includes('c'), left !== '*')
    wait.resolve({ output: 'a' })
    assert.equal((await conflicts).status, 'completed')
    assert.equal(started.includes('b'), true)
  }

  // Re-check resources changed by a prerequisite before starting a writer.
  const changingDirectory = path.join(workspaceRoot, 'changing')
  fs.mkdirSync(changingDirectory)
  const changedPlan = plan(node('replace'), node('writer', { dependencies: ['replace'], writeResources: ['changing/file'] }), node('dependent', { dependencies: ['writer'] }))
  const changedStarts = []
  const changed = await runTaskPlan(changedPlan, { runTask: async (task) => {
    changedStarts.push(task.id)
    fs.rmdirSync(changingDirectory)
    fs.symlinkSync(path.join(fixture, 'outside'), changingDirectory, directoryLinkType)
    return { output: 'fixture symlink changed' }
  } })
  assert.deepEqual(changedStarts, ['replace'])
  assert.deepEqual(changed.tasks.map((task) => task.status), ['completed', 'failed', 'blocked'])
  // Lock conflict comparisons fail closed if a path becomes a dangling symlink.
  assert.equal(writeResourcesConflict([path.join(workspaceRoot, 'dangling', 'file')], [hardlinkSource]), true)

  // Cancel pending work immediately, but never release a still-running task early.
  const controller = new AbortController()
  const cancelledWaits = new Map()
  const cancellationUpdates = []
  let cancellationFinished = false
  const cancelled = runTaskPlan(plan(node('a'), node('b'), node('c'), node('d', { dependencies: ['a'] })), {
    maxConcurrent: 2,
    signal: controller.signal,
    onUpdate: (snapshot) => cancellationUpdates.push(snapshot),
    runTask: (task, { signal }) => {
      assert.equal(signal, controller.signal)
      const wait = deferred()
      cancelledWaits.set(task.id, wait)
      return wait.promise
    },
  }).then((value) => { cancellationFinished = true; return value })
  await waitFor(() => cancelledWaits.size === 2)
  controller.abort()
  await tick()
  assert.equal(cancellationFinished, false)
  assert.deepEqual(cancellationUpdates.at(-1).tasks.map((item) => item.status), ['running', 'running', 'cancelled', 'cancelled'])
  cancelledWaits.get('a').resolve({ output: 'late result' })
  cancelledWaits.get('b').reject(new Error('aborted'))
  const cancellationResult = await cancelled
  assert.equal(cancellationResult.status, 'cancelled')
  assert.equal(cancellationResult.tasks.every((item) => item.status === 'cancelled'), true)
  assert.equal(cancelledWaits.size, 2)
  const preCancelled = new AbortController()
  preCancelled.abort()
  let preCancelledRuns = 0
  const preCancelledResult = await runTaskPlan(plan(node('a')), { signal: preCancelled.signal, runTask: () => { preCancelledRuns += 1 } })
  assert.equal(preCancelledRuns, 0)
  assert.equal(preCancelledResult.tasks[0].status, 'cancelled')

  // Progress is observational: IDs, edges, state and counts cannot be rolled back.
  let lateProgress
  const progressUpdates = []
  const progress = await runTaskPlan(plan(node('a')), {
    onUpdate: (snapshot) => {
      progressUpdates.push(snapshot)
      snapshot.tasks[0].id = 'observer mutation'
      snapshot.tasks[0].dependencies.push('observer mutation')
      return Promise.reject(new Error('ignored observer failure'))
    },
    runTask: async (task, { reportProgress }) => {
      task.id = 'runner mutation'
      task.writeResources.push('*')
      lateProgress = reportProgress
      reportProgress({ id: 'bad', status: 'completed', dependencies: ['bad'], toolCallCount: 3, phase: 'search_files' })
      reportProgress({ toolCallCount: 2 })
      return { output: 'verified', toolCallCount: 1, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, secret: 'excluded' } }
    },
  })
  assert.equal(progress.tasks[0].id, 'a')
  assert.equal(progress.tasks[0].status, 'completed')
  assert.deepEqual(progress.tasks[0].dependencies, [])
  assert.deepEqual(progress.tasks[0].writeResources, [])
  assert.equal(progress.tasks[0].toolCallCount, 3)
  assert.equal(progress.tasks[0].phase, 'search_files')
  assert.deepEqual(progress.tasks[0].usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  const progressCount = progressUpdates.length
  lateProgress({ toolCallCount: 99, phase: 'late' })
  assert.equal(progressUpdates.length, progressCount)
  await tick()

  console.log(JSON.stringify({ ok: true, cheapGate: true, planValidation: true, maximumConcurrency: 5, dependencyOrdering: true, failureBlocking: true, cancellation: true, writeResourceSerialization: true, symlinkCanonicalization: true, hardlinkConflict: true, waitingPhases: true, resourceRevalidation: true, progressSnapshots: true, usage: true }))
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
