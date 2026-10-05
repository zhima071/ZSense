import {
  ArrowRight,
  Bot as BotIcon,
  Brain,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Cpu,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  MessageSquareMore,
  Mic2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { folderLabel, formatDate, frequencyLabel, providerNames } from '../services/scheduled-task-format'
import { ScheduledTaskDetailPanel } from './ScheduledTaskDetailPanel'
import type { Activity, Bot, Channel, Conversation, ModelConfiguration, ModelProvider, RuntimeStatus, ScheduledTask, ScheduledTaskRun, ViewId } from '../types'

interface OverviewProps {
  bots: Bot[]
  conversations: Conversation[]
  scheduledTasks?: ScheduledTask[]
  scheduledTaskRuns?: ScheduledTaskRun[]
  channels: Channel[]
  activities: Activity[]
  runtime: RuntimeStatus
  defaultModelConfiguration: ModelConfiguration
  voiceWakeEnabled: boolean
  onOpenBot: (id: string) => void
  onNavigate: (view: ViewId) => void
  onOpenVoiceSettings: () => void
  /** 直接在这里启用 / 暂停定时任务 */
  onToggleTask?: (id: string, enabled: boolean) => void | Promise<void>
  /** 详情面板里的操作：立即运行 / 编辑 / 打开工作区 / 删除 / 查看完整对话 */
  onRunTask?: (id: string) => void | Promise<void>
  onEditTask?: (task: ScheduledTask) => void
  onOpenTaskWorkspace?: (id: string) => void | Promise<void>
  onDeleteTask?: (id: string) => void | Promise<void>
  onToggleOverviewVisibility?: (id: string, visible: boolean) => void | Promise<void>
  onOpenConversation?: (conversationId: string) => void
}

const modelProviderNames: Record<ModelProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
  zai: '智谱 GLM',
  'kimi-coding-cn': 'Kimi',
  nous: 'Nous Research',
  custom: '自定义',
}

