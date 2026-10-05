import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { OfficeTaskService } from '../electron/services/office-task-service.mjs'
import { ZSenseGatewayService } from '../electron/services/zsense-gateway-service.mjs'

const root = mkdtempSync(path.join(tmpdir(), 'zsense-office-tasks-'))
let database
try {
  database = new ZSenseDatabase(root)
  database.memoryService = {
    recallMemories: (botId, query, options) => database.recallMemories(botId, query, options),
    retainUserMessage: async () => ({ stored: false }),
  }
  const atlas = database.loadWorkspace().bots.find((bot) => bot.id === 'atlas')
  assert(atlas)
  database.createBot({ ...atlas, id: 'other', name: 'Other', initials: 'OT', memories: [], memoryCount: 0, memorySize: '0 KB', conversations: 0, channels: ['web'] })
  const conversationId = database.createConversation('atlas', '检查报价单', { workspacePath: root })
  const otherConversationId = database.createConversation('other', '其它 Bot', { workspacePath: root })
  const service = new OfficeTaskService({ database })
  const task = service.create({ botId: 'atlas', conversationId, sourceChannel: 'dingtalk', sourceConnectionId: 'ding-1', sourceMessageId: 'msg-1', title: '检查报价单', request: '读取报价单', reviewRequired: true })
  assert.equal(service.create({ botId: 'atlas', conversationId, sourceChannel: 'dingtalk', sourceConnectionId: 'ding-1', sourceMessageId: 'msg-1', title: '重复', request: '重复' }).id, task.id)
  assert.throws(() => service.create({ botId: 'other', conversationId, title: '越权', request: '越权' }), /不属于/)
  service.recordTool(task.id, { type: 'tool', toolId: 'tool-1', name: 'read_pdf', status: 'complete', input: JSON.stringify({ path: 'report.pdf', startPage: 2, endPage: 3 }) })
  assert(service.get(task.id).evidence.some((item) => item.page === 2))
  service.addSearchDocument({ botId: 'atlas', taskId: task.id, sourceType: 'answer', sourceId: 'msg-1', title: '报价单', body: '葡萄牙语说明书包含产品规格和价格。' })
  assert.equal(service.search({ botId: 'atlas', query: '产品规格' }).length, 1)
  assert.equal(service.search({ botId: 'other', query: '产品规格' }).length, 0)
  const filePath = path.join(root, 'notes.txt')
  writeFileSync(filePath, '当前合同需要人工审核。')
  await service.indexFile({ botId: 'atlas', taskId: task.id, filePath, workspacePath: root })
  assert.equal(service.search({ botId: 'atlas', query: '人工审核' }).length, 1)
  assert.equal(await service.indexFile({ botId: 'atlas', taskId: task.id, filePath, workspacePath: root }) !== null, true)
  const other = service.create({ botId: 'other', conversationId: otherConversationId, title: '普通任务', request: '搜索' })
  assert.equal(service.list({ botId: 'atlas' }).length, 1)
  assert.equal(service.list({ botId: 'other' })[0].id, other.id)
  database.updateModelConfiguration({ provider: 'custom', model: 'mock-model', baseUrl: 'http://127.0.0.1:1/v1', apiKeyName: 'MOCK_KEY', apiKeyConfigured: false, updatedAt: new Date().toISOString() })
  database.upsertGatewayConnection({ id: 'ding-office', provider: 'dingtalk', name: '钉钉办公', botId: 'atlas', profileName: 'office', status: 'connected', latency: '本地', messages: 0, configured: true, config: {}, secretKeys: [], secretScope: 'gateway:ding-office', updatedAt: new Date().toISOString() })
  const replies = []
  const sentFiles = []
  const outputPath = path.join(root, 'checked.csv')
  writeFileSync(outputPath, 'name,price\nexample,100\n')
  const gateway = new ZSenseGatewayService({
    database, officeTaskService: service, officeWorkspace: { discoverArtifacts: () => [{ name: 'checked.csv', path: outputPath }] }, userDataDirectory: root, secrets: { get: () => ({}) },
    agentCore: { requiresApiKey: () => false, extractMemories: async () => [], chatStream: async ({ onEvent }) => {
      onEvent({ type: 'tool', toolId: 'read-1', name: 'read_text_file', status: 'complete', detail: '已读文件' })
      return { output: '合同已核查，金额无误。', sessionId: 'zsense-core:test', durationMs: 1, agentSteps: [] }
    } },
  })
  const inbound = { connectionId: 'ding-office', userId: 'authorized-user', userName: '测试', chatId: 'chat-1', messageId: 'file-msg-1', text: '核查合同', attachmentDescriptors: [{ fileId: 'file-1', name: 'notes.txt' }], resolveAttachments: async () => ({ attachments: [{ name: 'notes.txt', path: filePath, kind: 'file' }], notes: [] }), reply: async (text) => { replies.push(text) }, sendFile: async (file) => { sentFiles.push(file); return { messageId: 'sent-file-1' } } }
  assert.equal((await gateway.receive(inbound)).reason, 'authorization-pending')
  gateway.approvePairing('ding-office', gateway.listPendingPairings('ding-office')[0].requestId)
  const accepted = await gateway.receive(inbound)
  assert.equal(accepted.accepted, true)
  assert.equal(replies.length, 1, '文件任务不应在审核前发送结果')
  const fileTask = service.list({ botId: 'atlas' }).find((item) => item.sourceMessageId === 'file-msg-1')
  assert.equal(fileTask.status, 'review')
  assert.equal(fileTask.evidence.find((item) => item.type === 'file')?.verified, true)
  await gateway.deliverOfficeTask(fileTask.id)
  assert.equal(service.get(fileTask.id).deliveryStatus, 'accepted')
  assert.deepEqual(sentFiles, [outputPath])
  assert(replies.at(-1).includes('合同已核查'))
  assert.equal((await gateway.receive(inbound)).reason, 'duplicate')
  service.patch(task.id, { status: 'delivering' })
  new OfficeTaskService({ database })
  assert.equal(service.get(task.id).status, 'interrupted')
  console.log('Office task smoke passed')
} finally {
  database?.close()
  rmSync(root, { recursive: true, force: true })
}
