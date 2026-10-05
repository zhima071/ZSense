import { Copy, MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Bot } from '../types'

interface BotActionsMenuProps {
  bot: Bot
  conversationCount: number
  gatewayCount: number
  bordered?: boolean
  onUpdate: (bot: Bot) => void | Promise<void>
  onDuplicate: (bot: Bot) => Promise<void>
  onDelete: (bot: Bot) => Promise<void>
}

export function BotActionsMenu({ bot, conversationCount, gatewayCount, bordered = false, onUpdate, onDuplicate, onDelete }: BotActionsMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busyAction, setBusyAction] = useState<'status' | 'duplicate' | 'delete' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const toggleStatus = async () => {
    setMenuOpen(false)
    setBusyAction('status')
    try {
      await onUpdate({ ...bot, status: bot.status === 'online' ? 'paused' : 'online', lastActive: '刚刚' })
    } finally {
      setBusyAction(null)
    }
  }

  const duplicateBot = async () => {
    setMenuOpen(false)
    setBusyAction('duplicate')
    try {
      await onDuplicate(bot)
    } catch {
      // The parent displays the actionable error notice.
    } finally {
      setBusyAction(null)
    }
  }

  const deleteBot = async () => {
    setBusyAction('delete')
    try {
      await onDelete(bot)
    } catch {
      // Keep the confirmation open so the user can retry.
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <>
      <div className="bot-actions-menu-wrap" ref={menuRef}>
        <button
          type="button"
          className={`icon-button ${bordered ? 'bordered' : ''}`}
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={`管理 ${bot.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busyAction !== null}
        >
          <MoreHorizontal size={19} />
        </button>
        {menuOpen && (
          <div className="bot-actions-menu" role="menu" aria-label={`${bot.name} 管理操作`}>
            <button type="button" role="menuitem" onClick={() => void toggleStatus()}>
              {bot.status === 'online' ? <Pause size={17} /> : <Play size={17} />}
              <span><strong>{bot.status === 'online' ? '暂停 Bot' : '启动 Bot'}</strong><small>{bot.status === 'online' ? '停止接收外部消息' : '恢复已启用的消息网关'}</small></span>
            </button>
            <button type="button" role="menuitem" onClick={() => void duplicateBot()}>
              <Copy size={17} />
              <span><strong>复制 Bot</strong><small>复制身份、模型和技能配置</small></span>
            </button>
            <span className="bot-actions-menu-separator" />
            <button type="button" className="danger" role="menuitem" onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}>
              <Trash2 size={17} />
              <span><strong>删除 Bot</strong><small>永久删除此 Bot 的独立数据</small></span>
            </button>
          </div>
        )}
      </div>

      {confirmDelete && createPortal(
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && busyAction !== 'delete' && setConfirmDelete(false)}>
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`delete-bot-title-${bot.id}`} aria-describedby={`delete-bot-description-${bot.id}`}>
            <span className="confirm-icon"><Trash2 size={22} /></span>
            <h2 id={`delete-bot-title-${bot.id}`}>删除“{bot.name}”？</h2>
            <p id={`delete-bot-description-${bot.id}`}>这会永久删除该 Bot 的 {bot.memoryCount} 条记忆、{conversationCount} 个对话、技能分配和 {gatewayCount} 个消息网关配置，并清除其已保存凭证。此操作无法撤销。</p>
            <div>
              <button className="secondary-button" onClick={() => setConfirmDelete(false)} disabled={busyAction === 'delete'}>取消</button>
              <button className="danger-button" onClick={() => void deleteBot()} disabled={busyAction === 'delete'}><Trash2 size={16} />{busyAction === 'delete' ? '正在删除…' : '确认删除'}</button>
            </div>
          </div>
        </div>
      , document.body)}
    </>
  )
}
