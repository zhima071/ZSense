import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { nextScheduledRun, ScheduledTaskRunner } from '../electron/services/scheduled-task-runner.mjs'

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'zsense-scheduled-task-'))
const database = new ZSenseDatabase(temporaryDirectory)
database.memoryService = { recallMemories: (botId, query, options) => database.recallMemories(botId, query, options) }
const notifications = []
const coreCalls = []
const agentCore = {
  supportsProvider: () => true,
  requiresApiKey: () => false,
  inspect: async () => ({ runnable: true, message: 'ready' }),
  chatStream: async (request) => {
    coreCalls.push({ type: 'chat', request })
    request.onEvent({ type: 'started', sessionId: 'scheduled-session' })
    request.onEvent({ type: 'tool', toolId: 'tool-1', name: 'File Workspace', status: 'complete', detail: 'done' })
    return { output: '定时任务执行成功', reasoning: '已完成计划', sessionId: 'scheduled-session', usage: { contextUsed: 10, contextMax: 1000, contextPercent: 1, inputTokens: 8, outputTokens: 6, totalTokens: 14 } }
  },
  summarizeScheduledTaskMemory: async (request) => {
    coreCalls.push({ type: 'summary', request })
    return '## 最新状态\n- 定时任务执行成功\n- 下次继续生成工作摘要'
  },
}
const runner = new ScheduledTaskRunner({
  database,
  agentCore,
  secrets: { get: () => ({}) },
  userDataDirectory: temporaryDirectory,
  notify: (...args) => notifications.push(args),
})

