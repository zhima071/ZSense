import {
  Bell,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  ClipboardList,
  PanelLeftClose,
  Pencil,
  Plus,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { FormEvent, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AuthUser, Bot as BotType, Conversation, ConversationGroup, ViewId, VoiceWakeStatus } from '../types'
import { useRunningConversationIds } from '../services/chat-run-store'
import { ConversationActions } from './ConversationActions'
import { VoiceWakeToggle } from './VoiceWakeToggle'

const navItems: Array<{ id: ViewId; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'bots', label: 'Bots', icon: Bot },
  { id: 'scheduled-tasks', label: '定时任务', icon: CalendarClock },
  { id: 'office-tasks', label: '任务工作台', icon: ClipboardList },
]

interface SidebarProps {
  activeView: ViewId
  bots: BotType[]
  nativeConversations: Conversation[]
  activeNativeConversationId?: string
  activeBotId: string | null
  mobileOpen: boolean
  collapsed: boolean
  onNavigate: (view: ViewId) => void
  onOpenBot: (botId: string) => void
  onOpenNativeChat: (conversationId?: string) => void
  onStartNativeChat: () => void
  onRenameNativeConversation: (conversationId: string, title: string) => Promise<void>
  onArchiveNativeConversation: (conversationId: string, archived: boolean) => Promise<void>
  onDeleteNativeConversation: (conversationId: string) => Promise<void>
  /** AI 对话空间的会话分组（拖拽排序与折叠收纳） */
  nativeSpaceId: string
  nativeConversationGroups: ConversationGroup[]
  onCreateConversationGroup: (botId: string, name: string) => Promise<void>
  onRenameConversationGroup: (groupId: string, name: string) => Promise<void>
  onDeleteConversationGroup: (groupId: string) => Promise<void>
  onToggleConversationGroup: (groupId: string, collapsed: boolean) => Promise<void>
  onMoveConversationToGroup: (conversationId: string, groupId: string) => Promise<void>
  onReorderConversations: (botId: string, orderedIds: string[]) => Promise<void>
  onCloseMobile: () => void
  onToggleCollapsed: () => void
  currentUser: AuthUser
  appLockEnabled: boolean
  onLock: () => Promise<void>
  voiceStatus: ReactNode
  voiceWakeEnabled: boolean
  voiceWakeStatus: VoiceWakeStatus
  voiceWakeBusy: boolean
  onToggleVoiceWake: () => void
  sessionCenterOpen: boolean
  runningSessionCount: number
  unreadSessionCount: number
  onToggleSessionCenter: () => void
}

