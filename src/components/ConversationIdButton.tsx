import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { writeTextToClipboard } from '../services/clipboard'
import { errorMessage } from '../services/desktop'

interface ConversationIdButtonProps {
  conversationId?: string
  onError: (message: string) => void
}

export function ConversationIdButton({ conversationId, onError }: ConversationIdButtonProps) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), [])

  const copyConversationId = async () => {
    if (!conversationId) return
    try {
      await writeTextToClipboard(conversationId)
      setCopied(true)
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_800)
    } catch (error) {
      onError(`复制对话 ID 失败：${errorMessage(error)}`)
    }
  }

  const label = !conversationId ? '等待生成 ID' : copied ? '已复制 ID' : '复制对话 ID'
  const title = conversationId ? `${label}：${conversationId}` : '发送第一条消息后生成对话 ID'

  return (
    <button
      type="button"
      className={`conversation-id-button ${copied ? 'is-copied' : ''}`}
      onClick={copyConversationId}
      disabled={!conversationId}
      title={title}
      aria-label={title}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  )
}
