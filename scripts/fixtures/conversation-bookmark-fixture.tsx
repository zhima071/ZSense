// Isolated renderer QA: storage belongs to this disposable browser context,
// never to Electron or an actual ZSense user database.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConversationJumpNav, conversationMessageAnchor } from '../../src/components/ConversationJumpNav'
import { ChatSendActions } from '../../src/components/ChatSendActions'
import { ChatDialog } from '../../src/components/ChatDialog'
import type { Bot, ChatMessageRecord, ChatResult, ChatStreamEvent, Conversation, ModelConfiguration, RuntimeStatus } from '../../src/types'
import '../../src/styles.css'

type Options = { edge: 'normal' | 'top' | 'bottom'; officeOpen: boolean; unsaved: boolean; composer: boolean; composerWidth: number; webBridge: boolean; sending: boolean; sendDisabled: boolean; dialog: 'off' | 'existing' | 'new' }
type BookmarkMap = Record<string, string[]>
const defaults: Options = { edge: 'normal', officeOpen: false, unsaved: false, composer: false, composerWidth: 900, webBridge: false, sending: true, sendDisabled: false, dialog: 'off' }
const prefix = 'bookmark-qa-shared-prefix'
const storageKey = (conversationId: string) => `zsense-bookmark-fixture:${conversationId}`
function readBookmarks(): BookmarkMap {
  return Object.fromEntries(['a', 'b'].map((id) => {
    try { return [id, JSON.parse(localStorage.getItem(storageKey(id)) || '[]')] } catch { return [id, []] }
  }))
}
const jumps: string[] = []
const originalScroll = HTMLElement.prototype.scrollIntoView
HTMLElement.prototype.scrollIntoView = function (...args) {
  if (this.dataset.messageId) jumps.push(this.dataset.messageId)
  return originalScroll.apply(this, args)
}
declare global {
  interface Window {
    __dialogQa?: {
      associate: () => void
      emit: (delta: string) => void
      finish: () => void
      fail: (message: string) => void
      updateMetadata: () => void
      snapshot: () => { conversation?: Conversation; sends: number; bookmarkCalls: Array<{ conversationId: string; messageId: string; bookmarked: boolean }>; userId: string; assistantId: string; streamText: string }
    }
    __bookmarkQa: {
      reset: () => void
      setConversation: (id: string) => void
      configure: (options: Partial<Options>) => void
      failNext: () => void
      setDelay: (ms: number) => void
      snapshot: () => { conversationId: string; bookmarks: BookmarkMap; calls: Array<{ conversationId: string; messageId: string; bookmarked: boolean }>; jumps: string[]; composer: { stop: number; send: number } }
    }
  }
}

