import { AlertTriangle, Bell, CheckCircle2, LoaderCircle, MessageCircle, Trash2, XCircle } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { SessionProgressItem } from '../types'

interface SessionProgressCenterProps {
  open: boolean
  items: SessionProgressItem[]
  onClose: () => void
  onOpenSession: (item: SessionProgressItem) => void
  onClearFinished: () => void
}

const statusCopy = {
  running: '进行中',
  complete: '已完成',
  failed: '失败',
  cancelled: '已停止',
} as const

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function StatusIcon({ status }: { status: SessionProgressItem['status'] }) {
  if (status === 'running') return <LoaderCircle className="spin" size={16} />
  if (status === 'complete') return <CheckCircle2 size={16} />
  if (status === 'cancelled') return <XCircle size={16} />
  return <AlertTriangle size={16} />
}

/** 同一个会话只保留最新的一条进度（按 updatedAt 取最新；没有会话 ID 的条目按 requestId 各自保留） */
export function latestSessionItems(items: SessionProgressItem[]): SessionProgressItem[] {
  const keyOf = (item: SessionProgressItem) => item.conversationId || `request:${item.requestId}`
  const best = new Map<string, SessionProgressItem>()
  for (const item of items) {
    const current = best.get(keyOf(item))
    if (!current || new Date(item.updatedAt).getTime() >= new Date(current.updatedAt).getTime()) best.set(keyOf(item), item)
  }
  return items.filter((item) => best.get(keyOf(item)) === item)
}

export function SessionProgressCenter({ open, items, onClose, onOpenSession, onClearFinished }: SessionProgressCenterProps) {
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.notification-button')) return
      onClose()
    }
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onClose()
      Array.from(document.querySelectorAll<HTMLButtonElement>('.notification-button')).find((button) => button.getClientRects().length > 0)?.focus()
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('keydown', dismissWithKeyboard)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('keydown', dismissWithKeyboard)
    }
  }, [onClose, open])

  if (!open) return null
  const visibleItems = latestSessionItems(items)
  const runningCount = visibleItems.filter((item) => item.status === 'running').length
  const finishedCount = visibleItems.length - runningCount

  return createPortal(
    <>
      <button className="session-center-scrim" type="button" onClick={onClose} aria-label="关闭会话进度" />
      <section ref={panelRef} className="session-progress-center" role="dialog" aria-modal="false" aria-labelledby="session-progress-title">
        <header>
          <span className="session-center-heading-icon"><Bell size={17} /></span>
          <span><strong id="session-progress-title">会话进度</strong><small>{runningCount ? `${runningCount} 个会话正在处理` : '当前没有进行中的会话'}</small></span>
          {finishedCount > 0 && <button type="button" onClick={onClearFinished}><Trash2 size={14} />清除已结束</button>}
        </header>

        <div className="session-progress-list">
          {visibleItems.map((item) => {
            const canOpen = item.status !== 'running' && Boolean(item.conversationId)
            return (
              <button
                type="button"
                className={`session-progress-item ${item.status} ${!item.read ? 'unread' : ''}`}
                key={item.requestId}
                onClick={() => canOpen && onOpenSession(item)}
                disabled={!canOpen}
                aria-label={`${item.title}，${statusCopy[item.status]}，${item.detail}`}
              >
                <span className="session-progress-status"><StatusIcon status={item.status} /></span>
                <span className="session-progress-copy">
                  <span><strong>{item.title}</strong><em>{item.kind === 'native' ? 'AI 对话' : 'Bot 会话'}</em></span>
                  <small>{item.detail}</small>
                </span>
                <span className="session-progress-meta"><time>{formatTime(item.updatedAt)}</time><em>{statusCopy[item.status]}</em></span>
              </button>
            )
          })}
          {!visibleItems.length && <div className="session-progress-empty"><MessageCircle size={23} /><strong>暂无会话任务</strong><p>发送消息后，可在这里查看实时处理阶段和完成状态。</p></div>}
        </div>
      </section>
    </>,
    document.body,
  )
}