export function Sidebar({ activeView, bots, nativeConversations, activeNativeConversationId, activeBotId, mobileOpen, collapsed, onNavigate, onOpenBot, onOpenNativeChat, onStartNativeChat, onRenameNativeConversation, onArchiveNativeConversation, onDeleteNativeConversation, nativeSpaceId, nativeConversationGroups, onCreateConversationGroup, onRenameConversationGroup, onDeleteConversationGroup, onToggleConversationGroup, onMoveConversationToGroup, onReorderConversations, onCloseMobile, onToggleCollapsed, currentUser, appLockEnabled, onLock, voiceStatus, voiceWakeEnabled, voiceWakeStatus, voiceWakeBusy, onToggleVoiceWake, sessionCenterOpen, runningSessionCount, unreadSessionCount, onToggleSessionCenter }: SidebarProps) {
  const [showArchivedChats, setShowArchivedChats] = useState(false)
  const activeNativeConversations = useMemo(() => nativeConversations.filter((item) => !item.archived), [nativeConversations])
  const archivedNativeConversations = useMemo(() => nativeConversations.filter((item) => item.archived), [nativeConversations])
  const visibleNativeConversations = showArchivedChats ? archivedNativeConversations : activeNativeConversations
  const nativeChatHeadingTarget = activeNativeConversationId || activeNativeConversations[0]?.id
  const runningNativeConversationIds = useRunningConversationIds('native')
  // 分组弹窗（新建 / 重命名）与拖拽状态
  const [groupDialog, setGroupDialog] = useState<{ mode: 'create' | 'rename'; groupId?: string; name: string } | null>(null)
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupError, setGroupError] = useState('')
  const [draggingConversationId, setDraggingConversationId] = useState('')
  const [dropTarget, setDropTarget] = useState<{ type: 'conversation' | 'group' | 'ungrouped'; id: string; position: 'before' | 'after' | 'inside' } | null>(null)

  const groupIds = useMemo(() => new Set(nativeConversationGroups.map((group) => group.id)), [nativeConversationGroups])
  const conversationsByGroup = useMemo(() => {
    const grouped = new Map<string, Conversation[]>()
    for (const conversation of visibleNativeConversations) {
      if (!groupIds.has(conversation.groupId)) continue
      const items = grouped.get(conversation.groupId) || []
      items.push(conversation)
      grouped.set(conversation.groupId, items)
    }
    return grouped
  }, [groupIds, visibleNativeConversations])
  const ungroupedVisibleConversations = useMemo(
    () => visibleNativeConversations.filter((conversation) => !groupIds.has(conversation.groupId)),
    [groupIds, visibleNativeConversations],
  )
  const visibleConversationIds = useMemo(() => visibleNativeConversations.map((conversation) => conversation.id), [visibleNativeConversations])

  const resetDrag = () => { setDraggingConversationId(''); setDropTarget(null) }

  const submitGroupDialog = async (event: FormEvent) => {
    event.preventDefault()
    if (!groupDialog || !groupDialog.name.trim()) return
    setGroupBusy(true)
    setGroupError('')
    try {
      if (groupDialog.mode === 'create') await onCreateConversationGroup(nativeSpaceId, groupDialog.name.trim())
      else if (groupDialog.groupId) await onRenameConversationGroup(groupDialog.groupId, groupDialog.name.trim())
      setGroupDialog(null)
    } catch (reason) {
      setGroupError(reason instanceof Error ? reason.message : '操作失败。')
    } finally {
      setGroupBusy(false)
    }
  }

  const removeGroup = async (group: ConversationGroup) => {
    if (!window.confirm(`确定删除分组「${group.name}」吗？组里的会话会回到未分组，不会被删除。`)) return
    await onDeleteConversationGroup(group.id).catch(() => undefined)
  }

  /** 拖到分组标题上：收进这个分组 */
  const dropIntoGroup = async (groupId: string) => {
    const dragged = draggingConversationId
    resetDrag()
    if (!dragged) return
    const conversation = nativeConversations.find((item) => item.id === dragged)
    if (conversation && conversation.groupId !== groupId) await onMoveConversationToGroup(dragged, groupId).catch(() => undefined)
  }

  /** 拖到未分组区域：移出分组 */
  const dropOutOfGroup = async () => {
    const dragged = draggingConversationId
    resetDrag()
    if (!dragged) return
    const conversation = nativeConversations.find((item) => item.id === dragged)
    if (conversation?.groupId) await onMoveConversationToGroup(dragged, '').catch(() => undefined)
  }

  /** 拖到某条会话上：插到它前面或后面（跨分组时会一并移动过去） */
  const dropOnConversation = async (targetId: string) => {
    const dragged = draggingConversationId
    const position = dropTarget?.id === targetId ? dropTarget.position : 'before'
    resetDrag()
    if (!dragged || dragged === targetId) return
    const target = nativeConversations.find((item) => item.id === targetId)
    const moving = nativeConversations.find((item) => item.id === dragged)
    if (!target || !moving) return
    if (target.groupId !== moving.groupId) await onMoveConversationToGroup(dragged, target.groupId).catch(() => undefined)
    const from = visibleConversationIds.indexOf(dragged)
    if (from < 0 || !visibleConversationIds.includes(targetId)) return
    const next = [...visibleConversationIds]
    next.splice(from, 1)
    const anchor = next.indexOf(targetId)
    next.splice(position === 'before' ? anchor : anchor + 1, 0, dragged)
    const hidden = nativeConversations.filter((item) => !visibleConversationIds.includes(item.id)).map((item) => item.id)
    await onReorderConversations(nativeSpaceId, [...next, ...hidden]).catch(() => undefined)
  }

  const renderConversationRow = (conversation: Conversation) => {
    const running = runningNativeConversationIds.has(conversation.id)
    const drop = dropTarget?.type === 'conversation' && dropTarget.id === conversation.id ? dropTarget.position : ''
    return (
      <div
        className={`native-chat-sidebar-row ${activeView === 'chat' && activeNativeConversationId === conversation.id ? 'active' : ''} ${running ? 'is-running' : ''} ${draggingConversationId === conversation.id ? 'is-dragging' : ''} ${drop ? `drop-${drop}` : ''}`}
        key={conversation.id}
        aria-label={running ? `${conversation.title}，正在执行任务` : undefined}
        draggable
        onDragStart={(event) => { if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; setDraggingConversationId(conversation.id) }}
        onDragEnd={resetDrag}
        onDragOver={(event) => {
          if (!draggingConversationId || draggingConversationId === conversation.id) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          setDropTarget({ type: 'conversation', id: conversation.id, position: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' })
        }}
        onDrop={(event) => { event.preventDefault(); void dropOnConversation(conversation.id) }}
      >
        <button type="button" className="native-chat-sidebar-open" onClick={() => onOpenNativeChat(conversation.id)}>
          <span><strong>{conversation.title}</strong><small>{running ? <><em>执行中</em> · </> : null}{conversation.messageCount} 条消息 · {new Date(conversation.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small></span>
        </button>
        <ConversationActions conversation={conversation} onRename={onRenameNativeConversation} onArchive={onArchiveNativeConversation} onDelete={onDeleteNativeConversation} />
      </div>
    )
  }

  return (
    <>
      {mobileOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={onCloseMobile} />}
      <aside
        className={`sidebar ${mobileOpen ? 'is-open' : ''}`}
        aria-hidden={collapsed && !mobileOpen}
        {...((collapsed && !mobileOpen ? { inert: '' } : {}) as React.HTMLAttributes<HTMLElement>)}
      >
        <div className="brand-row">
          <button className="icon-button sidebar-close" onClick={onCloseMobile} aria-label="收起导航">
            <PanelLeftClose size={16} />
          </button>
          <button className="icon-button sidebar-collapse" onClick={onToggleCollapsed} aria-label="隐藏左侧导航" title="隐藏左侧导航" aria-expanded="true">
            <PanelLeftClose size={16} />
          </button>
        </div>

        <div className="sidebar-content">
          <nav className="main-nav" aria-label="主导航">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={activeView === id && !activeBotId ? 'active' : ''}
                onClick={() => onNavigate(id)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <span>我的 Bots</span>
            </div>
            <div className="bot-quick-list">
              {bots.map((bot) => (
                <button key={bot.id} className={activeBotId === bot.id ? 'active' : ''} onClick={() => onOpenBot(bot.id)}>
                  <span className="mini-avatar" style={{ '--avatar': bot.color } as React.CSSProperties}>{bot.initials}</span>
                  <span className="quick-bot-copy">
                    <strong>{bot.name}</strong>
                    <small>{bot.role}</small>
                  </span>
                  <span className={`presence ${bot.status}`} aria-label={bot.status} />
                </button>
              ))}
            </div>
          </div>

          <section className={`sidebar-section native-chat-sidebar-section ${activeView === 'chat' && !activeBotId ? 'active' : ''}`} aria-label="AI 对话">
            <div className="native-chat-sidebar-heading">
              <button type="button" onClick={() => nativeChatHeadingTarget && onOpenNativeChat(nativeChatHeadingTarget)} disabled={!nativeChatHeadingTarget} title={nativeChatHeadingTarget ? '打开最近的 AI 对话' : '请点击右侧加号新建对话'}>
                <span><MessageCircle size={14} /></span>
                <span><strong>AI 对话</strong><small>{nativeConversations.length} 个会话</small></span>
              </button>
              <span className="native-chat-sidebar-actions">
                <button type="button" className="native-chat-sidebar-new" onClick={() => { setGroupError(''); setGroupDialog({ mode: 'create', name: '' }) }} aria-label="新建对话分组" title="新建分组（可以把会话拖进去折叠收纳）"><FolderPlus size={14} /></button>
                <button type="button" className="native-chat-sidebar-new" onClick={onStartNativeChat} aria-label="新建 AI 对话" title="新建 AI 对话"><Plus size={14} /></button>
              </span>
            </div>
            <div className="native-chat-sidebar-filter" role="group" aria-label="AI 对话状态">
              <button type="button" className={!showArchivedChats ? 'active' : ''} aria-pressed={!showArchivedChats} onClick={() => setShowArchivedChats(false)}>当前 {activeNativeConversations.length}</button>
              <button type="button" className={showArchivedChats ? 'active' : ''} aria-pressed={showArchivedChats} onClick={() => setShowArchivedChats(true)}>归档 {archivedNativeConversations.length}</button>
            </div>
            <div className={`native-chat-sidebar-list ${draggingConversationId ? 'is-dragging' : ''}`}>
              {ungroupedVisibleConversations.map((conversation) => renderConversationRow(conversation))}
              {draggingConversationId && !ungroupedVisibleConversations.length && <div
                className={`native-chat-sidebar-ungroup-drop ${dropTarget?.type === 'ungrouped' ? 'active' : ''}`}
                onDragOver={(event) => { event.preventDefault(); setDropTarget({ type: 'ungrouped', id: '', position: 'inside' }) }}
                onDrop={(event) => { event.preventDefault(); void dropOutOfGroup() }}
              >拖到这里移出分组</div>}
              {nativeConversationGroups.map((group) => {
                const conversations = conversationsByGroup.get(group.id) || []
                const dropping = dropTarget?.type === 'group' && dropTarget.id === group.id
                return (
                  <section className={`native-chat-sidebar-group ${dropping ? 'drop-inside' : ''}`} key={group.id} aria-label={`分组 ${group.name}`}>
                    <div
                      className="native-chat-sidebar-group-head"
                      role="button"
                      tabIndex={0}
                      aria-expanded={!group.collapsed}
                      title={group.collapsed ? '展开分组' : '折叠分组'}
                      onClick={() => void onToggleConversationGroup(group.id, !group.collapsed).catch(() => undefined)}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void onToggleConversationGroup(group.id, !group.collapsed).catch(() => undefined) } }}
                      onDragOver={(event) => { if (!draggingConversationId) return; event.preventDefault(); setDropTarget({ type: 'group', id: group.id, position: 'inside' }) }}
                      onDragLeave={() => setDropTarget((current) => current?.type === 'group' && current.id === group.id ? null : current)}
                      onDrop={(event) => { event.preventDefault(); void dropIntoGroup(group.id) }}
                    >
                      <span className="native-chat-sidebar-group-chevron">{group.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
                      <strong>{group.name}</strong>
                      <small>{conversations.length}</small>
                      <span className="native-chat-sidebar-group-actions" onClick={(event) => event.stopPropagation()}>
                        <button type="button" className="icon-button" title="重命名分组" aria-label={`重命名分组 ${group.name}`} onClick={() => { setGroupError(''); setGroupDialog({ mode: 'rename', groupId: group.id, name: group.name }) }}><Pencil size={12} /></button>
                        <button type="button" className="icon-button" title="删除分组（组内会话会回到未分组）" aria-label={`删除分组 ${group.name}`} onClick={() => void removeGroup(group)}><Trash2 size={12} /></button>
                      </span>
                    </div>
                    {!group.collapsed && conversations.map((conversation) => renderConversationRow(conversation))}
                    {!group.collapsed && !conversations.length && <p className="native-chat-sidebar-group-empty">把会话拖到这里</p>}
                  </section>
                )
              })}
              {!visibleNativeConversations.length && <button type="button" className="native-chat-sidebar-empty" onClick={onStartNativeChat}>{showArchivedChats ? '暂无已归档对话' : '新建你的第一次 AI 对话'}</button>}
            </div>
          </section>
          </div>

        <div className="sidebar-bottom">
          {voiceStatus && <div className="sidebar-voice-status">{voiceStatus}</div>}
          <div className="workspace-switcher">
            {appLockEnabled && <button
              className="icon-button workspace-lock"
              onClick={() => void onLock()}
              aria-label="锁定 ZSense"
              title="锁定应用"
            >
              <LockKeyhole size={17} />
            </button>}
            <button
              type="button"
              className={`icon-button notification-button ${sessionCenterOpen ? 'active' : ''}`}
              onClick={onToggleSessionCenter}
              aria-label={`查看会话进度${runningSessionCount ? `，${runningSessionCount} 个进行中` : ''}${unreadSessionCount ? `，${unreadSessionCount} 个新通知` : ''}`}
              title="会话进度"
              aria-expanded={sessionCenterOpen}
              aria-haspopup="dialog"
            >
              <Bell size={18} />
              {runningSessionCount > 0 && <i className="notification-running-dot" />}
              {unreadSessionCount > 0 && <small className="notification-count">{Math.min(unreadSessionCount, 9)}</small>}
            </button>
            <button
              className={`icon-button workspace-settings ${activeView === 'settings' ? 'active' : ''}`}
              onClick={() => onNavigate('settings')}
              aria-label="打开设置"
              title="设置"
            >
              <Settings size={18} />
            </button>
            <VoiceWakeToggle enabled={voiceWakeEnabled} status={voiceWakeStatus} busy={voiceWakeBusy} onToggle={onToggleVoiceWake} />
          </div>
        </div>
      </aside>
      {groupDialog && createPortal(
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !groupBusy && setGroupDialog(null)}>
          <form className="conversation-group-dialog" role="dialog" aria-modal="true" aria-label={groupDialog.mode === 'create' ? '新建对话分组' : '重命名对话分组'} onSubmit={submitGroupDialog}>
            <header>
              <strong>{groupDialog.mode === 'create' ? '新建分组' : '重命名分组'}</strong>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setGroupDialog(null)}><X size={16} /></button>
            </header>
            <label><span>分组名称</span><input autoFocus maxLength={40} value={groupDialog.name} onChange={(event) => setGroupDialog({ ...groupDialog, name: event.target.value })} placeholder="例如：工作 / 学习 / 项目 A" /></label>
            <p className="conversation-group-hint">建好后把左侧会话拖到分组标题上即可收进去，点标题可折叠收纳。</p>
            {groupError && <p className="conversation-group-error" role="alert">{groupError}</p>}
            <footer>
              <button type="button" className="button ghost small" onClick={() => setGroupDialog(null)}>取消</button>
              <button type="submit" className="button primary small" disabled={groupBusy || !groupDialog.name.trim()}>{groupBusy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{groupDialog.mode === 'create' ? '创建分组' : '保存名称'}</button>
            </footer>
          </form>
        </div>, document.body)}
    </>
  )
}
