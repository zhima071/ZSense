import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentCapabilityService } from '../electron/services/agent-capability-service.mjs'
import { AutonomyRunner } from '../electron/services/autonomy-runner.mjs'

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-autonomy-'))
const workspacePath = path.join(temporaryDirectory, 'workspace')
fs.mkdirSync(workspacePath, { recursive: true })
const conversations = new Map()
const messages = []
const workspace = {
  bots: [{ id: 'atlas', name: 'Atlas', status: 'online', modelProvider: 'custom', model: 'test-model', prompt: '测试' }],
  nativeMemories: [],
  skills: [],
  settings: { defaultWorkspacePath: workspacePath, memoryRecallLimit: 8 },
  modelConfiguration: { provider: 'custom', model: 'test-model', baseUrl: 'http://127.0.0.1/test' },
  availableModelConfigurations: [{ provider: 'custom', model: 'test-model', baseUrl: 'http://127.0.0.1/test' }],
}
const database = {
  loadWorkspace: () => workspace,
  loadSettings: () => workspace.settings,
  getBot: (id) => workspace.bots.find((item) => item.id === id) || null,
  getConversation: (id) => conversations.get(id) || null,
  createConversation: (botId, title, options) => {
    const id = `conversation-${conversations.size + 1}`
    conversations.set(id, { id, botId, title, messages: [], ...options })
    return id
  },
  createNativeConversation: () => { throw new Error('not used') },
  recallMemories: () => ({ memories: [] }),
  setConversationRuntimeSession: (id, _engine, runtimeSessionId) => { conversations.get(id).runtimeSessionId = runtimeSessionId },
  addMessage: (conversationId, role, content, metadata = {}) => { messages.push({ conversationId, role, content, ...metadata }) },
}
database.memoryService = database
const browserService = { shutdown: () => {} }
const capabilityService = new AgentCapabilityService({ rootPath: path.join(temporaryDirectory, 'data'), database, browserService })
let goalId = ''
const agentCore = {
  requiresApiKey: () => false,
  chatStream: async ({ appContext }) => {
    if (appContext.automation.kind === 'goal') {
      capabilityService.updateAutonomyItem('goal', goalId, { status: 'completed', enabled: false, statusNote: '已达到成功条件。' })
      return { output: '目标已经完成。', reasoning: '', sessionId: 'zsense-core:test', durationMs: 12, usage: { outputTokens: 4 } }
    }
    if (appContext.automation.kind === 'heartbeat') return { output: 'NO_CHANGE', reasoning: '', sessionId: 'zsense-core:test-heartbeat', durationMs: 8, usage: { outputTokens: 1 } }
    return { output: '循环任务完成一次。', reasoning: '', sessionId: 'zsense-core:test-loop', durationMs: 10, usage: { outputTokens: 4 } }
  },
}
const runner = new AutonomyRunner({ database, capabilityService, agentCore, secrets: { get: () => ({}) } })
const context = { botId: 'atlas', conversationId: '', workspaceRoot: workspacePath, modelProvider: 'custom', model: 'test-model', reasoningEffort: 'high' }

try {
  const goals = await capabilityService.execute('goal_manage', { action: 'create', objective: '完成迁移测试', successCriteria: '状态完成' }, context)
  goalId = goals[0].id
  capabilityService.manageAutonomy('goal', goalId, 'run')
  await runner.tick()
  const completedGoal = capabilityService.autonomySnapshot().goals[0]
  assert.equal(completedGoal.status, 'completed')
  assert.equal(completedGoal.iterationCount, 1)
  assert(completedGoal.lastRunAt, 'Goal 完成后没有记录最后运行时间')
  assert.equal(messages.some((item) => item.content === '目标已经完成。'), true)

  const heartbeats = await capabilityService.execute('heartbeat_manage', { action: 'create', prompt: '检查变化', intervalMinutes: 5 }, context)
  capabilityService.manageAutonomy('heartbeat', heartbeats[0].id, 'run')
  const messageCountBeforeHeartbeat = messages.length
  await runner.tick()
  const heartbeat = capabilityService.autonomySnapshot().heartbeats[0]
  assert.equal(messages.length, messageCountBeforeHeartbeat, 'NO_CHANGE 心跳不应写入普通消息或通知')
  assert.equal(heartbeat.lastOutput, 'NO_CHANGE')
  assert(Date.parse(heartbeat.nextRunAt) > Date.now())
  assert([...conversations.values()].every((item) => item.channelId === 'scheduled'))
  console.log(JSON.stringify({ ok: true, goalCompletion: true, heartbeatQuiet: true, persistedState: true, hiddenScheduledConversation: true }))
} finally {
  await runner.shutdown()
  capabilityService.shutdown()
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
