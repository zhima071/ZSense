import assert from 'node:assert/strict'
import { DeviceTaskRunner } from '../electron/services/device-task-runner.mjs'

const PEER = { deviceId: 'device-b', name: 'Windows-B', platform: 'win32' }

function fakeDatabase({ model = 'test-model', provider = 'custom', defaultWorkspacePath = '/tmp/zsense-device-workspace' } = {}) {
  const state = { conversations: [], messages: [] }
  return {
    state,
    get memoryService() { return this },
    loadWorkspace() {
      return {
        modelConfiguration: { provider, model, baseUrl: 'https://example.com/v1', contextWindow: 32_000 },
        settings: { memoryRecallLimit: 12, defaultWorkspacePath },
        bots: [{ id: '__zsense_native__', name: 'AI 对话', status: 'online' }],
        skills: [
          { id: 'private-skill', name: '其他 Bot 的私有技能', assignedBotIds: ['bot-1'] },
          { id: 'native-skill', name: '本机对话技能', assignedBotIds: ['__zsense_native__'] },
        ],
      }
    },
    recallMemories() { return { memories: [{ id: 'memory-1', title: '偏好', excerpt: '简洁', type: 'preference' }] } },
    createNativeConversation(title, options) {
      const id = `conversation-${state.conversations.length + 1}`
      state.conversations.push({ id, title, options })
      return id
    },
    addMessage(conversationId, role, content, extra = {}) { state.messages.push({ conversationId, role, content, extra }) },
    setConversationRuntimeSession(conversationId, engine, sessionId) { state.runtimeSession = { conversationId, engine, sessionId } },
    updateConversationOptions(conversationId, botId, options) { state.usage = options.usage },
    completeNativeConversation(conversationId) { state.completed = conversationId },
  }
}

function fakeAgentCore({ output = '任务已完成', approvals = 0, usage = { inputTokens: 12, outputTokens: 34 } } = {}) {
  return {
    calls: [],
    supportsProvider: (provider) => provider !== 'unsupported',
    requiresApiKey: (provider) => provider !== 'custom',
    async inspect() { return { runnable: true, message: '就绪' } },
    async chatStream(request) {
      this.calls.push(request)
      for (let index = 0; index < approvals; index += 1) {
        await request.approvalHandler('是否允许？', ['允许', '拒绝'], { kind: 'approval', label: '执行终端命令', category: 'terminal' }).catch(() => undefined)
      }
      return { output, reasoning: '', agentSteps: [{ tool: 'read_file' }], sessionId: 'session-1', durationMs: 500, usage }
    },
  }
}

const secrets = { get: (scope) => (scope === 'model:custom' ? { apiKey: 'sk-test' } : {}) }
const notifications = []
const notify = (kind, title, body) => notifications.push({ kind, title, body })

// 正常执行：写入本机 AI 对话空间、记录双方消息并返回结构化结果。
const database = fakeDatabase()
const agentCore = fakeAgentCore()
const runner = new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database, agentCore, secrets, notify })
const result = await runner.run({ prompt: '整理下载目录里的 PDF', peer: PEER })
assert.equal(result.output, '任务已完成')
assert.equal(result.conversationId, database.state.conversations[0].id)
assert.equal(database.state.conversations[0].title, '远程任务 · Windows-B')
assert.equal(database.state.conversations[0].options.channelId, 'device-link')
assert.equal(database.state.conversations[0].options.runtimeEngine, 'zsense-core')
assert.equal(database.state.completed, result.conversationId)
assert.equal(database.state.messages.length, 2, '应该记录请求与回复两条消息')
assert.equal(database.state.messages[0].role, 'user')
assert(database.state.messages[0].content.includes('【来自设备 Windows-B】'), '请求消息应标注来源设备')
assert.equal(database.state.messages[1].role, 'assistant')
assert.equal(result.model, 'test-model')
assert.equal(result.modelProvider, 'custom')
assert.equal(result.durationMs, 500)
assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 34 })
assert.equal(result.toolCalls, 1)
assert.equal(result.refusedOperations, 0)
assert.equal(agentCore.calls[0].message, '整理下载目录里的 PDF')
assert.equal(agentCore.calls[0].workspacePath, '/tmp/zsense-device-workspace', '远程任务应使用本机默认工作区')
assert.equal(agentCore.calls[0].memories.length, 1, '应该召回本机记忆')
assert.equal(agentCore.calls[0].skills.length, 1, '应该带上共享技能')
assert.equal(agentCore.calls[0].skills[0].id, 'native-skill', '远程任务不得载入其他 Bot 的私有技能')
assert.equal(agentCore.calls[0].appContext.remoteDevice.deviceId, PEER.deviceId)
assert(!agentCore.calls[0].appContext.automation, '远程任务不应被标记为后台自治任务')
assert.equal(notifications.at(-1).kind, 'completion', '执行完成应该给出本机通知')