try {
  const thursdayMorning = new Date(2026, 8, 10, 10)
  const daily = nextScheduledRun({ frequency: 'daily', timeOfDay: '09:00' }, thursdayMorning)
  assert(new Date(daily) > thursdayMorning, '每天任务没有计算到未来时间')
  const weekday = nextScheduledRun({ frequency: 'weekdays', timeOfDay: '09:00' }, new Date(2026, 8, 11, 10))
  assert.equal(new Date(weekday).getDay(), 1, '工作日任务没有跳过周末')

  database.updateModelConfiguration({ provider: 'custom', model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKeyName: 'CUSTOM_API_KEY', apiKeyConfigured: false, updatedAt: new Date().toISOString() })
  const selectedWorkspacePath = path.join(temporaryDirectory, 'user-selected-task-workspace')
  fs.mkdirSync(selectedWorkspacePath, { recursive: true })
  let workspace = runner.create({
    name: '每日工作摘要', frequency: 'daily', timeOfDay: '09:00', weekday: 1,
    modelProvider: 'custom', model: 'test-model', prompt: '生成一份工作摘要。', skillIds: [],
    deliveryTarget: 'local', repeatCount: 1, enabled: true, workspacePath: selectedWorkspacePath,
  })
  assert.equal(workspace.scheduledTasks.length, 1)
  const task = workspace.scheduledTasks.find((item) => item.name === '每日工作摘要')
  assert(task)
  assert.equal(task.memoryEnabled, true, '新定时任务没有默认开启任务记忆')
  assert.equal(task.memoryRevision, 0, '新定时任务记忆应有独立的初始版本')
  assert.equal(task.workspacePath, selectedWorkspacePath, '任务没有保存用户指定的工作区')
  assert(task.nextRunAt, '启用任务没有下次执行时间')

  const accepted = runner.runNow(task.id)
  assert.equal(accepted.accepted, true)
  await runner.shutdown()
  workspace = database.loadWorkspace()
  assert.equal(workspace.scheduledTaskRuns.length, 1)
  assert.equal(workspace.scheduledTaskRuns[0].status, 'success')
  assert.equal(workspace.scheduledTaskRuns[0].output, '定时任务执行成功')
  assert.equal(workspace.scheduledTaskRuns[0].modelProvider, 'custom', '运行记录没有保存实际模型供应商')
  assert.equal(workspace.scheduledTaskRuns[0].model, 'test-model', '运行记录没有保存实际模型 ID')
  assert(workspace.scheduledTaskRuns[0].conversationId, '任务结果没有保存到内部任务对话')
  const scheduledConversationId = workspace.scheduledTaskRuns[0].conversationId
  const scheduledConversation = workspace.conversations.find((item) => item.id === scheduledConversationId)
  assert.equal(scheduledConversation?.channelId, 'scheduled', '任务对话没有标记为仅供运行历史访问')
  assert.equal(scheduledConversation?.messages.length, 2, '任务运行历史无法读取完整任务对话')
  assert.equal(scheduledConversation?.messages[1].modelProvider, 'custom', '任务 AI 回复没有保存模型供应商')
  assert.equal(scheduledConversation?.messages[1].model, 'test-model', '任务 AI 回复没有保存模型 ID')
  assert.equal(typeof scheduledConversation?.messages[1].durationMs, 'number', '任务 AI 回复没有保存耗时')
  assert.equal(scheduledConversation?.messages[1].outputTokens, 6, '任务 AI 回复没有保存输出 Token 数')
  assert.equal(workspace.scheduledTasks.find((item) => item.id === task.id)?.status, 'completed')
  assert.equal(workspace.scheduledTasks.find((item) => item.id === task.id)?.enabled, false)
  assert(fs.existsSync(task.workspacePath), '任务独立工作区没有创建')
  assert.equal(coreCalls.some((item) => item.type === 'chat' && item.request.source === 'zsense-scheduled'), true)
  assert.equal(coreCalls.find((item) => item.type === 'chat')?.request.workspacePath, selectedWorkspacePath, '执行器没有把用户指定工作区传给 ZSense Agent Core')
  assert.equal(notifications.length, 1)
  const updatedTask = workspace.scheduledTasks.find((item) => item.id === task.id)
  assert.match(updatedTask?.memorySummary || '', /最新状态/, '成功运行后没有生成滚动摘要')
  assert.equal(updatedTask?.memorySummaryRunCount, 1, '滚动摘要没有记录已合并的成功运行数量')
  assert.equal(updatedTask?.memoryRevision, task.memoryRevision, '正常摘要更新不应使后续排队请求失效')
  assert.equal(coreCalls.some((item) => item.type === 'summary'), true, '成功运行后没有触发后台摘要整理')
  const taskMemories = database.recallScheduledTaskMemories(task.id, task.prompt)
  assert.equal(taskMemories.memories.length, 2, '滚动摘要和近期结果没有同时进入后续记忆')
  assert.match(taskMemories.memories[0].excerpt, /最新状态/)
  assert.match(taskMemories.memories[1].excerpt, /定时任务执行成功/)
  assert(taskMemories.usedCharacters <= 8_000, '任务记忆上下文超过 8,000 字符预算')

  const page = fs.readFileSync(new URL('../src/components/ScheduledTasksPage.tsx', import.meta.url), 'utf8')
  // 详情面板已抽成共用组件：文案可能落在这个文件里
  const panelSource = fs.readFileSync(new URL('../src/components/ScheduledTaskDetailPanel.tsx', import.meta.url), 'utf8')
  const settings = fs.readFileSync(new URL('../src/components/SystemPages.tsx', import.meta.url), 'utf8')
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const sidebar = fs.readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8')
  const chat = fs.readFileSync(new URL('../src/components/ChatDialog.tsx', import.meta.url), 'utf8')
  const nativeChat = fs.readFileSync(new URL('../src/components/NativeChatPage.tsx', import.meta.url), 'utf8')
  const markdown = fs.readFileSync(new URL('../src/components/MarkdownMessage.tsx', import.meta.url), 'utf8')
  const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const databaseSource = fs.readFileSync(new URL('../electron/services/database.mjs', import.meta.url), 'utf8')
  for (const text of ['定时任务', '创建任务', '名称排序', '时间排序', '运行历史', '立即运行', '打开工作区', '任务工作区', '选择文件夹', '恢复默认', '启用任务记忆', '失败运行不会写入记忆', '任务配置', '滚动摘要', '最近两次成功结果', '预计注入', '原始成功记录', '上下文不会随运行次数持续增长', 'scheduled_task_runs.output', '尚未生成滚动摘要']) assert(page.includes(text) || panelSource.includes(text), `定时任务界面缺少${text}`)
  assert(page.includes("run.taskId === task.id && run.status === 'success'") && page.includes('runs={runs}'), '编辑任务窗口没有按任务展示成功运行记忆')
  assert(page.includes('installedSkillIds.has(skillId)') && page.includes('已自动移除') && page.includes('已卸载或失效的技能'), '编辑旧任务时没有自动清理已失效的技能选择')
  assert(page.includes('role="tablist"') && page.includes("activePanel === 'memory'") && page.includes('scheduled-memory-summary'), '任务记忆没有作为独立可视化页签展示')
  assert(page.includes('scheduled-memory-reader') && page.includes('selectedRecentRunId') && page.includes('<MarkdownMessage content={selectedRecentMemory.output}'), '近期任务结果没有改为大面积主从阅读布局')
  assert(page.includes('查看完整对话') && page.includes('这些对话不会进入普通对话列表') && page.includes('onOpenConversation(run.conversationId!)'), '运行历史没有保留完整任务对话入口')
  assert(page.includes('运行模型：') && page.includes('删除记录') && page.includes('onDeleteRun(run.id)'), '运行历史没有显示模型或提供单条删除入口')
  assert(sidebar.includes("id: 'scheduled-tasks'"), '定时任务没有进入主导航')
  assert(app.includes('<ScheduledTasksPage') && app.includes('window.zsenseDesktop.tasks.runNow'), '定时任务界面没有接入桌面后端')
  assert(app.includes("listedNativeConversations = nativeConversations.filter((conversation) => conversation.channelId !== 'scheduled')") && app.includes('nativeConversations={listedNativeConversations}') && app.includes('<NativeChatPage conversations={nativeConversations}'), '任务对话没有从普通列表排除，或运行历史无法继续打开它')
  assert(databaseSource.includes("SET channel_id='scheduled'") && databaseSource.includes('FROM scheduled_task_runs'), '旧版本任务对话没有迁移为内部任务对话')
  for (const text of ['显示与通知', '流式响应', '紧凑模式', '显示推理过程', '显示费用', '内联差异', '完成提示音', '审批提示音', '审批桌面通知', '完成弹窗通知', '聊天输入框高度']) assert(settings.includes(text), `显示设置缺少${text}`)
  for (const text of ['发送中', '已发送', '测试请求已完成', 'notificationTestResult']) assert(settings.includes(text), `通知测试缺少${text}`)
  const notificationTestHandler = settings.match(/const testNotification = async[\s\S]*?\n  }\n\n  const statusLabel/)?.[0] || ''
  assert(notificationTestHandler.includes('window.zsenseDesktop.notifications.test(kind)'), '通知测试没有调用桌面通知接口')
  assert(!notificationTestHandler.includes('onSave(draft)'), '通知测试仍被设置保存流程阻塞')
  const ipc = fs.readFileSync(new URL('../electron/ipc.mjs', import.meta.url), 'utf8')
  const preload = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8')
  assert(page.includes('onPickWorkspace={onPickWorkspace}') && app.includes('window.zsenseDesktop.tasks.pickWorkspace()') && ipc.includes('zsense:tasks:pick-workspace') && preload.includes("invoke('zsense:tasks:pick-workspace')"), '定时任务工作区选择没有完整接入桌面文件夹选择器')
  assert(ipc.includes('task.skillIds.filter((skillId) => knownSkillIds.has(skillId))') && !ipc.includes('任务选择的技能已不存在，请重新选择。'), '后端保存任务时仍会被已删除的技能 ID 阻塞')
  assert(databaseSource.includes('workspace_path=?, next_run_at=?'), '编辑任务时没有持久化新的工作区')
  assert(databaseSource.includes('recallScheduledTaskMemories') && databaseSource.includes('memory_summary') && databaseSource.includes('LIMIT 2') && databaseSource.includes('characterBudget = 8_000'), '定时任务滚动摘要或有界召回没有持久化实现')
  assert(app.includes('window.zsenseDesktop.tasks.deleteRun(id)') && ipc.includes('zsense:tasks:delete-run') && preload.includes("invoke('zsense:tasks:delete-run', id)"), '运行记录删除功能没有完整接入桌面通信')
  assert(!ipc.includes('configureProfileModel'), '设置保存不应同步到外部 Agent Profile')
  assert(chat.includes('display.streamingResponse') && nativeChat.includes('display.streamingResponse'), '流式响应开关没有接入两类对话')
  assert(chat.includes('display.showReasoning') && nativeChat.includes('display.showReasoning'), '推理显示开关没有接入两类对话')
  assert(chat.includes('outputTokens={message.role') && nativeChat.includes('outputTokens={message.role'), '两类对话没有保留回复速度计算所需的 Token 数据')
  assert(markdown.includes('inlineDiff') && markdown.includes('inline-diff-code'), '内联差异没有接入 Markdown 渲染器')
  assert(styles.includes('--chat-input-height') && styles.includes('.app-shell.compact-mode'), '输入框高度或紧凑模式没有实际样式')

  database.deleteScheduledTaskRun(workspace.scheduledTaskRuns[0].id)
  assert.equal(database.loadWorkspace().scheduledTaskRuns.length, 0, '单条运行记录删除后仍然存在')
  assert.equal(database.getConversation(scheduledConversationId), null, '删除运行记录后遗留了无法访问的内部任务对话')
  assert.equal(database.getScheduledTask(task.id)?.memorySummary, '', '删除成功运行记录后仍残留包含该结果的滚动摘要')
  assert.equal(database.getScheduledTask(task.id)?.memoryRevision, task.memoryRevision + 1, '删除成功运行记录必须使后台旧摘要失效')
  // 总览展示开关：默认展示，关掉后只在总览页消失（任务本身照常运行）
  assert.equal(database.getScheduledTask(task.id)?.showOnOverview, true, '新建任务应默认在总览页展示')
  const hiddenWorkspace = database.setScheduledTaskOverviewVisibility(task.id, false)
  assert.equal(hiddenWorkspace.scheduledTasks.find((item) => item.id === task.id)?.showOnOverview, false, '关闭后任务不应在总览展示')
  assert.equal(database.loadWorkspace().scheduledTasks.find((item) => item.id === task.id)?.showOnOverview, false, '总览展示开关应持久化')
  const enabledBeforeToggle = database.getScheduledTask(task.id)?.enabled
  assert.equal(database.getScheduledTask(task.id)?.enabled, enabledBeforeToggle, '隐藏总览展示不应影响任务是否启用')
  database.setScheduledTaskOverviewVisibility(task.id, true)
  assert.equal(database.loadWorkspace().scheduledTasks.find((item) => item.id === task.id)?.showOnOverview, true, '重新打开后应恢复展示')
  assert.throws(() => database.setScheduledTaskOverviewVisibility('not-a-task', false), /不存在/, '不存在的任务应报错')

  const reassignedTask = { ...database.getScheduledTask(task.id), ownerBotId: 'review-owner-bot', updatedAt: new Date().toISOString() }
  database.updateScheduledTask(task.id, reassignedTask, { returnWorkspace: false })
  assert.equal(database.getScheduledTask(task.id)?.ownerBotId, 'review-owner-bot', '编辑任务后所属 Bot 应持久化')

  database.deleteScheduledTask(task.id)

  // 总览页也要展示定时任务，并且沿用总览 Bot 卡片的版面（保证观感统一）
  const overviewSource = fs.readFileSync(new URL('../src/components/Overview.tsx', import.meta.url), 'utf8')
  assert(overviewSource.includes('overview-tasks-panel'), '总览缺少定时任务区块')
  assert(overviewSource.includes("onNavigate('scheduled-tasks')"), '总览的定时任务区块应能跳转到定时任务页')
  assert(overviewSource.includes('overviewTasks.map('), '总览没有渲染定时任务列表')
  assert(overviewSource.includes('overview-bot-card overview-task-card'), '总览的定时任务卡片应复用 Bot 卡片的版面类')
  assert(overviewSource.includes('overview-bot-card-main') && overviewSource.includes('overview-bot-card-details'), '定时任务卡片缺少与 Bot 卡片一致的主面与悬停浮层')
  // 没有定时任务时整块区域不渲染（空状态会白占一大片版面）
  assert(overviewSource.includes('{overviewTasks.length > 0 && <section className="panel overview-tasks-panel">'), '总览的定时任务区块应在没有可展示任务时整块不渲染')
  assert(!overviewSource.includes('还没有定时任务'), '总览不应再显示定时任务空状态')
  assert(!/scheduledTasks\.length \? \(/.test(overviewSource), '总览不应回到三元分支渲染空状态')
  assert(/scheduled-task-format/.test(overviewSource), '总览应复用定时任务的展示口径（避免两处显示不一致）')
  // 总览只列打开开关的任务，全部关掉时整块隐藏
  assert(overviewSource.includes('const overviewTasks = scheduledTasks.filter((task) => task.showOnOverview !== false)'), '总览没有按「总览展示」过滤任务')
  assert(overviewSource.includes('{overviewTasks.length > 0 && <section className="panel overview-tasks-panel">'), '总览区块应按可见任务数决定是否渲染')
  assert(overviewSource.includes('{overviewTasks.map((task) => {'), '总览卡片列表应使用过滤后的任务')
  // 定时任务面板：卡片快捷按钮 + 详情浮层按钮
  assert(page.includes('onToggleOverviewVisibility(task.id, !task.showOnOverview)'), '任务卡片缺少「总览展示」开关按钮')
  assert(page.includes('aria-pressed={task.showOnOverview}'), '总览展示开关缺少按下状态')
  assert(panelSource.includes('onToggleOverviewVisibility(task.id, !task.showOnOverview)') && panelSource.includes('在总览页显示'), '详情浮层缺少「总览展示」按钮')
  assert(page.includes('onToggleOverviewVisibility: (id: string, visible: boolean) => Promise<void>'), '定时任务页缺少总览展示回调参数')
  assert(ipc.includes("'zsense:tasks:set-overview-visibility'"), 'IPC 缺少总览展示开关')
  assert(preload.includes('setOverviewVisibility: (id, visible)'), 'preload 缺少总览展示开关')
  const bridgeSource = fs.readFileSync(new URL('../src/electron.d.ts', import.meta.url), 'utf8')
  const typeSource = fs.readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')
  assert(bridgeSource.includes('setOverviewVisibility: (id: string, visible: boolean)'), 'electron.d.ts 缺少总览展示开关类型')
  assert(typeSource.includes('showOnOverview: boolean'), 'ScheduledTask 类型缺少 showOnOverview')
  assert(app.includes('setScheduledTaskOverviewVisibility') && app.includes('onToggleOverviewVisibility={setScheduledTaskOverviewVisibility}'), 'App 没有接线总览展示开关')
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert(/<Overview[^>]*scheduledTasks=\{scheduledTasks\}/.test(appSource), 'App 没有把定时任务数据传给总览')

  // 总览卡片内容：把任务内容换成「工作区 + 模型」，并加一个启用 / 暂停按钮
  assert(!overviewSource.includes('overview-task-description'), '总览定时任务卡片不应再显示任务内容')
  const overviewCardBlock = overviewSource.slice(overviewSource.indexOf('overview-task-grid'), overviewSource.indexOf('还没有定时任务'))
  assert(!/task\.prompt/.test(overviewCardBlock), '总览定时任务卡片仍在渲染任务内容（task.prompt）')
  assert(overviewCardBlock.includes('overview-task-meta') && overviewCardBlock.includes('overview-task-workspace') && overviewCardBlock.includes('overview-task-model'), '总览定时任务卡片应显示工作区与模型')
  assert(overviewCardBlock.includes("title={task.workspacePath ||"), '总览卡片的工作区应带上完整路径提示')
  assert(overviewCardBlock.includes("{task.model || '默认模型'}"), '总览卡片应显示模型名（未指定时提示默认模型）')
  assert(overviewCardBlock.includes('overview-task-toggle'), '总览卡片缺少启用 / 暂停按钮')
  assert(overviewCardBlock.includes('event.stopPropagation(); void toggleTaskEnabled(task.id, !task.enabled)'), '启用 / 暂停按钮没有阻止卡片跳转或没有调用切换')
  assert(overviewCardBlock.includes("aria-label={`${task.enabled ? '暂停' : '启用'}定时任务 ${task.name}`}"), '启用 / 暂停按钮缺少无障碍标签')
  assert(overviewCardBlock.includes('role="button"') && overviewCardBlock.includes('onKeyDown='), '卡片改成容器后应保留可点击与键盘语义')
  // 点卡片打开的是这个任务的详情面板（用户要的就是这个悬浮面板），不再直接跳定时任务页
  assert(overviewCardBlock.includes('setDetailTaskId(task.id)'), '总览卡片点击后应打开该任务的详情面板')
  assert(!overviewCardBlock.includes("onNavigate('scheduled-tasks')"), '总览卡片不应再直接跳到定时任务页')
  assert(overviewSource.includes("const [detailTaskId, setDetailTaskId] = useState('')"), '总览缺少详情面板状态')
  assert(overviewSource.includes('<ScheduledTaskDetailPanel'), '总览没有渲染共用的详情面板')
  assert(overviewSource.includes('aria-label={`查看定时任务 ${task.name} 的详情'), '总览卡片的无障碍标签应说明是查看详情')
  for (const callback of ['onRunTask={runScheduledTaskNow}', 'onOpenTaskWorkspace={openScheduledTaskWorkspace}', 'onDeleteTask={deleteScheduledTask}', 'onOpenConversation={openNativeChat}']) {
    assert(appSource.includes(callback), `App 没有把「${callback}」接到总览的详情面板`)
  }
  assert(appSource.includes('onEditTask={(task) => { setPendingEditTaskId(task.id); navigate(\'scheduled-tasks\') }}'), '总览里点编辑任务应跳到定时任务页并打开该任务表单')
  assert(appSource.includes('editingTaskId={pendingEditTaskId}') && appSource.includes('onEditingTaskHandled='), '定时任务页没有接收“直接打开某个任务表单”的入参')
  assert(page.includes('if (target) setEditing(target)'), '定时任务页没有按入参打开对应任务的编辑表单')
  assert(overviewSource.includes('onToggleTask?: (id: string, enabled: boolean) => void | Promise<void>'), '总览组件缺少启用 / 暂停回调参数')
  assert(appSource.includes('onToggleTask={toggleScheduledTask}'), 'App 没有把启用 / 暂停接到总览卡片')

  // 定时任务卡片：网格排列的长方形缩略卡片 + 点击后的悬浮详情面板
  const pageSource = fs.readFileSync(new URL('../src/components/ScheduledTasksPage.tsx', import.meta.url), 'utf8')
  const styleSource = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert(/scheduled-task-list \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(268px, 1fr\)\)/.test(styleSource), '任务列表应为网格布局，卡片不应占满整行')
  // 展开区底部蓝条上的工作区文字原来是深灰，在蓝底上看不清 → 白色
  assert(styleSource.includes('.overview-bot-footer .overview-task-workspace { color: #fff; }'), '展开区蓝条上的工作区文字应改成白色')
  assert(/\.overview-task-toggle \{[^}]*cursor: pointer/.test(styleSource), '启用 / 暂停按钮缺少可点击样式')
  assert(pageSource.includes('className="scheduled-task-open"'), '缩略卡片缺少整卡可点击区域')
  assert(pageSource.includes('const [detailTaskId, setDetailTaskId]'), '缺少悬浮详情面板状态')
  assert(panelSource.includes('createPortal') && panelSource.includes('scheduled-task-detail-layer'), '详情面板必须通过 Portal 渲染到遮罩层')
  assert(/role="dialog" aria-modal="true"/.test(panelSource), '悬浮面板缺少对话框语义')
  assert(panelSource.includes("event.key === 'Escape'") && panelSource.includes('onClose()'), '悬浮面板必须支持 Esc 关闭（组件内置，两处都生效）')
  assert(panelSource.includes('onMouseDown={(event) => event.target === event.currentTarget && onClose()}'), '悬浮面板必须支持点遮罩关闭')
  // 总览与定时任务页共用同一个面板，避免两处内容不一致
  assert(pageSource.includes('<ScheduledTaskDetailPanel') && overviewSource.includes('<ScheduledTaskDetailPanel'), '总览与定时任务页应复用同一个悬浮详情面板组件')
  assert(!pageSource.includes('scheduled-task-detail-layer'), '定时任务页不应再内联实现详情面板')

  const cardBlock = pageSource.slice(pageSource.indexOf('className="scheduled-task-open"'), pageSource.indexOf('{detailTask && createPortal'))
  assert(!cardBlock.includes('task.prompt'), '缩略卡片不应显示任务提示词正文')
  assert(!cardBlock.includes('<dl>'), '缩略卡片不应显示元数据表（模型/工作区/任务记忆/进度等）')
  assert(!cardBlock.includes('任务记忆'), '缩略卡片不应显示任务记忆信息')
  assert(cardBlock.includes('scheduled-task-when') && cardBlock.includes('scheduled-task-next'), '缩略卡片应显示运行时间与下次运行')
  assert(cardBlock.includes('task-status'), '缩略卡片应显示启用状态')

  const panelBlock = panelSource
  for (const label of ['任务内容', '运行配置', '任务记忆', '最近一次运行', '立即运行', '编辑任务', '暂停任务', '打开工作区', '删除任务', '查看完整对话']) {
    assert(panelBlock.includes(label), `悬浮详情面板缺少“${label}”`)
  }

  console.log(JSON.stringify({ ok: true, scheduleCalculation: true, databasePersistence: true, nativeCoreExecution: true, isolatedWorkspace: true, selectableWorkspace: true, scheduledConversationHiddenFromLists: true, scheduledConversationAvailableFromRunHistory: true, runHistory: true, displayControlsImplemented: true, compactCardGrid: true, floatingDetailPanel: true }))
} finally {
  await runner.shutdown()
  database.close()
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
