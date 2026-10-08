import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NATIVE_BOT_ID, NATIVE_PROFILE_NAME, ZSenseDatabase } from '../electron/services/database.mjs'
import { fetchOfficialModelCatalog } from '../electron/services/model-catalog-service.mjs'
import { contextWindowFromModelEntry, inferredContextWindow } from '../electron/services/model-metadata.mjs'
import { nativeWorkspaceIdentity } from '../electron/services/workspace-context.mjs'

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-settings-native-'))
let legacyReplyConversationId = ''
let legacyScheduledRunId = ''
let legacyBotConversationId = ''

try {
  assert.equal(inferredContextWindow('deepseek', 'deepseek-flash'), 1_000_000, 'DeepSeek Flash 的官网上下文兜底值不是 1M')
  assert.equal(contextWindowFromModelEntry({ id: 'provider/model', context_length: 1_048_576 }, 'custom', 'provider/model'), 1_048_576, '模型官网响应中的上下文长度没有优先使用')
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', context_length: 1_000_000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    const officialCatalog = await fetchOfficialModelCatalog({ provider: 'deepseek', apiKey: 'test-only-key' })
    assert.equal(officialCatalog.entries[0].contextWindow, 1_000_000, '官网 /models 返回的上下文长度没有保留在模型目录')
  } finally {
    globalThis.fetch = originalFetch
  }
  const database = new ZSenseDatabase(temporaryDirectory)
  try {
    let workspace = database.loadWorkspace()
    assert.equal(workspace.bots.length, 1)
    assert.equal(workspace.bots[0]?.id, 'atlas', '全新安装应只预设 Atlas Bot')
    assert.equal(workspace.nativeBot?.id, NATIVE_BOT_ID)
    assert(!workspace.bots.some((bot) => bot.id === NATIVE_BOT_ID), 'AI 对话不能混入 Bot 管理列表')
    assert(NATIVE_PROFILE_NAME.length > 8, 'AI 对话必须使用非空的稳定 Profile 名称')
    assert.equal(workspace.nativeBot?.name, 'AI 对话', 'AI 对话空间没有使用统一名称')
    assert.equal(workspace.settings.runWhileLocked, false, '锁屏运行默认应关闭')
    assert.equal('agentMaxToolSteps' in workspace.settings, false, 'Agent Loop 不应再使用固定最大轮次')
    workspace = database.updateSettings({ ...workspace.settings, runWhileLocked: true })
    assert.equal(workspace.settings.runWhileLocked, true, '锁屏运行设置没有持久化')

    database.updateModelConfiguration({ provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp', baseUrl: '', apiKeyName: 'DEEPSEEK_API_KEY', apiKeyConfigured: true, updatedAt: '2026-09-11T09:55:00.000Z' })
    database.updateModelConfiguration({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: '', apiKeyName: 'DEEPSEEK_API_KEY', apiKeyConfigured: true, updatedAt: '2026-09-11T09:56:00.000Z' })
    workspace = database.loadWorkspace()
    const savedModelCount = workspace.savedModelConfigurations.length
    database.syncModelCatalog({
      provider: 'deepseek',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      source: 'official-api',
      endpoint: 'https://api.deepseek.com/v1/models',
      fetchedAt: '2026-09-11T10:00:00.000Z',
      entries: [{ id: 'deepseek-flash', contextWindow: 1_000_000 }, { id: 'deepseek-v4-pro', contextWindow: 1_048_576 }],
    }, {
      baseUrl: '',
      apiKeyName: 'DEEPSEEK_API_KEY',
      apiKeyConfigured: true,
    })
    workspace = database.loadWorkspace()
    assert.equal(workspace.savedModelConfigurations.length, savedModelCount, '官网模型目录不能伪装成用户手动保存的模型')
    assert(workspace.availableModelConfigurations.some((item) => item.provider === 'deepseek' && item.model === 'deepseek-flash'), '官网模型没有进入统一可用模型列表')
    assert(workspace.availableModelConfigurations.some((item) => item.provider === 'deepseek' && item.model === 'deepseek-v4-pro' && item.apiKeyConfigured), '官网模型没有继承供应商凭证状态')
    assert.equal(workspace.availableModelConfigurations.find((item) => item.provider === 'deepseek' && item.model === 'deepseek-flash')?.contextWindow, 1_000_000, '官网同步的 1M 上下文长度没有进入统一模型配置')
    assert.equal(workspace.modelConfiguration.contextWindow, 1_000_000, '当前全局模型没有取得已同步的上下文长度')
    assert(!workspace.availableModelConfigurations.some((item) => item.provider === 'deepseek' && item.model === 'deepseek-v4-flash-vision-exp'), '官网已不再返回的旧模型仍出现在可选列表')

    database.createMemory(NATIVE_BOT_ID, {
      id: 'native-memory-check',
      title: 'AI 对话记忆',
      excerpt: '只属于 AI 对话',
      type: 'fact',
      updatedAt: '刚刚',
      source: 'AI 对话',
    })
    workspace = database.loadWorkspace()
    assert.equal(workspace.nativeBot?.memories.some((memory) => memory.id === 'native-memory-check'), true)
    assert.equal(workspace.bots.some((bot) => bot.memories.some((memory) => memory.id === 'native-memory-check')), false, 'AI 对话记忆不能进入 Bot 私有空间')
    database.updateMemory(NATIVE_BOT_ID, {
      id: 'native-memory-check',
      title: '修改后的 AI 对话记忆',
      excerpt: '仍然只属于 AI 对话',
      type: 'preference',
      updatedAt: '刚刚',
      source: 'AI 对话',
    })
    workspace = database.loadWorkspace()
    assert.equal(workspace.nativeBot?.memories.find((memory) => memory.id === 'native-memory-check')?.title, '修改后的 AI 对话记忆')
    assert.equal(workspace.nativeBot?.memories.find((memory) => memory.id === 'native-memory-check')?.type, 'preference')

    database.createBot({ ...workspace.bots[0], id: 'temporary-bot', name: 'Temporary', initials: 'TP', memories: [], memoryCount: 0, memorySize: '0 KB', conversations: 0, channels: ['web'] })
    database.deleteBot('temporary-bot')
    workspace = database.loadWorkspace()
    const identity = nativeWorkspaceIdentity(workspace)
    assert.equal(workspace.bots.length, 1)
    assert(identity.prompt.includes('当前 Bot 总数（精确值）：1'), '实时工作区快照没有反映删除后的 Bot 数量')
    assert(!identity.prompt.includes('Temporary'), '已删除 Bot 仍出现在 AI 对话快照中')
    assert.equal(identity.workspaceAssistant, true)
    assert.equal(identity.model, workspace.modelConfiguration.model)

    const legacyTimestamp = '2026-09-11T13:06:17.000Z'
    legacyReplyConversationId = database.createNativeConversation('旧版回复迁移', { modelProvider: 'deepseek', model: 'deepseek-flash', workspacePath: temporaryDirectory })
    database.addMessage(legacyReplyConversationId, 'user', '生成新闻摘要', { createdAt: legacyTimestamp })
    database.addMessage(legacyReplyConversationId, 'assistant', '摘要已生成', {
      createdAt: '2026-09-11T13:08:14.000Z',
      agentSteps: Array.from({ length: 11 }, (_, index) => ({ step: index + 1, status: 'complete', outcome: index === 10 ? 'final_answer' : 'tool_calls', reasoning: `第 ${index + 1} 轮`, content: index === 10 ? '摘要已生成' : '', tools: [], startedAt: legacyTimestamp, toolCallCount: index === 10 ? 0 : 1 })),
    })
    database.updateConversationOptions(legacyReplyConversationId, NATIVE_BOT_ID, { usage: { contextUsed: 534886, contextMax: 1_000_000, contextPercent: 53, inputTokens: 529275, outputTokens: 5611, totalTokens: 534886 } })
    legacyBotConversationId = database.createConversation('atlas', '旧版 Bot 回复迁移', { workspacePath: temporaryDirectory })
    database.addMessage(legacyBotConversationId, 'user', '介绍一下你自己', { createdAt: '2026-09-11T13:09:00.000Z' })
    database.addMessage(legacyBotConversationId, 'assistant', '我是 Atlas。', { createdAt: '2026-09-11T13:09:04.000Z' })
    const legacyTaskId = 'task-legacy-model-backfill'
    database.createScheduledTask({
      id: legacyTaskId, name: '旧版定时任务', frequency: 'daily', timeOfDay: '09:00', weekday: 1,
      modelProvider: 'deepseek', model: 'deepseek-flash', prompt: '生成新闻摘要', skillIds: [], deliveryTarget: 'local',
      repeatCount: 0, enabled: true, workspacePath: temporaryDirectory, nextRunAt: null,
      createdAt: legacyTimestamp, updatedAt: legacyTimestamp,
    })
    legacyScheduledRunId = 'task-run-legacy-model-backfill'
    database.startScheduledTaskRun(legacyTaskId, legacyScheduledRunId, legacyTimestamp, null)
    database.finishScheduledTaskRun({ taskId: legacyTaskId, runId: legacyScheduledRunId, status: 'success', finishedAt: '2026-09-11T13:08:15.000Z', durationMs: 118000, conversationId: legacyReplyConversationId, output: '摘要已生成' })
    database.db.prepare("UPDATE scheduled_task_runs SET model_provider='', model='' WHERE id=?").run(legacyScheduledRunId)
    database.db.prepare("UPDATE settings SET value='112' WHERE key='chatInputHeight'").run()
    database.db.prepare("UPDATE bots SET name=char(21407,29983) || '对话', role='ZSense ' || char(21407,29983) || '助手' WHERE id=?").run(NATIVE_BOT_ID)
    database.db.prepare("UPDATE memories SET source=char(21407,29983) || '对话' WHERE id='native-memory-check'").run()
    database.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '18')").run()
  } finally {
    database.close()
  }

  const migratedDatabase = new ZSenseDatabase(temporaryDirectory)
  try {
    const migratedWorkspace = migratedDatabase.loadWorkspace()
    const migratedRun = migratedWorkspace.scheduledTaskRuns.find((run) => run.id === legacyScheduledRunId)
    const migratedReply = migratedDatabase.getConversation(legacyReplyConversationId)?.messages.find((message) => message.role === 'assistant')
    const migratedBotConversation = migratedDatabase.getConversation(legacyBotConversationId, 'atlas')
    const migratedBotReply = migratedBotConversation?.messages.find((message) => message.role === 'assistant')
    assert.equal(migratedWorkspace.settings.chatInputHeight, 88, '旧版默认输入框高度没有迁移为紧凑高度')
    assert.equal(migratedWorkspace.nativeBot?.name, 'AI 对话', '旧版 AI 对话名称没有自动迁移')
    assert.equal(migratedWorkspace.nativeBot?.memories.find((memory) => memory.id === 'native-memory-check')?.source, 'AI 对话', '旧版 AI 对话记忆来源没有自动迁移')
    assert.equal(migratedRun?.modelProvider, 'deepseek', '旧任务运行记录没有从关联对话恢复模型供应商')
    assert.equal(migratedRun?.model, 'deepseek-flash', '旧任务运行记录没有从关联对话恢复模型 ID')
    assert.equal(migratedReply?.modelProvider, 'deepseek', '旧 AI 回复没有从会话恢复模型供应商')
    assert.equal(migratedReply?.model, 'deepseek-flash', '旧 AI 回复没有从会话恢复模型 ID')
    assert.equal(migratedReply?.durationMs, 117000, '旧 AI 回复没有从相邻消息时间戳恢复耗时')
    assert.equal(migratedDatabase.getConversation(legacyReplyConversationId)?.usage?.contextUsed, 48626, '多轮 Agent 累计 Token 没有迁移为单轮上下文估算值')
    assert.equal(migratedDatabase.getConversation(legacyReplyConversationId)?.usage?.contextPercent, 5, '旧会话上下文百分比没有消除 Agent Loop 重复累计')
    assert.equal(migratedBotConversation?.modelProvider, 'deepseek', '跟随全局模型的旧 Bot 会话没有恢复模型供应商')
    assert.equal(migratedBotConversation?.model, 'deepseek-flash', '跟随全局模型的旧 Bot 会话没有恢复模型 ID')
    assert.equal(migratedBotReply?.modelProvider, 'deepseek', '跟随全局模型的旧 Bot 回复没有恢复模型供应商')
    assert.equal(migratedBotReply?.model, 'deepseek-flash', '跟随全局模型的旧 Bot 回复没有恢复模型 ID')
  } finally {
    migratedDatabase.close()
  }

  const sidebar = fs.readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8')
  const settings = fs.readFileSync(new URL('../src/components/SystemPages.tsx', import.meta.url), 'utf8')
  const nativeChat = fs.readFileSync(new URL('../src/components/NativeChatPage.tsx', import.meta.url), 'utf8')
  const overview = fs.readFileSync(new URL('../src/components/Overview.tsx', import.meta.url), 'utf8')
  const userManagement = fs.readFileSync(new URL('../src/components/UserManagementPanel.tsx', import.meta.url), 'utf8')
  const sessionProgressCenter = fs.readFileSync(new URL('../src/components/SessionProgressCenter.tsx', import.meta.url), 'utf8')
  const gatewayPage = fs.readFileSync(new URL('../src/components/GatewayPage.tsx', import.meta.url), 'utf8')
  const firstRunSetup = fs.readFileSync(new URL('../src/components/FirstRunSetup.tsx', import.meta.url), 'utf8')
  const skillsPage = fs.readFileSync(new URL('../src/components/SkillsPage.tsx', import.meta.url), 'utf8')
  const botChat = fs.readFileSync(new URL('../src/components/ChatDialog.tsx', import.meta.url), 'utf8')
  const botWorkspace = fs.readFileSync(new URL('../src/components/BotWorkspace.tsx', import.meta.url), 'utf8')
  const botsPage = fs.readFileSync(new URL('../src/components/BotsPage.tsx', import.meta.url), 'utf8')
  const botActionsMenu = fs.readFileSync(new URL('../src/components/BotActionsMenu.tsx', import.meta.url), 'utf8')
  const memoryDialog = fs.readFileSync(new URL('../src/components/MemoryDialog.tsx', import.meta.url), 'utf8')
  const modelPage = fs.readFileSync(new URL('../src/components/ModelPage.tsx', import.meta.url), 'utf8')
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const composerToolbar = fs.readFileSync(new URL('../src/components/ChatComposerToolbar.tsx', import.meta.url), 'utf8')
  const composerResizeHandle = fs.readFileSync(new URL('../src/components/ChatComposerResizeHandle.tsx', import.meta.url), 'utf8')
  const chatMessageMeta = fs.readFileSync(new URL('../src/components/ChatMessageMeta.tsx', import.meta.url), 'utf8')
  const clipboardService = fs.readFileSync(new URL('../src/services/clipboard.ts', import.meta.url), 'utf8')
  const officeArtifacts = fs.readFileSync(new URL('../src/services/office-artifacts.ts', import.meta.url), 'utf8')
  const conversationIdButton = fs.readFileSync(new URL('../src/components/ConversationIdButton.tsx', import.meta.url), 'utf8')
  const attachmentService = fs.readFileSync(new URL('../src/services/chat-attachments.ts', import.meta.url), 'utf8')
  const desktopAttachmentService = fs.readFileSync(new URL('../electron/services/chat-attachment-service.mjs', import.meta.url), 'utf8')
  const preloadSource = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8')
  const chatToolCalls = fs.readFileSync(new URL('../src/components/ChatToolCalls.tsx', import.meta.url), 'utf8')
  const agentLoopPanel = fs.readFileSync(new URL('../src/components/AgentLoopPanel.tsx', import.meta.url), 'utf8')
  const chatScrollToBottom = fs.readFileSync(new URL('../src/components/ChatScrollToBottomButton.tsx', import.meta.url), 'utf8')
  const chatRunStore = fs.readFileSync(new URL('../src/services/chat-run-store.ts', import.meta.url), 'utf8')
  const dateTimeService = fs.readFileSync(new URL('../src/services/date-time.ts', import.meta.url), 'utf8')
  const conversationActions = fs.readFileSync(new URL('../src/components/ConversationActions.tsx', import.meta.url), 'utf8')
  const conversationJumpNav = fs.readFileSync(new URL('../src/components/ConversationJumpNav.tsx', import.meta.url), 'utf8')
  const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const desktopMain = fs.readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8')
  const databaseSource = fs.readFileSync(new URL('../electron/services/database.mjs', import.meta.url), 'utf8')
  const ipcSource = fs.readFileSync(new URL('../electron/ipc.mjs', import.meta.url), 'utf8')
  const capabilitySource = fs.readFileSync(new URL('../electron/services/agent-capability-service.mjs', import.meta.url), 'utf8')
  const autonomySource = fs.readFileSync(new URL('../electron/services/autonomy-runner.mjs', import.meta.url), 'utf8')
  const workspaceContextSource = fs.readFileSync(new URL('../electron/services/workspace-context.mjs', import.meta.url), 'utf8')
  const gatewayServiceSource = fs.readFileSync(new URL('../electron/services/zsense-gateway-service.mjs', import.meta.url), 'utf8')
  const agentCoreSource = fs.readFileSync(new URL('../electron/services/zsense-agent-core.mjs', import.meta.url), 'utf8')
  const dataSource = fs.readFileSync(new URL('../src/data.ts', import.meta.url), 'utf8')
  for (const view of ['memory', 'skills', 'models', 'activity']) {
    assert(!new RegExp(`id: '${view}'`).test(sidebar), `${view} 不应继续出现在主侧边栏`)
  }
  assert(!sidebar.includes("id: 'gateway'"), '消息网关不应继续作为独立主导航')
  assert(!app.includes("activeView === 'gateway'"), '应用不应继续渲染独立消息网关页面')
  assert(botWorkspace.includes('<GatewayPage embedded') && botWorkspace.includes('bots={gatewayBots}'), '完整消息网关没有嵌入当前 Bot 工作区')
  for (const prop of ['onSave={onSaveGateway}', 'onDelete={onDeleteGateway}', 'onLoadPairings={onLoadGatewayPairings}', 'onLoadAuthorizedUsers={onLoadAuthorizedUsers}', 'onApprovePairing={onApproveGatewayPairing}', 'onStartWeixinLogin={onStartWeixinLogin}', 'onRefreshRuntime={onRefreshRuntime}']) {
    assert(botWorkspace.includes(prop), `Bot 消息网关缺少完整操作：${prop}`)
  }
  assert(gatewayPage.includes('固定路由到当前 Bot') && gatewayPage.includes('gateway-authorized-panel'), 'Bot 消息网关没有锁定当前 Bot 或保留已授权用户详情')
  for (const portal of ['一键新建智能体应用', 'https://open-dev.dingtalk.com/fe/app#/corp/app', 'https://open.feishu.cn/app', "editingId === 'new' && applicationPortal", 'window.zsenseDesktop?.browser.openExternal']) {
    assert(gatewayPage.includes(portal), `飞书或钉钉机器人创建页缺少智能体应用入口：${portal}`)
  }
  assert(styles.includes('.gateway-app-create-card') && styles.includes('.gateway-app-create-icon'), '智能体应用跳转入口缺少适配样式')
  assert(overview.includes("onNavigate(runtime.runnable ? 'bots' : 'settings')"), '总览仍然指向已删除的全局消息网关')
  for (const section of ['AI 模型', '技能管理', '工具与 MCP', '浏览器', '记忆管理', '运行记录']) {
    assert(settings.includes(section), `${section} 没有进入设置二级导航`)
  }
  for (const text of ['设为全局', '当前全局模型', 'setAsGlobalModel', "apiKey: ''", 'clearApiKey: false', 'role="status"', 'role="alert"']) {
    assert(modelPage.includes(text), `AI 模型页缺少一键替换全局模型所需内容：${text}`)
  }
  assert(styles.includes('.saved-global-model-row') && styles.includes('.set-global-model-button'), '一键替换全局模型缺少列表或按钮样式')
  assert(databaseSource.includes('model_catalog_entries') && databaseSource.includes('syncModelCatalog'), '官网模型目录没有独立持久化')
  assert(databaseSource.includes('selectableSavedModelConfigurations') && databaseSource.includes('catalogModelKeys.has(key)'), '可用模型列表没有过滤官网已移除的旧模型')
  assert(ipcSource.includes('database.syncModelCatalog(catalog') && ipcSource.includes('workspace.availableModelConfigurations.find'), '官网模型目录没有接入对话执行链路')
  assert(app.includes('setAvailableModelConfigurations') && app.includes('applySnapshot(await unwrapDesktop(window.zsenseDesktop.data.loadWorkspace()))'), '前端获取官网模型后没有刷新统一可用模型状态')
  assert(app.includes('savedModelConfigurations={availableModelConfigurations}') && app.includes('models={availableModelConfigurations}'), '官网模型没有同步到对话、Bot 与定时任务选择器')
  assert(composerToolbar.includes('selectedModelOption?.contextWindow') && composerToolbar.includes('synchronizedContextMax'), '对话框没有使用已同步模型的上下文长度覆盖旧用量上限')
  assert(/function compactUsageLabel\(usage\?: ChatUsage\) \{[\s\S]*?return `\$\{Math\.round\(percent\)\}%`[\s\S]*?\}/.test(composerToolbar), '上下文缩略信息没有只显示使用百分比')
  const compactUsageBody = composerToolbar.match(/function compactUsageLabel\(usage\?: ChatUsage\) \{([\s\S]*?)\n\}/)?.[1] || ''
  assert(!compactUsageBody.includes('compactTokens'), '上下文缩略信息仍显示已使用 Token 数')
  assert(composerToolbar.includes('const fullUsageLabel = usageLabel(effectiveUsage)'), '上下文悬浮详情没有保留完整使用量')
  assert(modelPage.includes('上下文 ${compactContextWindow'), '模型页没有展示官网同步的上下文长度')
  assert(app.includes('availableConfigurations={availableModelConfigurations}') && modelPage.includes('<h2>可用模型</h2>') && modelPage.includes('visibleAvailableConfigurations.map'), 'AI 模型设置页没有展示官网同步后的统一可用模型')
  assert(modelPage.includes('catalogQuery') && modelPage.includes('deferredCatalogQuery') && modelPage.includes('model-catalog-search'), 'AI 模型设置页缺少即时搜索或延迟过滤')
  assert(modelPage.includes('catalogProvider') && modelPage.includes('catalogCredential') && modelPage.includes('visibleModelCount'), 'AI 模型设置页缺少供应商、凭证状态筛选或分批显示')
  assert(modelPage.includes('[configuration.provider, configuration.model, configuration.baseUrl, configuration.apiKeyName, configuration.updatedAt]'), '官网列表刷新不应因工作区快照对象更新而重置正在编辑的供应商和 API Key')
  for (const chatSource of [nativeChat, botChat]) {
    assert(chatSource.includes('<MarkdownMessage content={message.content} workspacePath={workspacePath} onOpenOfficeFile={openOfficeArtifact} onOpenBrowserUrl={openBrowserUrl} />'), '对话内容没有同时接入文件面板与会话浏览器')
  }
  assert(botChat.includes('<ChatMessageMeta') && nativeChat.includes('<ChatMessageMeta'), 'Bot 对话与 AI 对话没有共用消息时间和操作组件')
  assert(botChat.includes('createdAt: message.createdAt') && nativeChat.includes('createdAt: message.createdAt') && chatMessageMeta.includes("second: '2-digit'") && chatMessageMeta.includes('<time dateTime={dateTime}>'), '两类对话没有显示精确到秒的真实消息时间')
  assert(chatMessageMeta.includes('writeTextToClipboard(content)') && chatMessageMeta.includes("copied ? '已复制' : '复制'"), '消息复制功能或成功反馈未实装')
  assert(chatMessageMeta.includes('delete-message') && chatMessageMeta.includes('确认删除') && chatMessageMeta.includes('onDelete'), '每条消息底部缺少删除按钮或二次确认')
  assert(botChat.includes('onDelete={() => deleteMessage(message.id)}') && nativeChat.includes('onDelete={() => deleteMessage(message.id)}'), 'Bot 或 AI 对话没有接入单条消息删除')
  assert(preloadSource.includes('zsense:conversations:delete-message') && ipcSource.includes('deleteConversationMessage') && databaseSource.includes('deleteConversationMessage(conversationId, messageId)'), '单条消息删除没有贯通桌面桥、IPC 和数据库')
  assert(!settings.includes('Agent Loop 最大轮次') && !settings.includes('draft.agentMaxToolSteps') && !styles.includes('.policy-number-setting'), 'Agent Loop 最大轮次设置未完全移除')
  assert(!ipcSource.includes('agentMaxToolSteps') && agentCoreSource.includes('while (!machine.terminal())') && !agentCoreSource.includes('step < maxAgentToolSteps'), 'Agent Loop 尚未切换为无固定轮次的状态机')
  assert(chatMessageMeta.includes('再次提交') && chatMessageMeta.includes('onRegenerate') && botChat.includes('regenerateMessage(index + hiddenMessageCount)') && nativeChat.includes('regenerateMessage(index + hiddenMessageCount)'), 'Bot 或 AI 对话缺少再次提交功能')
  assert(botChat.includes('<div className="chat-message-author"><small>{delegatedAuthorByMessageId.get(message.id) ?') && botChat.includes(': bot.name}</small><AgentLoopTrigger') && nativeChat.includes(": 'ZSense Agent'}</small><AgentLoopTrigger"), 'Agent Loop 轮次没有放在回复名称右侧（/bot 委派回复要显示被委派 Bot 的名字）')
  assert(!nativeChat.includes("'ZSense AI'") && !nativeChat.includes('>ZSense AI<'), 'AI 对话回复仍显示旧的 ZSense AI 名称')
  assert(!composerToolbar.includes('在右侧预览和编辑'), '消息附件卡仍显示冗余的右侧预览说明')
  assert(officeArtifacts.includes("const HTML_ARTIFACT_EXTENSION = /\\.(?:html?|xhtml)$/i") && officeArtifacts.includes('isHtmlDocumentPath(filePath)') && officeArtifacts.includes('isPreviewableDocumentPath'), '历史 HTML 附件没有继续路由到右侧 HTML 预览编辑器')
  assert(styles.includes('.chat-message-actions button > span') && styles.includes('max-width: 0') && styles.includes('button:is(:hover, :focus-visible) > span'), '回复操作没有实现默认图标、悬浮或聚焦显示文字')
  assert(!chatMessageMeta.includes('usageLabel') && !chatMessageMeta.includes('chat-message-usage') && !botChat.includes('usageLabel={display.showUsage') && !nativeChat.includes('usageLabel={display.showUsage'), '回复底栏仍显示输入、输出或合计 Token 统计')
  assert(chatMessageMeta.includes("const modelLabel = model || (showModel ? '模型未记录' : '')") && !chatMessageMeta.includes('providerNames[modelProvider]'), '回复底栏没有只显示模型 ID')
  assert(styles.includes('.chat-message.assistant .chat-message-facts') && styles.includes('justify-content: flex-start') && styles.includes('flex-wrap: nowrap') && styles.includes('overflow-x: auto') && !styles.includes('.chat-response-usage'), '回复元信息没有在同一行左对齐，或窄窗口会截断内容')
  assert(clipboardService.includes('window.zsenseDesktop?.clipboard') && clipboardService.includes('navigator.clipboard?.writeText') && clipboardService.includes("document.execCommand('copy')"), '剪贴板没有按桌面桥接、浏览器 API、选区复制的顺序降级')
  assert(botChat.includes('<ConversationIdButton conversationId={conversationId}') && nativeChat.includes('<ConversationIdButton conversationId={activeConversationId}'), 'Bot 与 AI 对话右上角没有接入复制对话 ID 按钮')
  assert(conversationIdButton.includes('writeTextToClipboard(conversationId)') && conversationIdButton.includes('复制对话 ID') && conversationIdButton.includes('已复制 ID') && conversationIdButton.includes('等待生成 ID'), '复制对话 ID 的执行、成功反馈或未生成状态不完整')
  assert(!botChat.includes('ZSense Core 会话</span>') && !nativeChat.includes('ZSense 独立空间</span>'), '对话右上角仍保留旧的空间标识')
  assert(styles.includes('.conversation-id-button') && styles.includes('.conversation-id-button:focus-visible') && styles.includes('.conversation-id-button:disabled'), '复制对话 ID 按钮缺少样式、键盘焦点或禁用状态')
  assert(preloadSource.includes("invoke('zsense:clipboard:write-text', text)") && ipcSource.includes("'zsense:clipboard:write-text'") && ipcSource.includes('clipboard.writeText(payload)') && ipcSource.includes('clipboard.writeText(payload)\n    return true'), 'Electron 系统剪贴板桥接没有返回可识别的成功结果')
  assert(chatMessageMeta.includes('modelProvider') && chatMessageMeta.includes('耗时') && chatMessageMeta.includes('chat-message-model'), 'AI 回复没有显示实际模型或耗时')
  assert(chatMessageMeta.includes('formatTokenSpeed') && chatMessageMeta.includes('tokens/秒') && botChat.includes('outputTokens={message.role') && nativeChat.includes('outputTokens={message.role'), '两类对话没有显示每条 AI 回复的 Token 生成速度')
  assert(databaseSource.includes("this.#ensureColumn('messages', 'output_tokens'") && ipcSource.includes('outputTokens: result.usage?.outputTokens'), 'AI 回复的输出 Token 数没有持久化到本地数据库')
  assert(botChat.includes('<AgentLoopPanel') && nativeChat.includes('<AgentLoopPanel') && agentLoopPanel.includes('<ChatToolCalls'), 'Bot 对话与 AI 对话没有通过 Agent Loop 侧边卡片共用可折叠工具调用详情')
  assert(agentLoopPanel.includes("className={`agent-loop-step-summary ${stageResult ? 'has-stage-result' : ''}`}") && agentLoopPanel.includes('aria-expanded={open}') && agentLoopPanel.includes('{open && <div'), 'Agent Loop 轮次没有使用可控折叠按钮，展开内容可能不渲染')
  assert(!agentLoopPanel.includes('<details className={`agent-loop-step'), 'Agent Loop 轮次仍在使用容易出现展开空白的原生 details')
  assert(agentLoopPanel.includes("useState(step.status === 'running')") && !agentLoopPanel.includes("step.status === 'running' || latest"), '历史 Agent Loop 不应默认展开屏幕外的最后一轮')
  assert(agentLoopPanel.includes("setOpen(step.status === 'running')") && agentLoopPanel.includes('runningStep') && agentLoopPanel.includes('scrollIntoView') && agentLoopPanel.includes('data-agent-step={step.step}'), 'Agent Loop 没有自动折叠已完成轮次并滚动到当前执行轮次')
  assert(agentLoopPanel.includes('stageResultPreview(step)') && agentLoopPanel.includes('toolStageResult(lastTool)') && agentLoopPanel.includes("clippedStructuredField(rawOutput, 'stdout')") && agentLoopPanel.includes('agent-loop-step-preview') && agentLoopPanel.includes('agent-loop-step-heading') && agentLoopPanel.includes('阶段结果：') && styles.includes('-webkit-line-clamp: 3'), '折叠的 Agent Loop 轮次卡片没有把轮次、工具次数和耗时收进首行，或缺少阶段结果摘要与截断工具结果回退')
  for (const text of ['推理过程显示已关闭', '没有返回可展示的过程内容', '旧记录没有保存输入和输出详情']) assert(agentLoopPanel.includes(text), `Agent Loop 展开状态缺少明确提示：${text}`)
  assert(styles.includes('.agent-loop-step.is-open') && styles.includes('.agent-loop-step > .agent-loop-step-summary') && styles.includes('flex-direction: column') && styles.includes('.agent-loop-step {\n  flex: 0 0 auto;'), 'Agent Loop 可控展开状态缺少样式，或展开正文仍可能被固定 Grid 行高裁剪')
  for (const text of ['工具调用', '输入参数', '返回结果', 'chat-tool-group', 'chat-tool-detail']) assert(chatToolCalls.includes(text), `工具调用详情缺少${text}`)
  assert(botChat.includes('createChatQuote(bot.name') && nativeChat.includes("createChatQuote('ZSense Agent'") && botChat.includes('composerRef.current?.focus()') && nativeChat.includes('composerRef.current?.focus()'), '两类对话的 AI 回复引用功能没有写入并聚焦输入框')
  assert(styles.includes('.chat-message-meta') && styles.includes('.chat-message-actions button'), '消息时间与操作区缺少界面样式')
  assert(styles.includes('--sidebar-width: 208px') && styles.includes('.native-chat-sidebar-list { min-height: 0; max-height: none') && styles.includes('.native-chat-sidebar-section { min-height: 0;'), '左侧 AI 对话列表没有填满右下角剩余空间')
  for (const text of ['conversation-action-fan', 'conversation-action-toggle', 'aria-expanded={expanded}', 'conversation-action-item delete', 'conversation-action-item rename', 'conversation-action-item archive', 'title="删除对话"']) {
    assert(conversationActions.includes(text), `会话操作扇形菜单缺少：${text}`)
  }
  assert(conversationActions.includes('onRename(conversation.id') && conversationActions.includes('onArchive(conversation.id') && conversationActions.includes('onDelete(conversation.id)'), '会话操作没有保留重命名、归档和删除的真实操作')
  assert(styles.includes('.native-chat-sidebar-row:is(:hover, :focus-within) .conversation-action-toggle') && styles.includes('.conversation-actions:is(:hover, :focus-within, .is-expanded) .conversation-action-item') && styles.includes('translateX(calc(var(--conversation-action-step) * -2))') && styles.includes('.conversation-action-fan > button > svg { transition: none; }'), '会话操作缺少三点入口、悬浮展开动画或减少动态效果适配')
  assert(styles.includes('.conversation-action-toggle {') && styles.includes('opacity: 1;\n  pointer-events: auto;\n  visibility: visible;'), '会话列表的三点操作入口没有常驻显示')
  assert(styles.includes('0 0 40px color-mix(in srgb, var(--primary) 12%, transparent)') && styles.includes('background: var(--primary);\n  color: #fff;'), '会话列表三点按钮缺少与主题一致的蓝色发光悬停效果')
  assert(!conversationActions.includes('conversation-delete-direct') && !styles.includes('.conversation-delete-direct'), '删除按钮不应直接占用左侧会话列表空间')
  assert(styles.includes('--conversation-action-size: 30px') && styles.includes('--conversation-action-step: 34px') && styles.includes('.conversation-action-fan::before') && styles.includes('.conversation-actions:is(:hover, :focus-within, .is-expanded) .conversation-action-fan::before { pointer-events: auto; }'), '会话操作按钮没有缩小，或悬浮菜单缺少连续命中区域')
  assert(conversationActions.includes('<Pencil size={13}') && conversationActions.includes('<MoreHorizontal size={15}'), '会话操作图标没有使用紧凑尺寸')
  assert(!app.includes('className="top-create-button"'), '顶部不应保留重复的创建 Bot 按钮')
  assert(overview.includes('!voiceWakeEnabled && <button type="button" className="overview-voice-prompt"'), '语音未开启提示没有放在总览页右上角或没有按关闭状态显示')
  assert(overview.includes('语音唤醒未开启') && overview.includes('点击进入语音设置') && overview.includes('onOpenVoiceSettings'), '总览页语音提示没有提供清晰文案或语音设置入口')
  assert(app.includes("voiceInteraction.state !== 'idle' && <VoiceInteractionStatus"), '空闲时不应在侧栏额外显示语音交流状态条')
  assert(sidebar.indexOf('className={`icon-button workspace-settings') < sidebar.indexOf('<VoiceWakeToggle enabled='), '语音唤醒开关必须与设置同排并位于其右侧')
  assert(styles.includes('.workspace-switcher .workspace-settings { margin-left: auto; }') && styles.includes('.voice-wake-toggle.enabled'), '语音唤醒开关没有右对齐或缺少开启状态')
  assert(app.includes('voiceWakeEnabled: !settings.voiceWakeEnabled') && app.includes('onToggleVoiceWake={() => void toggleVoiceWake()}'), '侧栏语音图标没有切换并保存真实唤醒设置')
  assert(styles.includes('.overview-voice-prompt:focus-visible') && styles.includes('.overview-voice-prompt { width: 100%; }'), '总览语音提示缺少键盘焦点或窄窗口适配')
  assert(settings.includes('锁屏时继续运行') && settings.includes('不会阻止电脑锁屏') && settings.includes('draft.runWhileLocked'), '设置界面缺少锁屏运行开关或说明')
  // 访问范围不再有开关：Agent 固定为完全访问，破坏性操作仍逐次审批。
  assert(!settings.includes('允许完全访问') && !settings.includes('unrestrictedAgentAccess'), '设置界面不应再出现完全访问开关')
  assert(!composerToolbar.includes('完全访问') && !composerToolbar.includes('受限访问') && !composerToolbar.includes('unrestrictedAccess'), '对话输入栏不应再出现访问范围开关')
  assert(!nativeChat.includes('unrestrictedAgentAccess') && !botChat.includes('unrestrictedAgentAccess'), '对话页不应再传递访问范围状态')
  assert(!app.includes('updateUnrestrictedAgentAccess') && !app.includes('onUnrestrictedAccessChange'), 'App 不应再维护访问范围开关')
  assert(!ipcSource.includes('unrestrictedAgentAccess') && !databaseSource.includes('unrestrictedAgentAccess'), 'IPC 与数据库不应再保存访问范围设置')
  assert(capabilitySource.includes('unrestrictedAccess() {') && capabilitySource.includes('return true'), 'Agent 访问范围应固定为完全访问')
  assert(settings.includes('自动审批（模型判断）') && settings.includes('draft.autoApprovalEnabled') && settings.includes('onAutoApprovalEnabledChange'), '工具与 MCP 缺少自动审批开关')
  assert(settings.includes("onSectionChange('skills')") && settings.includes("onSectionChange('capabilities')") && settings.includes("onSectionChange('browser')"), '技能、工具与浏览器应是独立设置入口')
  assert(!settings.includes('settings-extension-tabs') && !settings.includes('扩展与技能'), '设置页不应保留扩展包分区')
  assert(settings.includes("section === 'skills' && <div className=\"settings-embedded-page\">{skillsPanel}</div>") && settings.includes("section === 'capabilities' && <AgentCapabilitiesPanel") && settings.includes("section === 'browser' && <BrowserSettingsPanel"), '三个设置页的路由与内容没有一一对应')
  assert(settings.includes('最近自动审批') && settings.includes('approvals?.autoApproval?.recent'), '缺少自动审批审计展示')
  assert(ipcSource.includes('autoApprovalEnabled: Boolean(settings.autoApprovalEnabled)') && databaseSource.includes('autoApprovalEnabled: true'), '自动审批开关缺少 IPC 校验，或默认值不再是“默认开启”')
  assert(capabilitySource.includes("category: 'filesystem:external-write'") && capabilitySource.includes('protectedDestructiveTarget'), '完全访问下文件工具安全边界仍然生效')
  assert(desktopMain.includes("powerSaveBlocker.start('prevent-app-suspension')") && desktopMain.includes('setBackgroundThrottling(!shouldKeepRunning)') && desktopMain.includes('onRunWhileLockedChanged: applyRunWhileLocked'), '锁屏运行设置没有连接桌面后台运行策略')
  assert(ipcSource.includes('onRunWhileLockedChanged(workspace.settings.runWhileLocked)'), '锁屏运行设置保存后没有立即应用')
  for (const text of ['工作区', '选择文件夹', '添加附件', '上下文', '当前模型', '推理强度', "value: 'none'", "value: 'low'", "value: 'high'", "value: 'max'"]) {
    assert(composerToolbar.includes(text), `对话输入区缺少${text}`)
  }
  assert(nativeChat.includes('<ChatComposerToolbar') && botChat.includes('<ChatComposerToolbar'), 'AI 对话和 Bot 对话必须共用完整输入工具栏')
  assert(nativeChat.includes('useChatAttachmentDrop') && botChat.includes('useChatAttachmentDrop') && nativeChat.includes('{...dropHandlers}') && botChat.includes('{...dropHandlers}'), 'Bot 与 AI 对话没有共用文件拖放入口')
  assert(attachmentService.includes('resolveDroppedAttachments(files)') && attachmentService.includes('mergeChatAttachments') && preloadSource.includes('webUtils.getPathForFile(file)') && ipcSource.includes("'zsense:chat:resolve-dropped-attachments'"), '拖入文件没有通过 Electron 安全路径解析与统一附件校验')
  assert(nativeChat.includes('useChatAttachmentPaste') && botChat.includes('useChatAttachmentPaste') && nativeChat.includes('onPaste={onPasteAttachments}') && botChat.includes('onPaste={onPasteAttachments}'), 'Bot 与 AI 对话输入框没有接入图片粘贴')
  assert(attachmentService.includes('resolvePastedAttachments(images, workspacePath)') && preloadSource.includes("invoke('zsense:chat:resolve-pasted-attachments'") && ipcSource.includes("'zsense:chat:resolve-pasted-attachments'") && desktopAttachmentService.includes('stagePastedImageAttachments'), '剪贴板图片没有通过 Electron 本地保存链路进入会话工作区')
  assert(botChat.includes('className="chat-composer bot-composer unified-composer"'), 'Bot 对话输入区没有与对话框等宽停靠')
  assert(nativeChat.includes('className="chat-composer native unified-composer"'), 'AI 对话没有使用统一输入布局')
  assert(botChat.includes('layout="composer"') && nativeChat.includes('layout="composer"'), '两类对话没有启用统一组合式布局')
  assert(styles.includes('linear-gradient(#ffffff, #ffffff) padding-box') && styles.includes('linear-gradient(135deg, #dbeafe') && styles.includes('.unified-composer .chat-send:active:not(:disabled)'), '对话输入框没有应用蓝色主题的参考样式和按压反馈')
  assert(styles.includes('--bg: #ffffff') && styles.includes('--primary: #2563eb') && styles.includes('--primary-soft: #eff6ff'), '应用没有统一使用白色背景与蓝色主题变量')
  assert(botChat.includes('<ChatComposerResizeHandle composerRef={composerContainerRef}') && nativeChat.includes('<ChatComposerResizeHandle composerRef={composerContainerRef}'), 'Bot 与 AI 对话没有共用输入框上边缘拖拽把手')
  for (const text of ['setPointerCapture', "event.key === 'ArrowUp'", "event.key === 'ArrowDown'", 'aria-valuenow={height}', 'onChatInputHeightChange', 'CHAT_COMPOSER_DEFAULT_HEIGHT = 88']) {
    assert(composerResizeHandle.includes(text), `输入框拉伸交互缺少：${text}`)
  }
  for (const text of ['CHAT_COMPOSER_AUTO_MIN_HEIGHT = 56', "addEventListener('scroll', onScroll", 'window.requestAnimationFrame(resizeFromScroll)', 'delta < -1', 'distanceFromBottom <= SCROLL_EDGE_TOLERANCE', 'animateToHeight(restingHeightRef.current, true)', "matchMedia('(prefers-reduced-motion: reduce)'"]) {
    assert(composerResizeHandle.includes(text), `输入框滚动收缩交互缺少：${text}`)
  }
  assert(botChat.includes('transcriptRef={scrollRef}') && nativeChat.includes('transcriptRef={transcriptRef}'), 'Bot 与 AI 对话没有把历史滚动区接入输入框自动收缩')
  assert(settings.includes('向上浏览历史时会临时收缩') && styles.includes('.is-scroll-collapsed .chat-composer-resize-handle'), '显示设置未说明自动收缩，或收缩状态缺少视觉反馈')
  for (const text of ['chat-compact-control', 'chat-control-summary', 'chat-control-detail', 'chat-workspace-detail', 'chat-reasoning-detail', 'chat-model-detail', 'chat-context-detail']) assert(composerToolbar.includes(text), `输入区底部控件缺少缩略或完整信息结构：${text}`)
  assert(styles.includes('.composer-layout .chat-compact-control:is(:hover, :focus-visible, :focus-within) > .chat-control-detail') && styles.includes('transform: translateY(0) scale(1)') && styles.includes('opacity: 1'), '输入区底部控件没有同时支持悬浮和键盘聚焦展开')
  assert(styles.includes('.composer-layout .chat-control-detail') && styles.includes('transition: opacity 160ms ease-out, transform 220ms') && styles.includes('@media (prefers-reduced-motion: reduce)') && styles.includes('.composer-layout .chat-control-detail,'), '底部控件展开动效没有使用稳定动画或适配减少动态效果')
  assert(!styles.includes('.chat-composer.unified-composer::before') && !styles.includes('@keyframes chat-composer-trail'), '整个输入框仍残留错误的悬浮描边或扫光动效')
  assert(styles.includes('.chat-composer.unified-composer > .chat-composer-resize-handle') && styles.includes('min-height: 0') && styles.includes('padding: 0') && styles.includes('justify-items: center') && styles.includes('cursor: ns-resize') && styles.includes('touch-action: none') && styles.includes('grid-template-rows: var(--chat-input-height, 88px) auto'), '输入框缺少顶部居中的拖拽边缘、通用样式隔离或紧凑默认高度')
  assert(databaseSource.includes("if (schemaVersion < 23)") && databaseSource.includes("UPDATE settings SET value='88'") && settings.includes('直接拖动输入框上边缘调整'), '旧版输入框高度没有迁移到紧凑默认值，或显示设置缺少拖拽说明')
  assert(botChat.includes('aria-label={`给 ${bot.name} 输入消息`}') && nativeChat.includes('aria-label="向 ZSense Agent 输入消息"'), '两类对话输入框缺少无障碍名称')
  for (const chatSource of [botChat, nativeChat]) {
    assert(chatSource.includes("event.key === 'Enter' && !event.shiftKey"), '普通 Enter 没有改为发送消息')
    assert(chatSource.includes('!nativeEvent.isComposing') && chatSource.includes('nativeEvent.keyCode !== 229'), 'Enter 发送没有避开中文输入法组词状态')
    assert(chatSource.includes('Enter 发送 · Shift + Enter 换行'), '输入框没有显示新的发送与换行快捷键')
    assert(!chatSource.includes('⌘/Ctrl + Enter 发送'), '输入框仍残留旧的发送快捷键')
  }
  assert(!nativeChat.includes('<button className="button primary" onClick={startNew}'), 'AI 对话新建页仍保留重复的新对话按钮')
  assert(!nativeChat.includes('onStartNew'), '已删除的 AI 对话新建按钮仍遗留无效回调')
  assert(composerToolbar.includes("<Plus size={layout === 'composer' ? 19 : 15}") && composerToolbar.includes('className="chat-control-summary attachment-summary"') && composerToolbar.includes("aria-label={picking ? '正在选择附件'"), '统一输入区的附件操作没有改成可访问的加号按钮')
  assert(styles.includes('.chat-attachment-button > .attachment-summary') && styles.includes('position: absolute') && styles.includes('place-items: center') && styles.includes('place-content: center'), '附件加号没有使用按钮内绝对居中定位')
  assert(composerToolbar.indexOf('className="chat-attachment-button"') < composerToolbar.indexOf('className={`chat-workspace-button'), '添加附件按钮没有放在输入工具栏最左侧')
  assert(composerToolbar.indexOf('chat-reasoning-select') < composerToolbar.indexOf('chat-model-select') && composerToolbar.indexOf('chat-model-select') < composerToolbar.indexOf('chat-context-usage'), '输入区控件源码顺序与视觉顺序不一致')
  assert(nativeChat.includes('<ConversationJumpNav') && botChat.includes('<ConversationJumpNav'), 'AI 对话和 Bot 对话没有共用快速跳转导航')
  assert(nativeChat.includes('<ChatScrollToBottomButton') && botChat.includes('<ChatScrollToBottomButton'), '两类会话都必须提供一键返回最底部按钮')
  assert(chatScrollToBottom.includes('> 120') && chatScrollToBottom.includes("scrollTo({ top: scrollRef.current.scrollHeight") && chatScrollToBottom.includes("prefers-reduced-motion: reduce"), '返回最底部按钮没有按历史滚动距离显示或缺少平滑滚动降级')
  assert(styles.includes('.chat-scroll-bottom') && styles.includes('.chat-scroll-bottom.with-side-panel') && styles.includes('.chat-scroll-bottom:focus-visible'), '返回最底部按钮缺少悬浮位置、Agent 面板避让或键盘焦点样式')
  assert(chatRunStore.includes("const runs = new Map<string, ChatRunSnapshot>()") && chatRunStore.includes('useSyncExternalStore') && chatRunStore.includes('moveChatRun'), '后台会话执行状态没有脱离单个对话组件持久保存')
  assert(!nativeChat.includes('onConversationChange(activeConversationId); onCancel') && /const close = \(\) => \{\s*onClose\(\)\s*\}/.test(botChat), '切换会话或关闭 Bot 对话仍可能隐式取消后台执行')
  assert(nativeChat.includes('updateChatRun(activeViewKeyRef.current') && botChat.includes('updateChatRun(activeViewKeyRef.current'), '追加指令或停止状态没有同步到后台会话执行状态')
  assert(botChat.includes("message.modelProvider || initialProvider") && botChat.includes("message.model || initialModel"), 'Bot 历史回复没有使用会话或全局模型兜底')
  assert(botChat.includes("showModel={message.role === 'assistant'}") && nativeChat.includes("showModel={message.role === 'assistant'}"), 'AI 回复在模型缺失时仍可能完全隐藏模型栏')
  assert(conversationJumpNav.includes('对话信息快速跳转') && conversationJumpNav.includes('scrollIntoView') && conversationJumpNav.includes("message.role !== 'user'"), '对话快速跳转没有按用户提问轮次建立导航')
  assert(conversationJumpNav.includes('IntersectionObserver') && conversationJumpNav.includes('chat-jump-preview') && conversationJumpNav.includes("aria-current={active ? 'step' : undefined}"), '历史对话导航没有实现刻度跟随、摘要预览和当前轮次状态')
  assert(botChat.includes('data-message-id={message.id}') && nativeChat.includes('data-message-id={message.id}'), 'Bot 与 AI 对话消息没有接入历史刻度跟随')
  assert(styles.includes('.chat-transcript-layout') && styles.includes('.chat-jump-nav') && styles.includes('.chat-jump-list') && styles.includes('.chat-jump-list button.active > i') && styles.includes('.chat-jump-preview'), '对话快速跳转缺少时间轴刻度或悬浮摘要样式')
  assert(!nativeChat.includes('NATIVE CHAT') && !nativeChat.includes('className="page-heading native-chat-heading"'), 'AI 对话新建页仍保留冗余抬头')
  assert(nativeChat.includes("const conversationTitle = activeConversation?.title.trim() || '新对话'") && nativeChat.includes('title={conversationTitle}>{conversationTitle}'), 'AI 对话页抬头没有显示当前会话名称')
  assert(!nativeChat.includes('<strong>ZSense AI</strong><small>'), 'AI 对话页仍在顶部显示固定 AI 名称和模型描述')
  assert(styles.includes('.composer-layout .chat-model-select') && styles.includes('max-width: 160px') && styles.includes('.composer-layout .chat-control-summary > strong') && styles.includes('text-overflow: ellipsis'), '对话模型选择器没有统一限宽和省略显示')
  assert(composerToolbar.includes('title={selectedModelLabel}'), '超长模型名省略后没有保留完整名称提示')
  assert(styles.includes('.page.native-chat-page') && styles.includes('height: calc(100dvh - var(--topbar-height))') && styles.includes('.native-chat-page .native-chat-main'), 'AI 对话没有贴齐工作区边界')
  assert(styles.includes('.chat-message-list .chat-message.user') && styles.includes('flex-direction: row-reverse') && styles.includes('.chat-message-list .chat-message.assistant'), '对话消息没有按用户右侧、AI 左侧排列')
  assert(styles.includes('.chat-message:focus { outline: none; }') && styles.includes('.chat-message:focus-visible { outline: 2px solid var(--primary);'), '鼠标点击消息仍会显示焦点边框，或键盘焦点缺少可见反馈')
  assert(nativeChat.includes('workspacePath={workspacePath}') && botChat.includes('workspacePath={workspacePath}'), '两类对话没有绑定独立工作区')
  assert(sidebar.includes('native-chat-sidebar-section') && sidebar.includes('AI 对话'), 'AI 对话记录没有进入左侧独立区域')
  assert(!nativeChat.includes('native-chat-history'), 'AI 对话主内容区不应继续保留历史记录面板')
  assert(overview.includes('defaultModelConfiguration') && overview.includes('modelLabel'), '总览没有解析 Bot 实际生效模型')
  assert(!overview.includes("'跟随全局默认模型'"), '总览不应再显示“跟随全局默认模型”')
  assert(app.includes('SessionProgressCenter') && app.includes('trackSessionEvent'), '铃铛没有接入会话流式进度')
  assert(sidebar.includes('aria-label={`查看会话进度') && !sidebar.includes('aria-label="查看运行记录"'), '左栏铃铛仍然指向运行记录')
  assert(sidebar.indexOf('className={`icon-button notification-button') < sidebar.indexOf('className={`icon-button workspace-settings'), '会话进度入口必须位于左栏设置按钮左侧')
  assert(styles.includes('--topbar-height: 0px') && styles.includes('.topbar {') && styles.includes('display: none;'), '桌面展开左栏时不应保留空白顶栏')
  for (const text of ['会话进度', '进行中', '已完成', '清除已结束']) assert(sessionProgressCenter.includes(text), `会话通知中心缺少${text}`)
  for (const text of ["addEventListener('pointerdown', dismissOutside, true)", "target.closest('.notification-button')", 'panelRef.current?.contains(target)', "event.key !== 'Escape'"]) {
    assert(sessionProgressCenter.includes(text), `会话通知中心缺少点击外部或键盘关闭逻辑：${text}`)
  }
  assert(nativeChat.includes("useState<ReasoningEffort>(() => activeConversation?.reasoningEffort || 'high')"), 'AI 对话默认推理强度不是 high')
  assert(botChat.includes("useState<ReasoningEffort>(conversation?.reasoningEffort || 'high')"), 'Bot 对话默认推理强度不是 high')
  for (const action of ['记忆详情', '修改长期记忆', '保存记忆', '确认删除']) assert(memoryDialog.includes(action), `记忆管理缺少${action}`)
  assert(dateTimeService.includes("new Intl.DateTimeFormat('zh-CN'") && dateTimeService.includes("${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}") && !dateTimeService.includes('toISOString()'), '记忆事件时间没有统一显示为本地 YYYY-MM-DD HH:mm:ss')
  assert(settings.includes('AI 对话记忆就在这里管理'))
  for (const [name, source] of Object.entries({ app, sidebar, settings, nativeChat, botChat, modelPage, overview, sessionProgressCenter, gatewayPage, firstRunSetup, skillsPage, dataSource, databaseSource, ipcSource, desktopMain, capabilitySource, autonomySource, workspaceContextSource, gatewayServiceSource, agentCoreSource })) {
    assert(!source.includes('原生'), `${name} 仍包含需要移除的旧界面术语`)
  }
  const workspaceHeaderActions = botWorkspace.match(/<div className="workspace-actions">([\s\S]*?)<\/section>/)?.[1] || ''
  assert(!workspaceHeaderActions.includes('className="button secondary"'), 'Bot 页面左侧不应保留重复的启停按钮')
  assert(botActionsMenu.includes('暂停 Bot') && botActionsMenu.includes('启动 Bot'), 'Bot 三点菜单必须保留启停操作')
  assert(botWorkspace.includes('<BotActionsMenu') && botsPage.includes('<BotActionsMenu'), 'Bot 列表和详情页没有复用同一套三点管理菜单')
  assert(!botWorkspace.includes('开始新对话'), '最近对话标题仍保留重复的开始新对话按钮')
  assert(botsPage.includes("conversation.kind === 'bot' && conversation.botId === bot.id"), 'Bot 卡片没有按真实会话表统计累计会话')
  for (const text of ['上午好', '下午好', '晚上好', '欢迎来到专属于你的 ZSense 空间', 'overview-panel-actions']) assert(overview.includes(text), `总览缺少${text}`)
  for (const text of ['overview-bot-card-main', 'overview-bot-card-details', '累计对话', '独立记忆', 'aria-hidden="true"']) assert(overview.includes(text), `总览 Bot 折叠卡片缺少${text}`)
  assert(skillsPage.includes('aria-label={`打开 ${skill.name} 的技能目录`}') && skillsPage.includes('<span>目录</span>'), '技能目录操作缺少明确的按钮名称或可访问标签')
  assert(styles.includes('.skill-row-actions { min-width: 0; width: 100%; display: grid; grid-template-columns: repeat(auto-fit, minmax(32px, 1fr));') && styles.includes('.skill-row-actions .table-action { width: 100%; min-width: 0; }'), '技能操作区没有使用紧凑的自适应单行网格')
  assert(styles.includes('.skill-list { container: skill-list / inline-size; }') && styles.includes('@container skill-list (max-width: 820px)') && styles.includes('.skill-row-actions .table-action span { display: inline; }'), '技能列表没有按面板自身宽度切换布局，嵌入设置页时仍可能裁掉操作')
  assert(!skillsPage.includes('可编辑管理') && skillsPage.includes('所有技能都可以编辑和管理') && skillsPage.includes('编辑过的内置技能会转为手动维护'), '技能页的统计卡或编辑管理权限说明不符合预期')
  assert(!skillsPage.includes('SourceFilter') && skillsPage.includes("selectedScope === 'mine'") && !skillsPage.includes('selectedPackage'), '技能范围应只包含全部、内置和我的技能')
  const skillListMarkup = skillsPage.match(/<section className="skill-list panel"[\s\S]*?<\/section>/)?.[0] || ''
  assert(!skillListMarkup.includes('来源与维护') && !skillListMarkup.includes('skill-source-cell'), '技能列表仍显示用户要求删除的来源与维护列')
  const maintenanceNote = skillsPage.match(/<section className="skill-maintenance-note">([\s\S]*?)<\/section>/)?.[1] || ''
  assert(!maintenanceNote.includes('<ExternalLink'), '技能维护说明右侧仍保留无功能的外部链接图标')
  for (const text of ['运行与数据状态', '本地隔离空间', '由应用托管', 'Bot 对话', '独立记忆', '健康网关', '自动巡检', '最近巡检', '自动恢复', '全局模型']) assert(overview.includes(text), `总览运行与数据状态缺少${text}`)
  for (const selector of ['.workspace-health-badges', '.workspace-health-metrics', '.workspace-health-details', '.workspace-health-attention']) assert(styles.includes(selector), `总览运行与数据状态缺少样式${selector}`)
  assert(styles.includes('grid-template-columns: repeat(3, minmax(0, 1fr))') && styles.includes('.overview-bot-card:is(:hover, :focus-visible) .overview-bot-card-details'), '总览 Bot 卡片没有缩成三列或缺少悬浮与键盘展开效果')
  assert(styles.includes('@media (hover: none)') && styles.includes('.overview-bot-card-details { opacity: 1; pointer-events: auto; transform: none; }'), '总览 Bot 卡片在触屏设备上无法读取完整信息')
  assert(styles.includes('.overview-bot-card-main,') && styles.includes('.overview-bot-card-details,'), '总览 Bot 卡片动效没有适配减少动态效果')
  assert(userManagement.includes("type={lockPasswordVisible ? 'text' : 'password'}") && userManagement.includes("type={lockConfirmationVisible ? 'text' : 'password'}"), '安全锁密码的两个输入框没有独立显示或隐藏状态')
  assert(userManagement.includes("aria-label={lockPasswordVisible ? '隐藏安全锁密码' : '显示安全锁密码'}") && userManagement.includes("aria-label={lockConfirmationVisible ? '隐藏确认密码' : '显示确认密码'}") && userManagement.includes('aria-pressed={lockPasswordVisible}') && userManagement.includes('aria-pressed={lockConfirmationVisible}'), '安全锁密码显示按钮缺少可访问名称或按下状态')
  assert(styles.includes('.user-password-input button:focus-visible') && styles.includes('grid-template-columns: minmax(0, 1fr) 44px'), '安全锁密码显示按钮缺少键盘焦点或足够的点击区域')
  assert(!app.includes("from './components/AuthPage'") && !app.includes('<AuthPage'), '应用登录页仍然存在于启动流程')
  assert(userManagement.includes('重置安全锁密码') && userManagement.includes('setLockPassword') && userManagement.includes('不再使用账号密码') && !userManagement.includes('users.resetPassword') && !settings.includes('退出登录'), '账号密码没有移除，或安全锁密码入口没有完成重构')
  assert(userManagement.includes('user-security-grid') && userManagement.includes('identity-list') && userManagement.includes('配置导入与导出'), '本机与安全页面没有完成紧凑分区重构')
  assert(html.includes('<title>ZSense</title>') && desktopMain.includes("title: 'ZSense'"), '应用名称仍包含 Agent Studio')
  for (const detailText of ['查看详情', '精确时间戳', '完整操作说明', '操作详细信息']) assert(settings.includes(detailText), `运行记录缺少${detailText}`)
  for (const copyText of ['formatActivityForCopy', 'writeActivityToClipboard', 'writeTextToClipboard(text)', '一键复制', '请帮我分析以下 ZSense 运行记录', '运行记录已复制到剪贴板']) assert(settings.includes(copyText), `运行记录一键复制缺少${copyText}`)
  assert(settings.match(/<ActivityCopyButton activity=\{activity\} bot=\{bot\} conversation=\{group\.conversation\}/g)?.length === 2, '普通事件与折叠工具明细没有同时提供一键复制')
  assert(settings.includes('<ActivityCopyButton activity={activity} bot={bot} conversation={conversation} variant="dialog" />'), '运行记录详情弹窗没有提供一键复制')
  for (const text of ['conversationFilter', 'startDate', 'endDate', '按会话名称筛选', '默认按会话汇总', 'audit-tool-details', '默认折叠']) assert(settings.includes(text), `运行记录筛选或会话聚合缺少${text}`)
  assert(settings.includes('segmented activity-type-filter'), '运行记录分类筛选缺少稳定布局标记')
  assert(styles.includes('grid-template-columns: minmax(220px, 320px)') && styles.includes('.activity-toolbar .search-field { width: 100%; max-width: 320px; }'), '运行记录筛选栏没有使用受限搜索宽度的稳定栅格布局')
  assert(styles.includes('.audit-copy-trigger') && styles.includes('.activity-copy-button'), '运行记录一键复制缺少列表或弹窗样式')
  for (const text of ['已注册能力工具', 'MCP 本次运行已验证', '运行中子 Agent', '每 8 秒自动刷新', '自主任务', 'Goal、Loop 和 Heartbeat', '立即运行']) assert(settings.includes(text), `工具与 MCP 设置页缺少迁移入口：${text}`)
  for (const text of ['技能管理', '导入 SKILL.md', '导入技能文件夹', '检查技能更新', '分配']) assert(skillsPage.includes(text), `技能管理页面缺少入口：${text}`)
  assert(!skillsPage.includes('导入扩展包') && !skillsPage.includes('OpenAI 兼容包') && !skillsPage.includes('plugins.'), '技能管理页不应再提供扩展包或插件兼容入口')
  for (const text of ['审批与自动放行', '自动放行', '需要审批', '始终禁止', '已记住的授权', '撤销全部']) assert(settings.includes(text), `工具与 MCP 设置页缺少审批策略入口：${text}`)
  assert(capabilitySource.includes("'仅允许这一次 (Recommended)'") && capabilitySource.includes("'始终允许此类操作'") && capabilitySource.includes('requestApproval(context'), 'Agent 审批没有统一为单次、长期授权与拒绝三种选择')
  assert(capabilitySource.includes("'workspace:delete'") && capabilitySource.includes("category: 'terminal:dependencies'") && capabilitySource.includes('needsApproval: false'), '低打扰审批分级没有区分普通工作区操作与重大操作')
  assert(agentCoreSource.includes('while (!machine.terminal())') && agentCoreSource.includes('持续无进展保护') && agentCoreSource.includes('现在禁止继续调用工具') && !agentCoreSource.includes('MAX_AGENT_TOOL_STEPS'), 'Agent Loop 没有改为无固定轮次且仅在持续无进展时收尾')
  for (const channel of ['zsense:capabilities:autonomy', 'zsense:capabilities:autonomy-manage']) {
    assert(ipcSource.includes(channel) && preloadSource.includes(channel), `桌面桥接缺少 ${channel}`)
  }
  assert(!ipcSource.includes('zsense:plugins:') && !preloadSource.includes('zsense:plugins:'), '插件 IPC 通道仍然可被调用')
  assert(!desktopMain.includes('PluginService') && !capabilitySource.includes('pluginService') && !agentCoreSource.includes('runHook('), '应用启动或 Agent Loop 仍在加载插件代码')
  assert(ipcSource.includes('zsense:capabilities:approval-revoke') && preloadSource.includes('zsense:capabilities:approval-revoke'), '已记住授权缺少桌面撤销桥接')
  for (const tool of ['list_files', 'read_file', 'write_file', 'patch_file', 'copy_file', 'move_file', 'delete_path', 'terminal', 'process_manage', 'web_extract', 'browser_navigate', 'checkpoint_manage', 'session_search', 'context_reference', 'tool_search', 'toolset_manage', 'mcp_manage', 'todo_manage', 'goal_manage', 'loop_manage', 'heartbeat_manage']) assert(capabilitySource.includes(`tool('${tool}'`), `Agent Core 缺少迁移工具 ${tool}`)
  assert(autonomySource.includes("task.kind === 'heartbeat'") && autonomySource.includes('NO_CHANGE') && autonomySource.includes("channelId: 'scheduled'"), '自治任务恢复、静默心跳或隐藏会话未实现')
  assert(styles.includes('.skills-source-tabs') && styles.includes('.autonomy-list'), '技能范围与自主任务面板缺少界面样式')
  assert(app.includes('SIDEBAR_COLLAPSED_STORAGE_KEY') && app.includes("sidebarCollapsed ? 'sidebar-collapsed' : ''") && app.includes('aria-label="展开左侧导航"'), '左侧导航折叠状态未持久化或缺少恢复按钮')
  assert(styles.includes('.app-shell.sidebar-collapsed { --sidebar-width: 0px; --topbar-height: 48px; }') && styles.includes('width: 208px') && styles.includes('.app-shell.sidebar-collapsed .sidebar { visibility: hidden; transform: translateX(-100%); pointer-events: none;'), '左侧导航折叠后没有完整隐藏或释放主内容区域')
  assert(styles.includes('.sidebar-collapse') && styles.includes('.desktop-sidebar-open'), '左侧导航缺少折叠或展开按钮样式')
  assert(sidebar.includes("collapsed && !mobileOpen ? { inert: '' } : {}"), '折叠后的左侧导航仍可能被键盘焦点访问')

  console.log(JSON.stringify({
    ok: true,
    settingsNavigation: true,
    nativeProfileIsolated: true,
    nativeMemoryIsolated: true,
    nativeMemoryCrud: true,
    explicitMemoryActions: true,
    oneClickGlobalModelSwitch: true,
    officialCatalogSyncedToSelectors: true,
    liveBotSnapshotAfterDeletion: true,
    markdownRendererConnected: true,
    chatMessageTimestampCopyAndQuoteShared: true,
    conversationActionFanAccessible: true,
    duplicateTopCreateRemoved: true,
    composerControlsShared: true,
    composerAutoCollapseOnHistoryScroll: true,
    composerControlHoverDisclosure: true,
    botComposerDocked: true,
    nativeComposerUnified: true,
    nativeChatEdgeToEdge: true,
    nativeConversationTitleInHeader: true,
    compactModelSelector: true,
    conversationQuickJump: true,
    attachmentActionFirst: true,
    conversationalMessageAlignment: true,
    nativeHistoryMovedToSidebar: true,
    effectiveModelShownOnOverview: true,
    sessionProgressCenterConnected: true,
    lowFrictionApprovalPolicy: true,
    resilientAgentLoopFinalization: true,
    defaultReasoningHigh: true,
    botStatusOnlyInOverflowMenu: true,
    activityTimestampAndDetails: true,
    activityCopyForAi: true,
    botHistoricalModelRecovered: true,
    hermesMigrationBatchesOneToThree: true,
    skillAndAutonomyManagement: true,
    runWhileLockedConnected: true,
    collapsibleSidebar: true,
  }))
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
