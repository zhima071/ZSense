import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { redactSensitiveText } from '../electron/services/redaction.mjs'

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-conversation-policy-'))
let database = new ZSenseDatabase(temporaryDirectory)

try {
  let workspace = database.loadWorkspace()
  assert.equal(workspace.settings.contextAutoCompression, true, '上下文自动压缩应默认启用')
  assert.equal(workspace.settings.contextCompressionThreshold, 0.5, '压缩阈值默认值不正确')
  assert.equal(workspace.settings.contextCompressionTargetRatio, 0.2, '压缩目标比例默认值不正确')
  assert.equal(workspace.settings.contextCompressionProtectLastN, 20, '保护最近消息默认值不正确')
  assert.equal(workspace.settings.contextCompressionProtectFirstN, 3, '保护开头消息默认值不正确')
  assert.equal(workspace.settings.memoryPeriodicReview, true, '周期性记忆复盘应默认启用')
  assert.equal(workspace.settings.memoryReviewInterval, 10, '周期性记忆复盘默认间隔不正确')
  assert.equal(workspace.settings.memoryRecallLimit, 24, '单轮记忆召回默认数量不正确')
  assert.equal(workspace.settings.memoryMaxItems, 500, '单空间记忆默认容量不正确')
  assert.equal(workspace.settings.sensitiveDataRedaction, true, '敏感信息脱敏应默认启用')
  assert.equal(workspace.settings.responseLanguage, 'zh-CN', '回复与播报语言应默认使用简体中文')
  assert.equal(workspace.settings.voiceWakePhrase, '你好 ZSense', '默认唤醒词不正确')

  database.updateSettings({
    ...workspace.settings,
    contextAutoCompression: false,
    contextCompressionThreshold: 0.75,
    contextCompressionTargetRatio: 0.3,
    contextCompressionProtectLastN: 28,
    contextCompressionProtectFirstN: 4,
    memoryPeriodicReview: false,
    memoryReviewInterval: 12,
    memoryRecallLimit: 18,
    memoryMaxItems: 750,
    sensitiveDataRedaction: true,
    responseLanguage: 'auto',
    voiceWakePhrase: '你好小智',
  })
  database.close()
  database = new ZSenseDatabase(temporaryDirectory)
  workspace = database.loadWorkspace()
  assert.equal(workspace.settings.contextAutoCompression, false, '上下文自动压缩设置没有持久化')
  assert.equal(workspace.settings.contextCompressionThreshold, 0.75, '压缩阈值没有持久化')
  assert.equal(workspace.settings.contextCompressionTargetRatio, 0.3, '压缩目标比例没有持久化')
  assert.equal(workspace.settings.contextCompressionProtectLastN, 28, '保护最近消息数没有持久化')
  assert.equal(workspace.settings.contextCompressionProtectFirstN, 4, '保护开头消息数没有持久化')
  assert.equal(workspace.settings.memoryPeriodicReview, false, '周期性记忆复盘开关没有持久化')
  assert.equal(workspace.settings.memoryReviewInterval, 12, '周期性记忆复盘间隔没有持久化')
  assert.equal(workspace.settings.memoryRecallLimit, 18, '单轮记忆召回数量没有持久化')
  assert.equal(workspace.settings.memoryMaxItems, 750, '单空间记忆容量没有持久化')
  assert.equal(workspace.settings.sensitiveDataRedaction, true, '敏感信息脱敏设置没有持久化')
  assert.equal(workspace.settings.responseLanguage, 'auto', '回复与播报语言设置没有持久化')
  assert.equal(workspace.settings.voiceWakePhrase, '你好小智', '自定义唤醒词没有持久化')

  const countConversationId = database.createConversation('atlas', '真实消息统计')
  database.addMessage(countConversationId, 'user', '一条用户消息')
  database.addMessage(countConversationId, 'assistant', '一条助手消息', { agentSteps: [{ step: 1, status: 'complete', outcome: 'final_answer', reasoning: '完成判断', content: '一条助手消息', tools: [], startedAt: '2026-09-13T00:00:00.000Z', durationMs: 320, toolCallCount: 0 }] })
  database.db.prepare("UPDATE channels SET messages=658 WHERE id='web'").run()
  workspace = database.loadWorkspace()
  assert.equal(workspace.channels.find((channel) => channel.id === 'web')?.messages, 2, '总览仍在读取漂移的历史消息计数器')
  assert.equal(workspace.conversations.find((item) => item.id === countConversationId)?.messages[1]?.agentSteps[0]?.reasoning, '完成判断', 'Agent Loop 分轮结果没有写入消息历史')
  assert.equal(database.getConversation(countConversationId, 'atlas')?.messages[1]?.agentSteps[0]?.reasoning, '完成判断', '单条会话读取接口漏传 Agent Loop 分轮结果')
  database.deleteConversation(countConversationId)
  assert.equal(database.loadWorkspace().channels.find((channel) => channel.id === 'web')?.messages, 0, '删除会话后总览消息数没有实时更新')

  const conversationId = database.createConversation('atlas', 'Session mapping test')
  assert.equal(database.getConversation(conversationId, 'atlas')?.externalThreadId, '', '普通应用内会话不应预填外部线程 ID')
  assert.equal(database.getConversation(conversationId, 'scout'), null, '不能跨 Bot 读取会话映射')
  const external = database.importExternalMessages([{ botId: 'atlas', channelId: 'dingtalk', externalThreadId: 'ding-thread-1', messages: [{ role: 'user', content: '外部消息', externalMessageId: 'ding-message-1', attachments: [{ id: 'ding-file-1', name: '引用文件.xlsx', path: '/tmp/reference.xlsx', size: 42, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'file' }] }] }])
  assert.equal(external.importedMessages, 1)
  const externalConversation = external.workspace.conversations.find((item) => item.externalThreadId === 'ding-thread-1')
  assert.equal(externalConversation?.messages[0].externalMessageId, 'ding-message-1', '外部线程与消息 ID 没有持久化')
  assert.equal(externalConversation?.messages[0].attachments[0]?.name, '引用文件.xlsx', '外部消息附件元数据没有持久化')

  const legacyConversationId = database.createConversation('atlas', '旧版 DSML 兼容测试')
  database.addMessage(legacyConversationId, 'assistant', '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="terminal"><｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>')
  database.db.prepare("UPDATE meta SET value='34' WHERE key='schema_version'").run()
  database.close()
  database = new ZSenseDatabase(temporaryDirectory)
  assert.equal(database.getConversation(legacyConversationId)?.messages[0]?.content, 'ZSense 已移除旧版本误存的工具调用标签；这些历史工具调用没有实际执行，请重新提交当时的问题。', '旧版 DSML 标签没有迁移清理')
  assert.equal(existsSync(path.join(temporaryDirectory, 'zsense.sqlite3.pre-schema-35.bak')), true, 'DSML 数据迁移前没有创建数据库备份')

  const source = [
    'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'database=https://admin:supersecret@example.com/data',
    'phone=13800138000',
    '-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----',
  ].join('\n')
  const redacted = redactSensitiveText(source)
  assert(!redacted.includes('abcdefghijklmnopqrstuvwxyz'), 'API Key 没有脱敏')
  assert(!redacted.includes('supersecret'), 'URL 密码没有脱敏')
  assert(!redacted.includes('very-secret-material'), '私钥块没有脱敏')
  assert(redacted.includes('13800138000'), '普通手机号不应被误判为凭证')
  assert(redacted.includes('[REDACTED]'), '脱敏文本没有标记替换位置')

  console.log(JSON.stringify({ ok: true, settingsPersistence: true, compressionSettingsPersistence: true, memoryPolicyPersistence: true, responseLanguagePersistence: true, customWakePhrasePersistence: true, liveMessageCount: true, externalMessageMapping: true, externalAttachmentPersistence: true, legacyDsmlMigration: true, botConversationIsolation: true, localSecretRedaction: true }))
} finally {
  try { database.close() } catch { /* already closed */ }
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
