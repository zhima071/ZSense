import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { collectDingTalkContent, collectDwsDingTalkResources, createDingTalkEmotionController, createDingTalkReplyController, DINGTALK_EMOTION_NAMES, downloadDingTalkAttachments, downloadFeishuAttachments, GATEWAY_HEALTH_CHECK_INTERVAL_MS, normalizeDingTalkMarkdown, parseDwsAuthStatus, resolveDingTalkAttachmentsViaDws, stopDingTalkClient, ZSenseGatewayService } from '../electron/services/zsense-gateway-service.mjs'

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-gateway-'))
const database = new ZSenseDatabase(temporaryDirectory)
database.memoryService = {
  recallMemories: (botId, query, options) => database.recallMemories(botId, query, options),
  retainUserMessage: async () => ({ stored: false }),
}
const replies = []
const notifications = []
const coreCalls = []
const agentCore = {
  requiresApiKey: () => false,
  chatStream: async (request) => {
    coreCalls.push(request)
    request.onEvent({ type: 'started', sessionId: `zsense-core:${request.bot.id}` })
    return { output: `${request.bot.name} 已处理：${request.message}`, reasoning: '', sessionId: `zsense-core:${request.bot.id}`, durationMs: 25, usage: { contextUsed: 12, contextMax: 1000, contextPercent: 1.2, inputTokens: 8, outputTokens: 4, totalTokens: 12 } }
  },
  extractMemories: async () => [],
}
const secrets = { get: () => ({}) }
const service = new ZSenseGatewayService({ database, agentCore, secrets, userDataDirectory: temporaryDirectory, notify: (...args) => notifications.push(args) })
let restartedService = null

const connectingSocket = new EventEmitter()
connectingSocket.readyState = 0
let terminatedConnectingSocket = false
connectingSocket.terminate = () => { terminatedConnectingSocket = true }
connectingSocket.on('error', () => undefined)
const reconnectTimerId = setTimeout(() => undefined, 60_000)
const heartbeatIntervallId = setInterval(() => undefined, 60_000)
const connectingDingTalkClient = { socket: connectingSocket, userDisconnect: false, reconnecting: true, reconnectAttempts: 2, reconnectTimerId, heartbeatIntervallId, connected: false, registered: false }
stopDingTalkClient(connectingDingTalkClient)
assert.equal(terminatedConnectingSocket, true, '半连接状态的钉钉 WebSocket 没有停止')
assert.equal(connectingDingTalkClient.userDisconnect, true)
assert.equal(connectingSocket.listenerCount('error') > 0, true, '停止半连接 WebSocket 前不应移除错误监听器')
connectingSocket.emit('close')
assert.equal(connectingDingTalkClient.socket, undefined)

function connection(id, botId, name) {
  database.upsertGatewayConnection({
    id, provider: 'dingtalk', name, botId, profileName: `route-${botId}`, status: 'connected', latency: '长连接', messages: 0,
    configured: true, config: {}, secretKeys: [], secretScope: `gateway:${id}`, updatedAt: new Date().toISOString(),
  })
}

async function authorizeAndReceive(connectionId, messageId) {
  const reply = async (text) => replies.push({ connectionId, text })
  const pendingResult = await service.receive({ connectionId, userId: 'same-user', userName: '测试用户', chatId: 'same-chat', messageId: `${messageId}-pending`, text: '第一次消息', reply })
  assert.equal(pendingResult.reason, 'authorization-pending')
  const pending = service.listPendingPairings(connectionId)
  assert.equal(pending.length, 1)
  service.approvePairing(connectionId, pending[0].requestId)
  return service.receive({ connectionId, userId: 'same-user', userName: '测试用户', chatId: 'same-chat', messageId, text: '正式消息', reply })
}

