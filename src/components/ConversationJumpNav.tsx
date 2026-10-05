import { useEffect, useMemo, useState } from 'react'

interface JumpMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ConversationJumpNavProps {
  messages: JumpMessage[]
  // 对话只渲染最近窗口，导航必须同步只列窗口内的轮次；roundOffset 让「第 N 轮」仍按整段对话计数。
  roundOffset?: number
  anchorPrefix: string
}

export function conversationMessageAnchor(prefix: string, messageId: string) {
  return `${prefix}-message-${messageId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function messageSummary(content: string) {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized || '附件消息'
}

export function ConversationJumpNav({ messages, anchorPrefix, roundOffset = 0 }: ConversationJumpNavProps) {
  const entries = useMemo(() => messages.reduce<Array<{ message: JumpMessage; response: string }>>((result, message, index) => {
    if (message.role !== 'user') return result
    // 单次向后扫描取「本轮的第一条 AI 回复」；原来每条用户消息都 slice 一份数组，消息多时是 O(N²)。
    let response = ''
    for (let i = index + 1; i < messages.length; i += 1) {
      const candidate = messages[i]
      if (candidate.role === 'user') break
      if (candidate.role === 'assistant') { response = messageSummary(candidate.content); break }
    }
    result.push({ message, response: response || '等待 AI 回复' })
    return result
  }, []), [messages])
  const [activeId, setActiveId] = useState(entries[0]?.message.id || '')
  const entryKey = entries.map((entry) => entry.message.id).join('\u001f')

  useEffect(() => {
    const entryIds = entryKey ? entryKey.split('\u001f') : []
    if (!entryIds.length) return
    setActiveId((current) => entryIds.includes(current) ? current : entryIds[0])
    if (typeof IntersectionObserver === 'undefined') return
    const targets = entryIds.map((id) => document.getElementById(conversationMessageAnchor(anchorPrefix, id))).filter((target): target is HTMLElement => Boolean(target))
    const observer = new IntersectionObserver((observed) => {
      const visible = observed.filter((entry) => entry.isIntersecting).sort((left, right) => Math.abs(left.boundingClientRect.top - 120) - Math.abs(right.boundingClientRect.top - 120))
      const id = visible[0]?.target.getAttribute('data-message-id')
      if (id) setActiveId(id)
    }, { rootMargin: '-72px 0px -62% 0px', threshold: [0, .15, .5] })
    targets.forEach((target) => observer.observe(target))
    return () => observer.disconnect()
  }, [anchorPrefix, entryKey])

  if (!entries.length) return null

  const jumpTo = (messageId: string) => {
    const target = document.getElementById(conversationMessageAnchor(anchorPrefix, messageId))
    if (!target) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    target.focus({ preventScroll: true })
    setActiveId(messageId)
  }

  return (
    <nav className="chat-jump-nav" aria-label="对话信息快速跳转">
      <div className="chat-jump-list">
        {entries.map(({ message, response }, index) => {
          const summary = messageSummary(message.content)
          const active = activeId === message.id
          return <button className={active ? 'active' : ''} type="button" key={message.id} onClick={() => jumpTo(message.id)} aria-current={active ? 'step' : undefined} aria-label={`跳转到第 ${roundOffset + index + 1} 轮：${summary}`}>
            <i aria-hidden="true" />
            <span className="chat-jump-preview" aria-hidden="true"><strong>{summary}</strong><small>{response}</small><em>第 {roundOffset + index + 1} 轮 · 点击跳转</em></span>
          </button>
        })}
      </div>
    </nav>
  )
}
