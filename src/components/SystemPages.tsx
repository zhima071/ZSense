import {
  Activity as ActivityIcon,
  AudioLines,
  AlertTriangle,
  Bell,
  BellRing,
  Blocks,
  Brain,
  Check,
  Code2,
  Clock3,
  Cable,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileCheck2,
  FolderOpen,
  Globe2,
  Languages,
  LockKeyhole,
  LoaderCircle,
  MemoryStick,
  MessageSquareMore,
  Mic2,
  Monitor,
  MousePointerClick,
  Minimize2,
  Minus,
  Power,
  Plus,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  TestTube2,
  Trash2,
  Users,
  Volume2,
  Webhook,
  Wrench,
  X,
} from 'lucide-react'
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { writeTextToClipboard } from '../services/clipboard'
import { formatLocalDateTime } from '../services/date-time'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import { deleteMossVoice, importMossVoice, listLocalVoiceOptions, speakLocalAudio, stopLocalSpeech } from '../services/local-speech'
import { VOICE_LANGUAGE_OPTIONS } from '../services/voice-language'
import type { Activity, AgentCapabilitiesStatus, AppSettings, AuthUser, AutonomySnapshot, AutonomyTask, AutonomyTaskKind, Bot, Conversation, LocalVoiceOption, McpServerConfiguration, McpServerConfigurationInput, MemoryItem, RuntimeCommandResult, RuntimeStatus, UpdateCheckResult, UpdateStatus, VoiceWakeStatus } from '../types'
import { MemoryDialog, type MemoryDialogMode } from './MemoryDialog'
import { BrowserSettingsPanel } from './BrowserSettingsPanel'
import { DeviceLinkSettingsPanel } from './DeviceLinkSettingsPanel'
import { AccountPanel } from './AccountPanel'
import { UserManagementPanel } from './UserManagementPanel'
import { WebAccessPanel } from './WebAccessPanel'
import { WakePhraseSetupDialog } from './WakePhraseSetupDialog'

interface GlobalMemoryPageProps {
  bots: Bot[]
  nativeBot?: Bot
  embedded?: boolean
  onAddMemory: (botId: string, memory: MemoryItem) => Promise<void>
  onUpdateMemory: (botId: string, memory: MemoryItem) => Promise<void>
  onDeleteMemory: (botId: string, memoryId: string) => Promise<void>
}

export function GlobalMemoryPage({ bots, nativeBot, embedded = false, onAddMemory, onUpdateMemory, onDeleteMemory }: GlobalMemoryPageProps) {
  const [query, setQuery] = useState('')
  const [selectedSpaceId, setSelectedSpaceId] = useState(nativeBot?.id || bots[0]?.id || 'all')
  const [dialog, setDialog] = useState<{ mode: MemoryDialogMode; bot: Bot; memory?: MemoryItem; confirmDelete?: boolean } | null>(null)
  const memorySpaces = useMemo(() => nativeBot ? [nativeBot, ...bots] : bots, [bots, nativeBot])
  const selectedSpace = memorySpaces.find((bot) => bot.id === selectedSpaceId)

  useEffect(() => {
    if (selectedSpaceId !== 'all' && !memorySpaces.some((bot) => bot.id === selectedSpaceId)) setSelectedSpaceId(nativeBot?.id || memorySpaces[0]?.id || 'all')
  }, [memorySpaces, nativeBot?.id, selectedSpaceId])

  const entries = useMemo(() => {
    const spaces = selectedSpace ? [selectedSpace] : memorySpaces
    return spaces.flatMap((bot) => bot.memories.map((memory) => ({ memory, bot }))).filter((item) => `${item.memory.title} ${item.memory.excerpt} ${item.bot.name}`.toLowerCase().includes(query.toLowerCase()))
  }, [memorySpaces, query, selectedSpace])

  return (
    <div className="page">
      <section className="page-heading"><div><span className="eyebrow">MEMORY REGISTRY</span>{embedded ? <h2>记忆管理</h2> : <h1>记忆管理</h1>}<p>在这里查看、添加、修改或删除 AI 对话与每个 Bot 的长期记忆。</p></div><button className="button primary" onClick={() => selectedSpace && setDialog({ mode: 'create', bot: selectedSpace })} disabled={!selectedSpace}><Plus size={16} />为{selectedSpace ? ` ${selectedSpace.name} ` : '当前空间'}添加记忆</button></section>
      <div className="memory-registry-stats">
        <div><span className="metric-icon purple"><Brain size={19} /></span><span><small>全部记忆</small><strong>{memorySpaces.reduce((sum, bot) => sum + bot.memoryCount, 0).toLocaleString()}</strong></span></div>
        <div><span className="metric-icon blue"><Database size={19} /></span><span><small>命名空间</small><strong>{memorySpaces.length}</strong></span></div>
        <div><span className="metric-icon green"><ShieldCheck size={19} /></span><span><small>隔离冲突</small><strong>0</strong></span></div>
      </div>
      <div className="toolbar"><label className="search-field wide"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆标题、内容或所属空间" /></label><span className="memory-active-space"><ShieldCheck size={14} />{selectedSpace ? `${selectedSpace.name} 独立空间` : '全部隔离空间'}</span></div>
      <div className="registry-layout">
        <aside className="panel namespace-list">
          <div className="panel-header"><div><h2>记忆空间</h2><p>选择后直接管理</p></div></div>
          <button className={selectedSpaceId === 'all' ? 'active' : ''} onClick={() => setSelectedSpaceId('all')}><span className="namespace-all-icon"><Database size={17} /></span><span><strong>全部空间</strong><small>{memorySpaces.reduce((sum, bot) => sum + bot.memoryCount, 0).toLocaleString()} 条聚合预览</small></span><small>汇总</small></button>
          {memorySpaces.map((bot) => <button className={selectedSpaceId === bot.id ? 'active' : ''} key={bot.id} onClick={() => setSelectedSpaceId(bot.id)}><span className="mini-avatar" style={{ '--avatar': bot.color } as React.CSSProperties}>{bot.initials}</span><span><strong>{bot.id === nativeBot?.id ? 'AI 对话' : bot.name}</strong><small>{bot.memoryCount.toLocaleString()} 条 · {bot.id === nativeBot?.id ? 'ZSense AI' : 'Bot 私有'}</small></span><small>{bot.id === nativeBot?.id ? 'AI' : 'Bot'}</small></button>)}
        </aside>
        <section className="panel registry-results">
          {selectedSpace?.id === nativeBot?.id && <div className="native-memory-note"><Brain size={18} /><span><strong>AI 对话记忆就在这里管理</strong><small>它使用 ZSense AI 的独立数据库分区，不会进入 Atlas、Scout 或其他本机 Agent。</small></span></div>}
          <div className="memory-list-heading"><span>{entries.length} 条记忆</span><small>{selectedSpace ? `只显示 ${selectedSpace.name}` : '显示全部空间'}</small></div>
          {entries.map(({ memory, bot }) => <article className="registry-memory" key={`${bot.id}-${memory.id}`}><span className="mini-avatar" style={{ '--avatar': bot.color } as React.CSSProperties}>{bot.initials}</span><span><span className="registry-memory-heading"><strong>{memory.title}</strong><small>{bot.id === nativeBot?.id ? 'AI 对话' : bot.name} / {memory.type}</small></span><p>{memory.excerpt}</p><small>{memory.source} · {formatLocalDateTime(memory.updatedAt)}</small></span><div className="memory-row-actions"><button className="button secondary compact-action" onClick={() => setDialog({ mode: 'view', bot, memory })}><Eye size={15} />查看</button><button className="button secondary compact-action" onClick={() => setDialog({ mode: 'edit', bot, memory })}><Pencil size={15} />修改</button><button className="button compact-action memory-delete-button" onClick={() => setDialog({ mode: 'view', bot, memory, confirmDelete: true })}><Trash2 size={15} />删除</button></div></article>)}
          {!entries.length && <div className="empty-state"><MemoryStick size={25} /><strong>{selectedSpace ? `${selectedSpace.name} 还没有长期记忆` : '没有匹配的记忆'}</strong><p>{selectedSpace ? '点击右上角“添加记忆”，或在对话中等待 ZSense Core 自动提取。' : '切换空间或修改搜索关键词。'}</p></div>}
        </section>
      </div>
      {dialog && <MemoryDialog spaceName={dialog.bot.id === nativeBot?.id ? 'AI 对话' : dialog.bot.name} memory={dialog.memory} initialMode={dialog.mode} confirmDeleteOnOpen={dialog.confirmDelete} onClose={() => setDialog(null)} onSave={(memory) => dialog.memory ? onUpdateMemory(dialog.bot.id, memory) : onAddMemory(dialog.bot.id, memory)} onDelete={(memoryId) => onDeleteMemory(dialog.bot.id, memoryId)} />}
    </div>
  )
}

const activityTypeLabels: Record<Activity['type'], string> = {
  message: '消息',
  memory: '记忆',
  tool: '工具',
  system: '系统',
}

const activityMetadataLabels: Record<string, string> = {
  operation: '操作代码',
  initialStatus: '初始状态',
  previousStatus: '原状态',
  nextStatus: '新状态',
  gatewayEffect: '网关行为',
  changedFields: '变更字段',
  conversationId: '会话 ID',
  channelId: '消息渠道',
  toolCalls: '工具调用数',
  toolId: '工具 ID',
  toolName: '工具名称',
  status: '执行状态',
  memoryId: '记忆 ID',
  memoryType: '记忆类型',
  source: '来源',
  sourceBotId: '源 Bot ID',
  botId: 'Bot ID',
  modelProvider: '模型供应商',
  model: '模型 ID',
}

function normalizedActivityDate(value: string) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
}

function formatActivityTimestamp(value: string, fallback = '') {
  return formatLocalDateTime(value, fallback)
}

function formatActivityForCopy(activity: Activity, bot?: Bot, conversation?: Conversation) {
  const timestamp = formatActivityTimestamp(activity.createdAt, activity.time)
  const metadata = Object.entries(activity.metadata || {})
  return [
    '请帮我分析以下 ZSense 运行记录，说明发生了什么、是否存在异常，以及建议如何处理：',
    '',
    `记录标题：${activity.title}`,
    `精确时间：${timestamp}`,
    `事件类型：${activityTypeLabels[activity.type]} (${activity.type})`,
    `所属 Bot：${bot?.name || 'ZSense'}`,
    `Bot ID：${activity.botId || '—'}`,
    `会话名称：${conversation?.title || '未关联会话'}`,
    `会话 ID：${conversation?.id || activity.metadata?.conversationId || '—'}`,
    `记录 ID：${activity.id}`,
    '',
    '完整操作说明：',
    activity.detail || '—',
    ...(metadata.length
      ? ['', '操作详细信息：', ...metadata.map(([key, value]) => `- ${activityMetadataLabels[key] || key} (${key})：${value || '—'}`)]
      : []),
  ].join('\n')
}

async function writeActivityToClipboard(text: string) {
  await writeTextToClipboard(text)
}

function ActivityCopyButton({ activity, bot, conversation, variant = 'row' }: { activity: Activity; bot?: Bot; conversation?: Conversation; variant?: 'row' | 'dialog' }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')

  useEffect(() => {
    if (status === 'idle') return
    const timer = window.setTimeout(() => setStatus('idle'), 2_000)
    return () => window.clearTimeout(timer)
  }, [status])

  const copyRecord = async () => {
    try {
      await writeActivityToClipboard(formatActivityForCopy(activity, bot, conversation))
      setStatus('copied')
    } catch {
      setStatus('error')
    }
  }

  const label = status === 'copied' ? '已复制' : status === 'error' ? '复制失败' : '一键复制'
  return (
    <button
      className={variant === 'dialog' ? 'button primary activity-copy-button' : 'text-button audit-copy-trigger'}
      type="button"
      onClick={() => void copyRecord()}
      title="复制完整记录，可直接粘贴给 AI 分析"
      aria-label={`${label}：${activity.title}运行记录`}
    >
      {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}{label}
      <span className="sr-only" aria-live="polite">{status === 'copied' ? '运行记录已复制到剪贴板' : status === 'error' ? '复制失败，请重试' : ''}</span>
    </button>
  )
}

