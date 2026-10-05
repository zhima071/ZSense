import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ZSenseDatabase } from '../electron/services/database.mjs'

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-bot-management-'))
let database = new ZSenseDatabase(temporaryDirectory)

try {
  let source = database.loadWorkspace().bots.find((bot) => bot.id === 'atlas')
  assert.ok(source, 'seeded source Bot should exist')

  database.updateModelConfiguration({ provider: 'deepseek', model: 'deepseek-chat', baseUrl: '', apiKeyName: 'DEEPSEEK_API_KEY', apiKeyConfigured: true, updatedAt: '2026-09-06T11:00:00.000Z' })
  database.updateModelConfiguration({ provider: 'deepseek', model: 'deepseek-reasoner', baseUrl: '', apiKeyName: 'DEEPSEEK_API_KEY', apiKeyConfigured: true, updatedAt: '2026-09-06T11:01:00.000Z' })
  database.updateModelConfiguration({ provider: 'openai', model: 'gpt-5.4', baseUrl: '', apiKeyName: 'OPENAI_API_KEY', apiKeyConfigured: true, updatedAt: '2026-09-06T11:02:00.000Z' })
  let workspace = database.loadWorkspace()
  assert.deepEqual(workspace.settings.hiddenSidebarBotIds, [], '所有 Bot 默认都应显示在左侧栏')
  workspace = database.updateSettings({ ...workspace.settings, hiddenSidebarBotIds: ['atlas'] })
  assert.deepEqual(workspace.settings.hiddenSidebarBotIds, ['atlas'], '左侧栏 Bot 显示偏好没有持久化')
  assert.deepEqual(workspace.savedModelConfigurations.map((item) => `${item.provider}:${item.model}`).sort(), ['deepseek:deepseek-chat', 'deepseek:deepseek-reasoner', 'openai:gpt-5.4'])
  source = workspace.bots.find((bot) => bot.id === 'atlas')
  assert.ok(source)
  database.updateBot({ ...source, modelProvider: 'deepseek', model: 'deepseek-reasoner' })

  database.close()
  database = new ZSenseDatabase(temporaryDirectory)
  workspace = database.loadWorkspace()
  assert.deepEqual(workspace.settings.hiddenSidebarBotIds, ['atlas'], '重启后左侧栏 Bot 显示偏好丢失')
  source = workspace.bots.find((bot) => bot.id === 'atlas')
  assert.equal(source?.modelProvider, 'deepseek')
  assert.equal(source?.model, 'deepseek-reasoner')
  assert.equal(workspace.savedModelConfigurations.length, 3, 'saved provider and model choices should survive reopening the database')

  database.close()
  const rawDatabase = new DatabaseSync(path.join(temporaryDirectory, 'zsense.sqlite3'))
  rawDatabase.prepare("DELETE FROM memories WHERE bot_id='atlas'").run()
  rawDatabase.prepare("UPDATE bots SET memory_count=1281, memory_size='18.4 MB' WHERE id='atlas'").run()
  rawDatabase.close()
  database = new ZSenseDatabase(temporaryDirectory)
  source = database.loadWorkspace().bots.find((bot) => bot.id === 'atlas')
  assert.equal(source?.memoryCount, 0, 'startup should repair stale memory counts from the actual memories table')
  assert.equal(source?.memorySize, '0 KB', 'startup should repair stale memory sizes from the actual memories table')

  database.updateBot({ ...source, memoryCount: 999, memorySize: '99 MB' })
  source = database.loadWorkspace().bots.find((bot) => bot.id === 'atlas')
  assert.equal(source?.memoryCount, 0, 'Bot updates must not overwrite derived memory counts')
  assert.equal(source?.memorySize, '0 KB', 'Bot updates must not overwrite derived memory sizes')

  let activityWorkspace = database.updateBot({ ...source, status: 'paused' })
  const statusActivity = activityWorkspace.activities.find((activity) => activity.title === 'Bot 已暂停')
  assert.ok(statusActivity, 'changing Bot status should create an activity record')
  assert.equal(statusActivity.metadata.previousStatus, '运行中')
  assert.equal(statusActivity.metadata.nextStatus, '已暂停')
  assert.ok(Number.isFinite(Date.parse(`${statusActivity.createdAt.replace(' ', 'T')}Z`)), 'activity should include a valid exact timestamp')
  source = activityWorkspace.bots.find((bot) => bot.id === 'atlas')

  const auditedConversationId = database.createConversation(source.id, '工具调用审计测试')
  database.completeConversation(source.id, auditedConversationId, [{ toolId: 'tool-check-1', name: 'Web Search', status: 'complete' }])
  activityWorkspace = database.loadWorkspace()
  const conversationActivity = activityWorkspace.activities.find((activity) => activity.metadata.conversationId === auditedConversationId && activity.type === 'message')
  const toolActivity = activityWorkspace.activities.find((activity) => activity.metadata.conversationId === auditedConversationId && activity.type === 'tool')
  assert.equal(conversationActivity?.metadata.toolCalls, '1')
  assert.equal(toolActivity?.metadata.toolName, 'Web Search')
  assert.equal(toolActivity?.metadata.status, 'complete')

  const duplicatedWorkspace = database.duplicateBot(source.id, 'atlas-copy-test')
  const duplicate = duplicatedWorkspace.bots.find((bot) => bot.id === 'atlas-copy-test')
  assert.ok(duplicate, 'duplicated Bot should exist')
  assert.equal(duplicate.name, 'Atlas 副本')
  assert.equal(duplicate.status, 'paused')
  assert.deepEqual(duplicate.channels, ['web'])
  assert.deepEqual(duplicate.memories, [])
  assert.equal(duplicate.memoryCount, 0)
  assert.equal(duplicate.conversations, 0)
  assert.equal(duplicate.modelProvider, 'deepseek')
  assert.equal(duplicate.model, 'deepseek-reasoner')
  assert.ok(duplicatedWorkspace.skills.every((skill) => skill.assignedBotIds.includes(duplicate.id)), 'source skill assignments should be copied')

  const deletedWorkspace = database.deleteBot(duplicate.id)
  assert.equal(deletedWorkspace.bots.some((bot) => bot.id === duplicate.id), false)
  assert.equal(deletedWorkspace.skills.some((skill) => skill.assignedBotIds.includes(duplicate.id)), false)
  console.log('Bot management smoke test passed')
} finally {
  database.close()
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