try {
  const atlasBot = database.loadWorkspace().bots.find((bot) => bot.id === 'atlas')
  database.createBot({ ...atlasBot, id: 'scout', name: 'Scout', initials: 'SC', memories: [], memoryCount: 0, memorySize: '0 KB', conversations: 0, channels: ['web'] })
  database.updateModelConfiguration({ provider: 'custom', model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKeyName: 'CUSTOM_API_KEY', apiKeyConfigured: false, updatedAt: new Date().toISOString() })
  connection('ding-atlas', 'atlas', '钉钉机器人一')
  connection('ding-scout', 'scout', '钉钉机器人二')

  const atlas = await authorizeAndReceive('ding-atlas', 'message-atlas')
  const scout = await authorizeAndReceive('ding-scout', 'message-scout')
  assert.equal(atlas.accepted, true)
  assert.equal(scout.accepted, true)
  assert.notEqual(atlas.conversationId, scout.conversationId)
  assert.deepEqual(coreCalls.map((request) => request.bot.id), ['atlas', 'scout'])
  assert.equal(database.getConversation(atlas.conversationId)?.externalThreadId, 'ding-atlas:same-chat')
  assert.equal(database.getConversation(scout.conversationId)?.externalThreadId, 'ding-scout:same-chat')
  assert.equal(database.getConversation(atlas.conversationId)?.messages[0].externalMessageId, 'message-atlas')
  assert(replies.some((item) => item.text.includes('Atlas 已处理')))
  assert(replies.some((item) => item.text.includes('Scout 已处理')))
  assert.equal(notifications.filter((item) => item[0] === 'approval').length, 2)

  const duplicate = await service.receive({ connectionId: 'ding-atlas', userId: 'same-user', userName: '测试用户', chatId: 'same-chat', messageId: 'message-atlas', text: '正式消息' })
  assert.equal(duplicate.reason, 'duplicate')
  assert.equal(service.listApprovedPairings('ding-atlas')[0]?.userName, '测试用户')
  service.renameApprovedPairing('ding-atlas', 'same-user', '财务负责人')
  assert.equal(service.listApprovedPairings('ding-atlas')[0]?.userName, '财务负责人')

  const dingTalkPayload = {
    msgtype: 'text',
    text: { content: '请读取我引用的工作簿' },
    quotedMessage: { msgId: 'message-atlas', text: { content: '上次导出的类目表' }, content: { downloadCode: 'download-code-1', fileName: '类目表.xlsx' } },
  }
  const parsedDingTalk = collectDingTalkContent(dingTalkPayload)
  assert.equal(parsedDingTalk.text, '请读取我引用的工作簿')
  assert.equal(parsedDingTalk.quotedText, '上次导出的类目表')
  assert.equal(parsedDingTalk.descriptors[0]?.quoted, true)
  assert.deepEqual(parsedDingTalk.quotedMessageIds, ['message-atlas'])
  const directFilePayload = collectDingTalkContent({ msgtype: 'file', downloadCode: 'direct-file-code', fileName: '普通文件.pdf' })
  assert.equal(directFilePayload.descriptors[0]?.name, '普通文件.pdf', '钉钉普通文件消息没有被识别')
  const repliedFilePayload = collectDingTalkContent({
    msgtype: 'text',
    text: {
      content: '请读取引用文件',
      isReplyMsg: true,
      repliedMsg: { msgId: 'replied-file-message', content: { downloadCode: 'replied-file-code', fileName: '引用文件.docx' } },
    },
  })
  assert.equal(repliedFilePayload.descriptors[0]?.downloadCode, 'replied-file-code', 'text.repliedMsg 中的引用文件没有被识别')
  assert.equal(repliedFilePayload.descriptors[0]?.quoted, true)
  assert.deepEqual(repliedFilePayload.quotedMessageIds, ['replied-file-message'])
  const picturePayload = collectDingTalkContent({ content: { richText: [{ type: 'picture', pictureDownloadCode: 'picture-code' }] } })
  assert.equal(picturePayload.descriptors[0]?.downloadCode, 'picture-code', 'pictureDownloadCode 没有被识别')
  assert.equal(picturePayload.descriptors[0]?.mimeType, 'image/png')
  const quoteMessagePayload = collectDingTalkContent({ text: { content: '继续处理' }, quoteMessage: { msgId: 'quoted-message-id', text: { content: '引用正文' } } })
  assert.deepEqual(quoteMessagePayload.quotedMessageIds, ['quoted-message-id'])
  assert.equal(quoteMessagePayload.quotedText, '引用正文')
  const originalMessagePayload = collectDingTalkContent({ text: { content: '继续处理' }, originalMsgId: 'original-message-id' })
  assert.deepEqual(originalMessagePayload.quotedMessageIds, ['original-message-id'])
  const activeDws = parseDwsAuthStatus({ currentProfile: 'corp:user', profiles: [{ profile: 'corp:user', corpName: '测试企业', userName: '测试用户', status: 'active', isCurrent: true, expiresAt: '2099-01-01T00:00:00+08:00' }] })
  assert.equal(activeDws.authenticated, true, 'dws 当前账号没有被识别为已登录')
  assert.equal(activeDws.accountLabel, '测试企业 · 测试用户')
  const expiredDws = parseDwsAuthStatus({ currentProfile: 'corp:user', profiles: [{ profile: 'corp:user', status: 'expired', isCurrent: true }] })
  assert.equal(expiredDws.state, 'expired', 'dws 过期登录没有触发重新授权状态')
  const dwsMessagePayload = {
    messages: [{
      openMessageId: 'current-dws-message', openConversationId: 'dws-group',
      resourceRefs: [{ fileName: '截图.png', download: { arguments: { type: 'mediaId', 'resource-id': 'media-1', 'message-id': 'current-dws-message', 'open-conversation-id': 'dws-group' } } }],
      quotedMessage: {
        openMessageId: 'quoted-dws-message', openConversationId: 'dws-group', fileName: '引用报表.xlsx',
        resourceRefs: [{ download: { arguments: { type: 'fileId', 'resource-id': 'file-1', 'message-id': 'quoted-dws-message', 'open-conversation-id': 'dws-group' } } }],
      },
    }],
  }
  const dwsResources = collectDwsDingTalkResources(dwsMessagePayload)
  assert.equal(dwsResources.length, 2, 'resourceRefs 没有完整解析 mediaId 与 fileId')
  assert(dwsResources.some((item) => item.type === 'fileId' && item.quoted), 'quotedMessage 中的 fileId 没有标记为引用资源')
  const dwsDownloads = []
  const dwsDownloaded = await resolveDingTalkAttachmentsViaDws({
    workspacePath: temporaryDirectory, chatId: 'dws-group', messageId: 'current-dws-message', quotedMessageIds: ['quoted-dws-message'], rawMessage: {},
    runDws: async (args, options = {}) => {
      dwsDownloads.push(args)
      if (args.includes('+messages-mget')) return dwsMessagePayload
      const output = args[args.indexOf('--output') + 1]
      assert.equal(path.isAbsolute(output), false, 'dws --output 必须使用工作目录内的相对路径')
      assert.equal(options.cwd, temporaryDirectory, 'dws 下载必须从当前会话工作区执行')
      const outputPath = path.resolve(options.cwd, output, args.includes('fileId') ? '引用文件.xlsx' : '引用图片.png')
      writeFileSync(outputPath, args.includes('fileId') ? 'mock file bytes' : 'mock media bytes')
      return { success: true, data: { localPath: path.relative(options.cwd, outputPath) } }
    },
  })
  assert.equal(dwsDownloaded.attachments.length, 2, 'dws 没有把引用文件和媒体下载到会话工作区')
  assert(dwsDownloads.some((args) => args.includes('+messages-mget')), '没有优先按消息 ID 拉取原始钉钉消息')
  assert(dwsDownloads.some((args) => args.includes('+messages-resource-download') && args.includes('fileId')), 'fileId 没有走 dws 资源下载命令')
  assert(dwsDownloads.some((args) => args.includes('+messages-resource-download') && args.includes('mediaId')), 'mediaId 没有走 dws 资源下载命令')
  assert(dwsDownloaded.attachments.every((item) => item.path.includes(`${path.sep}.zsense${path.sep}attachments${path.sep}`)), 'dws 文件没有保存到当前会话工作区')
  const downloaded = await downloadDingTalkAttachments({ getAccessToken: async () => 'test-access-token' }, 'robot-code', parsedDingTalk.descriptors, temporaryDirectory, {
    fetchImpl: async (input, init) => {
      if (String(input).includes('/robot/messageFiles/download')) {
        assert.equal(init.headers['x-acs-dingtalk-access-token'], 'test-access-token')
        assert.deepEqual(JSON.parse(init.body), { downloadCode: 'download-code-1', robotCode: 'robot-code' })
        return new Response(JSON.stringify({ downloadUrl: 'https://download.example.test/file.xlsx' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(Buffer.from('mock xlsx bytes'), { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
    },
  })
  assert.equal(downloaded.attachments.length, 1)
  assert.equal(existsSync(downloaded.attachments[0].path), true)
  assert.equal(readFileSync(downloaded.attachments[0].path, 'utf8'), 'mock xlsx bytes')
  const referencedFileResult = await service.receive({
    connectionId: 'ding-atlas', userId: 'same-user', userName: '测试用户', chatId: 'same-chat', messageId: 'message-with-quoted-file',
    text: parsedDingTalk.text, quotedText: parsedDingTalk.quotedText, attachmentDescriptors: parsedDingTalk.descriptors,
    resolveAttachments: async () => downloaded,
  })
  assert.equal(referencedFileResult.accepted, true)
  const referencedFileConversation = database.getConversation(referencedFileResult.conversationId)
  const referencedFileMessage = referencedFileConversation.messages.find((item) => item.externalMessageId === 'message-with-quoted-file')
  assert.equal(referencedFileMessage.attachments[0]?.name, '类目表.xlsx')
  assert(referencedFileMessage.content.includes('钉钉引用内容'))
  assert.equal(coreCalls.at(-1)?.attachments[0]?.name, '类目表.xlsx')

  const originalAttachmentPath = downloaded.attachments[0].path
  database.addMessage(referencedFileResult.conversationId, 'user', '原始文件消息', {
    externalMessageId: 'original-file-message',
    attachments: downloaded.attachments,
  })
  const restoredReferenceResult = await service.receive({
    connectionId: 'ding-atlas', userId: 'same-user', userName: '测试用户', chatId: 'same-chat', messageId: 'message-with-reference-id-only',
    text: '请继续读取刚才引用的文件', quotedMessageIds: ['original-file-message'],
  })
  assert.equal(restoredReferenceResult.accepted, true)
  const restoredReferenceMessage = database.getConversation(restoredReferenceResult.conversationId).messages.find((item) => item.externalMessageId === 'message-with-reference-id-only')
  assert.equal(restoredReferenceMessage.attachments[0]?.path, originalAttachmentPath)
  assert(restoredReferenceMessage.content.includes('已从当前会话的被引用消息恢复 1 个附件'))
  assert.equal(coreCalls.at(-1)?.attachments[0]?.path, originalAttachmentPath)

  const cacheSourceResult = await service.receive({
    connectionId: 'ding-atlas', userId: 'same-user', userName: '测试用户', chatId: 'same-chat', messageId: 'cached-direct-file-message',
    attachmentDescriptors: directFilePayload.descriptors,
    resolveAttachments: async () => ({ attachments: [], notes: ['模拟首次下载未落盘。'] }),
  })
  assert.equal(cacheSourceResult.accepted, true, '纯文件消息应在没有正文时仍触发 Agent')
  restartedService = new ZSenseGatewayService({ database, agentCore, secrets, userDataDirectory: temporaryDirectory })
  const cachedAttachmentPath = path.join(temporaryDirectory, 'cached-reference.pdf')
  writeFileSync(cachedAttachmentPath, 'cached pdf bytes')
  let cachedDescriptors = []
  const cachedReferenceResult = await restartedService.receive({
    connectionId: 'ding-atlas', userId: 'same-user', userName: '测试用户', chatId: 'same-chat', messageId: 'cached-reference-message',
    text: '读取刚才的文件', quotedMessageIds: ['cached-direct-file-message'],
    resolveAttachments: async (_workspacePath, descriptors) => {
      cachedDescriptors = descriptors
      return { attachments: [{ id: 'cached-pdf', name: '普通文件.pdf', path: cachedAttachmentPath, workspaceRelativePath: 'cached-reference.pdf', size: 16, mimeType: 'application/pdf', kind: 'file' }], notes: ['缓存附件已恢复。'] }
    },
  })
  assert.equal(cachedReferenceResult.accepted, true)
  assert.equal(cachedDescriptors[0]?.downloadCode, 'direct-file-code', '重启后没有从持久化索引恢复引用文件下载码')
  assert.equal(cachedDescriptors[0]?.quoted, true)
  const cachedReferenceMessage = database.getConversation(cachedReferenceResult.conversationId).messages.find((item) => item.externalMessageId === 'cached-reference-message')
  assert.equal(cachedReferenceMessage.attachments[0]?.name, '普通文件.pdf')
  assert(cachedReferenceMessage.content.includes('已从钉钉引用消息索引恢复 1 个附件下载信息'))

  assert.equal(normalizeDingTalkMarkdown('| 项目 | 状态 |\n| --- | --- |\n| 附件 | 已读取 |'), '项目 · 状态\n附件 · 已读取')
  const cardRequests = []
  const cardController = createDingTalkReplyController({
    client: { getAccessToken: async () => 'card-token' },
    robotCode: 'robot-code',
    message: { conversationType: '2', conversationId: 'group-id', senderStaffId: 'staff-id', sessionWebhook: 'https://webhook.example.test/reply' },
    templateId: 'template.schema',
    fetchImpl: async (input, init) => {
      cardRequests.push({ input: String(input), init, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ success: true, result: [{ success: true }] }), { status: 200 })
    },
  })
  await cardController.status('thinking', '已接收，正在思考…')
  await cardController.reply('**处理完成**')
  assert(cardRequests.some((item) => item.input.endsWith('/v1.0/card/instances') && item.init.method === 'POST' && item.body.cardTemplateId === 'template.schema'))
  assert(cardRequests.some((item) => item.input.endsWith('/v1.0/card/instances/deliver') && item.body.openSpaceId === 'dtv1.card//IM_GROUP.group-id'))
  assert(cardRequests.some((item) => item.input.endsWith('/v1.0/card/streaming') && item.body.isFinalize === true))
  assert(cardRequests.some((item) => item.input.endsWith('/v1.0/card/instances') && item.init.method === 'PUT' && item.body.cardData.cardParamMap.flowStatus === '3'))

  const markdownRequests = []
  const markdownEmotions = []
  const markdownController = createDingTalkReplyController({
    client: { getAccessToken: async () => 'unused' }, robotCode: 'robot-code',
    message: { sessionWebhook: 'https://webhook.example.test/reply' }, templateId: '',
    emotions: { done: async () => { markdownEmotions.push('done') }, settle: async () => { markdownEmotions.push('settle') } },
    fetchImpl: async (_input, init) => { markdownRequests.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) },
  })
  await markdownController.status('thinking', '已接收，正在思考…')
  await markdownController.status('working', '正在使用工具…')
  assert.equal(markdownRequests.length, 0, '没有 AI 卡片时不该再发“已接收，正在思考”这类状态消息（已读用表情表示）')
  await markdownController.reply('# 最终答案')
  assert.equal(markdownRequests.length, 1, '未配置 AI 卡片时只发最终回复')
  assert(markdownRequests[0].markdown.text.includes('最终答案'), '钉钉 Markdown 最终回复丢失')
  assert.equal(markdownRequests[0].msgtype, 'markdown', '钉钉最终回复没有使用 Markdown 消息')
  assert.deepEqual(markdownEmotions, ['done'], '回复完成后应把 🤔Thinking 换成 🥳Done')

  const failingEmotions = []
  const failingController = createDingTalkReplyController({
    client: { getAccessToken: async () => 'unused' }, robotCode: 'robot-code',
    message: { sessionWebhook: 'https://webhook.example.test/reply' }, templateId: '',
    emotions: { done: async () => { failingEmotions.push('done') }, settle: async () => { failingEmotions.push('settle') } },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  await failingController.fail('处理失败')
  assert.deepEqual(failingEmotions, ['settle'], '失败时应撤回 🤔Thinking（不要留成已完成）')

  // 钉钉“已读”表情：开始 🤔Thinking、完成 撤回 🤔 再贴 🥳Done
  const emotionRequests = []
  const emotionController = createDingTalkEmotionController({
    client: { getAccessToken: async () => 'emotion-token' },
    robotCode: 'robot-code',
    message: { msgId: 'inbound-message-id', conversationId: 'inbound-conversation-id' },
    fetchImpl: async (input, init) => { emotionRequests.push({ input: String(input), init, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ success: true }), { status: 200 }) },
  })
  assert.equal(emotionController.available, true, '有 msgId 与 conversationId 时表情控制器应可用')
  await emotionController.thinking()
  const thinkingRequest = emotionRequests[0]
  assert(thinkingRequest.input.endsWith('/v1.0/robot/emotion/reply'), `开始处理应贴表情，实际请求 ${thinkingRequest.input}`)
  assert.equal(thinkingRequest.init.headers['x-acs-dingtalk-access-token'], 'emotion-token', '钉钉表情请求缺少访问令牌')
  assert.equal(thinkingRequest.body.openMsgId, 'inbound-message-id', '钉钉表情缺少消息 ID')
  assert.equal(thinkingRequest.body.openConversationId, 'inbound-conversation-id', '钉钉表情缺少会话 ID')
  assert.equal(thinkingRequest.body.robotCode, 'robot-code')
  assert.equal(thinkingRequest.body.emotionType, 2, '钉钉表情类型应为 2')
  assert.equal(thinkingRequest.body.emotionName, DINGTALK_EMOTION_NAMES.thinking, '开始处理应贴 🤔Thinking')
  assert.equal(thinkingRequest.body.textEmotion.emotionId, '2659900', '钉钉表情缺少内置表情 ID（与 Hermes 一致）')
  await emotionController.done()
  assert(emotionRequests.some((item) => item.input.endsWith('/v1.0/robot/emotion/recall') && item.body.emotionName === DINGTALK_EMOTION_NAMES.thinking), '完成时应先撤回 🤔Thinking')
  assert(emotionRequests.some((item) => item.input.endsWith('/v1.0/robot/emotion/reply') && item.body.emotionName === DINGTALK_EMOTION_NAMES.done), '完成时应贴 🥳Done')

  const silentEmotion = createDingTalkEmotionController({ client: { getAccessToken: async () => 'x' }, robotCode: 'robot-code', message: { senderId: 'user-only' }, fetchImpl: async () => { throw new Error('缺少消息 ID 时不该发请求') } })
  assert.equal(silentEmotion.available, false, '缺少钉钉消息 ID 时应标记不可用')
  assert.equal(await silentEmotion.thinking(), false, '缺少钉钉消息 ID 时不该报错')

  const failingEmotion = createDingTalkEmotionController({
    client: { getAccessToken: async () => 'x' }, robotCode: 'robot-code',
    message: { msgId: 'm', conversationId: 'c' },
    fetchImpl: async () => new Response('{"success":false,"message":"no permission"}', { status: 403 }),
  })
  assert.equal(await failingEmotion.thinking(), false, '粘贴表情失败不能影响对话流程')

  const feishuDownloaded = await downloadFeishuAttachments({
    rawClient: { im: { v1: { messageResource: { get: async () => ({ headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, writeFile: async (target) => writeFileSync(target, 'feishu xlsx bytes') }) } } } },
  }, { messageId: 'feishu-message', resources: [{ type: 'file', fileKey: 'file-key', fileName: '飞书报表.xlsx' }] }, temporaryDirectory)
  assert.equal(feishuDownloaded.attachments.length, 1, '飞书普通文件没有下载到工作区')
  assert.equal(readFileSync(feishuDownloaded.attachments[0].path, 'utf8'), 'feishu xlsx bytes')
  assert.equal(feishuDownloaded.attachments[0].name, '飞书报表.xlsx')
  service.setMonitorEnabled(true)
  assert.equal(service.inspect().gatewayHealthCheckIntervalSeconds, GATEWAY_HEALTH_CHECK_INTERVAL_MS / 1000)

  console.log(JSON.stringify({ ok: true, nativeRouting: true, perBotIsolation: true, pairingAuthorization: true, authorizedUserRename: true, duplicateSuppression: true, conversationPersistence: true, dwsOnDemandAuth: true, dingTalkDwsPrimaryAttachments: true, dingTalkQuotedAttachments: true, dingTalkDirectAttachments: true, dingTalkMarkdown: true, dingTalkAiCard: true, dingTalkEmotion: true, gatewayStatus: true, feishuAttachments: true, healthMonitor: true }))
} finally {
  await restartedService?.shutdown()
  await service.shutdown()
  database.close()
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
