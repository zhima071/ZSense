// Isolated real renderer components; every send and saved record below is synthetic.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentTaskPlanCard } from '../../src/components/AgentTaskPlanCard'
import { ChatDialog } from '../../src/components/ChatDialog'
import { NativeChatPage } from '../../src/components/NativeChatPage'
import type { AgentLoopStep, AgentTaskPlanSnapshot, Bot, ChatMessageRecord, ChatResult, ChatStreamEvent, ChatUsage, Conversation, ModelConfiguration, RuntimeStatus } from '../../src/types'
import '../../src/styles.css'

const mode = new URLSearchParams(location.search).get('mode') || 'card'
const savedPlan: AgentTaskPlanSnapshot = { planId: 'saved-plan', phase: 'complete', message: '历史汇总已校验', tasks: [{ id: 'saved-history-task', title: '历史任务交付', goal: '历史任务交付', dependencies: [], expectedOutputs: ['历史报告'], writeResources: [], status: 'completed', output: '仅属于历史回复的任务交付', durationMs: 1234, toolCallCount: 2 }] }
const step = (plan: AgentTaskPlanSnapshot): AgentLoopStep => ({ step: 1, status: 'complete', outcome: 'final_answer', reasoning: '', content: '任务结果已汇总', tools: [], startedAt: '2026-10-10T03:00:00Z', orchestration: plan })
const record = (id: string, role: ChatMessageRecord['role'], content: string, plan?: AgentTaskPlanSnapshot): ChatMessageRecord => ({ id, role, content, reasoning: '', agentSteps: plan ? [step(plan)] : [], toolEvents: [], attachments: [], externalMessageId: '', modelProvider: 'custom', model: 'fixture-model', durationMs: 1234, outputTokens: 30, createdAt: '2026-10-10T03:00:00Z' })
const bot: Bot = { id: 'task-plan-fixture-bot', name: '隔离任务卡 Bot', initials: 'QA', role: '测试', description: '', status: 'online', color: '#2563eb', modelProvider: 'custom', model: 'fixture-model', memoryCount: 0, memorySize: '0', channels: [], lastActive: '', conversations: 1, successRate: 100, prompt: '', memories: [] }
const runtime: RuntimeStatus = { runnable: true, version: 'fixture', status: 'ready', message: '', checkedAt: '', scope: 'isolated', agentDataPath: null, gatewayDataPath: null, managedByApp: true, managedGatewayCount: 0, lifecycle: 'running', lastGatewayError: null, gatewayMonitorEnabled: false, gatewayHealthCheckIntervalSeconds: 0, lastGatewayHealthCheckAt: null, gatewayHealthyCount: 0, gatewayExpectedCount: 0, gatewayRecoveryCount: 0 }
const model: ModelConfiguration = { provider: 'custom', model: 'fixture-model', baseUrl: '', apiKeyName: '', apiKeyConfigured: true, updatedAt: '', contextWindow: 100_000 }
const alternativeModel: ModelConfiguration = { ...model, model: 'alternative-fixture-model-with-a-long-model-id', contextWindow: 200_000 }

declare global {
  interface Window {
    __taskPlanNodes?: Element[]
    __taskPlanQa: { setPlan: (plan?: AgentTaskPlanSnapshot) => void; copied: () => string[] }
    __taskChatQa: {
      emit: (plan: AgentTaskPlanSnapshot) => void
      finish: (plan: AgentTaskPlanSnapshot) => void
      emitAnswer: (text: string) => void
      emitUsage: (usage: ChatUsage) => void
      fail: () => void
      omitNextTerminalSnapshot: () => void
      switchConversation: (target: 'first' | 'second') => void
      remount: () => void
      cancel: () => void
      snapshot: () => { sends: number; requestId: string; conversationId: string; savedIds: string[]; cancels: number; forks: string[] }
    }
  }
}

