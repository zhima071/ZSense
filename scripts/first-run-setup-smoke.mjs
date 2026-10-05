import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ZSenseDatabase } from '../electron/services/database.mjs'

const freshDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-first-run-fresh-'))
const upgradeDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-first-run-upgrade-'))
const legacyDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-first-run-legacy-'))

try {
  let database = new ZSenseDatabase(freshDirectory)
  let workspace = database.loadWorkspace()
  assert.equal(workspace.settings.firstRunSetupCompleted, false, '全新安装必须显示首次启动配置')
  assert.equal(workspace.settings.defaultWorkspacePath, '', '全新安装不应伪造默认工作区')
  assert.deepEqual(workspace.bots.map((bot) => bot.id), ['atlas'], '全新安装只能预设 Atlas 一个 Bot')
  database.updateSettings({ ...workspace.settings, firstRunSetupCompleted: true, defaultWorkspacePath: freshDirectory })
  database.close()

  database = new ZSenseDatabase(freshDirectory)
  workspace = database.loadWorkspace()
  assert.equal(workspace.settings.firstRunSetupCompleted, true, '首次启动完成状态没有持久化')
  assert.equal(workspace.settings.defaultWorkspacePath, freshDirectory, '默认全局工作区没有持久化')
  database.close()

  database = new ZSenseDatabase(upgradeDirectory)
  database.db.prepare("DELETE FROM settings WHERE key IN ('firstRunSetupCompleted', 'defaultWorkspacePath')").run()
  database.db.prepare("UPDATE meta SET value='24' WHERE key='schema_version'").run()
  database.close()

  database = new ZSenseDatabase(upgradeDirectory)
  workspace = database.loadWorkspace()
  assert.equal(workspace.settings.firstRunSetupCompleted, true, '已有安装升级时不应被误判为首次安装')
  assert.equal(workspace.settings.defaultWorkspacePath, '', '已有安装升级时默认工作区迁移值应为空')
  database.close()

  database = new ZSenseDatabase(legacyDirectory)
  database.close()
  const legacyDatabase = new DatabaseSync(path.join(legacyDirectory, 'zsense.sqlite3'))
  const insertLegacyBot = legacyDatabase.prepare(`
    INSERT INTO bots (id, name, initials, role, description, status, color, model_provider, model, memory_count, memory_size, last_active, conversations, success_rate, prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', 0, '0 KB', '尚未运行', 0, 100, ?)
  `)
  insertLegacyBot.run('scout', 'Scout', 'SC', '研究情报助手', '持续跟踪行业动态，聚合来源并输出可验证的研究摘要。', 'online', '#38bdf8', '你是 Scout，一位证据优先的研究助手。必须标记来源与时间，对不确定结论给出置信度。')
  insertLegacyBot.run('momo', 'Momo', 'MO', '团队运营助理', '处理团队消息、会议跟进与任务提醒，保持协作节奏。', 'paused', '#f59e0b', '你是 Momo，负责团队运营与协作。行动前先确认负责人、截止时间和通知范围。')
  legacyDatabase.prepare("INSERT INTO conversations (id, bot_id, title) VALUES ('legacy-scout-conversation', 'scout', '已使用的旧示例 Bot')").run()
  legacyDatabase.prepare("INSERT INTO users (id, username, display_name, password_hash, password_salt, role, enabled) VALUES ('legacy-owner', 'Hank', 'Hank', 'hash', 'salt', 'admin', 1)").run()
  legacyDatabase.prepare("UPDATE meta SET value='37' WHERE key='schema_version'").run()
  legacyDatabase.close()

  database = new ZSenseDatabase(legacyDirectory)
  workspace = database.loadWorkspace()
  assert.equal(workspace.bots.some((bot) => bot.id === 'momo'), false, '从未使用的旧版 Momo 示例 Bot 应在迁移时删除')
  assert.equal(workspace.bots.some((bot) => bot.id === 'scout'), true, '已有真实会话的旧版 Scout Bot 不能被迁移删除')
  assert.equal(database.listUsers()[0]?.username, 'Hank', '升级不应擅自重写用户设置的身份标识')
  assert.equal(database.listUsers()[0]?.displayName, 'Hank', '升级不应擅自重写用户设置的显示名称')
  database.close()

  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const firstRun = readFileSync(new URL('../src/components/FirstRunSetup.tsx', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('../src/components/SystemPages.tsx', import.meta.url), 'utf8')
  const scheduledTasks = readFileSync(new URL('../src/components/ScheduledTasksPage.tsx', import.meta.url), 'utf8')
  const ipc = readFileSync(new URL('../electron/ipc.mjs', import.meta.url), 'utf8')

  assert(app.includes('!loading && !modelConfiguration.model && !settings.firstRunSetupCompleted') && app.includes('<FirstRunSetup'), '应用没有在首次启动或配置不完整时显示配置向导')
  // 回归：不能因为「首次启动标记位丢失」或「默认工作区为空」就反复弹出向导（Windows 装完新版每次都要过一遍的根因）
  assert(!app.includes('!settings.firstRunSetupCompleted || !settings.defaultWorkspacePath'), '首次启动向导不应由工作区为空/标记位丢失触发')
  assert(!app.includes('!settings.defaultWorkspacePath || !modelConfiguration.model'), '首次启动向导不应由工作区为空触发')
  assert(firstRun.includes('配置 AI 模型 API') && firstRun.includes('设置用户与全局工作区'), '首次启动向导缺少 API、用户名称或工作区步骤')
  assert(firstRun.includes('用户名称') && firstRun.includes('initialUserName') && firstRun.includes('userName.trim()'), '首次启动向导没有保存用户名称')
  assert(app.includes('window.zsenseDesktop.auth.users.update') && app.includes('displayName: userName'), '首次启动用户名称没有写入本机身份')
  assert(settings.includes('onCurrentUserChanged') && settings.includes('UserManagementPanel'), '设置页没有提供当前本机身份重命名闭环')
  assert(firstRun.includes('onLoadModels') && firstRun.includes('apiKey: apiKey.trim()'), '首次启动 API 配置没有接入官方模型列表或安全保存流程')
  assert(settings.includes('默认全局工作区') && settings.includes('pickDefaultWorkspace'), '设置页无法继续维护默认全局工作区')
  assert(app.includes('const nativeDefaultWorkspacePath = settings.defaultWorkspacePath') && app.includes('const chatDefaultWorkspacePath = settings.defaultWorkspacePath'), '新对话没有继承默认全局工作区')
  assert(scheduledTasks.includes('task?.workspacePath || defaultWorkspacePath'), '新定时任务没有继承默认全局工作区')
  assert(ipc.includes("validateWorkspaceDirectory(defaultWorkspacePath") && ipc.includes("workspace.settings.defaultWorkspacePath"), '主进程没有验证或兜底使用默认全局工作区')

  console.log(JSON.stringify({ ok: true, seededBots: ['atlas'], freshInstallPrompts: true, incompleteSetupRecovers: true, userNameSetupConnected: true, upgradesNotInterrupted: true, apiSetupConnected: true, globalWorkspacePersisted: true, chatAndTaskDefaultsConnected: true }))
} finally {
  rmSync(freshDirectory, { recursive: true, force: true })
  rmSync(upgradeDirectory, { recursive: true, force: true })
  rmSync(legacyDirectory, { recursive: true, force: true })
}
