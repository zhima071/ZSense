import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { importPortableConfiguration, portableConfigurationFromWorkspace } from '../electron/ipc.mjs'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { SkillManager } from '../electron/services/skill-manager.mjs'

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'zsense-configuration-transfer-'))
const sourceRoot = path.join(temporaryDirectory, 'source')
const targetRoot = path.join(temporaryDirectory, 'target')

try {
  fs.mkdirSync(sourceRoot, { recursive: true })
  const sourceSkillManager = new SkillManager(path.join(sourceRoot, 'agent-core'))
  const source = new ZSenseDatabase(sourceRoot, sourceSkillManager)
  const atlas = source.loadWorkspace().bots[0]
  source.createBot({ ...atlas, id: 'portable-bot', name: 'Portable Bot', initials: 'PB', modelProvider: 'deepseek', model: 'deepseek-chat', memories: [], memoryCount: 0, memorySize: '0 KB', conversations: 0 })
  source.updateModelConfiguration({ provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKeyName: 'DEEPSEEK_API_KEY', apiKeyConfigured: true, updatedAt: new Date().toISOString() })
  source.createSkill({ name: 'portable-skill', description: '跨平台配置测试技能。', version: '1.0.0', repositoryUrl: '', enabled: true, assignedBotIds: ['portable-bot'], content: '---\nname: portable-skill\ndescription: "跨平台配置测试技能。"\nversion: 1.0.0\n---\n\n# Portable\n\n## When to Use\n\n- 测试时使用。\n\n## Instructions\n\n1. 执行测试。\n\n## Verification\n\n- 验证结果。\n' })
  source.upsertGatewayConnection({ id: 'portable-gateway', provider: 'dingtalk', name: 'Portable DingTalk', botId: 'portable-bot', profileName: 'portable-profile', status: 'connected', latency: '12 ms', messages: 8, configured: true, config: { DINGTALK_CLIENT_ID: 'public-client-id' }, secretKeys: ['DINGTALK_CLIENT_SECRET'], secretScope: 'gateway:portable', updatedAt: new Date().toISOString() })
  source.createScheduledTask({ id: 'portable-task', name: 'Portable Task', frequency: 'daily', timeOfDay: '09:00', weekday: 1, modelProvider: 'deepseek', model: 'deepseek-chat', prompt: '生成日报', skillIds: ['portable-skill'], deliveryTarget: 'local', repeatCount: 0, enabled: true, workspacePath: sourceRoot, nextRunAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })

  const payload = portableConfigurationFromWorkspace(source.loadWorkspace(), 'test')
  const serialized = JSON.stringify(payload)
  assert.equal(payload.data.bots.length, 2)
  assert.equal(payload.data.gatewayProfiles[0].enabled, false)
  assert.equal(payload.data.scheduledTasks[0].workspacePath, '')
  assert.equal(payload.data.settings.defaultWorkspacePath, '')
  assert(!serialized.includes('DINGTALK_CLIENT_SECRET'), '导出文件泄漏了消息网关密钥字段')
  assert(!serialized.includes(sourceRoot), '导出文件泄漏了源设备绝对路径')

  const targetSkillManager = new SkillManager(path.join(targetRoot, 'agent-core'))
  fs.mkdirSync(targetRoot, { recursive: true })
  const target = new ZSenseDatabase(targetRoot, targetSkillManager)
  target.updateSettings({ ...target.loadWorkspace().settings, defaultWorkspacePath: targetRoot })
  const imported = await importPortableConfiguration({ payload, database: target, skillManager: targetSkillManager })
  assert(imported.workspace.bots.some((bot) => bot.id === 'portable-bot'), 'Bot 配置没有跨平台导入')
  assert(imported.workspace.savedModelConfigurations.some((model) => model.provider === 'deepseek' && model.model === 'deepseek-chat'), '模型配置没有导入')
  assert(imported.workspace.skills.some((skill) => skill.name === 'portable-skill'), '技能配置没有导入')
  assert(imported.workspace.scheduledTasks.some((task) => task.id === 'portable-task' && !task.enabled && !task.workspacePath), '定时任务没有以安全暂停状态导入')
  assert(imported.workspace.gatewayConnections.some((connection) => connection.botId === 'portable-bot' && connection.status === 'setup'), '消息网关配置没有以待填写凭证状态导入')
  assert.equal(imported.workspace.settings.defaultWorkspacePath, fs.realpathSync.native(targetRoot), '导入覆盖了目标设备的本机工作区路径')
  target.close()
  source.close()
  console.log(JSON.stringify({ ok: true, crossPlatform: true, secretsOmitted: true, pathsOmitted: true, safeImportState: true }))
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
  app.quit()
}
