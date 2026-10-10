import { useSyncExternalStore } from 'react'
import type { AgentLoopStep, AgentTaskPlanSnapshot, ChatAttachment, ChatClarification, ChatToolEvent, ChatUsage, ModelProvider } from '../types'

export interface ChatTranscriptItem {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  reasoning?: string
  agentSteps?: AgentLoopStep[]
  orchestration?: AgentTaskPlanSnapshot
  tools?: ChatToolEvent[]
  attachments?: ChatAttachment[]
  modelProvider?: ModelProvider | ''
  model?: string
  durationMs?: number | null
  outputTokens?: number | null
  status?: string
  streaming?: boolean
  requestId?: string
  clarification?: ChatClarification
  clarificationExpired?: boolean
  /** 「/bot 名字 指令」产生的回复：显示成哪个 Bot 回的 */
  delegateBotName?: string
  error?: boolean
}

export interface ChatRunSnapshot {
  key: string
  kind: 'bot' | 'native'
  botId?: string
  requestId: string
  conversationId?: string
  messages: ChatTranscriptItem[]
  usage?: ChatUsage
  sending: boolean
  error?: string
  updatedAt: number
}

export function settleOrchestrationSnapshot(plan: AgentTaskPlanSnapshot | undefined, cancelled: boolean): AgentTaskPlanSnapshot | undefined {
  if (!plan || ['complete', 'cancelled', 'error'].includes(plan.phase)) return plan
  if (!cancelled) return { ...plan, phase: 'error', message: '执行请求中断，未收到子任务最终状态；以下为最后已确认的进度。' }
  return {
    ...plan, phase: 'cancelled', message: '已停止当前任务。',
    tasks: plan.tasks.map((task) => ['pending', 'queued', 'waiting', 'running'].includes(task.status)
      ? { ...task, status: 'cancelled', finishedAt: new Date().toISOString() } : task),
  }
}

export function insertSteeringTranscript(messages: ChatTranscriptItem[], responseId: string, steering: { steeringId: string; content: string; receivedAt: string; attachments?: ChatAttachment[] }) {
  const messageId = `steering-user-${steering.steeringId}`
  if (messages.some((item) => item.id === messageId)) return messages
  const userMessage: ChatTranscriptItem = { id: messageId, role: 'user', content: steering.content, createdAt: steering.receivedAt, attachments: steering.attachments || [] }
  const responseIndex = messages.findIndex((item) => item.id === responseId)
  if (responseIndex < 0) return [...messages, userMessage]
  return [...messages.slice(0, responseIndex), userMessage, ...messages.slice(responseIndex)]
}

const runs = new Map<string, ChatRunSnapshot>()
const listeners = new Set<() => void>()
let runningRevision = 0

function runningIdentity(run: ChatRunSnapshot | undefined) {
  return run?.sending && run.conversationId ? `${run.kind}:${run.conversationId}` : ''
}

function emit(runningChanged = false) {
  if (runningChanged) runningRevision += 1
  for (const listener of listeners) listener()
}

export function chatRunKey(kind: 'bot' | 'native', conversationId?: string, botId?: string) {
  if (kind === 'native') return `native:${conversationId || 'new'}`
  return `bot:${botId || 'unknown'}:${conversationId || 'new'}`
}

export function getChatRun(key: string) {
  return runs.get(key)
}

export function setChatRun(key: string, snapshot: Omit<ChatRunSnapshot, 'key' | 'updatedAt'>) {
  const previous = runs.get(key)
  const next: ChatRunSnapshot = { ...snapshot, key, updatedAt: Date.now() }
  runs.set(key, next)
  emit(runningIdentity(previous) !== runningIdentity(next))
  return next
}

export function updateChatRun(key: string, update: (current: ChatRunSnapshot) => ChatRunSnapshot) {
  const current = runs.get(key)
  if (!current) return undefined
  const next = { ...update(current), key, updatedAt: Date.now() }
  runs.set(key, next)
  emit(runningIdentity(current) !== runningIdentity(next))
  return next
}

export function moveChatRun(fromKey: string, toKey: string, conversationId: string) {
  const current = runs.get(fromKey)
  if (!current) return toKey
  const next = { ...current, key: toKey, conversationId, updatedAt: Date.now() }
  if (fromKey !== toKey) runs.delete(fromKey)
  runs.set(toKey, next)
  emit(runningIdentity(current) !== runningIdentity(next))
  return toKey
}

export function removeChatRun(key: string, requestId?: string) {
  const current = runs.get(key)
  if (!current || (requestId && current.requestId !== requestId)) return
  runs.delete(key)
  emit(Boolean(runningIdentity(current)))
}

export function subscribeChatRuns(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useChatRun(key: string) {
  return useSyncExternalStore(subscribeChatRuns, () => getChatRun(key), () => getChatRun(key))
}

export function useRunningConversationIds(kind: 'bot' | 'native' = 'native') {
  // 消息 token 更新仍会通知精确订阅当前 run 的对话组件；只有「是否运行中」的拓扑
  // 真正变化时才刷新侧边栏与 Bot 工作区，避免它们在每个流式 token 上一起重渲染。
  useSyncExternalStore(subscribeChatRuns, () => runningRevision, () => runningRevision)
  return new Set([...runs.values()]
    .filter((run) => run.kind === kind && run.sending && run.conversationId)
    .map((run) => run.conversationId as string))
}
