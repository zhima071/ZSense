import { Archive, ArchiveRestore, Check, Pencil, Trash2, X } from 'lucide-react'
import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Conversation } from '../types'

interface ConversationActionsProps {
  conversation: Conversation
  onRename: (conversationId: string, title: string) => Promise<void>
  onArchive: (conversationId: string, archived: boolean) => Promise<void>
  onDelete: (conversationId: string) => Promise<void>
}

export function ConversationActions({ conversation, onRename, onArchive, onDelete }: ConversationActionsProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const [title, setTitle] = useState(conversation.title)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const [error, setError] = useState('')

  const restoreFocus = () => {
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true })
  }

  // The invisible anchor connects to the containing conversation row. No space
  // is reserved for a trigger; mouse, keyboard and touch share the same menu.
  useEffect(() => {
    const row = anchorRef.current?.parentElement
    if (!row) return
    let holdTimer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    let suppressClick = false
    const cancelHold = () => { clearTimeout(holdTimer); holdTimer = undefined; start = null }
    const open = (x: number, y: number, target: EventTarget | null) => {
      if (busy || dialog) return
      const element = target instanceof HTMLElement ? target : row
      returnFocusRef.current = element.closest<HTMLElement>('button') || row.querySelector<HTMLElement>('button') || element.closest<HTMLElement>('[tabindex]') || row
      setError('')
      setMenu({ x, y })
    }
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault()
      cancelHold()
      open(event.clientX, event.clientY, event.target)
    }
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      const bounds = row.getBoundingClientRect()
      open(bounds.left + Math.min(28, bounds.width / 2), bounds.bottom, event.target)
    }
    const pointerDown = (event: PointerEvent) => {
      cancelHold()
      suppressClick = false
      if (event.pointerType !== 'touch' || !event.isPrimary) return
      start = { x: event.clientX, y: event.clientY }
      holdTimer = setTimeout(() => {
        suppressClick = true
        open(event.clientX, event.clientY, event.target)
      }, 550)
    }
    const pointerMove = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancelHold()
    }
    const click = (event: MouseEvent) => {
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const compatibilityMouseDown = (event: MouseEvent) => {
      if (!suppressClick) return
      // Touch release synthesizes mousedown before click. Prevent it from
      // refocusing/opening the row and dismissing the freshly opened menu.
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    row.addEventListener('contextmenu', contextMenu)
    row.addEventListener('keydown', keyDown)
    row.addEventListener('pointerdown', pointerDown)
    row.addEventListener('pointermove', pointerMove)
    row.addEventListener('pointerup', cancelHold)
    row.addEventListener('pointercancel', cancelHold)
    row.addEventListener('dragstart', cancelHold)
    row.addEventListener('mousedown', compatibilityMouseDown, true)
    row.addEventListener('click', click, true)
    return () => {
      cancelHold()
      row.removeEventListener('contextmenu', contextMenu)
      row.removeEventListener('keydown', keyDown)
      row.removeEventListener('pointerdown', pointerDown)
      row.removeEventListener('pointermove', pointerMove)
      row.removeEventListener('pointerup', cancelHold)
      row.removeEventListener('pointercancel', cancelHold)
      row.removeEventListener('dragstart', cancelHold)
      row.removeEventListener('mousedown', compatibilityMouseDown, true)
      row.removeEventListener('click', click, true)
    }
  }, [busy, dialog])

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const bounds = menuRef.current.getBoundingClientRect()
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))
    if (x !== menu.x || y !== menu.y) setMenu({ x, y })
    menuRef.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const outside = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      close()
    }
    const contextOutside = (event: Event) => {
      if (event.target instanceof Node && anchorRef.current?.parentElement?.contains(event.target)) return
      outside(event)
    }
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); restoreFocus(); return }
      if (event.key === 'Tab') { close(); restoreFocus(); return }
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      let next: number | undefined
      if (event.key === 'ArrowDown') next = (index + 1) % items.length
      if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = items.length - 1
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); items[next]?.focus() }
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    document.addEventListener('contextmenu', contextOutside)
    document.addEventListener('keydown', keyDown, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', outside, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside, true)
      document.removeEventListener('contextmenu', contextOutside)
      document.removeEventListener('keydown', keyDown, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', outside, true)
    }
  }, [menu])

  useEffect(() => {
    if (!dialog) return
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) setDialog(null)
        return
      }
      if (event.key !== 'Tab') return
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || [])
      if (!items.length) return
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus() }
    }
    document.addEventListener('keydown', keyDown, true)
    return () => { document.removeEventListener('keydown', keyDown, true); restoreFocus() }
  }, [dialog])

  const rename = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    setError('')
    try {
      await onRename(conversation.id, title.trim())
      setDialog(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重命名失败。')
    } finally {
      setBusy(false)
    }
  }

  const archive = async () => {
    setMenu(null)
    setBusy(true)
    setError('')
    try {
      await onArchive(conversation.id, !conversation.archived)
      restoreFocus()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '归档操作失败。')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await onDelete(conversation.id)
      setDialog(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败。')
    } finally {
      setBusy(false)
    }
  }

  const openRenameDialog = () => {
    setMenu(null)
    setTitle(conversation.title)
    setError('')
    setDialog('rename')
  }

  const openDeleteDialog = () => {
    setMenu(null)
    setError('')
    setDialog('delete')
  }

  return (
    <>
      <span ref={anchorRef} className="conversation-context-anchor" hidden />
      {menu && createPortal(
        <div ref={menuRef} className="conversation-context-menu" role="menu" aria-label={`${conversation.title} 的管理操作`} style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}>
          <button type="button" role="menuitem" data-tooltip="off" onClick={openRenameDialog} aria-label={`重命名 ${conversation.title}`}><Pencil size={15} /><span>重命名</span></button>
          <button type="button" role="menuitem" data-tooltip="off" onClick={() => void archive()} aria-label={`${conversation.archived ? '恢复' : '归档'} ${conversation.title}`}>
            {conversation.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}<span>{conversation.archived ? '恢复对话' : '归档对话'}</span>
          </button>
          <div className="conversation-context-separator" role="separator" />
          <button type="button" role="menuitem" className="danger" data-tooltip="off" onClick={openDeleteDialog} aria-label={`删除 ${conversation.title}`}><Trash2 size={15} /><span>删除对话</span></button>
        </div>, document.body)}
      {error && !dialog && createPortal(<div className="conversation-context-error" role="alert"><span>{error}</span><button type="button" className="icon-button" aria-label="关闭会话操作错误提示" onClick={() => setError('')}><X size={14} /></button></div>, document.body)}

      {dialog === 'rename' && createPortal((
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && setDialog(null)}>
          <form ref={(node) => { dialogRef.current = node }} className="confirm-dialog conversation-rename-dialog" onSubmit={rename} role="dialog" aria-modal="true" aria-labelledby={`rename-${conversation.id}`} aria-describedby={`rename-description-${conversation.id}`}>
            <span className="confirm-icon"><Pencil size={21} /></span>
            <h2 id={`rename-${conversation.id}`}>重命名对话</h2>
            <p id={`rename-description-${conversation.id}`}>新的名称只影响 ZSense 中的显示，不会改动历史消息。</p>
            <label><span>对话名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} /></label>
            {error && <div className="inline-error" role="alert">{error}</div>}
            <div>
              <button className="secondary-button" type="button" onClick={() => setDialog(null)} disabled={busy}><X size={15} />取消</button>
              <button className="button primary" type="submit" disabled={busy || !title.trim()}><Check size={15} />{busy ? '保存中…' : '保存名称'}</button>
            </div>
          </form>
        </div>
      ), document.body)}

      {dialog === 'delete' && createPortal((
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && setDialog(null)}>
          <div ref={(node) => { dialogRef.current = node }} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`delete-${conversation.id}`} aria-describedby={`delete-description-${conversation.id}`}>
            <span className="confirm-icon"><Trash2 size={22} /></span>
            <h2 id={`delete-${conversation.id}`}>删除“{conversation.title}”？</h2>
            <p id={`delete-description-${conversation.id}`}>这会永久删除 ZSense 中保存的全部历史消息和推理摘要，无法撤销。</p>
            {error && <div className="inline-error" role="alert">{error}</div>}
            <div>
              <button className="secondary-button" autoFocus onClick={() => setDialog(null)} disabled={busy}>取消</button>
              <button className="danger-button" onClick={() => void remove()} disabled={busy}><Trash2 size={16} />{busy ? '正在删除…' : '确认删除'}</button>
            </div>
          </div>
        </div>
      ), document.body)}
    </>
  )
}
