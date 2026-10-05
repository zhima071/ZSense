import { AlertTriangle, ArrowUp, Globe2, LoaderCircle, Paintbrush, Settings2, Sparkles, Square } from 'lucide-react'
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import { mergeChatAttachments, useChatAttachmentDrop, useChatAttachmentPaste } from '../services/chat-attachments'
import { chatRunKey, getChatRun, insertSteeringTranscript, moveChatRun, removeChatRun, setChatRun, updateChatRun, useChatRun, type ChatTranscriptItem } from '../services/chat-run-store'
import { isCanvasDocumentPath } from '../services/office-artifacts'
import type { AgentLoopStep, AppSettings, Bot, ChatAttachment, ChatClarification, ChatClarificationAnswer, ChatResult, ChatStreamEvent, ChatToolEvent, ChatUsage, Conversation, ModelConfiguration, ModelProvider, ReasoningEffort, RuntimeStatus, Skill, VoiceChatRequest } from '../types'
import { AgentLoopPanel, AgentLoopTrigger, mergeAgentLoopEvent } from './AgentLoopPanel'
import { createStreamDeltaBuffer } from '../utils/stream-delta-buffer'
import { BrowserWorkspacePane } from './BrowserWorkspacePane'
import { ChatClarificationCard } from './ChatClarificationCard'
import { ChatComposerToolbar, ChatMessageAttachments } from './ChatComposerToolbar'
import { ChatComposerResizeHandle } from './ChatComposerResizeHandle'
import { ChatScrollToBottomButton } from './ChatScrollToBottomButton'
import { ChatMessageMeta, createChatQuote } from './ChatMessageMeta'
import { mergeChatToolEvent } from './ChatToolCalls'
import { ConversationIdButton } from './ConversationIdButton'
import { ConversationJumpNav, conversationMessageAnchor } from './ConversationJumpNav'
import { ZSenseCanvasPane } from './ZSenseCanvasPane'
import { MarkdownMessage } from './MarkdownMessage'
import { OfficeArtifactPane } from './OfficeArtifactPane'
import { useDisplaySettings } from './DisplaySettingsContext'
import { SlashCommandMenu, type SlashCommandItem } from './SlashCommandMenu'
import { createSlashCommandCatalog, delegatedBotNameFor, findSlashParent, matchingSlashCommands, resolveSlashSubmission } from './slash-command-catalog'

interface NativeChatPageProps {
  conversations: Conversation[]
  bots: Bot[]
  skills: Skill[]
  activeConversationId?: string
  resetToken: number
  draftRequest?: { id: string; text: string; submit?: boolean }
  runtime: RuntimeStatus
  savedModelConfigurations: ModelConfiguration[]
  defaultModelConfiguration: ModelConfiguration
  defaultWorkspacePath: string
  voiceRequest?: VoiceChatRequest
  speechLanguage: 'auto' | 'zh-CN' | 'en-US'
  speechVoice: string
  speechSpeed: number
  browserSettings: Pick<AppSettings, 'browserEnabled' | 'browserWebLinkTarget' | 'browserLocalUrlTarget' | 'browserShowFullUrl' >
  onSend: (message: string, conversationId: string | undefined, requestId: string, options: { attachments: ChatAttachment[]; modelProvider?: ModelProvider; model?: string; reasoningEffort: ReasoningEffort; interactionMode?: 'text' | 'voice'; workspacePath: string; browserSessionId?: string; /** 把这条消息交给另一个 Bot 执行，但结果记在当前会话里 */ delegateBotId?: string }, onEvent: (event: ChatStreamEvent) => void) => Promise<ChatResult>
  onPickAttachments: () => Promise<ChatAttachment[]>
  onPickWorkspace: () => Promise<string>
  onSaveWorkspace: (conversationId: string, workspacePath: string) => Promise<void>
  onDeleteMessage: (conversationId: string, messageId: string) => Promise<void>
  onCancel: (requestId: string) => Promise<void>
  onClarify: (requestId: string, clarificationRequestId: string, answers: ChatClarificationAnswer[]) => Promise<void>
  onConversationChange: (conversationId?: string) => void
  onOpenSettings: () => void
  onNewConversation: () => void
  onVoiceTurnCompleted?: (requestId: string, responseText: string) => void | Promise<void>
  onVoiceTurnDelta?: (requestId: string, delta: string) => void
  onVoiceTurnFailed?: (requestId: string, reason: string) => void
}

type TranscriptItem = ChatTranscriptItem

function transcript(conversation: Conversation | undefined, defaultModelConfiguration: ModelConfiguration): TranscriptItem[] {
  const fallbackModel = conversation?.model || defaultModelConfiguration.model || ''
  const fallbackProvider = (conversation?.modelProvider || (defaultModelConfiguration.model ? defaultModelConfiguration.provider : '')) as ModelProvider | ''
  return (conversation?.messages || []).map((message) => ({
    id: message.id,
    role: message.role as TranscriptItem['role'],
    content: message.content,
    createdAt: message.createdAt,
    reasoning: message.reasoning,
    agentSteps: message.agentSteps,
    tools: message.toolEvents,
    attachments: message.attachments,
    modelProvider: message.role === 'assistant' ? (message.modelProvider || fallbackProvider) : '',
    model: message.role === 'assistant' ? (message.model || fallbackModel) : '',
    durationMs: message.durationMs,
    outputTokens: message.outputTokens,
    error: message.role === 'system',
  }))
}

