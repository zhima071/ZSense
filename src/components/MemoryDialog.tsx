import { AlertTriangle, Check, FileText, Pencil, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { formatLocalDateTime } from '../services/date-time'
import type { MemoryItem } from '../types'

export type MemoryDialogMode = 'create' | 'view' | 'edit'

interface MemoryDialogProps {
  spaceName: string
  memory?: MemoryItem
  initialMode: MemoryDialogMode
  confirmDeleteOnOpen?: boolean
  onClose: () => void
  onSave: (memory: MemoryItem) => Promise<void>
  onDelete?: (memoryId: string) => Promise<void>
}

const typeNames: Record<MemoryItem['type'], string> = {
  fact: '事实',
  preference: '偏好',
  episode: '经历',
}

export function MemoryDialog({ spaceName, memory, initialMode, confirmDeleteOnOpen = false, onClose, onSave, onDelete }: MemoryDialogProps) {
  const titleId = useId()
  const [mode, setMode] = useState<MemoryDialogMode>(initialMode)
  const [title, setTitle] = useState(memory?.title || '')
  const [excerpt, setExcerpt] = useState(memory?.excerpt || '')
  const [type, setType] = useState<MemoryItem['type']>(memory?.type || 'fact')
  const [confirmDelete, setConfirmDelete] = useState(confirmDeleteOnOpen)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setMode(initialMode)
    setTitle(memory?.title || '')
    setExcerpt(memory?.excerpt || '')
    setType(memory?.type || 'fact')
    setConfirmDelete(confirmDeleteOnOpen)
    setError('')
  }, [confirmDeleteOnOpen, initialMode, memory])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const save = async () => {
    if (!title.trim() || !excerpt.trim()) return
    setBusy(true)
    setError('')
    try {
      await onSave({
        id: memory?.id || `memory-${Date.now()}`,
        title: title.trim(),
        excerpt: excerpt.trim(),
        type,
        updatedAt: new Date().toISOString(),
        source: memory?.source || '手动添加',
      })
      onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '记忆保存失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!memory || !onDelete) return
    setBusy(true)
    setError('')
    try {
      await onDelete(memory.id)
      onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '记忆删除失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  const editable = mode !== 'view'
  const dialogTitle = mode === 'create' ? '添加长期记忆' : mode === 'edit' ? '修改长期记忆' : '记忆详情'

  return (
    <div className="memory-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="memory-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <span className="memory-dialog-icon"><FileText size={20} /></span>
          <div><small>{spaceName} · 独立记忆空间</small><h2 id={titleId}>{dialogTitle}</h2></div>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭记忆窗口"><X size={18} /></button>
        </header>

        {editable ? (
          <div className="memory-dialog-form">
            <label><span>记忆标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} autoFocus placeholder="例如：回复语言偏好" /></label>
            <label><span>记忆类型</span><select value={type} onChange={(event) => setType(event.target.value as MemoryItem['type'])}><option value="fact">事实</option><option value="preference">偏好</option><option value="episode">经历</option></select></label>
            <label className="memory-dialog-content-field"><span>记忆内容</span><textarea value={excerpt} onChange={(event) => setExcerpt(event.target.value)} maxLength={20_000} rows={9} placeholder="填写需要长期保留、供后续对话召回的信息。" /></label>
            <div className="memory-dialog-scope"><ShieldCheck size={16} /><span><strong>只写入 {spaceName}</strong><small>保存在 ZSense SQLite 独立分区，不依赖外部运行时。</small></span></div>
          </div>
        ) : memory ? (
          <div className="memory-dialog-detail">
            <div className="memory-detail-meta"><span><small>类型</small><strong>{typeNames[memory.type]}</strong></span><span><small>来源</small><strong>{memory.source}</strong></span><span><small>更新时间</small><strong>{formatLocalDateTime(memory.updatedAt)}</strong></span><span><small>置信度</small><strong>{typeof memory.confidence === 'number' ? `${Math.round(memory.confidence * 100)}%` : '人工确认'}</strong></span><span><small>召回次数</small><strong>{memory.recallCount || 0} 次</strong></span><span><small>最后召回</small><strong>{formatLocalDateTime(memory.lastRecalledAt, '尚未召回')}</strong></span></div>
            <div className="memory-detail-copy"><small>标题</small><h3>{memory.title}</h3><small>完整内容</small><p>{memory.excerpt}</p></div>
            {memory.evidence && <div className="memory-detail-evidence"><small>原话证据</small><blockquote>{memory.evidence}</blockquote>{memory.conversationId && <code>会话 ID：{memory.conversationId}</code>}</div>}
          </div>
        ) : null}

        {error && <div className="memory-dialog-error" role="alert"><AlertTriangle size={16} />{error}</div>}

        {confirmDelete ? (
          <footer className="memory-dialog-delete-confirm">
            <span><AlertTriangle size={17} /><span><strong>确认删除这条记忆？</strong><small>删除只影响当前 ZSense 独立记忆空间。</small></span></span>
            <div><button className="button secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>取消</button><button className="danger-button" onClick={() => void remove()} disabled={busy}><Trash2 size={16} />{busy ? '正在删除…' : '确认删除'}</button></div>
          </footer>
        ) : (
          <footer>
            <div>{memory && onDelete && <button className="button memory-delete-button" onClick={() => setConfirmDelete(true)} disabled={busy}><Trash2 size={16} />删除</button>}</div>
            <div>
              {mode === 'view' ? <><button className="button secondary" onClick={onClose}>关闭</button><button className="button primary" onClick={() => setMode('edit')}><Pencil size={16} />编辑</button></> : <><button className="button secondary" onClick={() => memory ? setMode('view') : onClose()} disabled={busy}>取消</button><button className="button primary" onClick={() => void save()} disabled={busy || !title.trim() || !excerpt.trim()}><Check size={16} />{busy ? '保存中…' : '保存记忆'}</button></>}
            </div>
          </footer>
        )}
      </section>
    </div>
  )
}
