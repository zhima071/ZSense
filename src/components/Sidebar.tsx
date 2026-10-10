import {
  Bell,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  ClipboardList,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AuthUser, Bot as BotType, Conversation, ConversationGroup, ViewId, VoiceWakeStatus } from '../types'
import { useRunningConversationIds } from '../services/chat-run-store'
import { ConversationActions } from './ConversationActions'
import { VoiceWakeToggle } from './VoiceWakeToggle'
import { SidebarResizeHandle } from './SidebarResizeHandle'

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
  panelWidth: number
  onPanelWidthChange: (width: number) => void
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

export function Sidebar({ activeView, bots, nativeConversations, activeNativeConversationId, activeBotId, mobileOpen, collapsed, panelWidth, onPanelWidthChange, onNavigate, onOpenBot, onOpenNativeChat, onStartNativeChat, onRenameNativeConversation, onArchiveNativeConversation, onDeleteNativeConversation, nativeSpaceId, nativeConversationGroups, onCreateConversationGroup, onRenameConversationGroup, onDeleteConversationGroup, onToggleConversationGroup, onMoveConversationToGroup, onReorderConversations, onCloseMobile, onToggleCollapsed, currentUser, appLockEnabled, onLock, voiceStatus, voiceWakeEnabled, voiceWakeStatus, voiceWakeBusy, onToggleVoiceWake, sessionCenterOpen, runningSessionCount, unreadSessionCount, onToggleSessionCenter }: SidebarProps) {
  const accountName = currentUser.displayName.trim() || currentUser.username
  const [showArchivedChats, setShowArchivedChats] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches)
  const asideRef = useRef<HTMLElement>(null)
  const mobileDrawerWasOpenRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
  const railOpenRef = useRef<HTMLButtonElement>(null)
  const panelCollapseRef = useRef<HTMLButtonElement>(null)
  const groupDialogRef = useRef<HTMLFormElement>(null)
  const groupDialogTriggerRef = useRef<HTMLElement | null>(null)
  const activeNativeConversations = useMemo(() => nativeConversations.filter((item) => !item.archived), [nativeConversations])
  const archivedNativeConversations = useMemo(() => nativeConversations.filter((item) => item.archived), [nativeConversations])
  const listedNativeConversations = showArchivedChats ? archivedNativeConversations : activeNativeConversations
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase('zh-CN')
  const visibleNativeConversations = useMemo(
    () => listedNativeConversations.filter((conversation) => !normalizedSearch || conversation.title.toLocaleLowerCase('zh-CN').includes(normalizedSearch)),
    [listedNativeConversations, normalizedSearch],
  )
  const nativeChatHeadingTarget = activeNativeConversationId || activeNativeConversations[0]?.id
  const runningNativeConversationIds = useRunningConversationIds('native')
  // 分组弹窗（新建 / 重命名）与拖拽状态
  const [groupDialog, setGroupDialog] = useState<{ mode: 'create' | 'rename'; groupId?: string; name: string } | null>(null)
  const [groupBusy, setGroupBusy] = useState(false)
  const [groupError, setGroupError] = useState('')
  const [draggingConversationId, setDraggingConversationId] = useState('')
  const [dropTarget, setDropTarget] = useState<{ type: 'conversation' | 'group' | 'ungrouped'; id: string; position: 'before' | 'after' | 'inside' } | null>(null)
  const panelHidden = collapsed && !mobileOpen
  const mobileHidden = isMobile && !mobileOpen

  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)')
    const update = () => setIsMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!searchOpen || panelHidden || mobileHidden) return
    const focused = document.activeElement
    if (focused instanceof Element && focused.closest('[role="menu"], [role="dialog"], [role="alertdialog"]') && !asideRef.current?.contains(focused)) return
    searchInputRef.current?.focus()
  }, [searchOpen, panelHidden, mobileHidden])

  useEffect(() => {
    const drawerOpen = isMobile && mobileOpen
    const wasOpen = mobileDrawerWasOpenRef.current
    mobileDrawerWasOpenRef.current = drawerOpen
    if (!drawerOpen) {
      if (wasOpen && isMobile) document.querySelector<HTMLButtonElement>('.mobile-menu[aria-controls="sidebar-panel"]')?.focus()
      return
    }
    const focused = document.activeElement
    // Portaled menus and dialogs own their focus until they close.
    if (focused instanceof Element && focused.closest('[role="menu"], [role="dialog"], [role="alertdialog"]') && !asideRef.current?.contains(focused)) return
    const initialFocus = searchInputRef.current
      || asideRef.current?.querySelector<HTMLButtonElement>('.main-nav button[aria-current="page"]')
      || asideRef.current?.querySelector<HTMLButtonElement>('.sidebar-bot-rail-button[aria-pressed="true"]')
      || asideRef.current?.querySelector<HTMLButtonElement>('.sidebar-new-chat')
      || asideRef.current?.querySelector<HTMLButtonElement>('.main-nav button')
    initialFocus?.focus()
  }, [isMobile, mobileOpen])

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQuery('')
    requestAnimationFrame(() => searchTriggerRef.current?.focus())
  }

  const closeMobile = () => {
    onCloseMobile()
  }

  const togglePanel = () => {
    onToggleCollapsed()
    requestAnimationFrame(() => (collapsed ? panelCollapseRef.current : railOpenRef.current)?.focus({ preventScroll: true }))
  }

  const closeGroupDialog = () => {
    setGroupDialog(null)
    requestAnimationFrame(() => groupDialogTriggerRef.current?.focus())
  }

  const groupDialogOpen = Boolean(groupDialog)
  useEffect(() => {
    if (!groupDialogOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !groupDialogRef.current?.contains(event.target)) return
      if (event.key === 'Escape' && !groupBusy) {
        event.preventDefault()
        closeGroupDialog()
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(groupDialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || [])
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [groupDialogOpen, groupBusy])

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
  const visibleConversationIds = useMemo(() => listedNativeConversations.map((conversation) => conversation.id), [listedNativeConversations])

  const resetDrag = () => { setDraggingConversationId(''); setDropTarget(null) }

  const submitGroupDialog = async (event: FormEvent) => {
    event.preventDefault()
    if (!groupDialog || !groupDialog.name.trim()) return
    setGroupBusy(true)
    setGroupError('')
    try {
      if (groupDialog.mode === 'create') await onCreateConversationGroup(nativeSpaceId, groupDialog.name.trim())
      else if (groupDialog.groupId) await onRenameConversationGroup(groupDialog.groupId, groupDialog.name.trim())
      closeGroupDialog()
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
        aria-label={running ? `${conversation.title}，正在执行任务` : conversation.title}
        draggable={!normalizedSearch}
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
        <button type="button" className="native-chat-sidebar-open" title={conversation.title} onClick={() => onOpenNativeChat(conversation.id)}>
          <span><strong>{conversation.title}</strong><small>{running ? <><em>执行中</em> · </> : null}{conversation.messageCount} 条消息 · {new Date(conversation.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small></span>
        </button>
        <ConversationActions conversation={conversation} onRename={onRenameNativeConversation} onArchive={onArchiveNativeConversation} onDelete={onDeleteNativeConversation} />
      </div>
    )
  }

  return (
    <>
      {mobileOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={closeMobile} />}
      <aside
        ref={asideRef}
        className={`sidebar sidebar-rail-layout ${mobileOpen ? 'is-open' : ''} ${panelHidden ? 'is-panel-collapsed' : ''}`}
        aria-hidden={mobileHidden || undefined}
        {...((mobileHidden ? { inert: '' } : {}) as React.HTMLAttributes<HTMLElement>)}
        onKeyDown={(event) => {
          // React portal events can bubble here even though their DOM is outside the drawer.
          if (event.defaultPrevented || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
          if (event.key === 'Escape') {
            if (searchOpen) { event.preventDefault(); event.stopPropagation(); closeSearch() }
            else if (isMobile && mobileOpen) { event.preventDefault(); closeMobile() }
            return
          }
          if (event.key !== 'Tab' || !isMobile || !mobileOpen) return
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
            .filter((control) => !control.closest('[hidden], [inert]') && control.getClientRects().length > 0)
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }}
      >
        <div className="sidebar-rail">
          <nav className="main-nav" aria-label="主导航">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={`icon-button sidebar-rail-nav ${activeView === id && !activeBotId ? 'active' : ''}`}
                aria-label={label}
                title={label}
                aria-current={activeView === id && !activeBotId ? 'page' : undefined}
                onClick={() => onNavigate(id)}
              >
                <Icon size={19} />
              </button>
            ))}
          </nav>
          {bots.length > 0 && <nav className="sidebar-bot-rail-list" aria-label="我的 Bots">
            {bots.map((bot) => (
              <button type="button" key={bot.id} className={`icon-button sidebar-bot-rail-button ${activeBotId === bot.id ? 'active' : ''}`} onClick={() => onOpenBot(bot.id)} aria-label={`打开 ${bot.name}`} aria-pressed={activeBotId === bot.id} title={`${bot.name} · ${bot.role}`}>
                <span className="mini-avatar" style={{ '--avatar': bot.color } as React.CSSProperties} aria-hidden="true">{bot.initials}</span>
                <span className={`presence ${bot.status}`} aria-hidden="true" />
              </button>
            ))}
          </nav>}
          {panelHidden && <button ref={railOpenRef} type="button" className="icon-button sidebar-rail-open" onClick={togglePanel} aria-label="展开会话侧栏" title="展开会话侧栏" aria-expanded="false" aria-controls="sidebar-panel"><PanelLeftOpen size={19} /></button>}
          <div className="sidebar-rail-bottom">
            {appLockEnabled && <button type="button" className="icon-button workspace-lock" onClick={() => void onLock()} aria-label="锁定 ZSense" title="锁定应用"><LockKeyhole size={18} /></button>}
            <VoiceWakeToggle enabled={voiceWakeEnabled} status={voiceWakeStatus} busy={voiceWakeBusy} onToggle={onToggleVoiceWake} />
            <button type="button" className={`icon-button workspace-settings ${activeView === 'settings' ? 'active' : ''}`} onClick={() => onNavigate('settings')} aria-label="打开设置" title="设置"><Settings size={19} /></button>
            <button
              type="button"
              className={`icon-button notification-button ${sessionCenterOpen ? 'active' : ''}`}
              onClick={onToggleSessionCenter}
              aria-label={`查看会话进度${runningSessionCount ? `，${runningSessionCount} 个进行中` : ''}${unreadSessionCount ? `，${unreadSessionCount} 个新通知` : ''}`}
              title="会话进度"
              aria-expanded={sessionCenterOpen}
              aria-haspopup="dialog"
            >
              <Bell size={19} />
              {runningSessionCount > 0 && <i className="notification-running-dot" />}
              {unreadSessionCount > 0 && <small className="notification-count">{Math.min(unreadSessionCount, 9)}</small>}
            </button>
          </div>
        </div>

        <div className="sidebar-panel-viewport">
        <div id="sidebar-panel" className="sidebar-panel" aria-hidden={panelHidden || undefined} {...((panelHidden ? { inert: '' } : {}) as React.HTMLAttributes<HTMLDivElement>)}>
          <div className="sidebar-panel-heading">
            <strong className="sidebar-account-name" title={accountName}>{accountName}</strong>
            <div className="sidebar-panel-tools">
              <button ref={searchTriggerRef} type="button" className={`icon-button sidebar-search-trigger ${searchOpen ? 'active' : ''}`} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)} aria-label="搜索会话" title="搜索会话" aria-expanded={searchOpen} aria-controls="sidebar-conversation-search"><Search size={17} /></button>
              <button type="button" className="icon-button sidebar-close" onClick={closeMobile} aria-label="收起导航" title="收起导航"><PanelLeftClose size={17} /></button>
              <button ref={panelCollapseRef} type="button" className="icon-button sidebar-collapse" onClick={togglePanel} aria-label="折叠会话侧栏" title="折叠会话侧栏" aria-expanded="true" aria-controls="sidebar-panel"><PanelLeftClose size={17} /></button>
            </div>
          </div>
          {searchOpen && <div id="sidebar-conversation-search" className="sidebar-conversation-search" role="search">
            <label htmlFor="sidebar-search-input">搜索会话标题</label>
            <div><Search size={15} aria-hidden="true" /><input ref={searchInputRef} id="sidebar-search-input" type="search" aria-label="搜索会话标题" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索会话…" autoComplete="off" /><button type="button" className="icon-button" onClick={closeSearch} aria-label="关闭会话搜索" title="关闭会话搜索"><X size={15} /></button></div>
          </div>}
          <button type="button" className="sidebar-new-chat" onClick={onStartNativeChat} aria-label="新建 AI 对话"><Plus size={17} /><span>新对话</span></button>

          <div className="sidebar-content">
            <section className={`sidebar-section native-chat-sidebar-section ${activeView === 'chat' && !activeBotId ? 'active' : ''}`} aria-label="AI 对话">
              <div className="native-chat-sidebar-heading">
                <button type="button" onClick={() => nativeChatHeadingTarget && onOpenNativeChat(nativeChatHeadingTarget)} disabled={!nativeChatHeadingTarget} title={nativeChatHeadingTarget ? '打开最近的 AI 对话' : '点击新对话开始聊天'}><span><MessageCircle size={14} /></span><span><strong>会话</strong><small>{nativeConversations.length} 个会话</small></span></button>
                <button type="button" className="icon-button native-chat-sidebar-new" onClick={(event) => { groupDialogTriggerRef.current = event.currentTarget; setGroupError(''); setGroupDialog({ mode: 'create', name: '' }) }} aria-label="新建对话分组" title="新建对话分组"><FolderPlus size={16} /></button>
              </div>
              <div className="native-chat-sidebar-filter" role="group" aria-label="AI 对话状态">
                <button type="button" className={!showArchivedChats ? 'active' : ''} aria-pressed={!showArchivedChats} onClick={() => setShowArchivedChats(false)}>当前 {activeNativeConversations.length}</button>
                <button type="button" className={showArchivedChats ? 'active' : ''} aria-pressed={showArchivedChats} onClick={() => setShowArchivedChats(true)}>归档 {archivedNativeConversations.length}</button>
              </div>
              <div className={`native-chat-sidebar-list ${draggingConversationId ? 'is-dragging' : ''}`}>
                {nativeConversationGroups.map((group) => {
                  const conversations = conversationsByGroup.get(group.id) || []
                  if (normalizedSearch && !conversations.length) return null
                  const expanded = Boolean(normalizedSearch) || !group.collapsed
                  const dropping = dropTarget?.type === 'group' && dropTarget.id === group.id
                  return (
                    <section className={`native-chat-sidebar-group ${dropping ? 'drop-inside' : ''}`} key={group.id} aria-label={`分组 ${group.name}`}>
                      <div
                        className="native-chat-sidebar-group-head"
                        onDragOver={(event) => { if (!draggingConversationId) return; event.preventDefault(); setDropTarget({ type: 'group', id: group.id, position: 'inside' }) }}
                        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget((current) => current?.type === 'group' && current.id === group.id ? null : current) }}
                        onDrop={(event) => { event.preventDefault(); void dropIntoGroup(group.id) }}
                      >
                        <button type="button" className="native-chat-sidebar-group-toggle" aria-expanded={expanded} aria-label={`${expanded ? '折叠' : '展开'}分组 ${group.name}`} title={normalizedSearch ? '搜索时显示匹配会话' : group.name} disabled={Boolean(normalizedSearch)} onClick={() => void onToggleConversationGroup(group.id, !group.collapsed).catch(() => undefined)}>
                          <span className="native-chat-sidebar-group-chevron">{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                          {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                          <strong>{group.name}</strong><small>{conversations.length}</small>
                        </button>
                        <span className="native-chat-sidebar-group-actions">
                          <button type="button" className="icon-button" title="重命名分组" aria-label={`重命名分组 ${group.name}`} onClick={(event) => { groupDialogTriggerRef.current = event.currentTarget; setGroupError(''); setGroupDialog({ mode: 'rename', groupId: group.id, name: group.name }) }}><Pencil size={12} /></button>
                          <button type="button" className="icon-button" title="删除分组（组内会话会回到最近）" aria-label={`删除分组 ${group.name}`} onClick={() => void removeGroup(group)}><Trash2 size={12} /></button>
                        </span>
                      </div>
                      {expanded && <div className="native-chat-sidebar-group-children">{conversations.map((conversation) => renderConversationRow(conversation))}{!conversations.length && <p className="native-chat-sidebar-group-empty">把会话拖到这里</p>}</div>}
                    </section>
                  )
                })}
                <section className={`native-chat-sidebar-recent ${dropTarget?.type === 'ungrouped' ? 'drop-inside' : ''}`} aria-label="最近的未分组会话">
                  <div className="sidebar-section-title native-chat-sidebar-recent-heading" onDragOver={(event) => { if (!draggingConversationId) return; event.preventDefault(); setDropTarget({ type: 'ungrouped', id: '', position: 'inside' }) }} onDrop={(event) => { event.preventDefault(); void dropOutOfGroup() }}><span>最近</span><small>{ungroupedVisibleConversations.length}</small></div>
                  {ungroupedVisibleConversations.map((conversation) => renderConversationRow(conversation))}
                  {draggingConversationId && <div className={`native-chat-sidebar-ungroup-drop ${dropTarget?.type === 'ungrouped' ? 'active' : ''}`} onDragOver={(event) => { event.preventDefault(); setDropTarget({ type: 'ungrouped', id: '', position: 'inside' }) }} onDrop={(event) => { event.preventDefault(); void dropOutOfGroup() }}>拖到这里移出分组</div>}
                </section>
                {normalizedSearch && !visibleNativeConversations.length ? <div className="sidebar-search-empty" role="status"><p>没有匹配的会话</p><button type="button" onClick={() => { setSearchQuery(''); searchInputRef.current?.focus() }}>清除搜索</button></div> : !listedNativeConversations.length && <button type="button" className="native-chat-sidebar-empty" onClick={onStartNativeChat}>{showArchivedChats ? '暂无已归档对话' : '新建你的第一次 AI 对话'}</button>}
              </div>
            </section>
          </div>
          {voiceStatus && <div className="sidebar-panel-footer"><div className="sidebar-voice-status">{voiceStatus}</div></div>}
        </div>
        </div>
        {!panelHidden && !isMobile && <SidebarResizeHandle width={panelWidth} onWidthChange={onPanelWidthChange} />}
      </aside>
      {groupDialog && createPortal(
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !groupBusy && closeGroupDialog()}>
          <form ref={groupDialogRef} className="conversation-group-dialog" role="dialog" aria-modal="true" aria-label={groupDialog.mode === 'create' ? '新建对话分组' : '重命名对话分组'} onSubmit={submitGroupDialog}>
            <header>
              <strong>{groupDialog.mode === 'create' ? '新建分组' : '重命名分组'}</strong>
              <button type="button" className="icon-button" aria-label="关闭" disabled={groupBusy} onClick={closeGroupDialog}><X size={16} /></button>
            </header>
            <label><span>分组名称</span><input autoFocus maxLength={40} value={groupDialog.name} onChange={(event) => setGroupDialog({ ...groupDialog, name: event.target.value })} placeholder="例如：工作 / 学习 / 项目 A" /></label>
            <p className="conversation-group-hint">建好后把左侧会话拖到分组标题上即可收进去，点标题可折叠收纳。</p>
            {groupError && <p className="conversation-group-error" role="alert">{groupError}</p>}
            <footer>
              <button type="button" className="button ghost small" disabled={groupBusy} onClick={closeGroupDialog}>取消</button>
              <button type="submit" className="button primary small" disabled={groupBusy || !groupDialog.name.trim()}>{groupBusy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{groupDialog.mode === 'create' ? '创建分组' : '保存名称'}</button>
            </footer>
          </form>
        </div>, document.body)}
    </>
  )
}