function ActivityDetailDialog({ activity, bot, conversation, onClose }: { activity: Activity; bot?: Bot; conversation?: Conversation; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const metadata = Object.entries(activity.metadata || {})
  const timestamp = formatActivityTimestamp(activity.createdAt, activity.time)
  const Icon = activity.type === 'memory' ? MemoryStick : activity.type === 'message' ? MessageSquareMore : activity.type === 'tool' ? TerminalSquare : Clock3

  return createPortal(
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="activity-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="activity-detail-title">
        <header className="activity-detail-header">
          <div className="activity-detail-title">
            <span className={`activity-icon ${activity.type}`}><Icon size={18} /></span>
            <div><small>{activityTypeLabels[activity.type]}事件</small><h2 id="activity-detail-title">{activity.title}</h2></div>
          </div>
          <button className="icon-button" onClick={onClose} autoFocus aria-label="关闭运行记录详情"><X size={18} /></button>
        </header>
        <div className="activity-detail-body">
          <div className="activity-detail-grid">
            <span><small>精确时间戳</small><strong>{timestamp}</strong></span>
            <span><small>事件类型</small><strong>{activityTypeLabels[activity.type]} <code>{activity.type}</code></strong></span>
            <span><small>所属 Bot</small><strong>{bot?.name || 'ZSense'}</strong></span>
            <span><small>Bot ID</small><code>{activity.botId}</code></span>
            <span><small>会话名称</small><strong>{conversation?.title || '未关联会话'}</strong></span>
            <span><small>会话 ID</small><code>{conversation?.id || activity.metadata?.conversationId || '—'}</code></span>
            <span className="activity-detail-wide"><small>记录 ID</small><code>{activity.id}</code></span>
          </div>
          <section className="activity-detail-copy">
            <small>完整操作说明</small>
            <p>{activity.detail}</p>
          </section>
          <section className="activity-detail-metadata">
            <div><strong>操作详细信息</strong><small>{metadata.length ? `${metadata.length} 个详细字段` : '没有附加字段'}</small></div>
            {metadata.length ? <dl>{metadata.map(([key, value]) => <div key={key}><dt>{activityMetadataLabels[key] || key}</dt><dd>{value || '—'}</dd></div>)}</dl> : <p>这条记录只包含上方的基本信息。</p>}
          </section>
        </div>
        <footer className="activity-detail-footer"><ActivityCopyButton activity={activity} bot={bot} conversation={conversation} variant="dialog" /><button className="button secondary" onClick={onClose}>关闭</button></footer>
      </section>
    </div>,
    document.body,
  )
}

export function ActivityPage({ bots, conversations, activities, embedded = false }: { bots: Bot[]; conversations: Conversation[]; activities: Activity[]; embedded?: boolean }) {
  const [query, setQuery] = useState('')
  const [type, setType] = useState<'all' | Activity['type']>('all')
  const [conversationFilter, setConversationFilter] = useState('all')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null)
  const conversationById = useMemo(() => new Map(conversations.map((conversation) => [conversation.id, conversation])), [conversations])
  const visible = useMemo(() => activities.filter((activity) => {
    const conversationId = activity.metadata?.conversationId || ''
    const conversation = conversationById.get(conversationId)
    const searchable = `${conversation?.title || ''} ${conversationId} ${activity.title} ${activity.detail} ${Object.values(activity.metadata || {}).join(' ')}`.toLowerCase()
    const localDate = formatActivityTimestamp(activity.createdAt, activity.time).slice(0, 10)
    return searchable.includes(query.trim().toLowerCase())
      && (type === 'all' || activity.type === type)
      && (conversationFilter === 'all' || (conversationFilter === '__unscoped__' ? !conversation : conversationId === conversationFilter))
      && (!startDate || localDate >= startDate)
      && (!endDate || localDate <= endDate)
  }), [activities, conversationById, conversationFilter, endDate, query, startDate, type])
  const groupedActivities = useMemo(() => {
    const groups = new Map<string, Activity[]>()
    for (const activity of visible) {
      const conversationId = activity.metadata?.conversationId || ''
      const key = conversationId && conversationById.has(conversationId) ? conversationId : '__unscoped__'
      groups.set(key, [...(groups.get(key) || []), activity])
    }
    return [...groups.entries()].map(([conversationId, records]) => {
      const conversation = conversationById.get(conversationId)
      const toolRecords = records.filter((item) => item.type === 'tool')
      const primaryRecords = records.filter((item) => item.type !== 'tool')
      const failedTools = toolRecords.filter((item) => item.metadata?.status === 'error').length
      const totalDurationMs = toolRecords.reduce((sum, item) => sum + Number(item.metadata?.durationMs || 0), 0)
      const replyCount = records.filter((item) => item.metadata?.operation === 'conversation.complete').length
      const agentRounds = conversation?.messages.filter((item) => item.role === 'assistant').reduce((sum, message) => sum + (message.agentSteps?.length || 0), 0) || 0
      return { conversationId, conversation, records, toolRecords, primaryRecords, failedTools, totalDurationMs, replyCount, agentRounds }
    })
  }, [conversationById, visible])
  const exportRecords = () => {
    const blob = new Blob([JSON.stringify(visible, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `zsense-activity-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="page">
      <section className="page-heading"><div><span className="eyebrow">AUDIT TRAIL</span>{embedded ? <h2>运行记录</h2> : <h1>运行记录</h1>}<p>默认按会话汇总，工具明细折叠保留，方便快速定位异常。</p></div><button className="button secondary" onClick={exportRecords}><ExternalLink size={16} />导出记录</button></section>
      <div className="toolbar activity-toolbar"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话名称、事件或工具" /></label><label className="activity-select-filter"><span className="sr-only">按会话名称筛选</span><select value={conversationFilter} onChange={(event) => setConversationFilter(event.target.value)}><option value="all">全部会话</option>{conversations.map((conversation) => <option value={conversation.id} key={conversation.id}>{conversation.title}</option>)}<option value="__unscoped__">未关联会话</option></select></label><label className="activity-date-filter"><span>从</span><input type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} /></label><label className="activity-date-filter"><span>到</span><input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} /></label><div className="segmented activity-type-filter"><button className={type === 'all' ? 'active' : ''} onClick={() => setType('all')}>全部</button><button className={type === 'message' ? 'active' : ''} onClick={() => setType('message')}>消息</button><button className={type === 'memory' ? 'active' : ''} onClick={() => setType('memory')}>记忆</button><button className={type === 'tool' ? 'active' : ''} onClick={() => setType('tool')}>工具</button></div></div>
      <section className="panel audit-panel">
        <div className="audit-day"><span>{groupedActivities.length} 个会话分组 · {visible.length} 条底层记录</span><i /></div>
        {groupedActivities.map((group) => <section className="audit-conversation-group" key={group.conversationId} aria-label={group.conversation?.title || '未关联会话'}>
          <header className="audit-conversation-heading"><span><MessageSquareMore size={14} /><strong>{group.conversation?.title || '未关联会话的系统记录'}</strong></span><code title={group.conversation?.id || ''}>{group.conversation?.id || 'SYSTEM'}</code><span className="audit-conversation-stats"><small>{group.replyCount ? `${group.replyCount} 次回复` : `${group.records.length} 条事件`}</small>{group.agentRounds > 0 && <small>{group.agentRounds} 轮 Agent</small>}<small>{group.toolRecords.length} 次工具</small>{group.failedTools > 0 && <small className="error">{group.failedTools} 次失败</small>}{group.totalDurationMs > 0 && <small>{group.totalDurationMs >= 1000 ? `${(group.totalDurationMs / 1000).toFixed(1)} 秒` : `${group.totalDurationMs} 毫秒`}</small>}</span></header>
          {group.primaryRecords.map((activity) => {
          const bot = bots.find((item) => item.id === activity.botId)
          const Icon = activity.type === 'memory' ? MemoryStick : activity.type === 'message' ? MessageSquareMore : activity.type === 'tool' ? TerminalSquare : Clock3
          const timestamp = formatActivityTimestamp(activity.createdAt, activity.time)
          return <article className="audit-row" key={activity.id}><time dateTime={normalizedActivityDate(activity.createdAt)} title={timestamp}>{timestamp}</time><span className={`activity-icon ${activity.type}`}><Icon size={16} /></span>{bot ? <span className="mini-avatar" style={{ '--avatar': bot.color } as React.CSSProperties}>{bot.initials}</span> : <span className="mini-avatar">ZS</span>}<div className="audit-row-copy"><strong>{activity.title}</strong><p>{activity.detail}</p><small>{bot?.name || 'ZSense'} · {activityTypeLabels[activity.type]}</small></div><div className="audit-row-actions"><span className="activity-type-badge">{activityTypeLabels[activity.type]}</span><ActivityCopyButton activity={activity} bot={bot} conversation={group.conversation} /><button className="text-button audit-detail-trigger" onClick={() => setSelectedActivity(activity)} aria-label={`查看${activity.title}的详细信息`}><Eye size={14} />查看详情</button></div></article>
          })}
          {group.toolRecords.length > 0 && <details className="audit-tool-details"><summary><span><TerminalSquare size={14} /><strong>工具调用明细</strong></span><small>默认折叠 · {group.toolRecords.length} 次{group.failedTools ? ` · ${group.failedTools} 次失败` : ''}</small></summary><div>{group.toolRecords.map((activity) => {
            const bot = bots.find((item) => item.id === activity.botId)
            const timestamp = formatActivityTimestamp(activity.createdAt, activity.time)
            return <article className="audit-row audit-tool-row" key={activity.id}><time dateTime={normalizedActivityDate(activity.createdAt)} title={timestamp}>{timestamp}</time><span className="activity-icon tool"><TerminalSquare size={16} /></span><div className="audit-row-copy"><strong>{activity.title}</strong><p>{activity.detail}</p></div><div className="audit-row-actions"><ActivityCopyButton activity={activity} bot={bot} conversation={group.conversation} /><button className="text-button audit-detail-trigger" onClick={() => setSelectedActivity(activity)} aria-label={`查看${activity.title}的详细信息`}><Eye size={14} />查看详情</button></div></article>
          })}</div></details>}
        </section>)}
        {!visible.length && <div className="empty-state"><Search size={24} /><strong>没有匹配的运行记录</strong><p>修改关键词或筛选条件后再试。</p></div>}
      </section>
      {selectedActivity && <ActivityDetailDialog activity={selectedActivity} bot={bots.find((item) => item.id === selectedActivity.botId)} conversation={conversationById.get(selectedActivity.metadata?.conversationId || '')} onClose={() => setSelectedActivity(null)} />}
    </div>
  )
}

const emptyMcpInput: McpServerConfigurationInput = {
  id: '', name: '', transport: 'http', command: '', args: [], url: '', enabled: true, oauthToken: '', clearOAuthToken: false,
}

interface AgentCapabilitiesPanelProps {
  computerUseEnabled: boolean
  onComputerUseEnabledChange: (enabled: boolean) => void
  autoApprovalEnabled: boolean
  onAutoApprovalEnabledChange: (enabled: boolean) => void
}

function AgentCapabilitiesPanel({ computerUseEnabled, onComputerUseEnabledChange, autoApprovalEnabled, onAutoApprovalEnabledChange }: AgentCapabilitiesPanelProps) {
  const [status, setStatus] = useState<AgentCapabilitiesStatus>()
  const [servers, setServers] = useState<McpServerConfiguration[]>([])
  const [autonomy, setAutonomy] = useState<AutonomySnapshot>({ goals: [], loops: [], heartbeats: [] })
  const [draft, setDraft] = useState<McpServerConfigurationInput>(emptyMcpInput)
  const [busy, setBusy] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string }>()
  const refreshRequest = useRef<Promise<void> | null>(null)

  const load = useCallback(async () => {
    if (!window.zsenseDesktop) return
    if (refreshRequest.current) return refreshRequest.current
    const request = (async () => {
      setRefreshing(true)
      try {
        const [nextStatus, nextServers, nextAutonomy] = await Promise.all([
          unwrapDesktop(window.zsenseDesktop!.capabilities.status()),
          unwrapDesktop(window.zsenseDesktop!.mcp.list()),
          unwrapDesktop(window.zsenseDesktop!.capabilities.autonomy()),
        ])
        setStatus(nextStatus); setServers(nextServers); setAutonomy(nextAutonomy)
      } catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? errorMessage(error) : '无法读取 Agent 能力状态。请稍后重试。' }) }
      finally { setRefreshing(false) }
    })()
    refreshRequest.current = request
    try { await request } finally { if (refreshRequest.current === request) refreshRequest.current = null }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 8_000)
    const refreshOnFocus = () => void load()
    window.addEventListener('focus', refreshOnFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshOnFocus) }
  }, [load])

  const edit = (server: McpServerConfiguration) => setDraft({
    id: server.id, name: server.name, transport: server.transport, command: server.command || '', args: server.args || [], url: server.url || '', enabled: server.enabled, oauthToken: '', clearOAuthToken: false,
  })

  const save = async () => {
    if (!window.zsenseDesktop || busy) return
    setBusy('save'); setMessage(undefined)
    try {
      const saved = await unwrapDesktop(window.zsenseDesktop.mcp.configure(draft))
      setMessage({ kind: 'success', text: `${saved.name} 已保存。可以点击“测试连接”读取它提供的工具。` })
      setDraft(emptyMcpInput); await load()
    } catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? errorMessage(error) : 'MCP 配置保存失败。' }) }
    finally { setBusy('') }
  }

  const test = async (server: McpServerConfiguration) => {
    if (!window.zsenseDesktop || busy) return
    setBusy(`test:${server.id}`); setMessage(undefined)
    try {
      const result = await unwrapDesktop(window.zsenseDesktop.mcp.test(server.id))
      setMessage({ kind: 'success', text: `${server.name} 连接正常，共发现 ${result.toolCount} 个工具${result.tools.length ? `：${result.tools.slice(0, 8).map((item) => item.name).join('、')}` : '。'}` })
      await load()
    } catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? errorMessage(error) : `${server.name} 连接失败。` }) }
    finally { setBusy('') }
  }

  const remove = async (server: McpServerConfiguration) => {
    if (!window.zsenseDesktop || busy || !window.confirm(`确定删除 MCP 服务器“${server.name}”吗？相关 OAuth 凭证也会从系统安全存储中移除。`)) return
    setBusy(`delete:${server.id}`)
    try { setServers(await unwrapDesktop(window.zsenseDesktop.mcp.delete(server.id))); if (draft.id === server.id) setDraft(emptyMcpInput); setMessage({ kind: 'success', text: `${server.name} 已删除。` }); await load() }
    catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? errorMessage(error) : '删除 MCP 服务器失败。' }) }
    finally { setBusy('') }
  }


  const manageAutonomy = async (task: AutonomyTask, action: 'pause' | 'resume' | 'run' | 'remove') => {
    if (!window.zsenseDesktop || busy) return
    if (action === 'remove' && !window.confirm(`确定删除“${task.objective || task.name || (task.kind === 'heartbeat' ? '会话心跳' : task.id)}”吗？`)) return
    setBusy(`autonomy:${action}:${task.id}`); setMessage(undefined)
    try {
      setAutonomy(await unwrapDesktop(window.zsenseDesktop.capabilities.manageAutonomy(task.kind as AutonomyTaskKind, task.id, action)))
      setMessage({ kind: 'success', text: action === 'pause' ? '自治任务已暂停。' : action === 'resume' ? '自治任务已恢复。' : action === 'run' ? '已安排立即运行。' : '自治任务已删除。' })
      await load()
    } catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? errorMessage(error) : '自治任务操作失败。' }) }
    finally { setBusy('') }
  }

  const revokeApproval = async (id: string, label: string) => {
    if (!window.zsenseDesktop || busy) return
    if (id === 'all' && !window.confirm('确定撤销全部“始终允许”授权吗？之后相关重大操作会重新询问。')) return
    setBusy(`approval:${id}`); setMessage(undefined)
    try {
      const grants = await unwrapDesktop(window.zsenseDesktop.capabilities.revokeApproval(id))
      setStatus((current) => current ? { ...current, approvals: { policy: 'minimal', rememberedCount: grants.length, grants } } : current)
      setMessage({ kind: 'success', text: id === 'all' ? '全部已记住授权均已撤销。' : `“${label}”授权已撤销。` })
      await load()
    } catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? errorMessage(error) : '撤销授权失败。' }) }
    finally { setBusy('') }
  }

  const requestComputerPermissions = async () => {
    if (!window.zsenseDesktop?.computerUse || busy) return
    setBusy('computer:permissions'); setMessage(undefined)
    try {
      const computerUse = await unwrapDesktop(window.zsenseDesktop.computerUse.requestPermissions())
      setStatus((current) => current ? { ...current, computerUse } : current)
      setMessage({
        kind: computerUse.screenCapturePermission === 'granted' && computerUse.accessibilityPermission === 'granted' ? 'success' : 'error',
        text: computerUse.screenCapturePermission === 'granted' && computerUse.accessibilityPermission === 'granted'
          ? 'Computer Use 所需的屏幕与输入控制权限均已就绪。'
          : '系统权限尚未完整授予。请在系统隐私设置中允许 ZSense 录屏和辅助功能后再刷新。',
      })
      await load()
    } catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? errorMessage(error) : 'Computer Use 权限检查失败。' }) }
    finally { setBusy('') }
  }

  const autonomyTasks = [...autonomy.goals, ...autonomy.loops, ...autonomy.heartbeats].sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))
  const autonomyTitle = (task: AutonomyTask) => task.objective || task.name || (task.kind === 'heartbeat' ? '会话心跳' : task.id)
  const autonomyKindLabel = (task: AutonomyTask) => task.kind === 'goal' ? 'Goal' : task.kind === 'loop' ? 'Loop' : 'Heartbeat'
  const refreshedLabel = status?.refreshedAt ? new Date(status.refreshedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未刷新'

  return <div className="agent-capabilities-settings">
    <section className="panel settings-block capability-overview-panel" aria-busy={refreshing}>
      <div className="panel-header"><div><h2>Agent 工具与自治能力</h2><p>所有能力直接运行在 ZSense Agent Core，不调用电脑上的 Hermes</p></div><div className="capability-overview-actions"><span className="credential-state saved"><Wrench size={14} />内置能力</span><button className="button secondary capability-refresh-button" disabled={refreshing} onClick={() => void load()} aria-label="立即刷新 Agent 能力状态"><RefreshCw className={refreshing ? 'spin' : ''} size={15} />{refreshing ? '刷新中…' : '刷新'}</button></div></div>
      <div className="capability-refresh-state" aria-live="polite"><span className={refreshing ? 'is-refreshing' : ''}>{refreshing ? '正在读取实时状态' : `上次刷新 ${refreshedLabel}`}</span><small>每 8 秒自动刷新，窗口重新获得焦点时也会更新</small></div>
      <div className="runtime-status-grid capability-stat-grid" aria-live="polite">
        <div><small>已注册能力工具</small><strong>{status?.registeredToolCount ?? status?.toolCount ?? '—'}</strong><span>{status ? `${status.enabledToolCount} 个在 AI 对话启用` : '等待检测'}</span></div>
        <div><small>已注册工具集</small><strong>{status?.registeredToolsetCount ?? status?.toolsets.length ?? '—'}</strong><span title={status?.enabledToolsets.join(' · ')}>{status ? `${status.enabledToolsetCount} 个在 AI 对话启用` : '等待检测'}</span></div>
        <div><small>Agent 托管进程</small><strong>{status?.processCount ?? '—'}</strong><span>仅统计本次运行中由 Agent 启动且仍存活的进程</span></div>
        <div><small>安全回滚点</small><strong>{status?.checkpointCount ?? '—'}</strong><span>统计 ZSense 独立空间内现存回滚点</span></div>
        <div><small>MCP 本次运行已验证</small><strong>{status?.mcp.connectedCount ?? '—'}</strong><span title={status?.mcp.lastVerifiedAt ? `最近验证：${new Date(status.mcp.lastVerifiedAt).toLocaleString('zh-CN')}` : '本次运行尚未完成连接测试'}>{status ? `已配置 ${status.mcp.serverCount} · 已启用 ${status.mcp.enabledCount}` : '等待检测'}</span></div>
        <div><small>活跃自主任务</small><strong>{status?.autonomy.activeCount ?? autonomyTasks.filter((item) => item.status === 'active' && item.enabled).length}</strong><span>{status ? `Goal ${status.autonomy.goalCount} · Loop ${status.autonomy.loopCount} · Heartbeat ${status.autonomy.heartbeatCount}` : '等待检测'}</span></div>
        <div><small>运行中子 Agent</small><strong>{status?.subagents.running ?? '—'}</strong><span title={status?.subagents.recentTask?.title || ''}>{status ? `排队 ${status.subagents.queued} · 完成 ${status.subagents.completed} · 失败 ${status.subagents.failed} · 中断 ${status.subagents.interrupted}` : '等待检测'}</span></div>
        <div><small>已记住授权</small><strong>{status?.approvals?.rememberedCount ?? '—'}</strong><span>按工作区与操作类别隔离，可随时撤销</span></div>
      </div>
      <div className="runtime-details capability-badges"><span><ShieldCheck size={15} />普通操作 <strong>自动放行</strong></span><span><ShieldAlert size={15} />重大操作 <strong>交互审批</strong></span><span><FolderOpen size={15} />文件访问 <strong>完整访问</strong></span><span><RefreshCw size={15} />网页读取 <strong>SSRF 防护</strong></span></div>
    </section>
    {message && <div className={`runtime-message capability-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.kind === 'success' ? <FileCheck2 size={16} /> : <AlertTriangle size={16} />}<span><strong>{message.text}</strong></span></div>}

    <section className="panel settings-block computer-use-settings-panel">
      <div className="panel-header"><div><h2>Computer Use</h2><p>允许 Agent 查看屏幕并在审批后控制鼠标和键盘；默认关闭，截图不会写入数据库或运行日志</p></div><button type="button" className={`switch ${computerUseEnabled ? 'on' : ''}`} role="switch" aria-checked={computerUseEnabled} onClick={() => onComputerUseEnabledChange(!computerUseEnabled)} aria-label={`${computerUseEnabled ? '关闭' : '开启'} Computer Use`}><span /></button></div>
      <div className="computer-use-status-grid" aria-live="polite">
        <article><span><Monitor size={18} /></span><div><strong>屏幕读取</strong><small>{status?.computerUse?.screenCapturePermission === 'granted' ? '已授权' : status?.computerUse?.screenCapturePermission === 'denied' ? '未授权' : status?.computerUse?.screenCapturePermission || '等待检测'}</small></div></article>
        <article><span><MousePointerClick size={18} /></span><div><strong>输入控制</strong><small>{status?.computerUse?.accessibilityPermission === 'granted' ? '已授权' : status?.computerUse?.accessibilityPermission === 'denied' ? '未授权' : status?.computerUse?.accessibilityPermission || '等待检测'}</small></div></article>
        <article><span><ShieldAlert size={18} /></span><div><strong>控制审批</strong><small>点击、输入和按键按工作区审批，可选择仅一次或始终允许</small></div></article>
      </div>
      <div className="computer-use-footer"><span>{status?.computerUse?.supported === false ? '当前平台暂不支持；完整支持 macOS 和 Windows。' : computerUseEnabled ? '保存设置后，AI 对话即可发现 Computer Use 工具。' : '开启并保存后才会向模型暴露桌面控制工具。'}</span><button className="button secondary" type="button" disabled={Boolean(busy) || status?.computerUse?.supported === false} onClick={() => void requestComputerPermissions()}>{busy === 'computer:permissions' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}{busy === 'computer:permissions' ? '检查中…' : '检查并申请权限'}</button></div>
    </section>

    <section className="panel settings-block approval-policy-panel">
      <div className="panel-header"><div><h2>审批与自动放行</h2><p>读取与工作区内的普通处理自动执行；重大操作才询问，可交给模型先判断</p></div>{Boolean(status?.approvals?.grants.length) && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void revokeApproval('all', '全部授权')}><Trash2 size={15} />撤销全部</button>}</div>
      <div className="approval-policy-grid" role="list" aria-label="审批策略">
        <article role="listitem"><span className="approval-policy-icon safe"><Check size={17} /></span><div><strong>自动放行</strong><p>默认全部自动放行：读写任意路径、创建目录、删除或覆盖文件、安装与卸载依赖、控制进程、向外部服务写入数据等常规操作。只有右侧「始终禁止」那四类不会被放行。</p></div></article>
        <article role="listitem"><span className="approval-policy-icon confirm"><ShieldAlert size={17} /></span><div><strong>需要审批</strong><p>默认没有操作会落到这里，保留给将来需要单独收紧的规则。</p></div></article>
        <article role="listitem"><span className="approval-policy-icon blocked"><X size={17} /></span><div><strong>始终禁止</strong><p>提权、磁盘与关机操作、危险的整盘递归删除，以及下载脚本后直接执行。</p></div></article>
      </div>
      <div className="auto-approval-row">
        <span className="approval-policy-icon confirm"><ShieldAlert size={17} /></span>
        <div><strong>自动审批（模型判断）</strong><p>默认开启。需要审批的操作先交给当前对话使用的模型判断：认为你会同意就直接执行并留下记录；判断为拒绝、超时或失败时仍然弹窗问你，并在弹窗里说明原因。删除、安装发布、读取凭证等永久禁止的分类不会被绕过。</p></div>
        <button type="button" className={`switch ${autoApprovalEnabled ? 'on' : ''}`} role="switch" aria-checked={autoApprovalEnabled} aria-label={`${autoApprovalEnabled ? '关闭' : '开启'}自动审批`} onClick={() => onAutoApprovalEnabledChange(!autoApprovalEnabled)}><span /></button>
      </div>
      {autoApprovalEnabled && <div className="auto-approval-audit">
        <div className="auto-approval-audit-header"><strong>最近自动审批</strong><small>模型判断结果，可随时核对</small></div>
        {status?.approvals?.autoApproval?.recent?.length
          ? <div className="auto-approval-list">{status.approvals.autoApproval.recent.slice(0, 10).map((entry) => <article key={entry.id}><span className={`auto-approval-decision ${entry.allow ? 'allow' : 'deny'}`}>{entry.allow ? '自动放行' : '交回人工'}</span><div><strong>{entry.label || entry.category}</strong><small>{entry.reason || '模型没有给出理由'}</small></div><time dateTime={entry.at}>{new Date(entry.at).toLocaleString('zh-CN')}</time></article>)}</div>
          : <p className="auto-approval-empty">还没有自动审批记录；开启后第一次需要审批的操作会出现在这里。</p>}
      </div>}
      <div className="approval-grants-header"><span><strong>已记住的授权</strong><small>“始终允许”只对下列工作区与操作类别生效</small></span><span>{status?.approvals?.rememberedCount || 0} 项</span></div>
      <div className="approval-grant-list">
        {status?.approvals?.grants.map((grant) => <article key={grant.id}><span className="approval-grant-icon"><ShieldCheck size={16} /></span><div><strong>{grant.label}</strong><small title={grant.workspaceRoot}>{grant.workspaceRoot}</small><time dateTime={grant.lastUsedAt}>最近使用 {new Date(grant.lastUsedAt || grant.grantedAt).toLocaleString('zh-CN')}</time></div><button className="text-button danger" disabled={Boolean(busy)} onClick={() => void revokeApproval(grant.id, grant.label)}>{busy === `approval:${grant.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{busy === `approval:${grant.id}` ? '撤销中…' : '撤销'}</button></article>)}
        {!status?.approvals?.grants.length && <div className="empty-state compact"><ShieldCheck size={22} /><strong>还没有长期授权</strong><p>审批时选择“始终允许此类操作”后会显示在这里。</p></div>}
      </div>
    </section>

    <section className="panel settings-block mcp-settings-panel">
      <div className="panel-header"><div><h2>MCP 服务器</h2><p>连接本地 stdio 或远程 Streamable HTTP 工具；OAuth Token 加密保存在系统安全存储</p></div><button className="button secondary" onClick={() => { setDraft(emptyMcpInput); setMessage(undefined) }}><Plus size={15} />新建</button></div>
      <div className="mcp-summary" aria-live="polite"><span><Server size={15} /><small>已配置</small><strong>{servers.length}</strong></span><span><ShieldCheck size={15} /><small>已连接</small><strong>{servers.filter((server) => server.status === 'connected').length}</strong></span><span><Wrench size={15} /><small>已发现工具</small><strong>{servers.reduce((total, server) => total + Number(server.toolCount || 0), 0)}</strong></span></div>
      <div className="mcp-settings-layout">
        <div className="mcp-server-list">
          {servers.map((server) => <article key={server.id} className={draft.id === server.id ? 'active' : ''}>
            <button className="mcp-server-main" disabled={server.locked} onClick={() => edit(server)} aria-label={`${server.locked ? '查看' : '编辑'} MCP 服务器 ${server.name}`}><span className="mcp-server-icon"><Cable size={17} /></span><span><strong>{server.name}{server.builtIn && <em className="mcp-built-in-badge">内置</em>}</strong><small title={server.description || (server.transport === 'http' ? server.url : `${server.command} ${(server.args || []).join(' ')}`)}>{server.description || (server.transport === 'http' ? server.url : `${server.command} ${(server.args || []).join(' ')}`)}</small><em className="mcp-server-meta">{server.transport === 'http' ? 'HTTP' : 'STDIO'} · {server.toolCount || 0} 个工具</em>{server.error && <em className="mcp-server-error" title={server.error}>{server.error}</em>}</span><span className={`connection-state ${server.status === 'connected' ? 'connected' : 'paused'}`}>{!server.enabled ? '已停用' : server.status === 'connected' ? '已连接' : server.status === 'error' ? '异常' : '待测试'}</span></button>
            <div className="mcp-server-actions"><button className="text-button" disabled={Boolean(busy)} onClick={() => void test(server)}>{busy === `test:${server.id}` ? <LoaderCircle className="spin" size={14} /> : <TestTube2 size={14} />}{busy === `test:${server.id}` ? '测试中…' : '测试连接'}</button>{!server.locked && <button className="text-button danger" disabled={Boolean(busy)} onClick={() => void remove(server)}>{busy === `delete:${server.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{busy === `delete:${server.id}` ? '删除中…' : '删除'}</button>}</div>
          </article>)}
          {!servers.length && <div className="empty-state compact"><Cable size={22} /><strong>还没有 MCP 服务器</strong><p>在右侧添加后，Agent 可以通过 tool_search 发现并调用它的工具。</p></div>}
        </div>
        <div className="mcp-editor">
          <header className="mcp-editor-heading"><span><Pencil size={15} /></span><div><strong>{draft.id ? '编辑 MCP 配置' : '新建 MCP 配置'}</strong><small>{draft.id ? `正在配置 ${draft.name || draft.id}` : '填写连接信息后保存，再执行连接测试。'}</small></div></header>
          <div className="form-grid">
            <label><span>服务器名称 *</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value, id: current.id || event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '-') }))} placeholder="例如 GitHub" /></label>
            <label><span>服务器 ID *</span><input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '-') }))} placeholder="github" /></label>
            <label><span>传输方式</span><select value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value as 'stdio' | 'http' }))}><option value="http">Streamable HTTP</option><option value="stdio">本地 stdio</option></select></label>
            <label className="toggle-field"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>启用这个服务器</strong><small>停用后 Agent 不会发现或调用其工具</small></span></label>
            {draft.transport === 'http' ? <>
              <label className="full-field"><span>MCP 地址 *</span><input value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/mcp" /></label>
              <label className="full-field"><span>OAuth / Bearer Token</span><input type="password" value={draft.oauthToken} onChange={(event) => setDraft((current) => ({ ...current, oauthToken: event.target.value, clearOAuthToken: false }))} placeholder={servers.find((item) => item.id === draft.id)?.oauthConfigured ? '已安全保存；留空保持不变' : '可选'} /><small>只进入操作系统安全存储，不写入普通配置文件。</small></label>
            </> : <>
              <label className="full-field"><span>可执行命令 *</span><input value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} placeholder="npx" /></label>
              <label className="full-field"><span>命令参数（每行一个）</span><textarea value={draft.args.join('\n')} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value.split(/\r?\n/).filter(Boolean) }))} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path'} /></label>
            </>}
          </div>
          <div className="mcp-editor-actions"><button className="button primary" disabled={Boolean(busy) || !draft.id || !draft.name || (draft.transport === 'http' ? !draft.url : !draft.command)} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{busy === 'save' ? '保存中…' : '保存 MCP'}</button></div>
        </div>
      </div>
    </section>

    <section className="panel settings-block autonomy-settings-panel">
      <div className="panel-header"><div><h2>自主任务</h2><p>Goal、Loop 和 Heartbeat 会保存在 ZSense 独立空间，并在应用重启后继续调度</p></div><span className="credential-state saved"><Clock3 size={14} />{autonomyTasks.filter((item) => item.status === 'active' && item.enabled).length} 个运行中</span></div>
      <div className="autonomy-help">可在任意 Bot 或 AI 对话中直接说“创建一个持续目标”“每隔 30 分钟执行”或“为当前会话开启心跳”。</div>
      <div className="autonomy-list">
        {autonomyTasks.map((task) => <article key={`${task.kind}:${task.id}`}><span className={`autonomy-kind ${task.kind}`}>{autonomyKindLabel(task)}</span><div className="autonomy-copy"><strong title={autonomyTitle(task)}>{autonomyTitle(task)}</strong><small>{task.model ? `${task.model} · ` : ''}{task.status === 'active' && task.enabled ? `下次 ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN') : '等待调度'}` : task.status === 'completed' ? '已完成' : task.status === 'blocked' ? '需要处理' : '已暂停'}</small>{task.lastError && <em>{task.lastError}</em>}</div><div className="autonomy-actions">{task.status === 'active' && task.enabled ? <button className="text-button" disabled={Boolean(busy)} onClick={() => void manageAutonomy(task, 'pause')}>{busy === `autonomy:pause:${task.id}` ? <LoaderCircle className="spin" size={14} /> : <Power size={14} />}{busy === `autonomy:pause:${task.id}` ? '暂停中…' : '暂停'}</button> : task.status !== 'completed' && <button className="text-button" disabled={Boolean(busy)} onClick={() => void manageAutonomy(task, 'resume')}>{busy === `autonomy:resume:${task.id}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{busy === `autonomy:resume:${task.id}` ? '恢复中…' : '恢复'}</button>}{task.kind !== 'heartbeat' || task.status !== 'completed' ? <button className="text-button" disabled={Boolean(busy)} onClick={() => void manageAutonomy(task, 'run')}>{busy === `autonomy:run:${task.id}` ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{busy === `autonomy:run:${task.id}` ? '运行中…' : '立即运行'}</button> : null}<button className="text-button danger" disabled={Boolean(busy)} onClick={() => void manageAutonomy(task, 'remove')}>{busy === `autonomy:remove:${task.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{busy === `autonomy:remove:${task.id}` ? '删除中…' : '删除'}</button></div></article>)}
        {!autonomyTasks.length && <div className="empty-state compact"><Clock3 size={22} /><strong>还没有自主任务</strong><p>通过对话创建后，可以在这里暂停、恢复、立即运行或删除。</p></div>}
      </div>
    </section>
  </div>
}

interface SettingsPageProps {
  settings: AppSettings
  voiceWakeStatus: VoiceWakeStatus
  storagePath?: string
  runtime: RuntimeStatus
  onSave: (settings: AppSettings) => Promise<void>
  onPickWorkspace: () => Promise<string>
  onRefreshRuntime: () => Promise<void>
  onRuntimeChanged: (status: RuntimeStatus) => void
  currentUser: AuthUser
  onCurrentUserChanged: (user: AuthUser) => void
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  modelPanel: ReactNode
  skillsPanel: ReactNode
  memoryPanel: ReactNode
  activityPanel: ReactNode
}

export type SettingsSection = 'runtime' | 'capabilities' | 'browser' | 'devices' | 'models' | 'skills' | 'memory' | 'activity' | 'display' | 'voice' | 'policies' | 'storage' | 'users'
type RuntimeAction = 'doctor' | null

export function SettingsPage({ settings, voiceWakeStatus, storagePath, runtime, onSave, onPickWorkspace, onRefreshRuntime, onRuntimeChanged, currentUser, onCurrentUserChanged, section, onSectionChange, modelPanel, skillsPanel, memoryPanel, activityPanel }: SettingsPageProps) {

  // 未开启安全锁时，把用户引导到本页的安全锁卡片上并高亮
  const focusSecurityLock = () => {
    window.setTimeout(() => {
      const card = document.querySelector('.user-security-card.lock-card')
      if (!card) return
      card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      card.classList.add('lock-card-highlight')
      window.setTimeout(() => card.classList.remove('lock-card-highlight'), 2_600)
    }, 120)
  }

  const [draft, setDraft] = useState(settings)
  const [memoryEngineStatus, setMemoryEngineStatus] = useState<{ ready: boolean; error: string }>()
  const [saving, setSaving] = useState(false)
  const [runtimeAction, setRuntimeAction] = useState<RuntimeAction>(null)
  const [commandResult, setCommandResult] = useState<RuntimeCommandResult>()
  const [localError, setLocalError] = useState<string>()
  const [testingNotification, setTestingNotification] = useState<'approval' | 'completion' | null>(null)
  const [pickingDefaultWorkspace, setPickingDefaultWorkspace] = useState(false)
  const [notificationTestResult, setNotificationTestResult] = useState<{ kind: 'approval' | 'completion'; message: string }>()
  const [wakePhraseSetupOpen, setWakePhraseSetupOpen] = useState(false)
  const [voiceLanguagesExpanded, setVoiceLanguagesExpanded] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>()
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult>()
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [openingDownload, setOpeningDownload] = useState(false)
  const [localVoices, setLocalVoices] = useState<LocalVoiceOption[]>([])
  const [loadingVoices, setLoadingVoices] = useState(false)
  const [previewingVoice, setPreviewingVoice] = useState(false)
  const [importingVoice, setImportingVoice] = useState(false)
  const [customVoiceName, setCustomVoiceName] = useState('')
  const customVoiceFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(settings), [settings])

  useEffect(() => {
    if (section !== 'policies' || !window.zsenseDesktop?.memories?.status) return
    let active = true
    const refresh = () => { void unwrapDesktop(window.zsenseDesktop!.memories.status()).then((status) => {
      if (active) setMemoryEngineStatus(status)
    }).catch(() => undefined) }
    refresh()
    const interval = window.setInterval(refresh, 5_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [section])

  useEffect(() => {
    if (section !== 'runtime' || !window.zsenseDesktop?.update) return
    let active = true
    void unwrapDesktop(window.zsenseDesktop.update.status())
      .then((status) => { if (active) setUpdateStatus(status) })
      .catch(() => undefined)
    return () => { active = false }
  }, [section])

  const checkForUpdates = async () => {
    if (!window.zsenseDesktop?.update || checkingUpdate) return
    setCheckingUpdate(true)
    setLocalError(undefined)
    try {
      if (draft.updateFeedUrl !== settings.updateFeedUrl) await onSave(draft)
      setUpdateResult(await unwrapDesktop(window.zsenseDesktop.update.check(draft.updateFeedUrl)))
    } catch (error) {
      setLocalError(`检查更新失败：${errorMessage(error)}`)
    } finally {
      setCheckingUpdate(false)
    }
  }

  const openDownload = async () => {
    const url = updateResult?.downloadUrl
    if (!window.zsenseDesktop?.update || !url || openingDownload) return
    setOpeningDownload(true)
    setLocalError(undefined)
    try { await unwrapDesktop(window.zsenseDesktop.update.openDownload(url)) }
    catch (error) { setLocalError(`打开下载地址失败：${errorMessage(error)}`) }
    finally { setOpeningDownload(false) }
  }

  useEffect(() => {
    if (section !== 'voice' || !window.zsenseDesktop?.voice) return
    let active = true
    setLoadingVoices(true)
    void listLocalVoiceOptions().then((voices) => {
      if (!active) return
      setLocalVoices(voices)
      setDraft((current) => voices.some((voice) => voice.id === current.voiceTtsVoice) || !voices[0] ? current : { ...current, voiceTtsVoice: voices[0].id })
    }).catch((error) => {
      if (active) setLocalError(`读取内置音色失败：${errorMessage(error)}`)
    }).finally(() => {
      if (active) setLoadingVoices(false)
    })
    return () => { active = false }
  }, [section])

  const importVoice = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImportingVoice(true)
    setLocalError(undefined)
    try {
      const voiceId = await importMossVoice(file, customVoiceName)
      const voices = await listLocalVoiceOptions()
      setLocalVoices(voices)
      setDraft((current) => ({ ...current, voiceTtsVoice: voiceId }))
      setCustomVoiceName('')
    } catch (error) {
      setLocalError(`音色导入失败：${errorMessage(error)}`)
    } finally {
      setImportingVoice(false)
    }
  }

  const removeSelectedVoice = () => {
    if (!draft.voiceTtsVoice.startsWith('custom-') || !deleteMossVoice(draft.voiceTtsVoice)) return
    void listLocalVoiceOptions().then((voices) => {
      setLocalVoices(voices)
      setDraft((current) => ({ ...current, voiceTtsVoice: voices[0]?.id || 'Xiaoyu' }))
    })
  }

  const previewVoice = async () => {
    const voice = window.zsenseDesktop?.voice
    if (!voice) {
      setLocalError('内置音色试听只在 ZSense 桌面端中可用。')
      return
    }
    if (previewingVoice) {
      await stopLocalSpeech().catch(() => undefined)
      setPreviewingVoice(false)
      return
    }
    setPreviewingVoice(true)
    setLocalError(undefined)
    try {
      const result = await speakLocalAudio({
        text: '你好，我是 ZSense。这是当前选择的本地音色。',
        language: 'zh-CN',
        voice: draft.voiceTtsVoice,
        speed: draft.voiceTtsSpeed,
      })
      if (!result.played && !result.cancelled) throw new Error('本地音频没有完成播放。')
    } catch (error) {
      setLocalError(`试听失败：${errorMessage(error)}`)
    } finally {
      setPreviewingVoice(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setLocalError(undefined)
    const wakePhrase = draft.voiceWakePhrase.trim()
    if (wakePhrase.length < 2 || !/[\p{L}\p{N}]/u.test(wakePhrase)) {
      setLocalError('自定义唤醒词至少需要 2 个字符，并包含文字或数字。')
      setSaving(false)
      return
    }
    try { await onSave({ ...draft, voiceWakePhrase: wakePhrase }) }
    catch (error) { setLocalError(errorMessage(error)) }
    finally { setSaving(false) }
  }

  const pickDefaultWorkspace = async () => {
    setPickingDefaultWorkspace(true)
    setLocalError(undefined)
    try {
      const workspacePath = await onPickWorkspace()
      if (workspacePath) setDraft((current) => ({ ...current, defaultWorkspacePath: workspacePath }))
    } catch (error) {
      setLocalError(errorMessage(error))
    } finally {
      setPickingDefaultWorkspace(false)
    }
  }

  const runRuntimeAction = async () => {
    if (!window.zsenseDesktop) {
      setLocalError('核心服务诊断只在 ZSense 桌面端中可用。')
      return
    }
    setRuntimeAction('doctor')
    setCommandResult(undefined)
    setLocalError(undefined)
    try {
      const result = await unwrapDesktop(window.zsenseDesktop.runtime.doctor())
      setCommandResult(result)
      if (result.status) onRuntimeChanged(result.status)
      else await onRefreshRuntime()
    } catch (error) {
      setLocalError(errorMessage(error))
    } finally {
      setRuntimeAction(null)
    }
  }

  const testNotification = async (kind: 'approval' | 'completion') => {
    if (!window.zsenseDesktop) {
      setLocalError('系统通知测试只在 ZSense 桌面端中可用。')
      return
    }
    setTestingNotification(kind)
    setNotificationTestResult(undefined)
    setLocalError(undefined)
    try {
      const result = await unwrapDesktop(window.zsenseDesktop.notifications.test(kind))
      setNotificationTestResult({
        kind,
        message: result.notificationShown
          ? `${kind === 'approval' ? '审批' : '完成'}测试通知已发送${result.soundPlayed ? '，并已播放测试提示音' : ''}。若没有看到系统横幅，请检查系统通知权限、专注模式或通知中心。`
          : result.failureReason || (result.supported ? '系统拒绝显示桌面通知，请检查 ZSense 的通知权限。' : '当前系统不支持桌面通知。'),
      })
      window.setTimeout(() => setNotificationTestResult((current) => current?.kind === kind ? undefined : current), 8_000)
    } catch (error) {
      setLocalError(errorMessage(error))
    } finally {
      setTestingNotification(null)
    }
  }

  const statusLabel = runtime.runnable ? 'Agent Core 运行正常' : runtime.status === 'initializing' ? '正在初始化' : runtime.status === 'broken' ? 'Agent Core 异常' : '浏览器预览'
  const statusClass = runtime.runnable ? 'online' : runtime.status === 'browser' ? 'offline' : 'paused'
  const lifecycleLabel = runtime.lifecycle === 'running'
    ? `${runtime.managedGatewayCount} 个运行中`
    : runtime.lifecycle === 'idle'
      ? '已就绪 · 当前待命'
      : runtime.lifecycle === 'stopped'
        ? '正在关闭'
        : '暂不可用'
  const gatewayHealthLabel = runtime.lastGatewayHealthCheckAt
    ? `${new Date(runtime.lastGatewayHealthCheckAt).toLocaleString('zh-CN')} · ${runtime.gatewayHealthyCount}/${runtime.gatewayExpectedCount} 健康`
    : '等待首次检测'

  return (
    <div className="page settings-page">
      <section className="page-heading">
        <div><span className="eyebrow">SYSTEM SETTINGS</span><h1>设置</h1><p>集中管理模型、技能、记忆、运行记录以及 ZSense Agent Core。</p></div>
        <div className="settings-heading-actions">
          {(['runtime', 'storage', 'policies', 'display', 'voice', 'capabilities', 'browser'] as SettingsSection[]).includes(section) && <button className="button primary" onClick={save} disabled={saving}>{saving ? <><RefreshCw className="spin" size={16} />保存中</> : <><Save size={16} />保存更改</>}</button>}
        </div>
      </section>
      <div className="settings-layout">
        <nav className="panel settings-nav" aria-label="设置分类">
          <button className={section === 'runtime' ? 'active' : ''} onClick={() => onSectionChange('runtime')}><Server size={17} />核心服务</button>
          <button className={section === 'devices' ? 'active' : ''} onClick={() => onSectionChange('devices')}><Cable size={17} />设备互联</button>
          <button className={section === 'models' ? 'active' : ''} onClick={() => onSectionChange('models')}><Cpu size={17} />AI 模型</button>
          <button className={section === 'skills' ? 'active' : ''} onClick={() => onSectionChange('skills')}><Blocks size={17} />技能管理</button>
          <button className={section === 'capabilities' ? 'active' : ''} onClick={() => onSectionChange('capabilities')}><Wrench size={17} />工具与 MCP</button>
          <button className={section === 'browser' ? 'active' : ''} onClick={() => onSectionChange('browser')}><Globe2 size={17} />浏览器</button>
          <button className={section === 'memory' ? 'active' : ''} onClick={() => onSectionChange('memory')}><MemoryStick size={17} />记忆管理</button>
          <button className={section === 'activity' ? 'active' : ''} onClick={() => onSectionChange('activity')}><ActivityIcon size={17} />运行记录</button>
          <button className={section === 'display' ? 'active' : ''} onClick={() => onSectionChange('display')}><Monitor size={17} />显示</button>
          <button className={section === 'voice' ? 'active' : ''} onClick={() => onSectionChange('voice')}><AudioLines size={17} />语音交互</button>
          <button className={section === 'policies' ? 'active' : ''} onClick={() => onSectionChange('policies')}><LockKeyhole size={17} />会话与安全</button>
          <button className={section === 'storage' ? 'active' : ''} onClick={() => onSectionChange('storage')}><Database size={17} />本地存储</button>
        </nav>
        <section className="settings-content">
          {section === 'users' && currentUser.role === 'admin' && <UserManagementPanel currentUser={currentUser} settings={draft} onSaveSettings={onSave} onCurrentUserChanged={onCurrentUserChanged} />}
          {section === 'models' && <div className="settings-embedded-page">{modelPanel}</div>}
          {section === 'skills' && <div className="settings-embedded-page">{skillsPanel}</div>}
          {section === 'capabilities' && <AgentCapabilitiesPanel computerUseEnabled={draft.computerUseEnabled} onComputerUseEnabledChange={(enabled) => setDraft({ ...draft, computerUseEnabled: enabled })} autoApprovalEnabled={draft.autoApprovalEnabled} onAutoApprovalEnabledChange={(enabled) => setDraft({ ...draft, autoApprovalEnabled: enabled })} />}
          {section === 'browser' && <BrowserSettingsPanel draft={draft} setDraft={setDraft} />}
          {section === 'memory' && <div className="settings-embedded-page">{memoryPanel}</div>}
          {section === 'activity' && <div className="settings-embedded-page">{activityPanel}</div>}
          {section === 'devices' && <><DeviceLinkSettingsPanel onOpenSecurity={focusSecurityLock} /><AccountPanel currentUser={currentUser} settings={draft} onSaveSettings={onSave} /></>}

          {section === 'display' && <div className="panel settings-block display-settings-panel">
            <div className="panel-header"><div><h2>显示与通知</h2><p>控制对话内容的呈现方式、输入区高度以及系统反馈。</p></div></div>
            <SettingSwitch icon={MessageSquareMore} title="流式响应" description="实时显示 AI 回复；关闭后等待完整回答生成后一次显示" checked={draft.streamingResponse} onChange={(checked) => setDraft({ ...draft, streamingResponse: checked })} />
            <SettingSwitch icon={Minimize2} title="紧凑模式" description="减少对话消息之间的间距，在同一屏幕显示更多内容" checked={draft.compactMode} onChange={(checked) => setDraft({ ...draft, compactMode: checked })} />
            <SettingSwitch icon={Brain} title="显示推理过程" description="在 AI 回复中展示模型返回的推理摘要" checked={draft.showReasoning} onChange={(checked) => setDraft({ ...draft, showReasoning: checked })} />
            <SettingSwitch icon={Cpu} title="显示费用" description="在 AI 回复下方显示输入、输出及总 token 使用量" checked={draft.showUsage} onChange={(checked) => setDraft({ ...draft, showUsage: checked })} />
            <SettingSwitch icon={Code2} title="内联差异" description="代码变更以逐行增加和删除的内联样式显示" checked={draft.inlineDiff} onChange={(checked) => setDraft({ ...draft, inlineDiff: checked })} />
            <div className="voice-wake-option-row"><span className="setting-icon"><Languages size={18} /></span><span><strong>文字回复语言</strong><small>仅影响文字对话、Bot 与定时任务；语音交流始终使用简体中文。</small></span><label><span className="sr-only">文字回复语言</span><select value={draft.responseLanguage} onChange={(event) => setDraft({ ...draft, responseLanguage: event.target.value as AppSettings['responseLanguage'] })}><option value="zh-CN">简体中文 · 默认</option><option value="auto">自动跟随提问语言</option><option value="en-US">English</option></select></label></div>
            <SettingSwitch icon={Volume2} title="完成提示音" description="AI 回复或定时任务完成时播放提示音" checked={draft.completionSound} onChange={(checked) => setDraft({ ...draft, completionSound: checked })} />
            <SettingSwitch icon={Volume2} title="审批提示音" description="出现新的待处理审批、授权或澄清时播放提示音" checked={draft.approvalSound} onChange={(checked) => setDraft({ ...draft, approvalSound: checked })} />
            <div className="display-notification-row"><span className="setting-icon"><BellRing size={18} /></span><span><strong>审批桌面通知</strong><small>ZSense 不在前台时，新的审批、授权或澄清会发送系统通知；通知不会显示敏感详情。</small></span><div><button type="button" className={`switch ${draft.approvalDesktopNotification ? 'on' : ''}`} role="switch" aria-checked={draft.approvalDesktopNotification} onClick={() => setDraft({ ...draft, approvalDesktopNotification: !draft.approvalDesktopNotification })} aria-label={`${draft.approvalDesktopNotification ? '停用' : '启用'}审批桌面通知`}><span /></button><button type="button" className={`button secondary small ${notificationTestResult?.kind === 'approval' ? 'tested' : ''}`} disabled={testingNotification !== null} onClick={() => void testNotification('approval')}>{testingNotification === 'approval' ? <LoaderCircle className="spin" size={14} /> : notificationTestResult?.kind === 'approval' ? <Check size={14} /> : <Bell size={14} />}{testingNotification === 'approval' ? '发送中' : notificationTestResult?.kind === 'approval' ? '已发送' : '测试'}</button></div></div>
            <div className="display-notification-row"><span className="setting-icon"><BellRing size={18} /></span><span><strong>完成弹窗通知</strong><small>AI 回复或定时任务完成时发送系统通知；通知不会显示 API Key 等敏感内容。</small></span><div><button type="button" className={`switch ${draft.completionDesktopNotification ? 'on' : ''}`} role="switch" aria-checked={draft.completionDesktopNotification} onClick={() => setDraft({ ...draft, completionDesktopNotification: !draft.completionDesktopNotification })} aria-label={`${draft.completionDesktopNotification ? '停用' : '启用'}完成弹窗通知`}><span /></button><button type="button" className={`button secondary small ${notificationTestResult?.kind === 'completion' ? 'tested' : ''}`} disabled={testingNotification !== null} onClick={() => void testNotification('completion')}>{testingNotification === 'completion' ? <LoaderCircle className="spin" size={14} /> : notificationTestResult?.kind === 'completion' ? <Check size={14} /> : <Bell size={14} />}{testingNotification === 'completion' ? '发送中' : notificationTestResult?.kind === 'completion' ? '已发送' : '测试'}</button></div></div>
            {notificationTestResult && <div className="notification-test-result" role="status"><Check size={17} /><span><strong>测试请求已完成</strong><small>{notificationTestResult.message}</small></span></div>}
            <div className="chat-input-height-row"><span className="setting-icon"><MessageSquareMore size={18} /></span><span><strong>聊天输入框高度</strong><small>设置默认高度（80–320 像素）；向上浏览历史时会临时收缩，回到最底部后平滑恢复，也可以直接拖动输入框上边缘调整。</small></span><div><label><input type="number" min={80} max={320} value={draft.chatInputHeight} onChange={(event) => setDraft({ ...draft, chatInputHeight: Math.min(320, Math.max(80, Number(event.target.value) || 88)) })} aria-label="聊天输入框高度" /><span>px</span></label><button type="button" className="button secondary small" onClick={() => setDraft({ ...draft, chatInputHeight: 88 })}>重置</button></div></div>
            {localError && <div className="scheduled-form-error display-settings-error" role="alert">{localError}</div>}
          </div>}
          {section === 'voice' && <div className="panel settings-block voice-wake-settings-panel">
            <div className="panel-header"><div><h2>语音唤醒与交流</h2><p>Whisper 负责本地转写，MOSS-TTS-Nano 负责实时口语输出和音色克隆；录音和语音文字均不上传。</p></div><span className={`status-label ${voiceWakeStatus.listening ? 'online' : voiceWakeStatus.state === 'error' || voiceWakeStatus.state === 'unavailable' ? 'paused' : 'offline'}`}><i />{voiceWakeStatus.listening ? '正在监听' : voiceWakeStatus.state === 'starting' ? '正在启动' : draft.voiceWakeEnabled ? '等待启动' : '已关闭'}</span></div>
            <div className={`voice-wake-overview ${voiceWakeStatus.state}`} aria-live="polite">
              <span className="voice-wake-orb"><Mic2 size={23} /></span>
              <span><small>当前唤醒词</small><strong>{draft.voiceWakePhrase || '你好 ZSense'}</strong><p>{draft.voiceWakeEnabled ? voiceWakeStatus.message : '开启并保存后，ZSense 会在应用运行期间监听唤醒词。'}</p></span>
              {voiceWakeStatus.listening && <span className="voice-wake-listening"><i /><i /><i /><i /></span>}
            </div>
            <SettingSwitch icon={AudioLines} title="启用语音唤醒" description="随 ZSense 启动和退出；关闭功能或退出应用后立即释放麦克风" checked={draft.voiceWakeEnabled} onChange={(checked) => setDraft({ ...draft, voiceWakeEnabled: checked })} />
            <SettingSwitch icon={MessageSquareMore} title="唤醒后进入语音交流" description={`听到“${draft.voiceWakePhrase || '你好 ZSense'}”后直接识别并发送到 AI 对话；关闭后只打开并聚焦文字输入框`} checked={draft.voiceConversationEnabled} onChange={(checked) => setDraft({ ...draft, voiceConversationEnabled: checked })} />
            <SettingSwitch icon={Volume2} title="语音会话即时发声" description="语音提问会生成简短、自然的口语回答，并由内置 MOSS-TTS-Nano 边生成边按句播放；不是朗读普通长篇回复" checked={draft.voiceAutoSpeak} onChange={(checked) => setDraft({ ...draft, voiceAutoSpeak: checked })} />
            <SettingSwitch icon={AudioLines} title="连续语音交流" description="每轮口语回答结束后自动重新聆听；你也可以在思考或说话时直接开口打断，过短声音会被拦截" checked={draft.voiceContinuousConversation} onChange={(checked) => setDraft({ ...draft, voiceContinuousConversation: checked })} />
            <div className="voice-wake-option-row voice-language-row"><span className="setting-icon"><Languages size={18} /></span><span><strong>语音语言</strong><small>识别、唤醒和播报目前只支持简体中文。</small></span><div className="voice-language-actions"><span className="voice-language-current">{VOICE_LANGUAGE_OPTIONS[0].label}</span><button type="button" className="button secondary small" aria-expanded={voiceLanguagesExpanded} aria-controls="voice-language-expansion" onClick={() => setVoiceLanguagesExpanded((current) => !current)}><Plus size={14} />扩展语种</button></div></div>
            {voiceLanguagesExpanded && <div id="voice-language-expansion" className="voice-language-expansion" role="region" aria-label="语音语种扩展"><strong>语种扩展入口</strong><p>当前只启用简体中文。其他语种尚未接入本地识别模型与播报音色，因此暂不可选择；后续完成对应语言包适配后，会在这里显示并启用。</p></div>}
            <div className="voice-wake-option-row voice-tts-option-row"><span className="setting-icon"><Volume2 size={18} /></span><span><strong>MOSS 播报音色</strong><small>内置三种中文男声和三种中文女声，也可以导入参考音频克隆；macOS 与 Windows 使用同一套模型</small></span><div className="voice-tts-controls"><label htmlFor="voice-tts-voice"><span className="sr-only">选择 MOSS 播报音色</span><select id="voice-tts-voice" value={draft.voiceTtsVoice} disabled={loadingVoices || !localVoices.length} onChange={(event) => setDraft({ ...draft, voiceTtsVoice: event.target.value })}>{loadingVoices && <option value={draft.voiceTtsVoice}>正在读取 MOSS 音色…</option>}{!loadingVoices && !localVoices.length && <option value={draft.voiceTtsVoice}>MOSS 音色暂不可用</option>}{localVoices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label><button type="button" className={`button secondary small ${previewingVoice ? 'active' : ''}`} onClick={() => void previewVoice()} disabled={loadingVoices || !localVoices.length} aria-label={previewingVoice ? '停止试听当前音色' : '试听当前音色'}>{previewingVoice ? '停止' : '试听'}</button></div></div>
            <div className="voice-wake-option-row voice-clone-row"><span className="setting-icon"><Mic2 size={18} /></span><span><strong>克隆我的音色</strong><small>填写名称并导入一段 5–15 秒、无背景音乐的清晰 WAV/MP3；特征只保存在本机</small></span><div className="voice-clone-controls"><input value={customVoiceName} onChange={(event) => setCustomVoiceName(event.target.value)} placeholder="音色名称（可选）" maxLength={40} aria-label="自定义音色名称" /><input ref={customVoiceFileRef} className="sr-only" type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg" onChange={(event) => void importVoice(event)} /><button type="button" className="button secondary small" disabled={importingVoice} onClick={() => customVoiceFileRef.current?.click()}>{importingVoice ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{importingVoice ? '正在提取' : '导入音频'}</button>{draft.voiceTtsVoice.startsWith('custom-') && <button type="button" className="button danger small" onClick={removeSelectedVoice}><Trash2 size={14} />删除当前音色</button>}</div></div>
            <div className="voice-wake-option-row voice-wake-phrase-row"><span className="setting-icon"><Mic2 size={18} /></span><span><strong>自定义唤醒词</strong><small>建议使用 4–8 个中文字符，避免日常高频短语</small></span><div className="voice-wake-phrase-controls"><label htmlFor="voice-wake-phrase"><span className="sr-only">自定义唤醒词</span><input id="voice-wake-phrase" value={draft.voiceWakePhrase} maxLength={32} onChange={(event) => setDraft({ ...draft, voiceWakePhrase: event.target.value })} placeholder="例如：你好小智" /></label><button type="button" className="button secondary small" onClick={() => setWakePhraseSetupOpen(true)}><Mic2 size={15} />语音录入</button></div></div>
            <div className="voice-wake-option-row"><span className="setting-icon"><AudioLines size={18} /></span><span><strong>唤醒灵敏度</strong><small>越灵敏越容易在较远距离唤醒，也会略微增加误触发概率</small></span><label><span className="sr-only">唤醒灵敏度</span><select value={draft.voiceWakeSensitivity} onChange={(event) => setDraft({ ...draft, voiceWakeSensitivity: Number(event.target.value) })}><option value={0.2}>超高灵敏</option><option value={0.3}>高灵敏 · 推荐</option><option value={0.45}>均衡</option><option value={0.6}>稳健</option><option value={0.75}>严格</option></select></label></div>
            <div className="voice-wake-option-row"><span className="setting-icon"><AudioLines size={18} /></span><span><strong>唤醒确认速度</strong><small>确认帧越少，唤醒响应越快；嘈杂环境可以增加确认帧</small></span><label><span className="sr-only">唤醒确认帧数</span><select value={draft.voiceWakeConfirmationFrames} onChange={(event) => setDraft({ ...draft, voiceWakeConfirmationFrames: Number(event.target.value) })}><option value={1}>1 帧 · 最快（推荐）</option><option value={2}>2 帧 · 平衡</option><option value={3}>3 帧 · 稳定</option><option value={4}>4 帧 · 嘈杂环境</option></select></label></div>
            <SettingSwitch icon={Volume2} title="唤醒提示音" description="识别到唤醒词后播放一声系统提示音" checked={draft.voiceWakeSound} onChange={(checked) => setDraft({ ...draft, voiceWakeSound: checked })} />
            <SettingSwitch icon={MessageSquareMore} title="唤醒后新建 AI 对话" description="每次唤醒都打开一个新的 AI 对话；关闭后继续当前对话" checked={draft.voiceWakeStartNewConversation} onChange={(checked) => setDraft({ ...draft, voiceWakeStartNewConversation: checked })} />
            <div className="voice-wake-privacy-note"><ShieldCheck size={17} /><span><strong>完全本地语音 · 无需语音 API</strong><small>STT 使用 Whisper base，TTS 使用 MOSS-TTS-Nano 100M ONNX 和 MOSS Audio Tokenizer Nano。模型随安装包提供，运行时不下载、不调用网络语音服务，也不读取模型 API Key。</small></span></div>
            {voiceWakeStatus.permission === 'denied' && <div className="scheduled-form-error display-settings-error" role="alert">麦克风权限已被拒绝。请前往系统设置 → 隐私与安全性 → 麦克风，允许 ZSense 使用麦克风。</div>}
            {localError && <div className="scheduled-form-error display-settings-error" role="alert">{localError}</div>}
            <WakePhraseSetupDialog open={wakePhraseSetupOpen} initialPhrase={draft.voiceWakePhrase} onClose={() => setWakePhraseSetupOpen(false)} onApply={(phrase) => setDraft((current) => ({ ...current, voiceWakePhrase: phrase }))} />
          </div>}
          {section === 'runtime' && <>
            <div className={`panel settings-block runtime-control runtime-${runtime.status}`}>
              <div className="panel-header"><div><h2>ZSense Agent Core</h2><p>模型调用、工具循环、记忆、技能、定时任务、消息网关与语音均由 ZSense 提供</p></div><span className={`status-label ${statusClass}`}><i />{statusLabel}</span></div>
              <div className="runtime-status-grid">
                <div><small>ZSense Agent Core</small><strong>{runtime.agentCoreVersion ? `v${runtime.agentCoreVersion}` : '无法读取'}</strong><span>{runtime.agentCoreReady ? '应用内对话与定时任务可用' : '当前不可用'}</span></div>
                <div><small>消息网关引擎</small><strong>ZSense Native</strong><span>{runtime.gatewayHealthyCount}/{runtime.gatewayExpectedCount} 个连接健康</span></div>
                <div><small>语音引擎</small><strong>{runtime.voiceSupported ? '本地可用' : '当前平台不可用'}</strong><span>{runtime.voiceProvider || '等待检测'}</span></div>
                <div><small>运行范围</small><strong>仅 ZSense</strong><span>{runtime.scope === 'isolated' ? '完全隔离空间' : '浏览器预览'}</span></div>
                <div><small>随应用交付</small><strong>无需另装组件</strong><span>升级 ZSense 即同步升级 Agent Core</span></div>
                <div><small>Gateway 托管</small><strong>{lifecycleLabel}</strong><span>{runtime.managedByApp ? '随 ZSense 启动与退出' : '仅桌面端支持'}</span></div>
                <div><small>Gateway 自动巡检</small><strong>{runtime.gatewayMonitorEnabled ? `每 ${runtime.gatewayHealthCheckIntervalSeconds} 秒` : '未启用'}</strong><span>{gatewayHealthLabel} · 已恢复 {runtime.gatewayRecoveryCount} 次</span></div>
              </div>
              <div className="runtime-paths">
                <span><small>Agent 数据目录</small><code>{runtime.agentDataPath || '桌面端启动后生成'}</code></span>
                <span><small>消息网关目录</small><code>{runtime.gatewayDataPath || '桌面端启动后生成'}</code></span>
              </div>
              {runtime.managedByApp && <div className="runtime-lifecycle-note"><Power size={17} /><span><strong>所有服务均由 ZSense 托管</strong><small>打开应用时启动在线 Bot 的已启用渠道，退出应用时全部关闭；运行期间每 {runtime.gatewayHealthCheckIntervalSeconds} 秒检测平台连接，失联后自动重建。不会查找或调用电脑上的其他 Agent。</small></span></div>}
              {runtime.lastGatewayError && <div className="runtime-message warning"><AlertTriangle size={17} /><span><strong>{runtime.lastGatewayError}</strong><small>请重新检测；如持续失败，可运行诊断查看原因。</small></span></div>}
              <div className={`runtime-message ${runtime.runnable ? 'success' : 'warning'}`}>{runtime.runnable ? <FileCheck2 size={17} /> : <AlertTriangle size={17} />}<span><strong>{runtime.message}</strong><small>检测时间：{new Date(runtime.checkedAt).toLocaleString('zh-CN')}</small></span></div>
              <div className="runtime-actions">
                <button className="button secondary" onClick={() => void onRefreshRuntime()} disabled={Boolean(runtimeAction)}><RefreshCw size={16} />重新检测</button>
                <button className="button primary" onClick={() => void runRuntimeAction()} disabled={Boolean(runtimeAction)}>{runtimeAction === 'doctor' ? <RefreshCw className="spin" size={16} /> : <TerminalSquare size={16} />}运行核心服务诊断</button>
              </div>
            </div>

            <div className="panel settings-block">
              <div className="panel-header"><div><h2>Gateway 接口</h2><p>Webhook 在本机监听，其他渠道使用各平台官方长连接 SDK</p></div></div>
              <div className="settings-form two-column">
                <label className="full-field"><span>Webhook 本地地址</span><input value={draft.gatewayUrl} onChange={(event) => setDraft({ ...draft, gatewayUrl: event.target.value })} /><small>默认仅监听 127.0.0.1；可以由反向代理安全转发到公网。</small></label>
                <label><span>事件接收方式</span><input value="各渠道官方长连接 / 本机 Webhook" readOnly /><small>外部消息由各平台官方 SDK 长连接接收；只有 Webhook 渠道在本机监听端口。</small></label>
                <label><span>配置与凭证</span><input value="由 ZSense 系统钥匙串加密管理" readOnly /><small>界面和数据库均不保存供应商密钥明文。</small></label>
              </div>
            </div>

            <div className="panel settings-block">
              <div className="panel-header">
                <div><h2>软件更新</h2><p>当前版本 {updateStatus?.currentVersion ? `v${updateStatus.currentVersion}` : '读取中…'}；默认从 GitHub Releases 检查新版本</p></div>
                <button className="button secondary" disabled={checkingUpdate} onClick={() => void checkForUpdates()}>{checkingUpdate ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}{checkingUpdate ? '检查中…' : '检查更新'}</button>
              </div>
              <div className="settings-form two-column">
                <label className="full-field"><span>自定义更新地址（可选）</span><input value={draft.updateFeedUrl} placeholder="留空使用 ZSense 的 GitHub Releases" onChange={(event) => setDraft({ ...draft, updateFeedUrl: event.target.value })} /><small>留空时点击「检查更新」会读取公开的 GitHub Release；也可填写自己的 JSON 或 latest*.yml 更新清单地址。不会自动下载或安装。</small></label>
              </div>
              {updateResult && <div className={`runtime-message ${updateResult.ok ? (updateResult.updateAvailable ? 'warning' : 'success') : 'warning'}`}>
                {updateResult.ok ? (updateResult.updateAvailable ? <Download size={17} /> : <FileCheck2 size={17} />) : <AlertTriangle size={17} />}
                <span>
                  <strong>{updateResult.ok
                    ? (updateResult.updateAvailable ? `发现新版本 v${updateResult.latestVersion}（当前 v${updateResult.currentVersion}）` : `已是最新版本 v${updateResult.currentVersion}`)
                    : `检查更新失败：${updateResult.error || '未知原因'}`}</strong>
                  <small>{updateResult.ok
                    ? (updateResult.publishedAt ? `发布时间：${updateResult.publishedAt}` : `检查时间：${updateResult.checkedAt ? new Date(updateResult.checkedAt).toLocaleString('zh-CN') : '刚刚'}`)
                    : (updateResult.checkedAt ? `检查时间：${new Date(updateResult.checkedAt).toLocaleString('zh-CN')}` : '')}</small>
                </span>
              </div>}
              {updateResult?.ok && updateResult.notes && <pre className="update-notes">{updateResult.notes}</pre>}
              {updateResult?.ok && updateResult.updateAvailable && <div className="runtime-actions">
                <button className="button primary" disabled={!updateResult.downloadUrl || openingDownload} onClick={() => void openDownload()}><Download size={16} />{openingDownload ? '正在打开…' : updateResult.downloadUrl ? '打开下载地址' : '更新清单未提供下载地址'}</button>
              </div>}
            </div>

            {(commandResult || localError) && <div className={`panel command-result ${commandResult?.ok ? 'success' : 'error'}`}>
              <div className="panel-header"><div><h2>{localError ? '操作失败' : commandResult?.ok ? '检查已完成' : '核心服务返回错误'}</h2><p>{commandResult ? `耗时 ${(commandResult.durationMs / 1000).toFixed(1)} 秒` : '请根据下面的信息处理'}</p></div></div>
              <pre>{localError || commandResult?.output || '命令没有返回文本。'}</pre>
            </div>}
          </>}

          {section === 'storage' && <>
            <div className="panel settings-block global-workspace-settings">
              <div className="panel-header"><div><h2>默认全局工作区</h2><p>新建 AI 对话、Bot 对话与定时任务默认在此目录中读写文件</p></div></div>
              <div className={`storage-path ${draft.defaultWorkspacePath ? 'selected' : ''}`}><FolderOpen size={20} /><span><small>当前默认文件夹</small><code>{draft.defaultWorkspacePath || '尚未选择'}</code></span><button type="button" className="button secondary small" onClick={() => void pickDefaultWorkspace()} disabled={pickingDefaultWorkspace}>{pickingDefaultWorkspace ? <LoaderCircle className="spin" size={14} /> : <FolderOpen size={14} />}{draft.defaultWorkspacePath ? '更换文件夹' : '选择文件夹'}</button></div>
              <div className="global-workspace-help"><ShieldCheck size={15} /><span>每个会话仍然可以单独选择其他工作区；修改默认值不会移动或删除已有文件。</span></div>
              {localError && <div className="scheduled-form-error display-settings-error" role="alert">{localError}</div>}
            </div>
            <div className="panel settings-block">
              <div className="panel-header"><div><h2>本地数据库</h2><p>SQLite 保存会话与长期记忆；安装后即可离线使用，无需额外下载组件</p></div><span className="status-label online"><i />本机存储</span></div>
              <div className="storage-path"><Database size={20} /><span><small>数据库文件</small><code>{storagePath || '浏览器模式使用 localStorage'}</code></span></div>
              <div className="runtime-details"><span><ShieldCheck size={15} />Bot 记忆 <strong>按 bot_id 隔离</strong></span><span><ActivityIcon size={15} />审计记录 <strong>本机保存</strong></span><span><FileCheck2 size={15} />跨平台 <strong>macOS / Windows</strong></span></div>
            </div>
            <div className="panel settings-block storage-schema">
              <div className="panel-header"><div><h2>已建立的数据空间</h2><p>不再依赖界面中的临时 Mock 数据</p></div></div>
              <div>{['Bots 与身份', '独立记忆', '消息渠道与路由', '共享技能', '运行设置', '活动审计', '会话与消息'].map((name) => <span key={name}><Check size={15} />{name}</span>)}</div>
            </div>
          </>}

          {section === 'policies' && <div className="panel settings-block">
            <div className="panel-header"><div><h2>Bot 默认策略</h2><p>应用内对话与外部消息统一由 ZSense Agent Core 执行；长期记忆在本机整理和召回</p></div></div>
            <SettingSwitch icon={Brain} title="自动提取长期记忆" description="回复完成后只保存明确的长期事实与偏好，按 Bot 隔离、去重并按需召回；全程本地处理" checked={draft.autoExtractMemory} onChange={(checked) => setDraft({ ...draft, autoExtractMemory: checked })} />
            <div className="runtime-details"><span><Database size={15} />内置本地记忆 <strong>{memoryEngineStatus?.ready ? '可用' : memoryEngineStatus?.error ? '暂不可用' : '初始化中'}</strong></span>{memoryEngineStatus?.error && <span title={memoryEngineStatus.error}>{memoryEngineStatus.error.slice(0, 160)}</span>}</div>
            <div className={`compression-settings memory-policy-settings ${draft.autoExtractMemory ? '' : 'disabled'}`} aria-label="长期记忆参数">
              <CompressionSettingRow title="单轮召回数量" description="本地相关性召回的条数上限；仍受上下文长度预算限制" value={draft.memoryRecallLimit} min={1} max={100} step={1} disabled={!draft.autoExtractMemory} onChange={(value) => setDraft({ ...draft, memoryRecallLimit: value })} />
            </div>
            <SettingSwitch icon={Webhook} title="渠道身份绑定" description="外部用户在不同 Bot 中保持独立上下文" checked={draft.bindChannelIdentity} onChange={(checked) => setDraft({ ...draft, bindChannelIdentity: checked })} />
            <SettingSwitch icon={Power} title="锁屏时继续运行" description="允许 ZSense 在屏幕锁定或窗口处于后台时继续处理定时任务、消息网关和 Agent 任务；不会阻止电脑锁屏" checked={draft.runWhileLocked} onChange={(checked) => setDraft({ ...draft, runWhileLocked: checked })} />
            <SettingSwitch icon={Minimize2} title="启用上下文压缩" description="长对话达到设定阈值后，由 ZSense Core 自动压缩较早历史" checked={draft.contextAutoCompression} onChange={(checked) => setDraft({ ...draft, contextAutoCompression: checked })} />
            <div className={`compression-settings ${draft.contextAutoCompression ? '' : 'disabled'}`} aria-label="上下文压缩参数">
              <CompressionSettingRow title="压缩阈值" description="预估 token 超过上下文比例时开始压缩" value={draft.contextCompressionThreshold} min={0.5} max={0.95} step={0.05} disabled={!draft.contextAutoCompression} onChange={(value) => setDraft({ ...draft, contextCompressionThreshold: value })} />
              <CompressionSettingRow title="目标比例" description="压缩后历史保留到上下文的目标比例" value={draft.contextCompressionTargetRatio} min={0.1} max={0.8} step={0.05} disabled={!draft.contextAutoCompression} onChange={(value) => setDraft({ ...draft, contextCompressionTargetRatio: value })} />
              <CompressionSettingRow title="保护最近消息" description="最近多少条消息不参与压缩" value={draft.contextCompressionProtectLastN} min={0} max={500} step={1} disabled={!draft.contextAutoCompression} onChange={(value) => setDraft({ ...draft, contextCompressionProtectLastN: value })} />
              <CompressionSettingRow title="保护开头消息" description="最早多少条非系统消息不参与首次压缩" value={draft.contextCompressionProtectFirstN} min={0} max={500} step={1} disabled={!draft.contextAutoCompression} onChange={(value) => setDraft({ ...draft, contextCompressionProtectFirstN: value })} />
            </div>
            <SettingSwitch icon={EyeOff} title="敏感信息脱敏" description="隐藏工具输出、日志和本地会话中的 API Key、Token 与密码；变更后自动重启运行中的 Gateway" checked={draft.sensitiveDataRedaction} onChange={(checked) => setDraft({ ...draft, sensitiveDataRedaction: checked })} />
          </div>}
        </section>
      </div>
    </div>
  )
}

function SettingSwitch({ icon: Icon, title, description, checked, tone = 'default', onChange }: { icon: typeof ShieldCheck; title: string; description: string; checked: boolean; tone?: 'default' | 'danger'; onChange: (checked: boolean) => void }) {
  const actionTitle = title.replace(/^启用/, '')
  return <div className={`setting-toggle-row ${tone === 'danger' ? 'danger-setting' : ''}`}><span className="setting-icon"><Icon size={18} /></span><span><strong>{title}</strong><small>{description}</small></span><button type="button" className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)} aria-label={`${checked ? '停用' : '启用'}${actionTitle}`}><span /></button></div>
}

interface CompressionSettingRowProps {
  title: string
  description: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  onChange: (value: number) => void
}

function CompressionSettingRow({ title, description, value, min, max, step, disabled, onChange }: CompressionSettingRowProps) {
  const decimals = step < 1 ? 2 : 0
  const update = (direction: -1 | 1) => {
    const next = Math.min(max, Math.max(min, value + direction * step))
    onChange(Number(next.toFixed(decimals)))
  }
  const displayValue = Number(value.toFixed(decimals)).toString()

  return <div className="compression-setting-row">
    <span><strong>{title}</strong><small>{description}</small></span>
    <div className="number-stepper" aria-label={title}>
      <output aria-label={`${title}当前值`}>{displayValue}</output>
      <button type="button" onClick={() => update(-1)} disabled={disabled || value <= min} aria-label={`减小${title}`}><Minus size={16} /></button>
      <button type="button" onClick={() => update(1)} disabled={disabled || value >= max} aria-label={`增大${title}`}><Plus size={16} /></button>
    </div>
  </div>
}
