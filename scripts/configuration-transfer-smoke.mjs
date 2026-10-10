import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { importPortableConfiguration, portableConfigurationFromWorkspace, registerIpcHandlers } from '../electron/ipc.mjs'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { SkillManager } from '../electron/services/skill-manager.mjs'

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'zsense-configuration-transfer-'))
const sourceRoot = path.join(temporaryDirectory, 'source')
const targetRoot = path.join(temporaryDirectory, 'target')
app.setPath('userData', temporaryDirectory)

try {
  fs.mkdirSync(sourceRoot, { recursive: true })
  const sourceSkillManager = new SkillManager(path.join(sourceRoot, 'agent-core'))
  const source = new ZSenseDatabase(sourceRoot, sourceSkillManager)
  source.updateSettings({ chatDictationShortcut: 'Control+Alt+Shift+F12' })
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
  assert.equal(payload.data.settings.chatDictationShortcut, 'CommandOrControl+Alt+Shift+F12', '导出丢失自定义听写快捷键')
  assert(!serialized.includes('DINGTALK_CLIENT_SECRET'), '导出文件泄漏了消息网关密钥字段')
  assert(!serialized.includes(sourceRoot), '导出文件泄漏了源设备绝对路径')

  const targetSkillManager = new SkillManager(path.join(targetRoot, 'agent-core'))
  fs.mkdirSync(targetRoot, { recursive: true })
  const target = new ZSenseDatabase(targetRoot, targetSkillManager)
  target.updateSettings({ ...target.loadWorkspace().settings, defaultWorkspacePath: targetRoot })
  const loadWorkspace = target.loadWorkspace.bind(target)
  let importSnapshots = 0
  target.loadWorkspace = (...args) => { importSnapshots += 1; return loadWorkspace(...args) }
  const imported = await importPortableConfiguration({ payload, database: target, skillManager: targetSkillManager })
  assert(importSnapshots <= 2, `批量导入不应为每个条目重建完整工作区：实际 ${importSnapshots} 次`)
  assert(imported.workspace.bots.some((bot) => bot.id === 'portable-bot'), 'Bot 配置没有跨平台导入')
  assert(imported.workspace.savedModelConfigurations.some((model) => model.provider === 'deepseek' && model.model === 'deepseek-chat'), '模型配置没有导入')
  assert(imported.workspace.skills.some((skill) => skill.name === 'portable-skill'), '技能配置没有导入')
  assert(imported.workspace.scheduledTasks.some((task) => task.id === 'portable-task' && !task.enabled && !task.workspacePath), '定时任务没有以安全暂停状态导入')
  assert(imported.workspace.gatewayConnections.some((connection) => connection.botId === 'portable-bot' && connection.status === 'setup'), '消息网关配置没有以待填写凭证状态导入')
  assert.equal(imported.workspace.settings.defaultWorkspacePath, fs.realpathSync.native(targetRoot), '导入覆盖了目标设备的本机工作区路径')
  assert.equal(imported.workspace.settings.chatDictationShortcut, 'CommandOrControl+Alt+Shift+F12', '导入校验丢弃了听写快捷键')

  // Exercise the real registered settings handler, including its auth wrapper.
  const handlers = new Map()
  let locked = false
  let reconciles = 0
  registerIpcHandlers({
    ipcMain: { removeHandler: (name) => handlers.delete(name), handle: (name, handler) => handlers.set(name, handler) },
    database: target,
    deviceLinkService: {},
    gatewayService: { reconcile: async () => { reconciles += 1 } },
    auth: { requireUser: () => { if (locked) throw new Error('fixture security lock'); return { id: 'fixture-owner', role: 'admin' } } },
  })
  const saveSettings = (settings) => handlers.get('zsense:settings:update')({ sender: { id: 1 } }, settings)
  const saved = await saveSettings({ ...target.loadSettings(), chatDictationShortcut: 'Cmd+Shift+4' })
  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.data.settings.chatDictationShortcut, 'CommandOrControl+Shift+4', '真实 IPC 保存丢弃了自定义快捷键')
  assert.equal(target.getSetting('chatDictationShortcut'), 'CommandOrControl+Shift+4')
  const disabled = await saveSettings({ ...target.loadSettings(), chatDictationShortcut: '' })
  assert.equal(disabled.ok, true, disabled.error)
  assert.equal(disabled.data.settings.chatDictationShortcut, '', 'IPC 把关闭值错误回退为默认')
  assert.equal(target.getSetting('chatDictationShortcut'), '')
  for (const shortcut of [null, false, 12, 'M', 'Ctrl+M', 'Ctrl+Shift+8', 'Cmd+Shift+Q', 'Ctrl+Shift+F13']) {
    const before = target.loadSettings()
    const reconcilesBefore = reconciles
    const invalid = await saveSettings({ ...before, showUsage: !before.showUsage, chatDictationShortcut: shortcut })
    assert.equal(invalid.ok, false, 'IPC 必须拒绝非法快捷键')
    assert.match(invalid.error, /听写快捷键/)
    assert.equal(target.loadSettings().showUsage, before.showUsage, '非法快捷键不能部分保存其他字段')
    assert.equal(target.getSetting('chatDictationShortcut'), '')
    assert.equal(reconciles, reconcilesBefore, '非法设置不能继续触发服务更新')
  }
  const legacySettings = { ...target.loadSettings() }
  delete legacySettings.chatDictationShortcut
  const legacySaved = await saveSettings(legacySettings)
  assert.equal(legacySaved.ok, true, legacySaved.error)
  assert.equal(legacySaved.data.settings.chatDictationShortcut, '', '旧客户端缺失字段不能重新启用已关闭快捷键')
  locked = true
  const denied = await saveSettings({ ...target.loadSettings(), chatDictationShortcut: 'Ctrl+Shift+4' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /fixture security lock/)
  assert.equal(target.getSetting('chatDictationShortcut'), '')
  locked = false

  // Use settings-only payloads for the remaining transfer cases.
  const settingsPayload = (settings) => ({ format: payload.format, schemaVersion: payload.schemaVersion, data: { settings } })
  const disabledPayload = portableConfigurationFromWorkspace(target.loadWorkspace(), 'test')
  assert.equal(disabledPayload.data.settings.chatDictationShortcut, '', '导出需要保留关闭状态')
  const disabledImported = await importPortableConfiguration({ payload: settingsPayload(disabledPayload.data.settings), database: source, skillManager: sourceSkillManager })
  assert.equal(disabledImported.workspace.settings.chatDictationShortcut, '', '导入需要保留关闭状态')
  const olderPayload = settingsPayload({ showUsage: false })
  const olderImported = await importPortableConfiguration({ payload: olderPayload, database: source, skillManager: sourceSkillManager })
  assert.equal(olderImported.workspace.settings.chatDictationShortcut, '', '旧导出缺失字段时保留目标设备快捷键')
  target.db.prepare("DELETE FROM settings WHERE key='chatDictationShortcut'").run()
  const legacyDefault = await importPortableConfiguration({ payload: olderPayload, database: target, skillManager: targetSkillManager })
  assert.equal(legacyDefault.workspace.settings.chatDictationShortcut, 'CommandOrControl+Shift+M', '旧数据库和旧导出应使用默认快捷键')
  await assert.rejects(importPortableConfiguration({ payload: settingsPayload({ chatDictationShortcut: 'Ctrl+M' }), database: target, skillManager: targetSkillManager }), /听写快捷键/)
  assert.equal(target.loadSettings().chatDictationShortcut, 'CommandOrControl+Shift+M', '非法导入不能破坏已有快捷键')
  target.close()
  source.close()
  console.log(JSON.stringify({ ok: true, crossPlatform: true, secretsOmitted: true, pathsOmitted: true, safeImportState: true, dictationShortcutIpc: true, dictationShortcutTransfer: true }))
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
  app.quit()
}
