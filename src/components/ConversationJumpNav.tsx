import { Bookmark, LoaderCircle } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'

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
  conversationId?: string
  bookmarkedMessageIds?: readonly string[]
  bookmarkableMessageIds?: readonly string[]
  onBookmarkChange?: (messageId: string, bookmarked: boolean) => Promise<void>
}

interface BookmarkOperation {
  pending: boolean
  desired: boolean
  error: string
}

export function conversationMessageAnchor(prefix: string, messageId: string) {
  return `${prefix}-message-${messageId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function messageSummary(content: string) {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized || '附件消息'
}

export function ConversationJumpNav({ messages, anchorPrefix, roundOffset = 0, conversationId, bookmarkedMessageIds = [], bookmarkableMessageIds, onBookmarkChange }: ConversationJumpNavProps) {
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
  const [previewId, setPreviewId] = useState('')
  const [bookmarkOperations, setBookmarkOperations] = useState<Record<string, Record<string, BookmarkOperation>>>({})
  const pendingOperationsRef = useRef(new Map<string, { scope: string; messageId: string; desired: boolean }>())
  const previewRef = useRef<HTMLDivElement>(null)
  const bookmarkScope = `${anchorPrefix}\u001f${conversationId || ''}`
  const bookmarkScopeRef = useRef(bookmarkScope)
  bookmarkScopeRef.current = bookmarkScope
  const bookmarkedIds = useMemo(() => new Set(bookmarkedMessageIds), [bookmarkedMessageIds])
  const bookmarkableIds = useMemo(() => bookmarkableMessageIds ? new Set(bookmarkableMessageIds) : null, [bookmarkableMessageIds])
  const entryKey = entries.map((entry) => entry.message.id).join('\u001f')

  useEffect(() => {
    setPreviewId('')
    setBookmarkOperations((current) => {
      const operations = { ...current[bookmarkScope] }
      for (const pending of pendingOperationsRef.current.values()) {
        if (pending.scope === bookmarkScope) operations[pending.messageId] = { pending: true, desired: pending.desired, error: '' }
      }
      return Object.keys(operations).length ? { [bookmarkScope]: operations } : {}
    })
  }, [bookmarkScope])

  useLayoutEffect(() => {
    const preview = previewRef.current
    if (!previewId || !preview) return
    const positionPreview = () => {
      if (!preview.getClientRects().length) return
      let top = 8
      let bottom = window.innerHeight - 8
      let left = 8
      let right = window.innerWidth - 8
      // Clamp against every clipping ancestor, not only the viewport: transcripts scroll inside panels.
      for (let ancestor = preview.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor)
        const rect = ancestor.getBoundingClientRect()
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          top = Math.max(top, rect.top + ancestor.clientTop + 4)
          bottom = Math.min(bottom, rect.top + ancestor.clientTop + ancestor.clientHeight - 4)
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          left = Math.max(left, rect.left + ancestor.clientLeft + 4)
          right = Math.min(right, rect.left + ancestor.clientLeft + ancestor.clientWidth - 4)
        }
      }
      preview.style.setProperty('--chat-jump-preview-shift-x', '0px')
      preview.style.setProperty('--chat-jump-preview-shift-y', '0px')
      preview.style.maxHeight = `${Math.max(64, bottom - top)}px`
      preview.style.maxWidth = `${Math.max(80, right - left)}px`
      const rect = preview.getBoundingClientRect()
      const nextTop = Math.min(Math.max(rect.top, top), Math.max(top, bottom - rect.height))
      const nextLeft = Math.min(Math.max(rect.left, left), Math.max(left, right - rect.width))
      preview.style.setProperty('--chat-jump-preview-shift-x', `${nextLeft - rect.left}px`)
      preview.style.setProperty('--chat-jump-preview-shift-y', `${nextTop - rect.top}px`)
    }
    positionPreview()
    window.addEventListener('resize', positionPreview)
    document.addEventListener('scroll', positionPreview, true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionPreview)
    observer?.observe(preview)
    return () => {
      window.removeEventListener('resize', positionPreview)
      document.removeEventListener('scroll', positionPreview, true)
      observer?.disconnect()
    }
  }, [previewId, bookmarkScope])

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

  const jumpTo = (messageId: string) => {
    const target = document.getElementById(conversationMessageAnchor(anchorPrefix, messageId))
    if (!target) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    target.focus({ preventScroll: true })
    setActiveId(messageId)
  }

  const changeBookmark = async (messageId: string, desired: boolean) => {
    if (!onBookmarkChange || !conversationId || (bookmarkableIds && !bookmarkableIds.has(messageId))) return
    const scope = bookmarkScope
    const operationKey = `${scope}\u001f${messageId}`
    if (pendingOperationsRef.current.has(operationKey)) return
    pendingOperationsRef.current.set(operationKey, { scope, messageId, desired })
    const updateOperation = (operation: BookmarkOperation | null) => {
      if (bookmarkScopeRef.current !== scope) return
      setBookmarkOperations((current) => {
        if (bookmarkScopeRef.current !== scope) return current
        const operations = { ...current[scope] }
        if (operation) operations[messageId] = operation
        else delete operations[messageId]
        return Object.keys(operations).length ? { [scope]: operations } : {}
      })
    }
    updateOperation({ pending: true, desired, error: '' })
    try {
      // The saved IDs remain authoritative: a failed write never removes an existing mark.
      await onBookmarkChange(messageId, desired)
      updateOperation(null)
    } catch (reason) {
      updateOperation({ pending: false, desired, error: reason instanceof Error && reason.message.trim() ? reason.message : '无法保存标记，请重试。' })
    } finally {
      pendingOperationsRef.current.delete(operationKey)
    }
  }

  if (!entries.length) return null

  return (
    <nav className="chat-jump-nav" aria-label="对话信息快速跳转">
      <div className="chat-jump-list">
        {entries.map(({ message, response }, index) => {
          const summary = messageSummary(message.content)
          const active = activeId === message.id
          const round = roundOffset + index + 1
          const bookmarked = bookmarkedIds.has(message.id)
          const bookmarkable = Boolean(conversationId) && (!bookmarkableIds || bookmarkableIds.has(message.id))
          const operation = bookmarkOperations[bookmarkScope]?.[message.id]
          const previewOpen = previewId === message.id
          const statusId = `${conversationMessageAnchor(anchorPrefix, message.id)}-bookmark-status`
          const bookmarkLabel = bookmarked ? '取消标记' : '标记此轮对话'
          return <div
            className={`chat-jump-entry ${bookmarked ? 'is-bookmarked' : ''} ${previewOpen ? 'is-preview-open' : ''}`}
            key={message.id}
            onMouseEnter={() => setPreviewId(message.id)}
            onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setPreviewId((current) => current === message.id ? '' : current) }}
            onFocus={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreviewId(message.id) }}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !event.currentTarget.matches(':hover')) setPreviewId((current) => current === message.id ? '' : current) }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !previewOpen) return
              event.preventDefault()
              event.stopPropagation()
              setPreviewId('')
              event.currentTarget.querySelector<HTMLButtonElement>('.chat-jump-marker')?.focus()
            }}
          >
            <button className={`chat-jump-marker ${active ? 'active' : ''}`} type="button" onClick={() => jumpTo(message.id)} aria-current={active ? 'step' : undefined} aria-label={`跳转到第 ${round} 轮：${summary}${bookmarked ? '，已标记' : ''}`}>
              <i aria-hidden="true" />
              {bookmarked && <span className="chat-jump-bookmark-indicator" aria-hidden="true" />}
            </button>
            <div ref={previewOpen ? previewRef : undefined} className="chat-jump-preview" role="group" aria-label={`第 ${round} 轮预览`} aria-hidden={!previewOpen} {...((!previewOpen ? { inert: '' } : {}) as HTMLAttributes<HTMLDivElement>)}>
              {onBookmarkChange && <button type="button" className={`chat-jump-bookmark ${bookmarked ? 'is-bookmarked' : ''}`} onClick={(event) => { event.stopPropagation(); void changeBookmark(message.id, !bookmarked) }} aria-label={bookmarkLabel} title={bookmarkLabel} aria-pressed={bookmarked} aria-busy={Boolean(operation?.pending)} aria-disabled={!bookmarkable || Boolean(operation?.pending)} aria-describedby={!bookmarkable || operation?.pending ? statusId : undefined} disabled={!bookmarkable}>
                {operation?.pending ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <Bookmark size={18} fill={bookmarked ? 'currentColor' : 'none'} aria-hidden="true" />}
              </button>}
              <button type="button" className={`chat-jump-preview-content ${onBookmarkChange ? 'has-bookmark' : ''}`} onClick={() => jumpTo(message.id)} aria-label={`跳转到第 ${round} 轮：${summary}`}><strong>{summary}</strong><small>{response}</small><em>第 {round} 轮 · 点击跳转</em></button>
              {onBookmarkChange && (!bookmarkable || operation?.pending) && <p id={statusId} className="chat-jump-bookmark-status" role={operation?.pending ? 'status' : undefined}>{!bookmarkable ? '此轮对话尚未保存，保存后可标记。' : '正在保存标记…'}</p>}
              {onBookmarkChange && operation?.error && <div className="chat-jump-bookmark-error" role="alert"><p>标记保存失败：{operation.error}</p><button type="button" onClick={(event) => { event.stopPropagation(); event.currentTarget.closest('.chat-jump-preview')?.querySelector<HTMLButtonElement>('.chat-jump-bookmark')?.focus(); void changeBookmark(message.id, operation.desired) }} aria-label="重试保存标记" disabled={!bookmarkable || operation.pending}>重试</button></div>}
            </div>
          </div>
        })}
      </div>
    </nav>
  )
}
