import {
  ArrowLeft,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  Eye,
  FileText,
  Gauge,
  HardDrive,
  Link2,
  MemoryStick,
  MessageSquareMore,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Blocks,
  Users,
  Tags,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { formatLocalDateTime } from '../services/date-time'
import { useRunningConversationIds } from '../services/chat-run-store'
import type {ScheduledTask,  Bot, BotTab, Channel, Conversation, GatewayAuthorizedUser, GatewayConnection, GatewayConnectionConfigurationInput, GatewayPairingRequest, MemoryItem, ModelConfiguration, ModelProvider, RuntimeStatus, Skill, WeixinQrLoginStatus } from '../types'
import { BotActionsMenu } from './BotActionsMenu'
import { ChannelBadge, StatusLabel } from './Overview'
import { ConversationActions } from './ConversationActions'
import { GatewayPage } from './GatewayPage'
import { MemoryDialog, type MemoryDialogMode } from './MemoryDialog'

interface BotWorkspaceProps {
  bot: Bot
  channels: Channel[]
  gatewayConnections: GatewayConnection[]
  skills: Skill[]
  conversations: Conversation[]
  savedModelConfigurations: ModelConfiguration[]
  defaultModelConfiguration: ModelConfiguration
  runtime: RuntimeStatus
  onBack: () => void
  onOpenModels: () => void
  onLoadAuthorizedUsers: (connectionId: string) => Promise<GatewayAuthorizedUser[]>
  onSaveGateway: (configuration: GatewayConnectionConfigurationInput) => Promise<void>
  onDeleteGateway: (connectionId: string) => Promise<void>
  onLoadGatewayPairings: (connectionId: string) => Promise<GatewayPairingRequest[]>
  onApproveGatewayPairing: (connectionId: string, requestId: string) => Promise<GatewayPairingRequest[]>
  onStartWeixinLogin: (botId: string) => Promise<WeixinQrLoginStatus>
  onGetWeixinLoginStatus: (loginId: string) => Promise<WeixinQrLoginStatus>
  onCancelWeixinLogin: (loginId: string) => Promise<void>
  onOpenRuntime: () => void
  onRefreshRuntime: () => Promise<void>
  onUpdate: (bot: Bot) => void | Promise<void>
  onDuplicate: (bot: Bot) => Promise<void>
  onDelete: (bot: Bot) => Promise<void>
  onAddMemory: (botId: string, memory: MemoryItem) => Promise<void>
  onUpdateMemory: (botId: string, memory: MemoryItem) => Promise<void>
  onDeleteMemory: (botId: string, memoryId: string) => Promise<void>
  onStartChat: (conversationId?: string) => void
  onRenameConversation: (conversationId: string, title: string) => Promise<void>
  onArchiveConversation: (conversationId: string, archived: boolean) => Promise<void>
  onDeleteConversation: (conversationId: string) => Promise<void>
  scheduledTasks: ScheduledTask[]
  onRunScheduledTask: (id: string) => void | Promise<void>
  onToggleScheduledTask: (id: string, enabled: boolean) => void | Promise<void>
  onEditScheduledTask: (task: ScheduledTask) => void
  onOpenScheduledTaskWorkspace: (id: string) => void | Promise<void>
  onCreateScheduledTask: () => void
}

import { BotScheduledTasks } from './BotScheduledTasks'

const tabs: Array<{ id: BotTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'memory', label: '独立记忆' },
  { id: 'gateway', label: '消息网关' },
  { id: 'identity', label: '身份与模型' },
  { id: 'tasks', label: '定时任务' },
]

const conversationChannelNames: Record<Conversation['channelId'], string> = {
  web: 'ZSense 对话',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  wecom: '企业微信',
  weixin: '微信',
  dingtalk: '钉钉',
  feishu: '飞书',
  webhook: 'Webhook',
  scheduled: '定时任务',
  'device-link': '设备互联',
}

const modelProviderNames: Record<ModelProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  zai: '智谱 GLM',
  'kimi-coding-cn': 'Kimi / Moonshot',
  nous: 'Nous Portal',
  custom: '自定义 API',
}

