import { Check, Clock3, Copy, Cpu, Gauge, GitBranch, Quote, RefreshCw, Square, Timer, Trash2, Volume2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { writeTextToClipboard } from '../services/clipboard'
import { errorMessage } from '../services/desktop'
import { speakLocalAudio, stopLocalSpeech } from '../services/local-speech'
import type { ModelProvider } from '../types'

interface ChatMessageMetaProps {
  messageId: string
  content: string
  createdAt: string
  modelProvider?: ModelProvider | ''
  model?: string
  showModel?: boolean
  durationMs?: number | null
  outputTokens?: number | null
  copyDescription: string
  quoteDescription?: string
  quoteDisabled?: boolean
  speechLanguage?: 'auto' | 'zh-CN' | 'en-US'
  speechVoice?: string
  speechSpeed?: number
  onQuote?: () => void
  onRegenerate?: () => void
  regenerateDisabled?: boolean
  onBranch?: () => Promise<void>
  branchDisabled?: boolean
  onDelete?: () => Promise<void>
  deleteDisabled?: boolean
  deleteDescription?: string
  onError: (message: string) => void
}

function formatResponseDuration(value: number) {
  if (value < 1_000) return `${Math.max(0, Math.round(value))} 毫秒`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1_000)} 秒`
}

export function formatTokenSpeed(outputTokens: number, durationMs: number) {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(durationMs) || outputTokens <= 0 || durationMs <= 0) return ''
  const speed = outputTokens / (durationMs / 1_000)
  return speed >= 100 ? speed.toFixed(0) : speed >= 10 ? speed.toFixed(1) : speed.toFixed(2)
}

function normalizedMessageDate(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const chatTimestampFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export function formatChatMessageTimestamp(value: string) {
  const date = normalizedMessageDate(value)
  if (!date) return value || '时间未知'
  const parts = chatTimestampFormatter.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}

export function createChatQuote(source: string, createdAt: string, content: string) {
  const trimmedContent = content.trim()
  const clippedContent = trimmedContent.length > 1200 ? `${trimmedContent.slice(0, 1200).trimEnd()}…` : trimmedContent
  const quoteLines = clippedContent.split('\n').map((line) => `> ${line}`).join('\n')
  return `> 引用 ${source} · ${formatChatMessageTimestamp(createdAt)}\n${quoteLines}`
}

export function ChatMessageMeta({ messageId, content, createdAt, model = '', showModel = false, durationMs = null, outputTokens = null, copyDescription, quoteDescription, quoteDisabled = false, speechLanguage = 'auto', speechVoice = 'melo-zh', speechSpeed = 1, onQuote, onRegenerate, regenerateDisabled = false, onBranch, branchDisabled = false, onDelete, deleteDisabled = false, deleteDescription = '这条消息', onError }: ChatMessageMetaProps) {
  const [copied, setCopied] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [branching, setBranching] = useState(false)
  const branchInFlightRef = useRef(false)
  const copyFeedbackTimerRef = useRef<number>()

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current) window.clearTimeout(copyFeedbackTimerRef.current)
  }, [])

  useEffect(() => () => {
    if (speaking) void stopLocalSpeech().catch(() => undefined)
  }, [speaking])

  const timestamp = formatChatMessageTimestamp(createdAt)
  const dateTime = normalizedMessageDate(createdAt)?.toISOString()
  const modelLabel = model || (showModel ? '模型未记录' : '')
  const tokenSpeed = outputTokens != null && durationMs != null ? formatTokenSpeed(outputTokens, durationMs) : ''

  const branchMessage = async () => {
    if (!onBranch || branchDisabled || branchInFlightRef.current) return
    branchInFlightRef.current = true
    setBranching(true)
    try { await onBranch() }
    catch (reason) { onError(`创建分支失败：${errorMessage(reason)}`) }
    finally {
      branchInFlightRef.current = false
      setBranching(false)
    }
  }

  const copyMessage = async () => {
    try {
      await writeTextToClipboard(content)
      setCopied(true)
      if (copyFeedbackTimerRef.current) window.clearTimeout(copyFeedbackTimerRef.current)
      copyFeedbackTimerRef.current = window.setTimeout(() => setCopied(false), 1800)
    } catch (reason) {
      onError(`复制失败：${errorMessage(reason)}`)
    }
  }

  const toggleSpeech = async () => {
    if (!window.zsenseDesktop?.voice) {
      onError('语音播报只能在 ZSense 桌面端中使用。')
      return
    }
    if (speaking) {
      try { await stopLocalSpeech() }
      catch (reason) { onError(`停止播报失败：${errorMessage(reason)}`) }
      finally { setSpeaking(false) }
      return
    }
    setSpeaking(true)
    try {
      const result = await speakLocalAudio({ text: content, language: speechLanguage, voice: speechVoice, speed: speechSpeed })
      if (!result.played && !result.cancelled) throw new Error('本地音频没有完成播放。')
    } catch (reason) {
      onError(`语音播报失败：${errorMessage(reason)}`)
    } finally {
      setSpeaking(false)
    }
  }

  const deleteMessage = async () => {
    if (!onDelete || deleting) return
    setDeleting(true)
    try {
      await onDelete()
      setDeleteOpen(false)
    } catch (reason) {
      onError(`删除消息失败：${errorMessage(reason)}`)
    } finally {
      setDeleting(false)
    }
  }

  return <>
    <footer className="chat-message-meta" data-message-id={messageId}>
      <span className="chat-message-facts">
        <time dateTime={dateTime}><Clock3 size={12} aria-hidden="true" />{timestamp}</time>
        {modelLabel && <span className="chat-message-model" title={modelLabel}><Cpu size={12} aria-hidden="true" /><span className="chat-message-model-name">{modelLabel}</span></span>}
        {durationMs != null && <span><Timer size={12} aria-hidden="true" />耗时 {formatResponseDuration(durationMs)}</span>}
        {showModel && <span title={tokenSpeed ? `输出 ${outputTokens} tokens ÷ ${formatResponseDuration(durationMs || 0)}` : '旧消息没有保存输出 Token 数，无法计算生成速度'}><Gauge size={12} aria-hidden="true" />{tokenSpeed ? `${tokenSpeed} tokens/秒` : '速度未记录'}</span>}
      </span>
      <span className="chat-message-actions">
        {onBranch && <button type="button" onClick={() => void branchMessage()} disabled={branchDisabled || branching} aria-busy={branching || undefined} aria-label={branching ? '正在创建分支聊天' : '分支到新聊天'} title={branching ? '正在创建分支聊天…' : '分支到新聊天'}><GitBranch size={13} aria-hidden="true" /><span>{branching ? '正在创建…' : '分支到新聊天'}</span></button>}
        {onRegenerate && <button type="button" onClick={onRegenerate} disabled={regenerateDisabled} aria-label="再次提交对应问题并生成新回复" title="重新提交对应问题"><RefreshCw size={13} aria-hidden="true" /><span>再次提交</span></button>}
        {showModel && <button type="button" className={speaking ? 'speaking' : ''} onClick={() => void toggleSpeech()} aria-label={speaking ? '停止播报这条 AI 回复' : '播报这条 AI 回复'} title={speaking ? '停止播报' : '播报这条回复'} aria-pressed={speaking}>
          {speaking ? <Square size={12} aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
          <span aria-live="polite">{speaking ? '停止播报' : '播报'}</span>
        </button>}
        <button type="button" className={copied ? 'copied' : ''} onClick={() => void copyMessage()} aria-label={`复制${copyDescription}`} title={`复制${copyDescription}`}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span aria-live="polite">{copied ? '已复制' : '复制'}</span>
        </button>
        {onDelete && <button type="button" className="delete-message" onClick={() => setDeleteOpen(true)} disabled={deleteDisabled || deleting} aria-label={`删除${deleteDescription}`} title={`删除${deleteDescription}`}><Trash2 size={13} aria-hidden="true" /><span>删除</span></button>}
        {onQuote && <button type="button" onClick={onQuote} disabled={quoteDisabled} aria-label={quoteDescription || '引用 AI 回复'} title={quoteDescription || '引用 AI 回复'}><Quote size={13} aria-hidden="true" /><span>引用</span></button>}
      </span>
    </footer>
    {deleteOpen && createPortal(<div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !deleting && setDeleteOpen(false)}>
      <div className="confirm-dialog chat-message-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`delete-message-${messageId}`} aria-describedby={`delete-message-description-${messageId}`}>
        <span className="confirm-icon"><Trash2 size={22} /></span>
        <h2 id={`delete-message-${messageId}`}>删除{deleteDescription}？</h2>
        <p id={`delete-message-description-${messageId}`}>这条消息及其关联的推理、工具调用和附件记录会从当前会话中永久删除，无法撤销。</p>
        <div>
          <button className="secondary-button" type="button" autoFocus onClick={() => setDeleteOpen(false)} disabled={deleting}><X size={15} />取消</button>
          <button className="danger-button" type="button" onClick={() => void deleteMessage()} disabled={deleting}><Trash2 size={16} />{deleting ? '正在删除…' : '确认删除'}</button>
        </div>
      </div>
    </div>, document.body)}
  </>
}