export function NativeChatPage({ conversations, bots, skills, activeConversationId, resetToken, draftRequest, runtime, savedModelConfigurations, defaultModelConfiguration, defaultWorkspacePath, voiceRequest, speechLanguage, speechVoice, speechSpeed, browserSettings, onSend, onPickAttachments, onPickWorkspace, onSaveWorkspace, onDeleteMessage, onCancel, onClarify, onConversationChange, onOpenSettings, onNewConversation, onVoiceTurnCompleted, onVoiceTurnDelta, onVoiceTurnFailed }: NativeChatPageProps) {
  const display = useDisplaySettings()
  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeConversationId), [activeConversationId, conversations])
  const viewRunKey = chatRunKey('native', activeConversationId)
  const activeRun = useChatRun(viewRunKey)
  const conversationTitle = activeConversation?.title.trim() || '新对话'
  const [messages, setMessages] = useState<TranscriptItem[]>(() => transcript(activeConversation, defaultModelConfiguration))
  const [draft, setDraft] = useState('')
  const [pendingDraftSubmit, setPendingDraftSubmit] = useState('')
  const [modelProvider, setModelProvider] = useState<ModelProvider | ''>(() => (activeConversation?.modelProvider || (defaultModelConfiguration.model ? defaultModelConfiguration.provider : '')) as ModelProvider | '')
  const [model, setModel] = useState(() => activeConversation?.model || defaultModelConfiguration.model || '')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => activeConversation?.reasoningEffort || 'high')
  const [workspacePath, setWorkspacePath] = useState(() => activeConversation?.workspacePath || defaultWorkspacePath)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [usage, setUsage] = useState<ChatUsage | undefined>(() => activeConversation?.usage)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [officeArtifactPath, setOfficeArtifactPath] = useState('')
  const [browserOpen, setBrowserOpen] = useState(false)
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [canvasImportPath, setCanvasImportPath] = useState('')
  const [canvasImportRequestKey, setCanvasImportRequestKey] = useState(0)
  const [browserSessionId, setBrowserSessionId] = useState(() => activeConversationId || `native-browser-${crypto.randomUUID()}`)
  const [browserRequestedUrl, setBrowserRequestedUrl] = useState('')
  const [browserRequestKey, setBrowserRequestKey] = useState(0)
  const [loopPanelMessageId, setLoopPanelMessageId] = useState('')
  const [loopPanelOpen, setLoopPanelOpen] = useState(false)
  const [slashCommandIndex, setSlashCommandIndex] = useState(0)
  const requestRef = useRef('')
  const conversationIdRef = useRef(activeConversationId || '')
  const activeViewKeyRef = useRef(viewRunKey)
  const consumedVoiceRequestRef = useRef('')
  const consumedDraftRequestRef = useRef('')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const composerContainerRef = useRef<HTMLFormElement>(null)
  const { draggingFiles, dropHandlers } = useChatAttachmentDrop({
    disabled: !runtime.runnable,
    attachments,
    onAttachmentsChange: setAttachments,
    onError: setError,
  })
  const { onPaste: onPasteAttachments } = useChatAttachmentPaste({
    disabled: !runtime.runnable,
    attachments,
    workspacePath,
    onAttachmentsChange: setAttachments,
    onError: setError,
  })

  useEffect(() => {
    const preservingNewlyCreatedConversation = Boolean(activeConversationId && conversationIdRef.current === activeConversationId)
    const preservedRun = getChatRun(viewRunKey)
    activeViewKeyRef.current = viewRunKey
    requestRef.current = preservedRun?.sending ? preservedRun.requestId : ''
    setSending(Boolean(preservedRun?.sending))
    conversationIdRef.current = activeConversationId || ''
    setMessages(preservedRun?.messages || transcript(activeConversation, defaultModelConfiguration))
    setDraft('')
    setModelProvider((activeConversation?.modelProvider || (defaultModelConfiguration.model ? defaultModelConfiguration.provider : '')) as ModelProvider | '')
    setModel(activeConversation?.model || defaultModelConfiguration.model || '')
    setReasoningEffort(activeConversation?.reasoningEffort || 'high')
    setWorkspacePath(activeConversation?.workspacePath || defaultWorkspacePath)
    setUsage(preservedRun?.usage || activeConversation?.usage)
    setAttachments([])
    setError('')
    setOfficeArtifactPath('')
    setCanvasOpen(false)
    if (!preservingNewlyCreatedConversation) {
      setBrowserOpen(false)
      setBrowserSessionId(activeConversationId || `native-browser-${crypto.randomUUID()}`)
      setBrowserRequestedUrl('')
    }
    setLoopPanelMessageId('')
    setLoopPanelOpen(false)
  }, [activeConversationId, activeConversation?.updatedAt, resetToken, defaultModelConfiguration.model, defaultModelConfiguration.provider, defaultWorkspacePath, viewRunKey])

  useEffect(() => {
    if (activeRun) {
      setMessages(activeRun.messages)
      setUsage(activeRun.usage)
      setSending(activeRun.sending)
      setError(activeRun.error || '')
      requestRef.current = activeRun.sending ? activeRun.requestId : ''
      return
    }
    setMessages(transcript(activeConversation, defaultModelConfiguration))
    setUsage(activeConversation?.usage)
    setSending(false)
    requestRef.current = ''
  }, [activeRun, activeConversation, defaultModelConfiguration])

  useEffect(() => {
    if (!activeConversationId && !sending) {
      setModelProvider(defaultModelConfiguration.model ? defaultModelConfiguration.provider : '')
      setModel(defaultModelConfiguration.model || '')
    }
  }, [activeConversationId, defaultModelConfiguration.model, defaultModelConfiguration.provider, sending])

  const scrollToEnd = (force = false) => {
    const element = transcriptRef.current
    const nearBottom = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 180
    if (!force && !nearBottom) return
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const target = transcriptRef.current
      // 流式 token 会高频触发；反复启动 smooth 动画会让长会话持续做布局与动画合成。
      if (target) target.scrollTop = target.scrollHeight
    })
  }

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  useEffect(() => {
    // 打开会话时消息是异步加载的，表格/图片/文件预览还会继续把内容撑高，所以不能只滚一两次。
    // 另外容器 CSS 是 scroll-behavior: smooth，直接 scrollTo 会变成动画、每次重试都重启动画，
    // 长会话在固定窗口内根本滚不到底。这里临时切成瞬时滚动，边渲染边钉，
    // 直到内容高度连续稳定为止（最长 6 秒）；用户自己一动滚轮/键盘就立刻停手。
    const element = transcriptRef.current
    if (!element) return
    const previousBehavior = element.style.scrollBehavior
    element.style.scrollBehavior = 'auto'
    let cancelled = false
    let lastHeight = -1
    let stableTicks = 0
    const startedAt = Date.now()
    const pinToBottom = () => {
      if (cancelled) return
      const target = transcriptRef.current
      if (!target) return
      target.scrollTop = target.scrollHeight
      const height = target.scrollHeight
      stableTicks = height === lastHeight ? stableTicks + 1 : 0
      lastHeight = height
      if (stableTicks < 4 && Date.now() - startedAt < 6_000) window.setTimeout(pinToBottom, 80)
    }
    pinToBottom()
    const stop = () => {
      cancelled = true
      element.style.scrollBehavior = previousBehavior
    }
    element.addEventListener('wheel', stop, { passive: true })
    element.addEventListener('touchstart', stop, { passive: true })
    element.addEventListener('mousedown', stop)
    element.addEventListener('keydown', stop)
    return () => {
      cancelled = true
      element.style.scrollBehavior = previousBehavior
      element.removeEventListener('wheel', stop)
      element.removeEventListener('touchstart', stop)
      element.removeEventListener('mousedown', stop)
      element.removeEventListener('keydown', stop)
    }
  }, [activeConversationId, resetToken])

  const submit = async (event?: FormEvent, contentOverride?: string, voiceRequestId?: string, attachmentsOverride?: ChatAttachment[], workspaceOverride?: string, delegation?: { botId: string; botName: string; instruction: string }) => {
    event?.preventDefault()
    // 「/bot 名字 指令」：交给那个 Bot 执行，消息和回复都留在这个对话里
    if (!contentOverride && !attachmentsOverride && !attachments.length && !delegation) {
      const submission = resolveSlashSubmission(draft, slashCommands)
      if (submission?.kind === 'delegate') {
        if (!submission.instruction) {
          setError(`请在「/bot ${submission.botName}」后面接着写要交给它的指令。`)
          return
        }
        setDraft('')
        setError('')
        void submit(undefined, `@${submission.botName} ${submission.instruction}`, undefined, undefined, undefined, { botId: submission.botId, botName: submission.botName, instruction: submission.instruction })
        return
      }
      if (submission?.kind === 'insert') {
        setDraft(submission.text)
        setError('')
        focusComposer()
        return
      }
    }
    const selectedAttachments = attachmentsOverride ?? (contentOverride ? [] : attachments)
    const content = (contentOverride ?? draft).trim() || (selectedAttachments.length ? '请读取并处理这些附件。' : '')
    if (!content || !runtime.runnable) {
      if (voiceRequestId) onVoiceTurnFailed?.(voiceRequestId, runtime.message)
      return
    }
    const activeWorkspacePath = workspaceOverride || workspacePath
    if (!activeWorkspacePath) {
      const message = '请先为这个对话选择工作区文件夹。'
      setError(message)
      if (voiceRequestId) onVoiceTurnFailed?.(voiceRequestId, message)
      return
    }
    if (sending) {
      setError('')
      if (requestRef.current) {
        setDraft('')
        setAttachments([])
        try {
          await unwrapDesktop(window.zsenseDesktop!.chat.steer(requestRef.current, content, selectedAttachments, activeWorkspacePath))
        }
        catch (reason) {
          setDraft((current) => current ? `${contentOverride ?? draft}\n${current}` : (contentOverride ?? draft))
          setAttachments((current) => current.length ? [...selectedAttachments, ...current] : selectedAttachments)
          setError(`调整本轮失败：${errorMessage(reason)}`)
        }
      }
      return
    }
    const outgoingAttachments = selectedAttachments
    const requestId = voiceRequestId || crypto.randomUUID()
    const responseId = `native-assistant-${requestId}`
    const initialConversationId = conversationIdRef.current || activeConversationId
    let resolvedConversationId = initialConversationId || ''
    let currentRunKey = viewRunKey
    requestRef.current = requestId
    setDraft('')
    setAttachments([])
    setError('')
    setSending(true)
    const sentAt = new Date().toISOString()
    const initialMessages: TranscriptItem[] = [...messages, { id: `native-user-${requestId}`, role: 'user', content, createdAt: sentAt, attachments: outgoingAttachments }, { id: responseId, role: 'assistant', content: '', createdAt: sentAt, reasoning: '', agentSteps: [], tools: [], modelProvider, model, durationMs: null, outputTokens: null, status: delegation ? `正在把指令交给 ${delegation.botName}…` : '正在连接 ZSense Agent Core…', streaming: true, requestId, delegateBotName: delegation?.botName }]
    setChatRun(currentRunKey, { kind: 'native', requestId, conversationId: initialConversationId, messages: initialMessages, usage, sending: true })
    setMessages(initialMessages)
    scrollToEnd(true)

    // 逐 token 直接更新消息状态会让一次长回答触发上千次整表重渲染（还有滚动与 markdown 解析）。
    // 这里把 answer/reasoning 增量合并成约 60ms 一批再应用；其它事件到来前先落地，保证顺序不变。
    const answerDeltas = createStreamDeltaBuffer()
    const reasoningDeltas = createStreamDeltaBuffer()
    const flushStreamDeltas = () => { answerDeltas.flush(); reasoningDeltas.flush() }
    const applyStreamEvent = (streamEvent: ChatStreamEvent) => {
      if (streamEvent.conversationId && streamEvent.conversationId !== resolvedConversationId) {
        const previousKey = currentRunKey
        resolvedConversationId = streamEvent.conversationId
        currentRunKey = moveChatRun(previousKey, chatRunKey('native', resolvedConversationId), resolvedConversationId)
        if (activeViewKeyRef.current === previousKey) {
          activeViewKeyRef.current = currentRunKey
          conversationIdRef.current = resolvedConversationId
          onConversationChange(resolvedConversationId)
        }
      }
      if (streamEvent.type === 'agent-step' && streamEvent.phase === 'started' && activeViewKeyRef.current === currentRunKey) {
        setLoopPanelMessageId(responseId)
        setLoopPanelOpen(true)
      }
      updateChatRun(currentRunKey, (run) => ({ ...run, messages: (streamEvent.type === 'steering' && streamEvent.phase === 'queued' && streamEvent.source === 'user' ? insertSteeringTranscript(run.messages, responseId, streamEvent) : run.messages).map((item) => {
        if (item.id !== responseId) return item
        if (streamEvent.type === 'agent-step') return { ...item, agentSteps: mergeAgentLoopEvent(item.agentSteps || [], streamEvent), content: streamEvent.phase === 'started' && streamEvent.step > 1 ? '' : item.content, status: streamEvent.phase === 'started' ? `Agent 正在执行第 ${streamEvent.step} 轮…` : item.status }
        if (streamEvent.type === 'answer') return display.streamingResponse ? { ...item, content: `${item.content}${streamEvent.delta}`, agentSteps: mergeAgentLoopEvent(item.agentSteps || [], streamEvent), status: '正在生成回答…' } : { ...item, agentSteps: mergeAgentLoopEvent(item.agentSteps || [], streamEvent), status: '正在生成完整回答…' }
        if (streamEvent.type === 'reasoning') return display.streamingResponse ? { ...item, reasoning: streamEvent.replace ? streamEvent.delta : `${item.reasoning || ''}${streamEvent.delta}`, agentSteps: mergeAgentLoopEvent(item.agentSteps || [], streamEvent), status: streamEvent.summary ? '已生成推理摘要' : '正在推理…' } : { ...item, agentSteps: mergeAgentLoopEvent(item.agentSteps || [], streamEvent), status: 'ZSense 正在推理…' }
        if (streamEvent.type === 'status') return { ...item, status: streamEvent.message || item.status }
        if (streamEvent.type === 'agent-state') return { ...item, status: streamEvent.phase === 'tools' ? '正在执行工具…' : streamEvent.phase === 'steering' ? '已接收追加指令，正在重新规划…' : item.status }
        if (streamEvent.type === 'steering') return { ...item, status: streamEvent.phase === 'queued' ? (streamEvent.intent === 'adjust' ? '已接收调整，正在重新规划…' : '已接收补充，当前步骤结束后应用…') : '调整已应用，正在继续处理…' }
        if (streamEvent.type === 'clarify') return { ...item, clarification: streamEvent.clarification, clarificationExpired: false, status: '正在等待你的选择…' }
        if (streamEvent.type === 'clarify-expired' && item.clarification?.requestId === streamEvent.clarificationRequestId) return { ...item, clarificationExpired: true, status: '选择已超时，ZSense 正在继续处理…' }
        if (streamEvent.type === 'tool') {
          const tools = mergeChatToolEvent(item.tools || [], streamEvent)
          const agentSteps = mergeAgentLoopEvent(item.agentSteps || [], streamEvent)
          const clarificationFinished = streamEvent.name === 'clarify' && streamEvent.status !== 'running'
          return { ...item, tools, agentSteps, ...(clarificationFinished ? { clarification: undefined, clarificationExpired: false } : {}), status: streamEvent.status === 'running' ? (`正在使用 ${streamEvent.name}…`) : clarificationFinished ? 'ZSense 正在继续处理…' : item.status }
        }
        if (streamEvent.type === 'error') return streamEvent.message === '已停止生成。'
          ? { ...item, status: '已被追加指令打断', streaming: false, clarification: undefined }
          : { ...item, content: streamEvent.message, status: '', streaming: false, error: true, clarification: undefined }
        if (streamEvent.type === 'done') return { ...item, content: streamEvent.content || item.content, reasoning: streamEvent.reasoning || item.reasoning, agentSteps: streamEvent.agentSteps || item.agentSteps, status: '', streaming: false, clarification: undefined }
        return item
      }), ...((streamEvent.type === 'usage' || (streamEvent.type === 'done' && streamEvent.usage)) ? { usage: streamEvent.usage } : {}) }))
      if (activeViewKeyRef.current === currentRunKey) scrollToEnd()
    }
    const onStreamEvent = (streamEvent: ChatStreamEvent) => {
      if (voiceRequestId && streamEvent.type === 'answer') onVoiceTurnDelta?.(voiceRequestId, streamEvent.delta)
      if (streamEvent.type === 'answer' && streamEvent.delta && display.streamingResponse) {
        answerDeltas.push(streamEvent.delta, (delta) => applyStreamEvent({ ...streamEvent, delta }), currentRunKey)
        return
      }
      if (streamEvent.type === 'reasoning' && streamEvent.delta && !streamEvent.replace && display.streamingResponse) {
        reasoningDeltas.push(streamEvent.delta, (delta) => applyStreamEvent({ ...streamEvent, delta }), currentRunKey)
        return
      }
      flushStreamDeltas()
      applyStreamEvent(streamEvent)
    }

    try {
      const result = await onSend(content, initialConversationId, requestId, { attachments: outgoingAttachments, modelProvider: delegation ? undefined : modelProvider || undefined, model: delegation ? undefined : model || undefined, reasoningEffort, interactionMode: voiceRequestId ? 'voice' : 'text', workspacePath: activeWorkspacePath, browserSessionId, delegateBotId: delegation?.botId }, onStreamEvent)
      if (result.conversationId !== resolvedConversationId) {
        const previousKey = currentRunKey
        resolvedConversationId = result.conversationId
        currentRunKey = moveChatRun(previousKey, chatRunKey('native', result.conversationId), result.conversationId)
        if (activeViewKeyRef.current === previousKey) {
          activeViewKeyRef.current = currentRunKey
          conversationIdRef.current = result.conversationId
          onConversationChange(result.conversationId)
        }
      }
      updateChatRun(currentRunKey, (run) => ({ ...run, usage: result.usage || run.usage, messages: run.messages.map((item) => item.id === responseId ? { ...item, content: result.message || item.content, agentSteps: result.agentSteps || item.agentSteps, attachments: result.attachments, modelProvider: result.modelProvider, model: result.model, durationMs: result.durationMs, outputTokens: result.usage?.outputTokens ?? null, status: '', streaming: false } : item) }))
      if (voiceRequestId) void onVoiceTurnCompleted?.(voiceRequestId, result.message)
    } catch (reason) {
      const message = errorMessage(reason)
      updateChatRun(currentRunKey, (run) => ({ ...run, error: message === '已停止生成。' ? '' : message, messages: message === '已停止生成。'
        ? run.messages.filter((item) => item.id !== responseId || Boolean(item.content || item.reasoning || item.agentSteps?.length || item.tools?.length)).map((item) => item.id === responseId ? { ...item, streaming: false, status: '已停止', clarification: undefined } : item)
        : run.messages.map((item) => item.id === responseId ? { ...item, content: item.content || message, streaming: false, status: '', error: true, clarification: undefined } : item) }))
      if (voiceRequestId) onVoiceTurnFailed?.(voiceRequestId, message)
    } finally {
      flushStreamDeltas()
      answerDeltas.dispose()
      reasoningDeltas.dispose()
      updateChatRun(currentRunKey, (run) => ({ ...run, sending: false }))
      if (activeViewKeyRef.current === currentRunKey) {
        requestRef.current = ''
        setSending(false)
        scrollToEnd()
      }
      window.setTimeout(() => removeChatRun(currentRunKey, requestId), 1_500)
    }
  }

  useEffect(() => {
    if (!draftRequest || consumedDraftRequestRef.current === draftRequest.id) return
    consumedDraftRequestRef.current = draftRequest.id
    setDraft(draftRequest.text)
    if (draftRequest.submit) setPendingDraftSubmit(draftRequest.text)
    window.requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(draftRequest.text.length, draftRequest.text.length)
    })
  }, [draftRequest])

  useEffect(() => {
    if (!pendingDraftSubmit) return
    const text = pendingDraftSubmit
    setPendingDraftSubmit('')
    void submit(undefined, text)
  }, [pendingDraftSubmit])

  useEffect(() => {
    if (!voiceRequest || consumedVoiceRequestRef.current === voiceRequest.id) return
    consumedVoiceRequestRef.current = voiceRequest.id
    void submit(undefined, voiceRequest.text, voiceRequest.id)
  }, [voiceRequest?.id])

  const slashCommands = useMemo<SlashCommandItem[]>(() => {
    const applicationCommands: SlashCommandItem[] = [
    { id: 'new', command: 'new', title: '新对话', description: '新建一个独立 AI 对话', keywords: '新建 清空 conversation', run: onNewConversation },
    { id: 'settings', command: 'settings', title: '打开设置', description: '进入 ZSense 设置页面', keywords: '设置 preferences', run: onOpenSettings },
    { id: 'browser', command: 'browser', title: '打开浏览器', description: '在右侧打开会话浏览器', keywords: '网页 web', run: () => { setOfficeArtifactPath(''); setCanvasOpen(false); setBrowserOpen(true) } },
    { id: 'canvas', command: 'canvas', title: '打开画布', description: '在右侧打开 ZSense 画布', keywords: '画布 canvas', run: () => { if (!workspacePath) return setError('请先为这个对话选择工作区文件夹。'); setBrowserOpen(false); setOfficeArtifactPath(''); setCanvasOpen(true) } },
    { id: 'clear', command: 'clear', title: '清空输入', description: '清空当前草稿和未发送附件', keywords: '清除 draft', run: () => { setDraft(''); setAttachments([]); setError('') } },
    { id: 'skills', command: 'skills', title: '浏览技能目录', description: '搜索并选择当前可用技能', keywords: '技能 skill catalog', run: () => setDraft('/skill ') },
    { id: 'help', command: 'help', title: '查看快捷指令', description: '重新显示全部斜杠命令', keywords: '帮助 commands', run: () => setDraft('/') },
    ]
    return createSlashCommandCatalog({ applicationCommands, bots, skills: skills.filter((skill) => skill.enabled), setDraft })
  }, [bots, onNewConversation, onOpenSettings, skills, workspacePath])
  const visibleSlashCommands = matchingSlashCommands(draft, slashCommands)
  // 「/bot 名字 指令」的回复：显示成那个 Bot 回的（内存标记优先，其次看「@名字 」标记，刷新后也一致）
  const delegatedAuthorByMessageId = useMemo(() => {
    const names = bots.map((item) => item.name)
    const map = new Map<string, string>()
    messages.forEach((message, index) => {
      if (message.role !== 'assistant') return
      const name = message.delegateBotName || delegatedBotNameFor(messages, index, names)
      if (name) map.set(message.id, name)
    })
    return map
  }, [bots, messages])

  // 二级菜单（/bot 名字）时要知道当前在哪个分类下，用于提示与显示
  const activeSlashGroup = slashCommands.find((item) => item.argument && draft.toLowerCase().startsWith(`/${item.command.toLowerCase()} `)) || null

  useEffect(() => setSlashCommandIndex(0), [draft])

  const focusComposer = () => window.requestAnimationFrame(() => composerRef.current?.focus())

  const executeSlashCommand = (command = visibleSlashCommands[slashCommandIndex]) => {
    if (!command) return
    if (command.argument) {
      setDraft(`/${command.command} `)
      setSlashCommandIndex(0)
      focusComposer()
      return
    }
    const parent = findSlashParent(slashCommands, command)
    if (parent?.command === 'bot') {
      setDraft(`/bot ${command.command} `)
      setSlashCommandIndex(0)
      focusComposer()
      return
    }
    setDraft(command.insertText || '')
    if (!command.insertText) void command.run?.()
    focusComposer()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (visibleSlashCommands.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setSlashCommandIndex((current) => (current + direction + visibleSlashCommands.length) % visibleSlashCommands.length)
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); setDraft(''); return }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        executeSlashCommand()
        return
      }
    }
    const nativeEvent = event.nativeEvent
    if (event.key === 'Enter' && !event.shiftKey && !nativeEvent.isComposing && nativeEvent.keyCode !== 229) {
      event.preventDefault()
      void submit()
    }
  }

  const submitComposer = (event: FormEvent) => {
    if (visibleSlashCommands.length) {
      event.preventDefault()
      executeSlashCommand()
      return
    }
    void submit(event)
  }

  const cancel = async () => {
    if (!requestRef.current) return
    const markStopping = (current: TranscriptItem[]) => current.map((item) => item.streaming ? { ...item, status: '正在停止…' } : item)
    setMessages(markStopping)
    updateChatRun(activeViewKeyRef.current, (run) => ({ ...run, messages: markStopping(run.messages) }))
    await onCancel(requestRef.current)
  }

  const quoteMessage = (message: TranscriptItem) => {
    const quote = createChatQuote('ZSense Agent', message.createdAt, message.content)
    const nextDraft = `${draft.trimEnd()}${draft.trim() ? '\n\n' : ''}${quote}\n\n`
    setDraft(nextDraft)
    window.requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(nextDraft.length, nextDraft.length)
    })
  }

  const regenerateMessage = (assistantIndex: number) => {
    const sourceMessage = messages.slice(0, assistantIndex).reverse().find((item) => item.role === 'user')
    if (!sourceMessage) {
      setError('没有找到这条回复对应的用户问题。')
      return
    }
    void submit(undefined, sourceMessage.content, undefined, sourceMessage.attachments || [])
  }

  const deleteMessage = async (messageId: string) => {
    const currentConversationId = conversationIdRef.current || activeConversationId
    if (!currentConversationId) throw new Error('当前消息尚未保存到会话。')
    await onDeleteMessage(currentConversationId, messageId)
    const withoutMessage = (current: TranscriptItem[]) => current.filter((item) => item.id !== messageId)
    setMessages(withoutMessage)
    updateChatRun(activeViewKeyRef.current, (run) => ({ ...run, messages: withoutMessage(run.messages) }))
    if (loopPanelMessageId === messageId) {
      setLoopPanelMessageId('')
      setLoopPanelOpen(false)
    }
  }

  const askAIAboutOfficeSelection = (prompt: string, behavior: 'send' | 'insert') => {
    if (behavior === 'send') {
      void submit(undefined, prompt)
      return
    }
    setDraft((current) => `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${prompt}`)
    window.requestAnimationFrame(() => {
      composerRef.current?.focus()
      const length = composerRef.current?.value.length || 0
      composerRef.current?.setSelectionRange(length, length)
    })
  }

  const handleAnnotatedScreenshot = async (attachment: ChatAttachment, requirement: string, sendImmediately: boolean) => {
    const prompt = requirement.trim() || '请查看这张带批注的截图，并根据批注内容处理。'
    if (sendImmediately) {
      void submit(undefined, prompt, undefined, [attachment])
      return
    }
    try {
      setAttachments(mergeChatAttachments(attachments, [attachment]))
      if (requirement.trim()) setDraft((current) => `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${requirement.trim()}`)
      setError('')
      window.requestAnimationFrame(() => composerRef.current?.focus())
    } catch (reason) { setError(errorMessage(reason)) }
  }

  const loopPanelMessage = messages.find((item) => item.id === loopPanelMessageId)

  const openCanvas = useCallback((filePath = '') => {
    if (!workspacePath) { setError('请先为这个对话选择工作区文件夹。'); return }
    setBrowserOpen(false)
    setOfficeArtifactPath('')
    setCanvasImportPath(filePath)
    if (filePath) setCanvasImportRequestKey((current) => current + 1)
    setCanvasOpen(true)
  }, [workspacePath])

  const openOfficeArtifact = useCallback(async (filePath: string) => {
    if (isCanvasDocumentPath(filePath)) { openCanvas(filePath); return }
    setBrowserOpen(false)
    setCanvasOpen(false)
    setOfficeArtifactPath(filePath)
  }, [openCanvas])

  const openBrowserUrl = useCallback((url?: string) => {
    if (!browserSettings.browserEnabled) { setError('内置浏览器已关闭，可在设置 → 浏览器中重新开启。'); return }
    if (url) {
      let isLocal = false
      try { isLocal = ['localhost', 'localhost.localdomain', '127.0.0.1', '::1'].includes(new URL(url).hostname.toLowerCase()) } catch { /* Search text stays in ZSense. */ }
      const destination = isLocal ? browserSettings.browserLocalUrlTarget : browserSettings.browserWebLinkTarget
      if (destination === 'system' && /^https?:\/\//i.test(url) && window.zsenseDesktop?.browser) {
        void unwrapDesktop(window.zsenseDesktop.browser.openExternal(url)).catch((reason) => setError(errorMessage(reason)))
        return
      }
    }
    setOfficeArtifactPath('')
    setCanvasOpen(false)
    if (url) {
      setBrowserRequestedUrl(url)
      setBrowserRequestKey((current) => current + 1)
    }
    setBrowserOpen(true)
  }, [browserSettings])

  const hideBrowser = useCallback(() => setBrowserOpen(false), [])
  const closeBrowser = useCallback(async () => {
    try {
      if (window.zsenseDesktop?.browser) await unwrapDesktop(window.zsenseDesktop.browser.close(browserSessionId))
    } catch (reason) { setError(`关闭浏览器失败：${errorMessage(reason)}`) }
    finally { setBrowserOpen(false) }
  }, [browserSessionId])

  // 内存优化：长会话只渲染最近 120 条，避免上万 DOM 节点与整段 Markdown 常驻。
  // 索引语义保持不变：index 仍是 visibleMessages 内的相对位置，需要绝对位置的两处手动加偏移。
  const VISIBLE_MESSAGE_LIMIT = 120
  const hiddenMessageCount = Math.max(0, messages.length - VISIBLE_MESSAGE_LIMIT)
  const visibleMessages = hiddenMessageCount ? messages.slice(hiddenMessageCount) : messages
  // 一次算好「第一条用户消息」的位置：原来每条消息都要 slice 一整份数组，消息多时是 O(N²)，打字会卡。
  const firstUserIndex = useMemo(() => messages.findIndex((item) => item.role === 'user'), [messages])
  // 被裁掉的窗口外用户消息数：导航据此显示对得上号的轮次编号。
  const hiddenRoundCount = useMemo(() => (hiddenMessageCount ? messages.slice(0, hiddenMessageCount).filter((item) => item.role === 'user').length : 0), [messages, hiddenMessageCount])
  const pendingClarificationMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].clarification && messages[index].streaming) return messages[index]
    }
    return undefined
  }, [messages])

  return (
    <div className="page native-chat-page">
      <div className={`native-chat-layout ${officeArtifactPath ? 'has-office-artifact' : canvasOpen ? 'has-zsense-canvas' : browserOpen ? 'has-browser-workspace' : ''}`}>
        <section className={`panel native-chat-main ${draggingFiles ? 'is-file-dragging' : ''}`} {...dropHandlers}>
          {draggingFiles && <div className="chat-drop-overlay" aria-hidden="true"><strong>松开即可添加附件</strong><span>文件会在发送时安全复制到当前会话工作区</span></div>}
          <header><span className="native-chat-avatar"><Sparkles size={19} /></span><span className="native-chat-title"><strong title={conversationTitle}>{conversationTitle}</strong></span><span className="chat-header-actions"><button type="button" className={`icon-button chat-canvas-toggle ${canvasOpen ? 'active' : ''}`} onClick={() => canvasOpen ? setCanvasOpen(false) : openCanvas()} aria-label={canvasOpen ? '关闭 ZSense 画布' : '打开 ZSense 画布'} title={canvasOpen ? '关闭 ZSense 画布' : '打开 ZSense 画布'} aria-pressed={canvasOpen}><Paintbrush size={17} /></button><button type="button" className={`icon-button chat-browser-toggle ${browserOpen ? 'active' : ''}`} onClick={() => browserOpen ? void closeBrowser() : openBrowserUrl()} aria-label={browserOpen ? '关闭会话浏览器' : '打开会话浏览器'} title={browserOpen ? '关闭浏览器' : '打开会话浏览器'} aria-pressed={browserOpen}><Globe2 size={17} /></button><ConversationIdButton conversationId={activeConversationId} onError={setError} /></span></header>
          <div className={`chat-transcript-stage ${loopPanelOpen && loopPanelMessage ? 'has-agent-loop-panel' : ''}`}>
          <div className="native-chat-transcript" ref={transcriptRef} aria-live="polite">
            {!runtime.runnable ? <div className="chat-runtime-blocked"><span><AlertTriangle size={24} /></span><strong>ZSense Agent Core 尚未就绪</strong><p>{runtime.message}</p><button className="button primary" onClick={onOpenSettings}><Settings2 size={16} />前往核心服务设置</button></div> : !messages.length ? <div className="chat-welcome"><span className="chat-welcome-icon"><Sparkles size={25} /></span><strong>开始一次 AI 对话</strong><p>这里使用全局模型、共享技能和独立长期记忆；每次提问都会读取 ZSense 当前的 Bot 与网关状态，所有处理都在 ZSense 自己的隔离空间完成。</p><div><button onClick={() => setDraft('介绍一下你能为我做什么。')}>了解能力</button><button onClick={() => setDraft('当前 ZSense 一共有几个 Bot？请列出名称和状态。')}>查看当前 Bot</button></div></div> : <div className="chat-transcript-layout"><ConversationJumpNav messages={visibleMessages} anchorPrefix="native" roundOffset={hiddenRoundCount} /><div className="chat-message-list">{visibleMessages.map((message, index) => <article id={conversationMessageAnchor('native', message.id)} data-message-id={message.id} tabIndex={-1} className={`chat-message ${message.role} ${message.streaming ? 'streaming' : ''} ${message.error ? 'error' : ''}`} key={message.id}><span>{message.role === 'user' ? '你' : message.role === 'system' ? '!' : 'AI'}</span><div>{message.role === 'assistant' ? <div className="chat-message-author"><small>{delegatedAuthorByMessageId.get(message.id) ? `${delegatedAuthorByMessageId.get(message.id)}（/bot 指令）` : 'ZSense Agent'}</small><AgentLoopTrigger source={message} onClick={() => { setLoopPanelMessageId(message.id); setLoopPanelOpen(true) }} /></div> : <small>{message.role === 'user' ? '你' : '会话错误'}</small>}<ChatMessageAttachments attachments={message.attachments} workspacePath={workspacePath} onOpenAttachment={openOfficeArtifact} />{message.clarification && <div className="chat-clarification-placeholder" role="status">{message.clarificationExpired ? '选择已超时' : '正在等待你的选择，请在输入框上方回答。'}</div>}{message.content && (message.error ? <div className="chat-inline-error" role="alert"><AlertTriangle size={15} /><span>{message.content}</span></div> : <MarkdownMessage content={message.content} workspacePath={workspacePath} onOpenOfficeFile={openOfficeArtifact} onOpenBrowserUrl={openBrowserUrl} />)}{message.streaming && !message.clarification && <div className="chat-stream-status"><LoaderCircle className="spin" size={14} />{message.status || 'ZSense Agent Core 正在处理…'}</div>}<ChatMessageMeta messageId={message.id} content={message.content} createdAt={message.createdAt} modelProvider={message.role === 'assistant' ? message.modelProvider : ''} model={message.role === 'assistant' ? message.model : ''} showModel={message.role === 'assistant'} durationMs={message.role === 'assistant' ? message.durationMs : null} outputTokens={message.role === 'assistant' ? message.outputTokens : null} copyDescription={message.role === 'user' ? '你的消息' : message.role === 'assistant' ? 'ZSense Agent 的回复' : '会话错误'} quoteDescription={message.role === 'assistant' ? '引用 ZSense Agent 的回复' : undefined} quoteDisabled={sending} speechLanguage={speechLanguage} speechVoice={speechVoice} speechSpeed={speechSpeed} onQuote={message.role === 'assistant' ? () => quoteMessage(message) : undefined} onRegenerate={message.role === 'assistant' && firstUserIndex >= 0 && firstUserIndex < index + hiddenMessageCount ? () => regenerateMessage(index + hiddenMessageCount) : undefined} regenerateDisabled={sending || message.streaming} onDelete={() => deleteMessage(message.id)} deleteDisabled={sending || Boolean(message.streaming) || /^(native|local)-(user|assistant)-/.test(message.id)} deleteDescription={message.role === 'user' ? '你的消息' : message.role === 'assistant' ? '这条 AI 回复' : '这条会话错误'} onError={setError} /></div></article>)}</div></div>}
          </div>
          <ChatScrollToBottomButton scrollRef={transcriptRef} sidePanelOpen={loopPanelOpen && Boolean(loopPanelMessage)} />
          <AgentLoopPanel source={loopPanelMessage} open={loopPanelOpen} showReasoning={display.showReasoning} onClose={() => setLoopPanelOpen(false)} />
          </div>
          {pendingClarificationMessage?.clarification && <div className="chat-clarification-dock" role="region" aria-label="当前待回答的选择"><ChatClarificationCard key={pendingClarificationMessage.clarification.requestId} clarification={pendingClarificationMessage.clarification} expired={pendingClarificationMessage.clarificationExpired} onRespond={(answers) => onClarify(pendingClarificationMessage.requestId || requestRef.current, pendingClarificationMessage.clarification!.requestId, answers)} /></div>}
          {error && <div className="chat-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
          <form ref={composerContainerRef} className="chat-composer native unified-composer" onSubmit={submitComposer}>
            <ChatComposerResizeHandle composerRef={composerContainerRef} transcriptRef={transcriptRef} resetKey={`${activeConversationId || 'new'}:${resetToken}`} />
            <SlashCommandMenu commands={visibleSlashCommands} selectedIndex={slashCommandIndex} onSelect={executeSlashCommand} prefix={activeSlashGroup?.command || ''} hint={activeSlashGroup?.argument?.hint} />
            <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} onPaste={onPasteAttachments} aria-label="向 ZSense Agent 输入消息" placeholder={!runtime.runnable ? 'ZSense Agent Core 尚未就绪' : sending ? '输入调整要求，Enter 提交到当前轮…' : workspacePath ? '直接向 AI 发送消息…（Enter 发送，Shift + Enter 换行，可直接粘贴图片）' : '请先选择会话工作区'} rows={4} disabled={!runtime.runnable} />
            <ChatComposerToolbar
              layout="composer"
              attachments={attachments}
              usage={usage}
              savedModelConfigurations={savedModelConfigurations}
              selectedModelProvider={modelProvider}
              selectedModel={model}
              reasoningEffort={reasoningEffort}
              workspacePath={workspacePath}
              disabled={!runtime.runnable || sending}
              attachmentDisabled={!runtime.runnable}
              onPickAttachments={onPickAttachments}
              onPickWorkspace={onPickWorkspace}
              onAttachmentsChange={setAttachments}
              onWorkspaceChange={async (nextWorkspacePath) => {
                if (activeConversationId) await onSaveWorkspace(activeConversationId, nextWorkspacePath)
                setWorkspacePath(nextWorkspacePath)
                setError('')
              }}
              onModelChange={(provider, nextModel) => { setModelProvider(provider); setModel(nextModel) }}
              onReasoningEffortChange={setReasoningEffort}
                            onError={setError}
              onOpenAttachment={openOfficeArtifact}
            />
            <div className="chat-composer-footer"><small>{sending ? '调整要求将作用于当前轮次' : '输入 / 使用快捷指令 · Enter 发送 · Shift + Enter 换行'}</small><span className="chat-send-actions">{sending && <button className="chat-send stop" type="button" onClick={() => void cancel()} aria-label="停止当前轮次"><Square size={14} /></button>}<button className={`chat-send ${sending ? 'steer' : ''}`} type="submit" disabled={(!draft.trim() && !attachments.length) || !runtime.runnable || !workspacePath} aria-label={sending ? '调整本轮' : '发送消息'} title={sending ? '调整本轮' : '发送消息'}><ArrowUp size={18} /></button></span></div>
          </form>
        </section>
        {officeArtifactPath && <OfficeArtifactPane filePath={officeArtifactPath} workspacePath={workspacePath} onClose={() => setOfficeArtifactPath('')} onAskAI={askAIAboutOfficeSelection} onAnnotatedScreenshot={handleAnnotatedScreenshot} />}
        {canvasOpen && <ZSenseCanvasPane workspacePath={workspacePath} conversationId={activeConversationId || browserSessionId} importPath={canvasImportPath} importRequestKey={canvasImportRequestKey} onClose={() => setCanvasOpen(false)} onAskAI={askAIAboutOfficeSelection} onAnnotatedScreenshot={handleAnnotatedScreenshot} />}
        <BrowserWorkspacePane key={browserSessionId} sessionId={browserSessionId} visible={browserOpen && !officeArtifactPath && !canvasOpen} requestedUrl={browserRequestedUrl} requestKey={browserRequestKey} showFullUrl={browserSettings.browserShowFullUrl} workspacePath={workspacePath} onOpen={openBrowserUrl} onClose={hideBrowser} onAnnotatedScreenshot={handleAnnotatedScreenshot} />
      </div>
    </div>
  )
}
