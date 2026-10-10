// Browser-only regression fixture. All state and callbacks are in memory; no
// Electron bridge, user database, real account, or network service is involved.
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../../src/components/Sidebar'
import { removeChatRun, setChatRun } from '../../src/services/chat-run-store'
import { SIDEBAR_PANEL_DEFAULT_WIDTH, useSidebarPanelWidth } from '../../src/services/sidebar-panel-width'
import type { AuthUser, Bot, Conversation, ConversationGroup, ViewId } from '../../src/types'
import '../../src/styles.css'

const now = '2026-10-10T03:20:00.000Z'
const spaceId = 'sidebar-qa-native'
const user: AuthUser = { id: 'qa-user', username: 'qa', displayName: '测试用户', role: 'admin', enabled: true, createdAt: now, updatedAt: now, lastLoginAt: now }
const bots: Bot[] = [
  { id: 'atlas', name: 'Atlas', initials: 'A', role: '办公室智能体', description: '', status: 'online', color: '#3378ff', modelProvider: '', model: '', memoryCount: 0, memorySize: '', channels: ['web'], lastActive: '', conversations: 2, successRate: 100, prompt: '', memories: [] },
  { id: 'scout', name: 'Scout 超长机器人名称用于验证窄栏省略和完整悬浮说明', initials: 'S', role: '研究与检索', description: '', status: 'online', color: '#6a5ce7', modelProvider: '', model: '', memoryCount: 0, memorySize: '', channels: ['web'], lastActive: '', conversations: 1, successRate: 100, prompt: '', memories: [] },
]
function conversation(id: string, title: string, groupId = '', archived = false): Conversation {
  return { id, title, groupId, archived, botId: spaceId, kind: 'native', channelId: 'web', externalThreadId: '', runtimeEngine: 'zsense-core', runtimeSessionId: '', modelProvider: '', model: '', reasoningEffort: 'high', workspacePath: '', createdAt: now, updatedAt: now, messageCount: 8, sortOrder: 0, messages: [] }
}
function initialConversations() {
  return [
    conversation('c-alpha', '文件整理与日报'),
    conversation('c-beta', '预算表与会议纪要'),
    conversation('c-long', '这是一条非常长的会话标题：跨部门季度采购流程优化方案与文档协作进度追踪'.repeat(3)),
    conversation('c-work', '工作组内的报告分析', 'g-work'),
    conversation('c-study', '折叠组内的学习笔记', 'g-study'),
    conversation('c-archived', '历史归档会话', '', true),
    ...Array.from({ length: 30 }, (_, index) => conversation(`c-history-${index}`, `历史任务 ${String(index + 1).padStart(2, '0')}：文档分析`)),
  ]
}
function initialGroups(): ConversationGroup[] {
  return [
    { id: 'g-work', botId: spaceId, name: '工作项目', collapsed: false, sortOrder: 1, createdAt: now },
    { id: 'g-study', botId: spaceId, name: '学习资料', collapsed: true, sortOrder: 2, createdAt: now },
  ]
}
type FixtureOptions = { collapsed: boolean; mobileOpen: boolean; theme: 'light' | 'dark'; extraBots: number; displayName: string; username: string; showVoiceStatus: boolean }
type Event = { name: string; args: unknown[] }
declare global {
  interface Window {
    __sidebarQa: {
      events: Event[]
      reset: (options?: Partial<FixtureOptions>) => void
      configure: (options: Partial<FixtureOptions>) => void
      snapshot: () => { options: FixtureOptions; activeView: ViewId; conversations: Conversation[]; groups: ConversationGroup[] }
      setRunning: (enabled: boolean) => void
    }
  }
}
function Fixture() {
  const [panelWidth, setPanelWidth] = useSidebarPanelWidth()
  const [options, setOptions] = useState<FixtureOptions>({ collapsed: false, mobileOpen: false, theme: 'light', extraBots: 0, displayName: user.displayName, username: user.username, showVoiceStatus: false })
  const [activeView, setActiveView] = useState<ViewId>('chat')
  const [activeBotId, setActiveBotId] = useState<string | null>(null)
  const [activeConversationId, setActiveConversationId] = useState('c-alpha')
  const [conversations, setConversations] = useState(initialConversations)
  const [groups, setGroups] = useState(initialGroups)
  const [epoch, setEpoch] = useState(0)
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const events = useRef<Event[]>([])
  const nextGroup = useRef(0)
  const record = (name: string, ...args: unknown[]) => { events.current.push({ name, args }) }
  useEffect(() => {
    document.documentElement.dataset.theme = options.theme
    document.documentElement.style.colorScheme = options.theme
  }, [options.theme])
  window.__sidebarQa = {
    events: events.current,
    configure: (patch) => setOptions((current) => ({ ...current, ...patch })),
    reset: (patch = {}) => {
      events.current.length = 0
      setConversations(initialConversations())
      setGroups(initialGroups())
      setOptions({ collapsed: false, mobileOpen: false, theme: 'light', extraBots: 0, displayName: user.displayName, username: user.username, showVoiceStatus: false, ...patch })
      setActiveView('chat'); setActiveBotId(null); setActiveConversationId('c-alpha')
      setVoiceEnabled(false); setSessionsOpen(false); setEpoch((current) => current + 1)
      setPanelWidth(SIDEBAR_PANEL_DEFAULT_WIDTH)
      removeChatRun('sidebar-qa-running')
    },
    snapshot: () => ({ options, activeView, conversations, groups }),
    setRunning: (enabled) => {
      if (!enabled) removeChatRun('sidebar-qa-running')
      else setChatRun('sidebar-qa-running', { kind: 'native', requestId: 'sidebar-qa-request', conversationId: 'c-alpha', messages: [], sending: true })
    },
  }
  const fixtureBots = [...bots, ...Array.from({ length: options.extraBots }, (_, index) => ({ ...bots[0], id: `extra-${index}`, name: `额外 Bot ${index + 1}`, initials: String(index + 1) }))]
  return (
    <div className={`app-shell ${options.collapsed ? 'sidebar-collapsed' : ''}`} style={{ '--sidebar-panel-width': `${panelWidth}px` } as React.CSSProperties}>
      <Sidebar key={epoch} activeView={activeView} bots={fixtureBots} nativeConversations={conversations} activeNativeConversationId={activeConversationId} activeBotId={activeBotId} mobileOpen={options.mobileOpen} collapsed={options.collapsed} panelWidth={panelWidth} onPanelWidthChange={(width) => { record('resizeWidth', width); setPanelWidth(width) }}
        onNavigate={(view) => { record('navigate', view); setActiveView(view); setActiveBotId(null); setOptions((current) => ({ ...current, mobileOpen: false })) }}
        onOpenBot={(id) => { record('openBot', id); setActiveView('chat'); setActiveBotId(id); setOptions((current) => ({ ...current, mobileOpen: false })) }}
        onOpenNativeChat={(id) => { record('openChat', id); setActiveView('chat'); setActiveBotId(null); if (id) setActiveConversationId(id); setOptions((current) => ({ ...current, mobileOpen: false })) }}
        onStartNativeChat={() => { record('startChat'); setActiveView('chat'); setActiveBotId(null); setOptions((current) => ({ ...current, mobileOpen: false })) }}
        onRenameNativeConversation={async (id, title) => { record('renameChat', id, title); setConversations((items) => items.map((item) => item.id === id ? { ...item, title } : item)) }}
        onArchiveNativeConversation={async (id, archived) => { record('archiveChat', id, archived); setConversations((items) => items.map((item) => item.id === id ? { ...item, archived } : item)) }}
        onDeleteNativeConversation={async (id) => { record('deleteChat', id); setConversations((items) => items.filter((item) => item.id !== id)) }}
        nativeSpaceId={spaceId} nativeConversationGroups={groups}
        onCreateConversationGroup={async (botId, name) => { record('createGroup', botId, name); setGroups((items) => [...items, { id: `g-created-${++nextGroup.current}`, botId, name, sortOrder: items.length + 1, collapsed: false, createdAt: now }]) }}
        onRenameConversationGroup={async (id, name) => { record('renameGroup', id, name); setGroups((items) => items.map((item) => item.id === id ? { ...item, name } : item)) }}
        onDeleteConversationGroup={async (id) => { record('deleteGroup', id); setGroups((items) => items.filter((item) => item.id !== id)); setConversations((items) => items.map((item) => item.groupId === id ? { ...item, groupId: '' } : item)) }}
        onToggleConversationGroup={async (id, collapsed) => { record('toggleGroup', id, collapsed); setGroups((items) => items.map((item) => item.id === id ? { ...item, collapsed } : item)) }}
        onMoveConversationToGroup={async (id, groupId) => { record('moveChat', id, groupId); setConversations((items) => items.map((item) => item.id === id ? { ...item, groupId } : item)) }}
        onReorderConversations={async (botId, ids) => { record('reorderChats', botId, ids); setConversations((items) => ids.flatMap((id) => items.filter((item) => item.id === id))) }}
        onCloseMobile={() => { record('closeMobile'); setOptions((current) => ({ ...current, mobileOpen: false })) }}
        onToggleCollapsed={() => { record('toggleCollapsed'); setOptions((current) => ({ ...current, collapsed: !current.collapsed })) }}
        currentUser={{ ...user, displayName: options.displayName, username: options.username }} appLockEnabled onLock={async () => { record('lock') }} voiceStatus={options.showVoiceStatus ? <span>语音正在监听</span> : null}
        voiceWakeEnabled={voiceEnabled} voiceWakeStatus={{ supported: true, enabled: voiceEnabled, listening: voiceEnabled, state: voiceEnabled ? 'listening' : 'disabled', phrase: '你好 ZSense', provider: 'local', capture: 'local', sampleRate: 16000, frameLength: 512, sensitivity: 0.5, confirmationFrames: 2, permission: 'granted', message: voiceEnabled ? '正在监听' : '语音已关闭', checkedAt: now }} voiceWakeBusy={false}
        onToggleVoiceWake={() => { record('voice'); setVoiceEnabled((current) => !current) }}
        sessionCenterOpen={sessionsOpen} runningSessionCount={1} unreadSessionCount={2}
        onToggleSessionCenter={() => { record('sessions'); setSessionsOpen((current) => !current) }}
      />
      <div className="app-main">
        <header className="topbar"><button className="icon-button mobile-menu" aria-label="打开导航" aria-controls="sidebar-panel" aria-expanded={options.mobileOpen} onClick={() => setOptions((current) => ({ ...current, mobileOpen: true }))}>☰</button></header>
        <main id="main-content" style={{ padding: 24 }}><h1>隔离测试工作区</h1><p>本页不连接 Electron，也不读取或修改任何真实用户数据。</p></main>
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
