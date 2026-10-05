import { Archive, ArchiveRestore, Check, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react'
import { FocusEvent, FormEvent, KeyboardEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Conversation } from '../types'

interface ConversationActionsProps {
  conversation: Conversation
  onRename: (conversationId: string, title: string) => Promise<void>
  onArchive: (conversationId: string, archived: boolean) => Promise<void>
  onDelete: (conversationId: string) => Promise<void>
}

export function ConversationActions({ conversation, onRename, onArchive, onDelete }: ConversationActionsProps) {
  const [expanded, setExpanded] = useState(false)
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const [title, setTitle] = useState(conversation.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
    setExpanded(false)
    setBusy(true)
    setError('')
    try {
      await onArchive(conversation.id, !conversation.archived)
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
    setExpanded(false)
    setTitle(conversation.title)
    setError('')
    setDialog('rename')
  }

  const openDeleteDialog = () => {
    setExpanded(false)
    setError('')
    setDialog('delete')
  }

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || busy) return
    if (dialog) setDialog(null)
    else setExpanded(false)
  }

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !dialog) setExpanded(false)
  }

  return (
    <div
      className={`conversation-actions ${expanded ? 'is-expanded' : ''}`}
      role="group"
      aria-label={`${conversation.title} 的管理操作`}
      onBlur={closeOnBlur}
      onKeyDown={closeOnEscape}
    >
      <div className="conversation-action-fan" id={`conversation-action-menu-${conversation.id}`}>
        <button
          type="button"
          className="conversation-action-item delete"
          disabled={busy}
          tabIndex={expanded ? 0 : -1}
          onClick={openDeleteDialog}
          aria-label={`删除 ${conversation.title}`}
          title="删除对话"
        ><Trash2 size={13} /></button>
        <button
          type="button"
          className="conversation-action-item rename"
          disabled={busy}
          tabIndex={expanded ? 0 : -1}
          onClick={openRenameDialog}
          aria-label={`重命名 ${conversation.title}`}
          title="重命名"
        ><Pencil size={13} /></button>
        <button
          type="button"
          className="conversation-action-item archive"
          disabled={busy}
          tabIndex={expanded ? 0 : -1}
          onClick={() => void archive()}
          aria-label={`${conversation.archived ? '恢复' : '归档'} ${conversation.title}`}
          title={conversation.archived ? '恢复对话' : '归档对话'}
        >{conversation.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}</button>
        <button
          type="button"
          className="conversation-action-toggle"
          disabled={busy}
          onClick={() => setExpanded((current) => !current)}
          aria-controls={`conversation-action-menu-${conversation.id}`}
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'} ${conversation.title} 的管理操作`}
          title={expanded ? '收起会话操作' : '展开会话操作'}
        ><MoreHorizontal size={15} /></button>
      </div>
      {error && !dialog && <span className="conversation-action-error" role="alert">{error}</span>}

      {dialog === 'rename' && createPortal((
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && setDialog(null)}>
          <form className="confirm-dialog conversation-rename-dialog" onSubmit={rename} role="dialog" aria-modal="true" aria-labelledby={`rename-${conversation.id}`} aria-describedby={`rename-description-${conversation.id}`}>
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
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`delete-${conversation.id}`} aria-describedby={`delete-description-${conversation.id}`}>
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
    </div>
  )
}