function greetingForHour(hour: number) {
  if (hour < 12) return '上午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function compactDateTime(value: string | null) {
  if (!value) return '尚未巡检'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function Overview({ bots, conversations, channels, activities, scheduledTasks = [], scheduledTaskRuns = [], runtime, defaultModelConfiguration, voiceWakeEnabled, onOpenBot, onNavigate, onOpenVoiceSettings, onToggleTask, onRunTask, onEditTask, onOpenTaskWorkspace, onDeleteTask, onOpenConversation, onToggleOverviewVisibility }: OverviewProps) {
  const [currentHour, setCurrentHour] = useState(() => new Date().getHours())
  // 只有在定时任务面板里打开「在总览页显示」的任务才出现在这里
  const overviewTasks = scheduledTasks.filter((task) => task.showOnOverview !== false)
  const [togglingTaskId, setTogglingTaskId] = useState('')
  // 点卡片打开的是这个任务的悬浮详情面板（与定时任务页同一个组件），不再跳页
  const [detailTaskId, setDetailTaskId] = useState('')
  const [detailBusy, setDetailBusy] = useState('')
  const detailTask = scheduledTasks.find((task) => task.id === detailTaskId) || null

  // 卡片上的启用 / 暂停按钮：出错由上层提示，这里只负责忙碌状态
  const toggleTaskEnabled = async (id: string, enabled: boolean) => {
    if (!onToggleTask) return
    setTogglingTaskId(id)
    try { await onToggleTask(id, enabled) }
    catch { /* 上层已经提示过失败原因 */ }
    finally { setTogglingTaskId('') }
  }
  const onlineBots = bots.filter((bot) => bot.status === 'online').length
  const pausedBots = bots.filter((bot) => bot.status === 'paused').length
  const offlineBots = bots.filter((bot) => bot.status === 'offline').length
  const externalEntrances = bots.reduce((total, bot) => total + bot.channels.filter((channel) => channel !== 'web').length, 0)
  const connectedChannels = channels.filter((channel) => channel.status === 'connected').length
  const attentionBots = pausedBots + offlineBots
  const botConversationCount = conversations.filter((conversation) => conversation.kind === 'bot').length
  const totalMemoryCount = bots.reduce((total, bot) => total + bot.memoryCount, 0)
  const defaultModelLabel = defaultModelConfiguration.model
    ? `${modelProviderNames[defaultModelConfiguration.provider]} · ${defaultModelConfiguration.model}`
    : '尚未配置'
  const gatewayHealthValue = runtime.lastGatewayHealthCheckAt
    ? `${runtime.gatewayHealthyCount}/${runtime.gatewayExpectedCount}`
    : '待检测'

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentHour(new Date().getHours()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="page overview-page">
      <section className="overview-greeting">
        <div>
          <span className="eyebrow">BOT WORKSPACE</span>
          <h1>{greetingForHour(currentHour)}</h1>
          <p>欢迎来到专属于你的 ZSense 空间</p>
        </div>
        {!voiceWakeEnabled && <button type="button" className="overview-voice-prompt" onClick={onOpenVoiceSettings} aria-label="语音唤醒未开启，前往语音交互设置">
          <span><Mic2 size={17} /></span>
          <span><strong>语音唤醒未开启</strong><small>点击进入语音设置</small></span>
          <ArrowRight size={15} />
        </button>}
      </section>

      <section className="bot-status-summary" aria-label="Bot 状态摘要">
        <div className="bot-summary-primary">
          <span className="bot-summary-icon"><BotIcon size={20} /></span>
          <span><small>全部 Bot</small><strong>{bots.length}</strong></span>
        </div>
        <SummaryItem label="运行中" value={onlineBots} tone="online" />
        <SummaryItem label="已暂停" value={pausedBots} tone="paused" />
        <SummaryItem label="离线" value={offlineBots} tone="offline" />
        <SummaryItem label="外部消息入口" value={externalEntrances} tone="channel" />
      </section>

      {/* 没有定时任务时整块区域不显示（空状态会白占一大片版面） */}
      {overviewTasks.length > 0 && <section className="panel overview-tasks-panel">
        <div className="panel-header overview-panel-header">
          <div><h2>定时任务</h2><p>按计划自动执行的固化流程，与“定时任务”面板同一份数据</p></div>
          <div className="overview-panel-actions">
            <span className="overview-bot-count">{overviewTasks.length} 个</span>
            <button className="button secondary small" onClick={() => onNavigate('scheduled-tasks')}>管理全部任务 <ArrowRight size={15} /></button>
          </div>
        </div>
        <div className="overview-task-grid">
            {overviewTasks.map((task) => {
              const latestRun = scheduledTaskRuns.find((run) => run.taskId === task.id)
              const running = latestRun?.status === 'running'
              const statusLabel = running ? '运行中' : task.status === 'active' ? '已启用' : task.status === 'completed' ? '已完成' : '已暂停'
              const successCount = scheduledTaskRuns.filter((run) => run.taskId === task.id && run.status === 'success').length
              return (
                <div
                  className="overview-bot-card overview-task-card"
                  key={task.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailTaskId(task.id)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setDetailTaskId(task.id) } }}
                  aria-label={`查看定时任务 ${task.name} 的详情，状态 ${statusLabel}，计划 ${frequencyLabel(task)}，累计运行 ${task.runCount} 次`}
                >
                  <span className="overview-bot-card-main">
                    <span className="overview-bot-card-head">
                      <span className={`overview-task-icon ${running ? 'running' : task.status}`}><CalendarClock size={17} /></span>
                      <span className="overview-bot-identity"><strong>{task.name}</strong><small>{frequencyLabel(task)}</small></span>
                      <span className={`task-status ${running ? 'running' : task.status}`}>{statusLabel}</span>
                    </span>
                    <span className="overview-task-meta">
                      <span className="overview-task-workspace" title={task.workspacePath || '由 ZSense 自动创建的任务工作区'}><FolderOpen size={13} />{task.workspacePath ? folderLabel(task.workspacePath) : '自动创建'}</span>
                      <span className="overview-task-model" title={`${providerNames[task.modelProvider] || task.modelProvider || '默认供应商'} · ${task.model || '默认模型'}`}><Cpu size={13} />{task.model || '默认模型'}</span>
                    </span>
                    <span className="overview-bot-model">
                      <Clock3 size={15} />
                      <span><small>下次运行</small><strong title={task.enabled ? formatDate(task.nextRunAt) : '已暂停'}>{task.enabled ? formatDate(task.nextRunAt) : '已暂停，不再自动运行'}</strong></span>
                      {onToggleTask && <button
                        type="button"
                        className={`overview-task-toggle ${task.enabled ? '' : 'paused'}`}
                        disabled={togglingTaskId === task.id}
                        title={task.enabled ? '暂停这个任务' : '启用这个任务'}
                        aria-label={`${task.enabled ? '暂停' : '启用'}定时任务 ${task.name}`}
                        onClick={(event) => { event.stopPropagation(); void toggleTaskEnabled(task.id, !task.enabled) }}
                      >{togglingTaskId === task.id ? <LoaderCircle className="spin" size={14} /> : task.enabled ? <Pause size={14} /> : <Play size={14} />}</button>}
                    </span>
                  </span>
                  <span className="overview-bot-card-details" aria-hidden="true">
                    <span className="overview-bot-metrics">
                      <span><RotateCcw size={15} /><span><small>累计运行</small><strong>{task.runCount.toLocaleString()}</strong></span></span>
                      <span><CheckCircle2 size={15} /><span><small>成功</small><strong>{successCount.toLocaleString()}</strong></span></span>
                      <span><Cpu size={15} /><span><small>模型</small><strong title={`${providerNames[task.modelProvider] || task.modelProvider} · ${task.model}`}>{task.model || '默认模型'}</strong></span></span>
                    </span>
                    <span className="overview-bot-footer">
                      <span className="overview-task-workspace" title={task.workspacePath}><FolderOpen size={13} />{folderLabel(task.workspacePath)}</span>
                      <span className="overview-last-active"><Clock3 size={13} />{latestRun ? `最近 ${formatDate(latestRun.startedAt)}` : '尚未运行'}</span>
                    </span>
                  </span>
                </div>
              )
            })}
        </div>
      </section>}

      <div className="bot-first-layout">
        <section className="panel overview-bots-panel">
          <div className="panel-header overview-panel-header">
            <div><h2>我的 Bots</h2><p>模型、记忆、对话与消息入口集中概览</p></div>
            <div className="overview-panel-actions">
              <span className="overview-bot-count">{bots.length} 个</span>
              <button className="button secondary small" onClick={() => onNavigate('bots')}>管理全部 Bot <ArrowRight size={15} /></button>
            </div>
          </div>

          {bots.length ? (
            <div className="overview-bot-grid">
              {bots.map((bot) => {
                const conversationCount = conversations.filter((conversation) => conversation.kind === 'bot' && conversation.botId === bot.id).length
                const usesOwnModel = Boolean(bot.model && bot.modelProvider)
                const effectiveProvider = usesOwnModel ? bot.modelProvider : (defaultModelConfiguration.model ? defaultModelConfiguration.provider : '')
                const effectiveModel = usesOwnModel ? bot.model : defaultModelConfiguration.model
                const modelLabel = effectiveProvider && effectiveModel
                  ? `${modelProviderNames[effectiveProvider]} · ${effectiveModel}`
                  : '尚未配置模型'
                return (
                <button className="overview-bot-card" key={bot.id} onClick={() => onOpenBot(bot.id)} aria-label={`打开 ${bot.name} 工作区，当前模型 ${modelLabel}，${conversationCount} 个对话，${bot.memoryCount} 条记忆，${bot.channels.length} 个消息入口`}>
                  <span className="overview-bot-card-main">
                    <span className="overview-bot-card-head">
                      <span className="bot-avatar" style={{ '--avatar': bot.color } as React.CSSProperties}>{bot.initials}<i className={`presence ${bot.status}`} /></span>
                      <span className="overview-bot-identity"><strong>{bot.name}</strong><small>{bot.role}</small></span>
                      <StatusLabel status={bot.status} />
                    </span>
                    <span className="overview-bot-description">{bot.description || '尚未填写 Bot 描述。'}</span>
                    <span className="overview-bot-model">
                      <Cpu size={15} />
                      <span><small>当前模型</small><strong title={modelLabel}>{modelLabel}</strong></span>
                      <ArrowRight className="overview-card-arrow" size={15} />
                    </span>
                  </span>
                  <span className="overview-bot-card-details" aria-hidden="true">
                    <span className="overview-bot-metrics">
                      <span><MessageSquareMore size={15} /><span><small>累计对话</small><strong>{conversationCount.toLocaleString()}</strong></span></span>
                      <span><Brain size={15} /><span><small>独立记忆</small><strong>{bot.memoryCount.toLocaleString()}</strong></span></span>
                      <span><Radio size={15} /><span><small>消息入口</small><strong>{bot.channels.length}</strong></span></span>
                    </span>
                    <span className="overview-bot-footer">
                      <span className="channel-stack">{bot.channels.map((channel) => <ChannelBadge key={channel} id={channel} compact />)}</span>
                      <span className="overview-last-active"><Clock3 size={13} />{bot.lastActive}</span>
                    </span>
                  </span>
                </button>
                )
              })}
            </div>
          ) : (
            <div className="overview-empty-bots">
              <span><BotIcon size={22} /></span>
              <strong>还没有 Bot</strong>
              <p>前往 Bot 管理创建第一个独立智能体。</p>
              <button className="button secondary" onClick={() => onNavigate('bots')}>前往 Bot 管理 <ArrowRight size={16} /></button>
            </div>
          )}
        </section>

        <aside className="overview-side-column" aria-label="Bot 辅助信息">
          <section className="panel workspace-health-panel">
            <div className="panel-header"><div><h2>运行与数据状态</h2><p>核心服务、网关与 Bot 数据概览</p></div>{attentionBots > 0 && <span className="workspace-health-attention">{attentionBots} 项需关注</span>}</div>
            <div className="workspace-health-runtime">
              <span className={`workspace-health-icon ${runtime.runnable ? 'ready' : 'warning'}`}><Cpu size={18} /></span>
              <span className="workspace-health-runtime-copy"><small>ZSense Agent Core</small><strong>{runtime.runnable ? '运行正常' : '需要处理'}<em>{runtime.agentCoreVersion ? `v${runtime.agentCoreVersion}` : '版本未知'}</em></strong><span className="workspace-health-message" title={runtime.message}>{runtime.message}</span></span>
            </div>
            <div className="workspace-health-badges" aria-label="运行范围">
              <span><HardDrive size={13} />本地隔离空间</span>
              <span><ShieldCheck size={13} />{runtime.managedByApp ? '由应用托管' : '手动运行'}</span>
            </div>
            <div className="workspace-health-metrics">
              <span><small>在线 Bot</small><strong>{onlineBots}/{bots.length}</strong><em>{attentionBots ? `${attentionBots} 个需关注` : '全部正常'}</em></span>
              <span><small>Bot 对话</small><strong>{botConversationCount.toLocaleString()}</strong><em>已保存会话</em></span>
              <span><small>独立记忆</small><strong>{totalMemoryCount.toLocaleString()}</strong><em>全部 Bot 合计</em></span>
              <span><small>健康网关</small><strong>{gatewayHealthValue}</strong><em>{connectedChannels} 个渠道已连接</em></span>
            </div>
            <div className="workspace-health-details">
              <span><span><RefreshCw size={13} />自动巡检</span><strong>{runtime.gatewayMonitorEnabled ? `每 ${runtime.gatewayHealthCheckIntervalSeconds} 秒` : '未开启'}</strong></span>
              <span><span><Clock3 size={13} />最近巡检</span><strong>{compactDateTime(runtime.lastGatewayHealthCheckAt)}</strong></span>
              <span><span><ShieldCheck size={13} />自动恢复</span><strong>{runtime.gatewayRecoveryCount.toLocaleString()} 次</strong></span>
              <span><span><Cpu size={13} />全局模型</span><strong title={defaultModelLabel}>{defaultModelLabel}</strong></span>
            </div>
            <button className="panel-footer-button" onClick={() => onNavigate(runtime.runnable ? 'bots' : 'settings')}>{runtime.runnable ? '管理 Bot 消息网关' : '检查核心服务'} <ArrowRight size={15} /></button>
          </section>

          <section className="panel bot-activity-panel">
            <div className="panel-header"><div><h2>Bot 最近活动</h2><p>最新的本地运行记录</p></div></div>
            <div className="bot-activity-list">
              {activities.slice(0, 4).map((activity) => {
                const bot = bots.find((item) => item.id === activity.botId)
                return (
                  <div className="bot-activity-item" key={activity.id}>
                    <span className={`activity-icon ${activity.type}`}>
                      {activity.type === 'memory' && <MemoryStick size={15} />}
                      {activity.type === 'message' && <MessageSquareMore size={15} />}
                      {activity.type === 'tool' && <Cpu size={15} />}
                      {activity.type === 'system' && <Clock3 size={15} />}
                    </span>
                    <span><strong>{activity.title}</strong><small>{bot?.name || '系统'} · {activity.time}</small></span>
                  </div>
                )
              })}
              {!activities.length && <div className="bot-activity-empty">暂无 Bot 活动记录</div>}
            </div>
            <button className="panel-footer-button" onClick={() => onNavigate('activity')}>查看完整运行记录 <ArrowRight size={15} /></button>
          </section>
        </aside>
      </div>
      {detailTask && <ScheduledTaskDetailPanel
        task={detailTask}
        runs={scheduledTaskRuns}
        busy={detailBusy}
        onBusyChange={setDetailBusy}
        onClose={() => setDetailTaskId('')}
        onRunNow={onRunTask || (() => undefined)}
        onEdit={onEditTask}
        onToggle={onToggleTask || (() => undefined)}
        onToggleOverviewVisibility={onToggleOverviewVisibility}
        onOpenWorkspace={onOpenTaskWorkspace || (() => undefined)}
        onDelete={onDeleteTask || (() => undefined)}
        onOpenConversation={onOpenConversation || (() => undefined)}
      />}
    </div>
  )
}