function conversationTime(value: string) {
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

export function BotWorkspace({ bot, channels, gatewayConnections, skills, conversations, savedModelConfigurations, defaultModelConfiguration, runtime, onBack, onOpenModels, onLoadAuthorizedUsers, onSaveGateway, onDeleteGateway, onLoadGatewayPairings, onApproveGatewayPairing, onStartWeixinLogin, onGetWeixinLoginStatus, onCancelWeixinLogin, onOpenRuntime, onRefreshRuntime, onUpdate, onDuplicate, onDelete, onAddMemory, onUpdateMemory, onDeleteMemory, onStartChat, onRenameConversation, onArchiveConversation, onDeleteConversation, scheduledTasks, onRunScheduledTask, onToggleScheduledTask, onEditScheduledTask, onOpenScheduledTaskWorkspace, onCreateScheduledTask }: BotWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<BotTab>('overview')
  const [memoryQuery, setMemoryQuery] = useState('')
  const gatewayBots = useMemo(() => [bot], [bot])
  return (
    <div className="page bot-workspace-page">
      <button className="back-button" onClick={onBack}><ArrowLeft size={16} />返回 Bots</button>
      <section className="bot-workspace-header">
        <div className="workspace-identity">
          <span className="workspace-avatar" style={{ '--avatar': bot.color } as React.CSSProperties}>{bot.initials}<i className={`presence ${bot.status}`} /></span>
          <div><div className="workspace-title-line"><h1>{bot.name}</h1><StatusLabel status={bot.status} /></div><p>{bot.role} · {bot.model || defaultModelConfiguration.model || '尚未配置模型'}</p></div>
        </div>
        <div className="workspace-actions">
          <button className="button primary" onClick={() => onStartChat()}><MessageSquareMore size={17} />开始对话</button>
          <BotActionsMenu bot={bot} conversationCount={conversations.length} gatewayCount={gatewayConnections.length} bordered onUpdate={onUpdate} onDuplicate={onDuplicate} onDelete={onDelete} />
        </div>
      </section>

      <nav className="tab-nav" aria-label={`${bot.name} 工作区导航`}>
        {tabs.map((tab) => <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>{tab.label}{tab.id === 'memory' && <small>{bot.memoryCount}</small>}</button>)}
      </nav>

      {activeTab === 'overview' && <BotOverview bot={bot} effectiveModel={bot.model || defaultModelConfiguration.model || '尚未配置模型'} skills={skills} conversations={conversations} runtime={runtime} onTab={setActiveTab} onStartChat={onStartChat} onRenameConversation={onRenameConversation} onArchiveConversation={onArchiveConversation} onDeleteConversation={onDeleteConversation} />}
      {activeTab === 'memory' && (
        <MemoryWorkspace
          bot={bot}
          query={memoryQuery}
          setQuery={setMemoryQuery}
          onAdd={(memory) => onAddMemory(bot.id, memory)}
          onUpdate={(memory) => onUpdateMemory(bot.id, memory)}
          onDelete={(id) => onDeleteMemory(bot.id, id)}
        />
      )}
      {activeTab === 'gateway' && <GatewayPage embedded bots={gatewayBots} channels={channels} connections={gatewayConnections} runtime={runtime} onSave={onSaveGateway} onDelete={onDeleteGateway} onLoadPairings={onLoadGatewayPairings} onLoadAuthorizedUsers={onLoadAuthorizedUsers} onApprovePairing={onApproveGatewayPairing} onStartWeixinLogin={onStartWeixinLogin} onGetWeixinLoginStatus={onGetWeixinLoginStatus} onCancelWeixinLogin={onCancelWeixinLogin} onOpenRuntime={onOpenRuntime} onRefreshRuntime={onRefreshRuntime} />}
      {activeTab === 'tasks' && <BotScheduledTasks botName={bot.name} tasks={scheduledTasks} onRunNow={onRunScheduledTask} onToggle={onToggleScheduledTask} onEdit={onEditScheduledTask} onOpenWorkspace={onOpenScheduledTaskWorkspace} onCreate={onCreateScheduledTask} />}
      {activeTab === 'identity' && <IdentitySettings bot={bot} runtime={runtime} savedModelConfigurations={savedModelConfigurations} defaultModelConfiguration={defaultModelConfiguration} onOpenModels={onOpenModels} onUpdate={onUpdate} />}
    </div>
  )
}

function BotOverview({ bot, effectiveModel, skills, conversations, runtime, onTab, onStartChat, onRenameConversation, onArchiveConversation, onDeleteConversation }: { bot: Bot; effectiveModel: string; skills: Skill[]; conversations: Conversation[]; runtime: RuntimeStatus; onTab: (tab: BotTab) => void; onStartChat: (conversationId?: string) => void; onRenameConversation: (conversationId: string, title: string) => Promise<void>; onArchiveConversation: (conversationId: string, archived: boolean) => Promise<void>; onDeleteConversation: (conversationId: string) => Promise<void> }) {
  const enabledSkills = skills.filter((skill) => skill.assignedBotIds.includes(bot.id))
  const runningConversationIds = useRunningConversationIds('bot')
  const [showArchived, setShowArchived] = useState(false)
  const activeConversations = conversations.filter((conversation) => !conversation.archived)
  const archivedConversations = conversations.filter((conversation) => conversation.archived)
  const visibleConversations = showArchived ? archivedConversations : activeConversations
  return (
    <div className="workspace-grid">
      <section className="workspace-main-column">
        <div className="panel execution-panel">
          <div className="panel-header"><div><h2>运行状态</h2><p>ZSense Agent Core 实时状态</p></div><span className="live-label"><i /> LIVE</span></div>
          <div className="execution-metrics">
            <div><span className="metric-icon purple"><Gauge size={18} /></span><small>当前状态</small><strong>{bot.status === 'online' ? '空闲，等待任务' : '已暂停'}</strong></div>
            <div><span className="metric-icon blue"><Clock3 size={18} /></span><small>响应采样</small><strong>{conversations.length ? '已记录' : '等待首次对话'}</strong></div>
            <div><span className="metric-icon green"><CircleDot size={18} /></span><small>累计会话</small><strong>{conversations.length}</strong></div>
          </div>
          <div className={`runtime-event runtime-${runtime.status}`}>
            <span className="event-pulse"><i /></span>
            <div><strong>{runtime.runnable ? 'ZSense Agent Core 已就绪' : 'ZSense Agent Core 尚不可用'}</strong><p>{runtime.runnable ? `v${runtime.agentCoreVersion || runtime.version || '未知'} · 当前模型 ${effectiveModel}` : runtime.message}</p></div>
            <small>{runtime.runnable ? '已检测' : '需处理'}</small>
          </div>
        </div>

        <div className="panel recent-conversations">
          <div className="panel-header"><div><h2>{showArchived ? '已归档对话' : '最近对话'}</h2><p>ZSense 与外部消息渠道的本地会话</p></div></div>
          <div className="conversation-filter" role="group" aria-label="对话状态筛选"><button type="button" className={!showArchived ? 'active' : ''} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>当前 {activeConversations.length}</button><button type="button" className={showArchived ? 'active' : ''} aria-pressed={showArchived} onClick={() => setShowArchived(true)}>已归档 {archivedConversations.length}</button></div>
          {visibleConversations.length ? visibleConversations.slice(0, 8).map((conversation) => (
            <div className={`conversation-row-shell ${runningConversationIds.has(conversation.id) ? 'is-running' : ''}`} key={conversation.id} aria-label={runningConversationIds.has(conversation.id) ? `${conversation.title}，正在执行任务` : undefined}>
              <button className="conversation-row" onClick={() => onStartChat(conversation.id)}><span className="conversation-icon"><MessageSquareMore size={17} /></span><span><strong>{conversation.title}</strong><small>{conversationChannelNames[conversation.channelId]} · {runningConversationIds.has(conversation.id) ? '执行中 · ' : ''}{conversation.messageCount} 条消息</small></span><time>{conversationTime(conversation.updatedAt)}</time><ChevronRight size={16} /></button>
              <ConversationActions conversation={conversation} onRename={onRenameConversation} onArchive={onArchiveConversation} onDelete={onDeleteConversation} />
            </div>
          )) : <div className="conversation-empty"><MessageSquareMore size={21} /><span><strong>{showArchived ? '没有已归档对话' : '还没有真实对话'}</strong><small>{showArchived ? '归档的会话会保留在这里，可随时恢复。' : `第一次和 ${bot.name} 对话后，会话会出现在这里。`}</small></span></div>}
        </div>
      </section>

      <aside className="workspace-side-column">
        <div className="panel memory-summary-panel">
          <div className="panel-header"><div><h2>记忆空间</h2><p>仅 {bot.name} 可访问</p></div><span className="private-badge"><ShieldCheck size={13} /> PRIVATE</span></div>
          <div className="memory-orbit">
            <div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" />
            <span className="memory-core" style={{ '--avatar': bot.color } as React.CSSProperties}><BrainCircuit size={27} /></span>
            <i className="memory-node one" /><i className="memory-node two" /><i className="memory-node three" />
          </div>
          <div className="memory-summary-stats"><span><strong>{bot.memoryCount.toLocaleString()}</strong><small>记忆条目</small></span><span><strong>{bot.memorySize}</strong><small>占用空间</small></span></div>
          <button className="button secondary full-button" onClick={() => onTab('memory')}>管理独立记忆 <ChevronRight size={16} /></button>
        </div>
        <div className="panel quick-gateway-panel">
          <div className="panel-header"><div><h2>消息入口</h2><p>{bot.channels.length} 个已分配</p></div><button className="icon-button" onClick={() => onTab('gateway')} aria-label="管理消息入口"><ChevronRight size={17} /></button></div>
          <div className="assigned-channel-list">
            {bot.channels.map((channel) => <div key={channel}><ChannelBadge id={channel} /><span className="status-label online"><i />在线</span></div>)}
          </div>
        </div>
        <div className="panel shared-skills-panel">
          <div className="panel-header"><div><h2>可用技能</h2><p>单独分配给 {bot.name}</p></div><span className="shared-mini-badge"><Users size={12} />按 Bot</span></div>
          <div className="shared-skill-list">
            {enabledSkills.slice(0, 4).map((skill) => <span key={skill.id}><i><Blocks size={13} /></i><strong>{skill.name}</strong><small>v{skill.version}</small></span>)}
            {!enabledSkills.length && <span><i><Blocks size={13} /></i><strong>尚未分配技能</strong><small>在“技能管理”中添加</small></span>}
          </div>
          <div className="shared-skill-foot"><ShieldCheck size={14} /><span><strong>{enabledSkills.length} 个技能可用</strong><small>仅当前 Bot 的 ZSense 隔离空间启用</small></span></div>
        </div>
      </aside>
    </div>
  )
}

interface MemoryWorkspaceProps {
  bot: Bot
  query: string
  setQuery: (value: string) => void
  onAdd: (memory: MemoryItem) => Promise<void>
  onUpdate: (memory: MemoryItem) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

function MemoryWorkspace({ bot, query, setQuery, onAdd, onUpdate, onDelete }: MemoryWorkspaceProps) {
  const [memoryType, setMemoryType] = useState<'all' | MemoryItem['type']>('all')
  const [dialog, setDialog] = useState<{ mode: MemoryDialogMode; memory?: MemoryItem; confirmDelete?: boolean } | null>(null)
  const memories = useMemo(() => bot.memories.filter((memory) => `${memory.title} ${memory.excerpt}`.toLowerCase().includes(query.toLowerCase()) && (memoryType === 'all' || memory.type === memoryType)), [bot.memories, memoryType, query])
  const typeMap = { fact: '事实', preference: '偏好', episode: '经历' }
  return (
    <div className="memory-workspace">
      <section className="memory-boundary-banner">
        <div className="boundary-icon"><ShieldCheck size={22} /></div>
        <div><span className="eyebrow">ISOLATED MEMORY VAULT</span><h2>{bot.name} 的独立记忆空间</h2><p>所有检索、写入和遗忘操作都严格限定在此 Bot 的命名空间。</p></div>
        <div className="namespace-path"><small>NAMESPACE</small><code>bot:{bot.id}:memory</code></div>
      </section>
      <div className="memory-toolbar">
        <label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆内容" /></label>
        <div className="segmented compact"><button className={memoryType === 'all' ? 'active' : ''} onClick={() => setMemoryType('all')}>全部</button><button className={memoryType === 'fact' ? 'active' : ''} onClick={() => setMemoryType('fact')}>事实</button><button className={memoryType === 'preference' ? 'active' : ''} onClick={() => setMemoryType('preference')}>偏好</button><button className={memoryType === 'episode' ? 'active' : ''} onClick={() => setMemoryType('episode')}>经历</button></div>
        <button className="button primary" onClick={() => setDialog({ mode: 'create' })}><Plus size={16} />添加记忆</button>
      </div>
      <div className="memory-layout">
        <aside className="memory-index panel">
          <div><span className="memory-index-icon"><Database size={17} /></span><span><strong>{bot.memoryCount.toLocaleString()}</strong><small>全部条目</small></span></div>
          <div><span className="memory-index-icon"><Tags size={17} /></span><span><strong>{new Set(bot.memories.map((memory) => memory.type)).size}</strong><small>记忆类型</small></span></div>
          <div><span className="memory-index-icon"><Link2 size={17} /></span><span><strong>{bot.channels.length}</strong><small>消息入口</small></span></div>
          <div><span className="memory-index-icon"><HardDrive size={17} /></span><span><strong>{bot.memorySize}</strong><small>本地占用</small></span></div>
          <div className="vault-health"><span><Check size={15} />本地数据正常</span><small>Agent Core 与 SQLite 已同步</small></div>
        </aside>
        <section className="memory-list-panel panel">
          <div className="memory-list-heading"><span>{memories.length} 条匹配记忆</span><small>按最近更新排序</small></div>
          {memories.length ? memories.map((memory) => (
            <article className="memory-item" key={memory.id}>
              <span className={`memory-type-icon ${memory.type}`}><FileText size={17} /></span>
              <div><div className="memory-item-title"><strong>{memory.title}</strong><span className={`memory-type ${memory.type}`}>{typeMap[memory.type]}</span></div><p>{memory.excerpt}</p><small>{memory.source} · {formatLocalDateTime(memory.updatedAt)}</small></div>
              <div className="memory-row-actions">
                <button className="button secondary compact-action" onClick={() => setDialog({ mode: 'view', memory })}><Eye size={15} />查看</button>
                <button className="button secondary compact-action" onClick={() => setDialog({ mode: 'edit', memory })}><Pencil size={15} />修改</button>
                <button className="button compact-action memory-delete-button" onClick={() => setDialog({ mode: 'view', memory, confirmDelete: true })}><Trash2 size={15} />删除</button>
              </div>
            </article>
          )) : <div className="empty-state"><MemoryStick size={25} /><strong>没有匹配的记忆</strong><p>尝试其他关键词，或手动添加一条。</p></div>}
        </section>
      </div>
      {dialog && <MemoryDialog spaceName={bot.name} memory={dialog.memory} initialMode={dialog.mode} confirmDeleteOnOpen={dialog.confirmDelete} onClose={() => setDialog(null)} onSave={dialog.memory ? onUpdate : onAdd} onDelete={onDelete} />}
    </div>
  )
}

function IdentitySettings({ bot, runtime, savedModelConfigurations, defaultModelConfiguration, onOpenModels, onUpdate }: { bot: Bot; runtime: RuntimeStatus; savedModelConfigurations: ModelConfiguration[]; defaultModelConfiguration: ModelConfiguration; onOpenModels: () => void; onUpdate: (bot: Bot) => void | Promise<void> }) {
  const [role, setRole] = useState(bot.role)
  const [description, setDescription] = useState(bot.description)
  const [prompt, setPrompt] = useState(bot.prompt)
  const [modelProvider, setModelProvider] = useState<ModelProvider | ''>(bot.modelProvider || '')
  const [model, setModel] = useState(bot.model)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const providers = useMemo(() => [...new Set(savedModelConfigurations.filter((item) => item.model).map((item) => item.provider))], [savedModelConfigurations])
  const modelOptions = useMemo(() => savedModelConfigurations.filter((item) => item.provider === modelProvider), [modelProvider, savedModelConfigurations])
  const defaultModelLabel = defaultModelConfiguration.model
    ? `${modelProviderNames[defaultModelConfiguration.provider]} · ${defaultModelConfiguration.model}`
    : '尚未配置全局默认模型'

  useEffect(() => {
    setRole(bot.role)
    setDescription(bot.description)
    setPrompt(bot.prompt)
    setModelProvider(bot.modelProvider || '')
    setModel(bot.model)
  }, [bot.description, bot.id, bot.model, bot.modelProvider, bot.prompt, bot.role])

  const save = async () => {
    if (modelProvider && !model) {
      setSaveError('请先选择一个可用的模型 ID。')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await onUpdate({ ...bot, role, description, prompt, modelProvider, model: modelProvider ? model : '' })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1800)
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : '保存 Bot 配置失败。')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="identity-layout">
      <section className="panel settings-form-panel">
        <div className="panel-header"><div><h2>身份与行为</h2><p>定义 {bot.name} 如何思考、表达和行动</p></div></div>
        <div className="settings-form">
          <label><span>角色名称</span><input value={role} onChange={(event) => setRole(event.target.value)} /></label>
          <label><span>角色说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
          <label><span>系统提示词</span><textarea className="code-textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={9} /><small>这段内容会在每次 ZSense Agent Core 会话开始时注入。</small></label>
        </div>
      </section>
      <aside className="identity-side">
        <section className="panel settings-form-panel compact-form">
          <div className="panel-header"><div><h2>模型覆盖</h2><p>可选择已保存或从官网同步的供应商与模型 ID</p></div><button className="text-button" onClick={onOpenModels}>管理模型 <ChevronRight size={14} /></button></div>
          {savedModelConfigurations.some((item) => item.model) ? <>
            <label><span>可用模型供应商</span><select value={modelProvider} onChange={(event) => {
              const nextProvider = event.target.value as ModelProvider | ''
              setModelProvider(nextProvider)
              setModel(nextProvider ? savedModelConfigurations.find((item) => item.provider === nextProvider)?.model || '' : '')
            }}><option value="">跟随全局默认模型</option>{providers.map((provider) => <option value={provider} key={provider}>{modelProviderNames[provider]}</option>)}</select><small>供应商的 API 凭证继续使用系统安全存储中的已保存配置。</small></label>
            <label><span>可用模型 ID</span><select value={modelProvider ? model : ''} disabled={!modelProvider} onChange={(event) => setModel(event.target.value)}><option value="">{modelProvider ? '请选择模型 ID' : '请先选择供应商'}</option>{modelOptions.map((configuration) => <option key={`${configuration.provider}:${configuration.model}`} value={configuration.model}>{configuration.model}</option>)}</select><small>{modelProvider ? `${modelOptions.length} 个可用模型` : `当前跟随全局默认：${defaultModelLabel}`}。</small></label>
          </> : <div className="saved-model-empty"><Sparkles size={20} /><span><strong>还没有可用模型</strong><small>先在“AI 模型”页面保存配置或刷新官网模型列表，再回来为 Bot 选择。</small></span><button className="button secondary small" onClick={onOpenModels}>前往配置</button></div>}
          <div className="selected-model-summary"><small>此 Bot 将使用</small><strong>{modelProvider && model ? `${modelProviderNames[modelProvider]} · ${model}` : `全局默认 · ${defaultModelLabel}`}</strong><span>{runtime.runnable ? `ZSense Agent Core v${runtime.agentCoreVersion || runtime.version || '未知'}` : 'Agent Core 未就绪，配置会先保存'}</span></div>
          {saveError && <div className="identity-save-error inline-error" role="alert">{saveError}</div>}
        </section>
        <section className="panel isolation-card"><span className="boundary-icon"><ShieldCheck size={20} /></span><div><strong>记忆严格隔离</strong><p>此 Bot 无法读取其他 Bot 的私有记忆。跨 Bot 共享需要显式授权。</p></div></section>
        <button className="button primary full-button" onClick={() => void save()} disabled={saving || Boolean(modelProvider && !model)}>{saving ? <><LoaderCircle className="spin" size={16} />正在保存…</> : saved ? <><Check size={16} />已保存</> : <><Save size={16} />保存更改</>}</button>
      </aside>
    </div>
  )
}
