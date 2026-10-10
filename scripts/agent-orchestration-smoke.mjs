import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AgentCapabilityService } from '../electron/services/agent-capability-service.mjs'
import { AgentWriteLockService, agentWriteLocks } from '../electron/services/agent-write-locks.mjs'
import { NATIVE_BOT_ID, ZSenseDatabase } from '../electron/services/database.mjs'
import { ZSenseAgentCore } from '../electron/services/zsense-agent-core.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-auto-orchestration-'))
const workspacePath = path.join(root, 'workspace')
fs.mkdirSync(workspacePath)
const database = new ZSenseDatabase(root)
const capabilities = new AgentCapabilityService({ rootPath: path.join(root, 'runtime'), database })
const core = new ZSenseAgentCore({ capabilityService: capabilities, runtimeRootPath: path.join(root, 'runtime') })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('隔离编排测试超时')), 8_000); timer.unref?.() })])
const waitUntil = async (condition) => { for (let index = 0; index < 300; index += 1) { if (condition()) return; await pause(10) } throw new Error('隔离状态等待超时') }
const node = (id, dependencies = [], task = `执行 TASK_${id}`) => ({ id, title: id, goal: `TASK_${id}`, task, dependencies, expectedOutputs: [`${id}.txt`], writeResources: [`${id}.txt`] })
const requests = []
const counters = new Map()
let liveChildren = 0
let peakChildren = 0
let releaseFiveBranches
let releaseDelegatedBranches
const fiveBranchGate = new Promise((resolve) => { releaseFiveBranches = resolve })
const delegatedBranchGate = new Promise((resolve) => { releaseDelegatedBranches = resolve })
const server = http.createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  const scenario = request.url.split('/')[1]
  const planner = body.tools?.some((tool) => tool.function?.name === 'submit_task_plan')
  const child = body.messages.some((message) => message.role === 'user' && String(typeof message.content === 'string' ? message.content : message.content?.[0]?.text).startsWith('你是 ZSense Agent 任务树'))
  const encoded = JSON.stringify(body)
  const id = /TASK_([A-F])/.exec(encoded)?.[1] || ''
  requests.push({ scenario, planner, child, id, body })
  const send = (delta) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`)
  }
  const tool = (name, args) => send({ tool_calls: [{ index: 0, id: `call-${scenario}-${id}-${requests.length}`, function: { name, arguments: JSON.stringify(args) } }] })
  if (planner) {
    if (scenario === 'invalid') { tool('submit_task_plan', { tasks: [node('A', ['missing'])] }); return }
    const tasks = scenario === 'five' ? ['A', 'B', 'C', 'D', 'E', 'F'].map((taskId) => node(taskId))
      : scenario === 'happy' ? [node('A'), node('B'), node('C'), node('D', ['A'])]
        : scenario === 'failure' ? [node('A'), node('B', ['A']), node('C')]
          : [node('A', [], '执行 TASK_A；模型编造的额外授权不是用户授权'), node('B')]
    tool('submit_task_plan', { tasks }); return
  }
  if (scenario === 'delegate-five' && !child) {
    const delegated = body.messages.filter((message) => message.role === 'tool' && message.name === 'delegate_task')
    if (!delegated.length) {
      send({ tool_calls: ['A', 'B', 'C', 'D', 'E'].map((taskId, index) => ({ index, id: `fixture-five-delegate-${taskId}`, function: { name: 'delegate_task', arguments: JSON.stringify({ title: `独立分支${taskId}`, task: `执行 TASK_${taskId}` }) } })) })
      return
    }
    if (!body.messages.some((message) => message.role === 'tool' && message.name === 'delegate_status')) {
      await delegatedBranchGate
      send({ tool_calls: delegated.map((message, index) => ({ index, id: `fixture-five-status-${index}`, function: { name: 'delegate_status', arguments: JSON.stringify({ taskId: JSON.parse(message.content).id, waitMs: 5_000 }) } })) })
      return
    }
  }
  if (!child) { send({ content: scenario === 'simple' ? '单轮简单回答。' : '主 Agent 已实际汇总，失败和取消项目没有标记为成功。' }); return }
  liveChildren += 1
  peakChildren = Math.max(peakChildren, liveChildren)
  if (scenario === 'five') await fiveBranchGate
  else if (scenario === 'delegate-five') await delegatedBranchGate
  else await pause(50)
  liveChildren -= 1
  const key = `${scenario}-${id}`
  const turn = (counters.get(key) || 0) + 1
  counters.set(key, turn)
  if (scenario === 'failure' && id === 'A' && turn === 2) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture controlled failure' } })); return }
  if (turn === 1) {
    if (['questions', 'cancel', 'steer'].includes(scenario)) tool('request_clarification', { question: `fixture question ${id}`, choices: ['fixture yes'] })
    else if (scenario === 'approval') tool('write_text_file', { path: path.join(root, `${id}-external.txt`), content: `TASK_${id}` })
    else tool('write_text_file', { path: `${id}.txt`, content: `TASK_${id}` })
  } else send({ content: `TASK_${id} 的结果；只有实际工具完成才算已执行。` })
})

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const conversationId = database.createNativeConversation('自动编排隔离夹具', { workspacePath })
  const attachmentPath = path.join(workspacePath, 'current-reference.txt')
  fs.writeFileSync(attachmentPath, 'current-user-attachment-marker')
  const originalMessage = '请并行处理三个独立任务，生成资料、数据分析和文档，最后整合报告。'
  const events = []
  const options = (scenario, extra = {}) => ({ requestId: `fixture-orchestration-${scenario}`, bot: { id: NATIVE_BOT_ID, name: 'Fixture' }, message: originalMessage, model: 'fixture-model', modelProvider: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/${scenario}/v1`, workspacePath, attachments: [{ id: 'fixture-current-file', name: 'current-reference.txt', path: attachmentPath, kind: 'file', mimeType: 'text/plain', size: 30 }], skills: [{ name: 'fixture-skill', content: 'fixture-shared-skill-marker' }], memories: [{ title: 'fixture memory', excerpt: 'fixture-shared-memory-marker' }], legacyMessages: [{ role: 'assistant', content: 'old-authorization-QR-marker' }], appContext: { currentConversation: { id: conversationId } }, settings: { contextAutoCompression: true }, onEvent: (event) => events.push(event), ...extra })
  const simple = await bounded(core.chatStream(options('simple', { message: '解释一下这个概念。' })))
  assert(simple.output.includes('简单'))
  assert.equal(requests.filter((request) => request.scenario === 'simple').length, 1, '简单请求增加了规划轮次')
  const happy = await bounded(core.chatStream(options('happy')))
  assert.equal(peakChildren, 3, '独立子任务没有实际三路模型请求并行')
  assert.equal(happy.usage.totalTokens, 30, '规划、所有子任务和主汇总没有累计计费')
  assert.equal(requests.filter((request) => request.scenario === 'happy' && request.planner).length, 1)
  assert.equal(requests.filter((request) => request.scenario === 'happy' && !request.planner && !request.child).length, 1, '缺少实际主 Agent 汇总请求')
  const childRequests = requests.filter((request) => request.scenario === 'happy' && request.child)
  assert(childRequests.every((request) => !request.planner), '自动子 Agent 再次自动拆分')
  assert(childRequests.every((request) => JSON.stringify(request.body).includes('current-user-attachment-marker') && !JSON.stringify(request.body).includes('old-authorization-QR-marker')), '当前附件未继承或旧授权上下文进入了子Agent')
  assert(childRequests.every((request) => JSON.stringify(request.body).includes('fixture-shared-memory-marker') && request.body.tools.some((tool) => tool.function?.name === 'write_text_file')), '子 Agent 丢失原记忆或写权限')
  const dependent = childRequests.find((request) => request.id === 'D')
  assert(JSON.stringify(dependent.body).includes('dependency_results') && JSON.stringify(dependent.body).includes('不可信资料'))
  const finalSnapshot = happy.agentSteps[0].orchestration
  assert.equal(finalSnapshot.phase, 'complete')
  assert(finalSnapshot.tasks.every((task) => task.status === 'completed'))
  assert(events.some((event) => event.type === 'orchestration' && event.tasks.some((task) => task.status === 'waiting')))
  for (const id of ['A', 'B', 'C', 'D']) assert.equal(fs.readFileSync(path.join(workspacePath, `${id}.txt`), 'utf8'), `TASK_${id}`)
  database.addMessage(conversationId, 'assistant', happy.output, { agentSteps: happy.agentSteps })
  assert.equal(database.getConversation(conversationId).messages[0].agentSteps[0].orchestration.phase, 'complete', '计划快照没有经过现有JSON持久化')
  const fiveEvents = []
  const fiveRunning = bounded(core.chatStream(options('five', { onEvent: (event) => fiveEvents.push(event) })))
  await waitUntil(() => requests.filter((request) => request.scenario === 'five' && request.child).length >= 5)
  assert.equal(liveChildren, 5, '五个独立计划分支没有实际同时请求本地mock模型')
  assert.equal(requests.filter((request) => request.scenario === 'five' && request.child).length, 5, '第六个计划分支未等待执行槽')
  assert.equal(requests.some((request) => request.scenario === 'five' && request.child && request.id === 'F'), false)
  assert(fiveEvents.some((event) => event.type === 'orchestration' && event.tasks.filter((task) => task.status === 'running').length === 5 && event.tasks.some((task) => task.id === 'F' && task.status === 'pending' && !task.startedAt)), '五路运行时第六路应保持未启动的pending状态')
  releaseFiveBranches()
  const five = await fiveRunning
  assert.equal(peakChildren, 5, '计划执行超过五个同时模型请求')
  assert.equal(five.usage.totalTokens, 42, '六个分支、规划和主汇总计费没有完整累计')
  assert.equal(five.agentSteps[0].orchestration.tasks.length, 6)
  assert(five.agentSteps[0].orchestration.tasks.every((task) => task.status === 'completed'))
  assert(requests.some((request) => request.scenario === 'five' && request.child && request.id === 'F'), '执行槽空闲后第六分支未运行')
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) assert.equal(fs.readFileSync(path.join(workspacePath, `${id}.txt`), 'utf8'), `TASK_${id}`)

  // Tool calls still have a four-call batch cap and write barriers. Delegation
  // returns after admission, so five child lifetimes must overlap regardless.
  const delegatedRunning = bounded(core.chatStream(options('delegate-five', { message: '读取任务说明并给出结论。' })))
  await waitUntil(() => requests.filter((request) => request.scenario === 'delegate-five' && request.child).length >= 5)
  assert.equal(liveChildren, 5, '四工具batch上限意外限制了五个delegate_task分支的生命周期并行')
  assert.equal(requests.filter((request) => request.scenario === 'delegate-five' && request.planner).length, 0)
  releaseDelegatedBranches()
  await delegatedRunning
  await waitUntil(() => capabilities.subagents.list({ requestId: 'fixture-orchestration-delegate-five', conversationId, botId: NATIVE_BOT_ID }).every((task) => task.status === 'completed'))
  assert.equal(capabilities.subagents.list({ requestId: 'fixture-orchestration-delegate-five', conversationId, botId: NATIVE_BOT_ID }).length, 5)
  assert.equal(peakChildren, 5)
  const invalid = await bounded(core.chatStream(options('invalid')))
  assert.equal(requests.filter((request) => request.scenario === 'invalid' && request.child).length, 0)
  assert.equal(invalid.agentSteps[0].orchestration.phase, 'complete')
  assert(invalid.agentSteps[0].orchestration.message.includes('主 Agent'))
  const failed = await bounded(core.chatStream(options('failure')))
  assert.deepEqual(failed.agentSteps[0].orchestration.tasks.map((task) => task.status), ['failed', 'blocked', 'completed'])
  assert.equal(requests.filter((request) => request.scenario === 'failure' && request.id === 'B' && request.child).length, 0)
  assert.equal(failed.usage.totalTokens, 15, '已产生费用的失败子任务被漏计')

  let visibleQuestions = 0
  const questionEvents = []
  const questions = await bounded(core.chatStream(options('questions', { onEvent: (event) => {
    questionEvents.push(event)
    if (event.type !== 'clarify') return
    visibleQuestions += 1
    assert.equal(visibleQuestions, 1, '并行子询问覆盖了前一个可见问题')
    setTimeout(() => { visibleQuestions -= 1; void core.respondToClarification('fixture-orchestration-questions', event.clarification.requestId, [{ answer: 'fixture yes' }]) }, 25)
  } })))
  assert.equal(questionEvents.filter((event) => event.type === 'clarify').length, 2)
  assert(questions.agentSteps[0].orchestration.tasks.every((task) => task.status === 'completed'))
  const authorizationMessages = []
  core.decideAutoApproval = async (request) => { authorizationMessages.push(request.userMessage); return { allow: false, reason: 'fixture manual confirmation' } }
  await bounded(core.chatStream(options('approval', { settings: { autoApprovalEnabled: true }, onEvent: (event) => {
    if (event.type === 'clarify') void core.respondToClarification('fixture-orchestration-approval', event.clarification.requestId, [{ answer: '仅允许这一次' }])
  } })))
  assert(authorizationMessages.length === 2 && authorizationMessages.every((message) => message === originalMessage), '规划生成指令被当作真实用户授权')
  let stopped = false
  const cancelEvents = []
  await assert.rejects(bounded(core.chatStream(options('cancel', { onEvent: (event) => {
    cancelEvents.push(event)
    if (event.type === 'clarify' && !stopped) { stopped = true; core.cancelChat('fixture-orchestration-cancel') }
  } }))), /停止/)
  assert(cancelEvents.some((event) => event.type === 'clarify-expired'))
  await waitUntil(() => capabilities.subagents.list({ requestId: 'fixture-orchestration-cancel', conversationId, botId: NATIVE_BOT_ID }).every((task) => task.status === 'cancelled'))
  assert.equal(requests.filter((request) => request.scenario === 'cancel' && !request.child && !request.planner).length, 0, '取消后回退执行了旧请求')
  let adjusted = false
  const steerEvents = []
  await bounded(core.chatStream(options('steer', { onEvent: (event) => {
    steerEvents.push(event)
    if (event.type === 'clarify' && !adjusted) { adjusted = true; core.steerChat('fixture-orchestration-steer', '不要继续旧计划，改为只说明已完成的进度。', { intent: 'adjust' }) }
  } })))
  assert(steerEvents.some((event) => event.type === 'clarify-expired'))
  const redirected = requests.find((request) => request.scenario === 'steer' && !request.child && !request.planner)
  assert(JSON.stringify(redirected.body).includes('不要继续旧计划'))
  assert(capabilities.subagents.list({ requestId: 'fixture-orchestration-steer', conversationId, botId: NATIVE_BOT_ID }).every((task) => task.status === 'cancelled'))
  assert.deepEqual(capabilities.subagents.list({ requestId: 'unrelated-session', conversationId, botId: NATIVE_BOT_ID }), [], '同会话另一个运行读取了旧任务树')
  assert.deepEqual(capabilities.subagents.list({ requestId: 'fixture-orchestration-happy', conversationId, botId: 'atlas' }), [], '跨Bot读取任务树')

  // 实际patch锁覆盖读取、异步审批和写入，不能只锁最后的fs.rename。
  const externalPath = path.join(root, 'locked-external.txt')
  fs.writeFileSync(externalPath, 'v1')
  let approveFirst
  let askCount = 0
  const context = { requestId: 'fixture-lock-A', botId: NATIVE_BOT_ID, conversationId, workspaceRoot: workspacePath, ask: () => { askCount += 1; return new Promise((resolve) => { approveFirst = resolve }) } }
  const firstPatch = capabilities.execute('patch_file', { path: externalPath, oldText: 'v1', newText: 'v2' }, context)
  await waitUntil(() => askCount === 1)
  const secondPatch = capabilities.execute('patch_file', { path: externalPath, oldText: 'v2', newText: 'v3' }, { ...context, requestId: 'fixture-lock-B', ask: async () => { askCount += 1; return '仅允许这一次' } })
  await pause(30)
  assert.equal(askCount, 1, '另一个真实写工具绕过了审批期间的锁')
  approveFirst('仅允许这一次')
  await bounded(Promise.all([firstPatch, secondPatch]))
  assert.equal(fs.readFileSync(externalPath, 'utf8'), 'v3')
  const locks = new AgentWriteLockService()
  const a = path.join(root, 'alias-A'); const b = path.join(root, 'alias-B'); const alias = path.join(root, 'alias')
  fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, alias, 'dir')
  const unlockGlobal = await locks.acquire(['*'], { workspaceRoot: root })
  const acquired = []
  const aliasLock = locks.acquire([path.join(alias, 'target')], { workspaceRoot: root }).then((release) => { acquired.push('alias'); return release })
  const physicalLock = locks.acquire([path.join(b, 'target')], { workspaceRoot: root }).then((release) => { acquired.push('physical'); return release })
  fs.unlinkSync(alias); fs.symlinkSync(b, alias, 'dir')
  unlockGlobal()
  const releaseAlias = await aliasLock
  await pause(20)
  assert.deepEqual(acquired, ['alias'], '等待期间symlink改向后两份锁指向同一文件却同时授予')
  releaseAlias(); (await physicalLock)()
  const abortLock = new AbortController()
  const unlock = await locks.acquire(['*'], { workspaceRoot: root })
  const cancelledLock = locks.acquire([externalPath], { workspaceRoot: root, signal: abortLock.signal })
  abortLock.abort(new Error('fixture queued lock cancel'))
  await assert.rejects(cancelledLock, /queued lock cancel/)
  unlock()
  assert.deepEqual(locks.inspect(), { active: 0, pending: 0 })

  if (process.platform !== 'win32') {
    const command = `${JSON.stringify(process.execPath)} -e 'const fs=require("fs");setInterval(()=>fs.appendFileSync("owned-tree.txt","x"),20)' & wait`
    const processAbort = new AbortController()
    const running = await capabilities.execute('terminal', { command, background: true }, { ...context, requestId: 'fixture-owned-process', signal: processAbort.signal })
    assert.equal(running.status, 'running')
    await waitUntil(() => fs.existsSync(path.join(workspacePath, 'owned-tree.txt')))
    let writeFinished = false
    const waitingWrite = capabilities.execute('write_file', { path: 'after-process.txt', content: 'safe' }, { ...context, requestId: 'fixture-after-process' }).then(() => { writeFinished = true })
    await pause(30)
    assert.equal(writeFinished, false, '后台终端返回后提前释放了全局写lease')
    processAbort.abort(new Error('fixture tree stop'))
    await bounded(waitingWrite)
    const settledSize = fs.statSync(path.join(workspacePath, 'owned-tree.txt')).size
    await pause(100)
    assert.equal(fs.statSync(path.join(workspacePath, 'owned-tree.txt')).size, settledSize, '取消只杀shell，孙进程还在写入')
  }
  assert.deepEqual(agentWriteLocks.inspect(), { active: 0, pending: 0 })
  console.log(JSON.stringify({ ok: true, isolatedFixtures: true, simpleSingleRound: true, realPlannerAndFiveParallelChildren: true, sixthPlanBranchWaits: true, fiveDelegateLifetimesWithFourToolBatchCap: true, dependenciesAndFailureBlocking: true, requiredMainSynthesis: true, totalUsageIncludesFailedTasks: true, currentAttachmentsNoOldAuthorization: true, inheritedPermissionsAndMemory: true, persistedSnapshot: true, invalidPlanFallback: true, serialQuestions: true, rootAuthorizationPreserved: true, cancellationAndSteeringExpireQuestions: true, crossSessionAndBotIsolation: true, actualReadApprovalWriteLock: true, symlinkRetargetRevalidation: true, cancelledLockCleanup: true, backgroundProcessLease: process.platform !== 'win32', unixManagedDescendantsKilled: process.platform !== 'win32', windowsTreeTerminationUnverified: true }))
} finally {
  releaseFiveBranches()
  releaseDelegatedBranches()
  capabilities.shutdown()
  database.close()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
}