function SummaryItem({ label, value, tone }: { label: string; value: number; tone: 'online' | 'paused' | 'offline' | 'channel' }) {
  return <div className="bot-summary-item"><i className={tone} /><span><small>{label}</small><strong>{value}</strong></span></div>
}

export function StatusLabel({ status }: { status: Bot['status'] }) {
  const map = { online: '运行中', paused: '已暂停', offline: '离线' }
  return <span className={`status-label ${status}`}><i />{map[status]}</span>
}

export function ChannelBadge({ id, compact = false }: { id: Bot['channels'][number]; compact?: boolean }) {
  const map: Record<Bot['channels'][number], string> = { web: 'W', telegram: 'T', discord: 'D', slack: 'S', wecom: '企', weixin: '微', dingtalk: '钉', feishu: '飞', webhook: '{}' }
  const names: Record<Bot['channels'][number], string> = { web: 'Web Chat', telegram: 'Telegram', discord: 'Discord', slack: 'Slack', wecom: '企业微信', weixin: '微信', dingtalk: '钉钉', feishu: '飞书', webhook: 'Webhook' }
  return <span className={`channel-badge channel-${id} ${compact ? 'compact' : ''}`} title={names[id]}>{map[id]}{!compact && <small>{names[id]}</small>}</span>
}