// 需要审批的操作被拒绝，并计入 refusedOperations。
const approvalDatabase = fakeDatabase()
const approvalCore = fakeAgentCore({ output: '已跳过危险操作', approvals: 2 })
const approvalRunner = new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database: approvalDatabase, agentCore: approvalCore, secrets, notify })
const approvalResult = await approvalRunner.run({ prompt: '删除工作区里的文件', peer: PEER })
assert.equal(approvalResult.refusedOperations, 2, '每次审批都应被拒绝并计数')
assert.equal(approvalResult.output, '已跳过危险操作')

// 未配置模型、供应商不支持、缺少 API Key 时应直接失败。
await assert.rejects(() => new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database: fakeDatabase({ model: '' }), agentCore: fakeAgentCore(), secrets, notify }).run({ prompt: '你好', peer: PEER }), /还没有配置默认模型/)
await assert.rejects(() => new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database: fakeDatabase({ provider: 'unsupported' }), agentCore: fakeAgentCore(), secrets, notify }).run({ prompt: '你好', peer: PEER }), /暂不支持/)
await assert.rejects(() => new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database: fakeDatabase({ provider: 'openai' }), agentCore: fakeAgentCore(), secrets, notify }).run({ prompt: '你好', peer: PEER }), /API Key 尚未配置/)
await assert.rejects(() => runner.run({ prompt: '   ', peer: PEER }), /远程任务内容不能为空/)

// 同一台设备同时只能执行一条远程任务。
const busyRunner = new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database: fakeDatabase(), agentCore: fakeAgentCore(), secrets, notify })
const first = busyRunner.run({ prompt: '第一条任务', peer: PEER })
await assert.rejects(() => busyRunner.run({ prompt: '第二条任务', peer: PEER }), /已经有一条远程任务正在本机执行/)
await first
assert.equal(busyRunner.inspect().running, 0, '任务结束后不应残留运行状态')

// 失败时也要写入本机记录并通知。
const failureCore = fakeAgentCore()
failureCore.chatStream = async () => { throw new Error('模型服务不可用') }
const failureDatabase = fakeDatabase()
const failureRunner = new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database: failureDatabase, agentCore: failureCore, secrets, notify })
await assert.rejects(() => failureRunner.run({ prompt: '会失败的任务', peer: PEER }), /模型服务不可用/)
assert.equal(failureDatabase.state.messages.at(-1).role, 'system', '失败时应该留下系统记录')
assert.match(failureDatabase.state.messages.at(-1).content, /远程任务失败/, '系统记录应说明失败原因')

// 请求超时必须真正取消内核执行，而不只是让发起方停止等待。
let cancelRemoteRun
const slowCore = fakeAgentCore()
slowCore.chatStream = async () => await new Promise((_, reject) => { cancelRemoteRun = reject })
slowCore.cancelChat = () => { cancelRemoteRun?.(new Error('cancelled')); return true }
const timeoutRunner = new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database: fakeDatabase(), agentCore: slowCore, secrets, notify })
await assert.rejects(() => timeoutRunner.run({ prompt: '测试超时', peer: PEER, timeoutMs: 10_000 }), /超过 10 秒，已终止/)
assert.equal(timeoutRunner.inspect().running, 0, '超时后不得残留运行状态')

// 接收方撤销授权时，运行中的请求必须取消；即使模型忽略取消并返回，也不能记为成功。
const revokedDatabase = fakeDatabase()
let resolveRevokedRun
let revokedRequestId = ''
const revokedCore = fakeAgentCore()
revokedCore.chatStream = async () => await new Promise((resolve) => { resolveRevokedRun = resolve })
revokedCore.cancelChat = (requestId) => { revokedRequestId = requestId; return true }
const revokedRunner = new DeviceTaskRunner({ rootPath: '/tmp/zsense-device-root', database: revokedDatabase, agentCore: revokedCore, secrets, notify })
const revokedRun = revokedRunner.run({ prompt: '撤销中的任务', peer: PEER })
for (let attempt = 0; attempt < 20 && !resolveRevokedRun; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1))
assert(resolveRevokedRun, '测试任务应已进入模型请求')
assert.equal(revokedRunner.cancelPeer(PEER.deviceId), true)
assert.match(revokedRequestId, /^device-link-/)
resolveRevokedRun({ output: '本不应成功的结果', sessionId: 'revoked-session' })
await assert.rejects(() => revokedRun, /已取消/)
assert.equal(revokedDatabase.state.messages.at(-1).role, 'system', '撤销任务应记录为失败，不得记为回复')
assert.equal(revokedRunner.inspect().running, 0)

console.log(JSON.stringify({
  ok: true,
  engine: 'device-task-runner',
  nativeWorkspaceRecording: true,
  remoteContextIsolation: true,
  approvalsRefused: true,
  configurationGuards: true,
  singleFlightPerPeer: true,
  failureRecorded: true,
}))