const copied: string[] = []
document.addEventListener('copy', (event) => {
  // Verify the real keyboard copy gesture/selection without changing OS clipboard.
  copied.push(getSelection()?.toString() || '')
  event.preventDefault()
})

function CardFixture() {
  const [plan, setPlan] = useState<AgentTaskPlanSnapshot | undefined>({ planId: 'fixture-plan', phase: 'planning', tasks: [] })
  window.__taskPlanQa = { setPlan, copied: () => copied }
  return <main style={{ padding: '36px 12px', maxWidth: 1060, margin: '0 auto' }}>
    <h1 style={{ fontSize: 18, marginBottom: 20 }}>隔离多 Agent 任务卡验证</h1>
    <div className="chat-message-list"><article className="chat-message assistant"><span>AI</span><div><AgentTaskPlanCard plan={plan} /></div></article></div>
  </main>
}

function ChatFixture({ native }: { native: boolean }) {
  const [nonce] = useState(() => crypto.randomUUID())
  const initial: Conversation = { id: `task-plan-fixture-${nonce}`, botId: native ? '__zsense_native__' : bot.id, kind: native ? 'native' : 'bot', title: '隔离任务卡历史', channelId: 'web', externalThreadId: '', runtimeEngine: 'zsense-core', runtimeSessionId: '', modelProvider: 'custom', model: 'fixture-model', reasoningEffort: 'high', workspacePath: '/isolated-fixture-workspace', createdAt: '2026-10-10T03:00:00Z', updatedAt: '2026-10-10T03:00:00Z', messageCount: 4, archived: false, sortOrder: 0, groupId: '', messages: [record('history-user', 'user', '已保存的历史任务'), record('history-assistant', 'assistant', '历史回答正文', savedPlan), record('plain-user', 'user', '不需要任务卡的历史问题'), record('plain-assistant', 'assistant', '没有任务卡的普通回复')] }
  const [conversation, setConversation] = useState(initial)
  const secondary = useRef<Conversation>({ ...initial, id: `second-task-plan-fixture-${nonce}`, title: '第二会话', messages: [record('second-user', 'user', '第二会话问题'), record('second-assistant', 'assistant', '第二会话正文', { ...savedPlan, planId: 'second-plan', tasks: [{ ...savedPlan.tasks[0], id: 'second-history-task', title: '第二会话历史任务', goal: '第二会话历史任务' }] })], messageCount: 2 })
  const [activeId, setActiveId] = useState(initial.id)
  const selected = activeId === secondary.current.id ? secondary.current : conversation
  const [epoch, setEpoch] = useState(0)
  const sends = useRef(0)
  const cancels = useRef(0)
  const forks = useRef<string[]>([])
  const omitTerminal = useRef(false)
  const pending = useRef<{ requestId: string; prompt: string; conversation: Conversation; onEvent: (event: ChatStreamEvent) => void; resolve: (result: ChatResult) => void; reject: (error: Error) => void }>()
  const send = (prompt: string, requestId: string, onEvent: (event: ChatStreamEvent) => void) => {
    sends.current += 1
    return new Promise<ChatResult>((resolve, reject) => { pending.current = { requestId, prompt, conversation: selected, onEvent, resolve, reject } })
  }
  const emit = (plan: AgentTaskPlanSnapshot) => {
    const run = pending.current!
    run.onEvent({ type: 'orchestration', requestId: run.requestId, conversationId: run.conversation.id, ...plan })
  }
  const cancel = async () => {
    cancels.current += 1
    if (!pending.current) return
    if (!omitTerminal.current) emit({ planId: 'live-plan', phase: 'cancelled', tasks: [{ id: 'live-task', title: '实时任务', goal: '实时任务', status: 'cancelled', dependencies: [], expectedOutputs: [], writeResources: [] }], message: '用户已取消' })
    omitTerminal.current = false
    pending.current.reject(new Error('已停止生成。'))
  }
  window.__taskChatQa = {
    emit,
    emitAnswer: (delta) => { const run = pending.current!; run.onEvent({ type: 'answer', requestId: run.requestId, conversationId: run.conversation.id, delta }) },
    emitUsage: (usage) => { const run = pending.current!; run.onEvent({ type: 'usage', requestId: run.requestId, conversationId: run.conversation.id, usage }) },
    fail: () => {
      if (!omitTerminal.current) emit({ planId: 'live-plan', phase: 'error', tasks: [{ id: 'live-task', title: '实时任务', goal: '实时任务', status: 'failed', dependencies: [], expectedOutputs: [], writeResources: [], error: '隔离任务执行失败' }] })
      omitTerminal.current = false
      pending.current!.reject(new Error('隔离任务执行失败'))
    },
    omitNextTerminalSnapshot: () => { omitTerminal.current = true },
    switchConversation: (target) => setActiveId(target === 'first' ? conversation.id : secondary.current.id),
    finish: (plan) => {
      const run = pending.current!
      emit(plan)
      const saved = { ...run.conversation, messages: [...run.conversation.messages, record(`saved-user-${run.requestId}`, 'user', run.prompt), record(`saved-assistant-${run.requestId}`, 'assistant', '当前任务汇总完成', plan)], messageCount: run.conversation.messages.length + 2, updatedAt: new Date().toISOString() }
      run.onEvent({ type: 'done', requestId: run.requestId, conversationId: run.conversation.id, content: '当前任务汇总完成', reasoning: '', agentSteps: [step(plan)], status: 'complete' })
      if (saved.id === conversation.id) setConversation(saved)
      else { secondary.current = saved; setEpoch((value) => value + 1) }
      window.setTimeout(() => run.resolve({ conversationId: saved.id, message: '当前任务汇总完成', attachments: [], modelProvider: 'custom', model: 'fixture-model', durationMs: 1234, agentSteps: [step(plan)], workspace: { conversations: [saved] } as ChatResult['workspace'] }), 40)
    },
    remount: () => setEpoch((value) => value + 1),
    cancel: () => { void cancel() },
    snapshot: () => ({ sends: sends.current, requestId: pending.current?.requestId || '', conversationId: selected.id, savedIds: selected.messages.map((message) => message.id), cancels: cancels.current, forks: forks.current }),
  }
  const shared = { bots: [bot], skills: [], runtime, savedModelConfigurations: [model, alternativeModel], defaultModelConfiguration: model, defaultWorkspacePath: '/isolated-fixture-workspace', speechLanguage: 'zh-CN' as const, speechVoice: '', speechSpeed: 1, browserSettings: { browserEnabled: false, browserWebLinkTarget: 'zsense' as const, browserLocalUrlTarget: 'zsense' as const, browserShowFullUrl: false }, onPickAttachments: async () => [], onPickWorkspace: async () => '/isolated-fixture-workspace', onSaveWorkspace: async () => undefined, onDeleteMessage: async () => undefined, onBookmarkMessage: async () => undefined, onForkMessage: async (_conversationId: string, messageId: string) => { forks.current.push(messageId) }, onCancel: cancel, onClarify: async () => undefined, onNewConversation: () => undefined, onOpenSettings: () => undefined }
  return native
    ? <div style={{ '--sidebar-width': '0px' } as React.CSSProperties}><NativeChatPage key={epoch} {...shared} conversations={[conversation, secondary.current]} activeConversationId={activeId} resetToken={0} onConversationChange={(id) => id && setActiveId(id)} onSend={(prompt, _conversationId, requestId, _options, onEvent) => send(prompt, requestId, onEvent)} /></div>
    : <ChatDialog key={`${selected.id}:${epoch}`} {...shared} bot={bot} conversation={selected} onClose={() => undefined} onSend={(_botId, prompt, _conversationId, requestId, _options, onEvent) => send(prompt, requestId, onEvent)} />
}

createRoot(document.getElementById('root')!).render(mode === 'card' ? <CardFixture /> : <ChatFixture native={mode === 'native'} />)