function DialogFixture({ mode }: { mode: 'existing' | 'new' }) {
  const [nonce] = useState(() => crypto.randomUUID())
  const bot: Bot = { id: `fixture-bot-${nonce}`, name: '隔离 Bot', initials: 'QA', role: '测试', description: '', status: 'online', color: '#2563eb', modelProvider: 'custom', model: 'fixture-model', memoryCount: 0, memorySize: '0', channels: [], lastActive: '', conversations: 1, successRate: 100, prompt: '', memories: [] }
  const record = (id: string, role: ChatMessageRecord['role'], content: string): ChatMessageRecord => ({ id, role, content, reasoning: '', agentSteps: [], toolEvents: [], attachments: [], externalMessageId: '', modelProvider: 'custom', model: 'fixture-model', durationMs: null, outputTokens: null, createdAt: new Date().toISOString() })
  const base = useRef<Conversation>({ id: `fixture-conversation-${nonce}`, botId: bot.id, kind: 'bot', title: '隔离会话', channelId: 'web', externalThreadId: '', runtimeEngine: 'zsense-core', runtimeSessionId: '', modelProvider: 'custom', model: 'fixture-model', reasoningEffort: 'high', workspacePath: '/isolated-fixture-workspace', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: mode === 'existing' ? 2 : 0, archived: false, sortOrder: 0, groupId: '', messages: mode === 'existing' ? [record(`history-user-${nonce}`, 'user', '已保存的历史问题'), record(`history-assistant-${nonce}`, 'assistant', '已保存的历史回答')] : [] })
  const [conversation, setConversation] = useState<Conversation | undefined>(mode === 'existing' ? base.current : undefined)
  const sendCount = useRef(0)
  const bookmarkCalls = useRef<Array<{ conversationId: string; messageId: string; bookmarked: boolean }>>([])
  const pending = useRef<{ requestId: string; content: string; streamText: string; onEvent: (event: ChatStreamEvent) => void; resolve: (result: ChatResult) => void; reject: (reason: Error) => void }>()
  const persisted = (final = false): Conversation => {
    const run = pending.current!
    const messages = [...base.current.messages, record(`saved-user-${run.requestId}`, 'user', run.content), record(`saved-assistant-${run.requestId}`, 'assistant', final ? '最终回答：流式完整内容已保存。' : run.streamText)]
    return { ...base.current, messages, messageCount: messages.length, updatedAt: new Date().toISOString() }
  }
  window.__dialogQa = {
    associate: () => setConversation(persisted()),
    emit: (delta) => {
      const run = pending.current!
      run.streamText += delta
      run.onEvent({ type: 'answer', requestId: run.requestId, conversationId: base.current.id, delta })
    },
    finish: () => {
      const run = pending.current!
      const final = persisted(true)
      run.onEvent({ type: 'done', requestId: run.requestId, conversationId: base.current.id, content: '最终回答：流式完整内容已保存。', reasoning: '', status: 'complete' })
      setConversation(final)
      window.setTimeout(() => run.resolve({ conversationId: final.id, message: '最终回答：流式完整内容已保存。', attachments: [], modelProvider: 'custom', model: 'fixture-model', durationMs: 120, workspace: { conversations: [final] } as ChatResult['workspace'] }), 40)
    },
    fail: (message) => pending.current!.reject(new Error(message)),
    updateMetadata: () => setConversation((current) => current ? { ...current, updatedAt: new Date().toISOString(), messages: current.messages.map((message) => ({ ...message, bookmarked: message.role === 'user' ? !message.bookmarked : message.bookmarked })) } : current),
    snapshot: () => ({ conversation, sends: sendCount.current, bookmarkCalls: bookmarkCalls.current, userId: pending.current ? `saved-user-${pending.current.requestId}` : '', assistantId: pending.current ? `saved-assistant-${pending.current.requestId}` : '', streamText: pending.current?.streamText || '' }),
  }
  const runtime: RuntimeStatus = { runnable: true, version: 'fixture', status: 'ready', message: '', checkedAt: '', scope: 'isolated', agentDataPath: null, gatewayDataPath: null, managedByApp: true, managedGatewayCount: 0, lifecycle: 'running', lastGatewayError: null, gatewayMonitorEnabled: false, gatewayHealthCheckIntervalSeconds: 0, lastGatewayHealthCheckAt: null, gatewayHealthyCount: 0, gatewayExpectedCount: 0, gatewayRecoveryCount: 0 }
  const model: ModelConfiguration = { provider: 'custom', model: 'fixture-model', baseUrl: '', apiKeyName: '', apiKeyConfigured: true, updatedAt: '' }
  return <ChatDialog bot={bot} bots={[bot]} skills={[]} conversation={conversation} runtime={runtime} savedModelConfigurations={[model]} defaultModelConfiguration={model} defaultWorkspacePath="/isolated-fixture-workspace" speechLanguage="zh-CN" speechVoice="" speechSpeed={1} browserSettings={{ browserEnabled: true, browserWebLinkTarget: 'zsense', browserLocalUrlTarget: 'zsense', browserShowFullUrl: false }} onClose={() => undefined} onOpenSettings={() => undefined} onNewConversation={() => undefined}
    onSend={async (_botId, content, _conversationId, requestId, _options, onEvent) => {
      sendCount.current += 1
      return new Promise<ChatResult>((resolve, reject) => {
        pending.current = { requestId, content, streamText: '流式初始片段', onEvent, resolve, reject }
        onEvent({ type: 'conversation-ready', requestId, conversationId: base.current.id })
        onEvent({ type: 'answer', requestId, conversationId: base.current.id, delta: '流式初始片段' })
      })
    }} onPickAttachments={async () => []} onPickWorkspace={async () => '/isolated-fixture-workspace'} onSaveWorkspace={async () => undefined} onDeleteMessage={async () => undefined} onForkMessage={async () => undefined} onBookmarkMessage={async (conversationId, messageId, bookmarked) => {
      bookmarkCalls.current.push({ conversationId, messageId, bookmarked })
      setConversation((current) => current ? { ...current, messages: current.messages.map((message) => message.id === messageId ? { ...message, bookmarked } : message) } : current)
    }} onCancel={async () => { pending.current!.reject(new Error('已停止生成。')) }} onClarify={async () => undefined} />
}
function Fixture() {
  const [conversationId, setConversationId] = useState('a')
  const [bookmarks, setBookmarks] = useState(readBookmarks)
  const [options, setOptions] = useState(defaults)
  const [epoch, setEpoch] = useState(0)
  const fail = useRef(false)
  const delay = useRef(0)
  const calls = useRef<Array<{ conversationId: string; messageId: string; bookmarked: boolean }>>([])
  const composerCalls = useRef({ stop: 0, send: 0 })
  const messages = [
    { id: 'user-1', role: 'user' as const, content: `会话 ${conversationId.toUpperCase()} 第一轮：帮我整理项目资料并生成执行计划。`.repeat(3) },
    { id: 'assistant-1', role: 'assistant' as const, content: '已完成素材清点，下一步将核对版本并整理交付目录。'.repeat(5) },
    { id: 'user-2', role: 'user' as const, content: '第二轮：继续完善交付内容。' },
    { id: 'assistant-2', role: 'assistant' as const, content: '第二轮处理完成。' },
    { id: 'temporary-user', role: 'user' as const, content: '正在提交、尚未保存的本轮消息' },
  ]
  window.__bookmarkQa = {
    reset: () => {
      localStorage.removeItem(storageKey('a')); localStorage.removeItem(storageKey('b'))
      setBookmarks({ a: [], b: [] }); setConversationId('a'); setOptions(defaults); setEpoch((current) => current + 1)
      calls.current.length = 0; jumps.length = 0; fail.current = false; delay.current = 0
      composerCalls.current = { stop: 0, send: 0 }
      delete window.__dialogQa
      window.scrollTo(0, 0)
    },
    setConversation: setConversationId,
    configure: (patch) => setOptions((current) => ({ ...current, ...patch })),
    failNext: () => { fail.current = true },
    setDelay: (ms) => { delay.current = ms },
    snapshot: () => ({ conversationId, bookmarks, calls: calls.current, jumps, composer: composerCalls.current }),
  }
  const toggleBookmark = async (messageId: string, bookmarked: boolean) => {
    const targetConversation = conversationId
    calls.current.push({ conversationId: targetConversation, messageId, bookmarked })
    if (delay.current) await new Promise((resolve) => setTimeout(resolve, delay.current))
    if (fail.current) { fail.current = false; throw new Error('测试保存失败，请重试') }
    const current = JSON.parse(localStorage.getItem(storageKey(targetConversation)) || '[]') as string[]
    const updated = bookmarked ? Array.from(new Set([...current, messageId])) : current.filter((id) => id !== messageId)
    localStorage.setItem(storageKey(targetConversation), JSON.stringify(updated))
    setBookmarks((items) => ({ ...items, [targetConversation]: updated }))
  }
  const navStyle: React.CSSProperties = options.edge === 'normal' ? {} : { position: 'fixed', left: 24, ...(options.edge === 'top' ? { top: 4 } : { bottom: 4 }) }
  return (
    <main className={`${options.officeOpen ? 'has-office-artifact' : ''} ${options.webBridge ? 'zsense-web-bridge' : ''}`} style={{ padding: 24, '--sidebar-width': '0px' } as React.CSSProperties}>
      {options.dialog !== 'off' && <DialogFixture key={`${epoch}:${options.dialog}`} mode={options.dialog} />}
      <h1 style={{ marginBottom: 24 }}>隔离书签测试</h1>
      <div className="chat-transcript-layout">
        <div style={navStyle}><ConversationJumpNav key={epoch} messages={messages} anchorPrefix={prefix} conversationId={options.unsaved ? undefined : conversationId} bookmarkedMessageIds={bookmarks[conversationId] || []} bookmarkableMessageIds={['user-1', 'user-2']} onBookmarkChange={toggleBookmark} /></div>
        <div className="chat-message-list">
          {messages.map((message) => <article id={conversationMessageAnchor(prefix, message.id)} data-message-id={message.id} tabIndex={-1} key={message.id} style={{ minHeight: 240, padding: 24, border: '1px solid var(--border)', borderRadius: 8 }}><h2>{message.role === 'user' ? '你' : 'ZSense Agent'}</h2><p>{message.content}</p></article>)}
        </div>
      </div>
      {options.composer && <section className="native-chat-main" data-testid="composer-fixture" style={{ position: 'fixed', zIndex: 50, left: 12, top: 70, width: options.composerWidth, display: 'block', overflow: 'visible' }}>
        <form className={`chat-composer native unified-composer ${options.sending ? 'is-running' : ''}`} onSubmit={(event) => { event.preventDefault(); composerCalls.current.send += 1 }}>
          <textarea aria-label="输入任务内容" defaultValue="这个输入框用于验证发送、停止与移动端键盘布局，不会发送真实任务。" />
          <div className="chat-composer-toolbar composer-layout"><div className="chat-composer-toolbar-main">
            <button type="button" className="chat-attachment-button" title="添加附件" data-composer-control="attachment">＋</button>
            <button type="button" className="chat-workspace-button" data-composer-control="workspace"><span className="chat-control-summary">工作区</span></button>
            <button type="button" className="chat-access-button" data-composer-control="access"><span className="chat-control-summary">受限访问</span></button>
            <label className="chat-toolbar-select chat-reasoning-select" data-composer-control="reasoning"><span className="chat-control-summary">标准</span><select aria-label="推理等级"><option>标准</option></select></label>
            <label className="chat-toolbar-select chat-model-select" data-composer-control="model"><span className="chat-control-summary">model-id</span><select aria-label="模型"><option>model-id</option></select></label>
            <button type="button" className="chat-context-usage" data-composer-control="context"><span className="chat-control-summary">10%</span></button>
          </div></div>
          <div className="chat-composer-footer"><small>隔离测试，不连接真实任务</small><ChatSendActions sending={options.sending} disabled={options.sendDisabled} onStop={() => { composerCalls.current.stop += 1 }} /></div>
        </form>
      </section>}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
