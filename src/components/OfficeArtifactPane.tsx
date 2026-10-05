import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FilePenLine,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Presentation,
  RefreshCw,
  Save,
  X,
} from 'lucide-react'
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, lazy, PointerEvent as ReactPointerEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { ChatAttachment, OfficeDocumentKind, OfficeDocumentState } from '../types'
import { HtmlArtifactEditor } from './HtmlArtifactEditor'

const SpreadsheetEditor = lazy(() => import('./SpreadsheetEditor').then((module) => ({ default: module.SpreadsheetEditor })))
const WordDocumentEditor = lazy(() => import('./WordDocumentEditor').then((module) => ({ default: module.WordDocumentEditor })))
const PdfDocumentEditor = lazy(() => import('./PdfDocumentEditor').then((module) => ({ default: module.PdfDocumentEditor })))

interface OfficeArtifactPaneProps {
  filePath: string
  workspacePath?: string
  onClose: () => void
  onAskAI?: (prompt: string, behavior: 'send' | 'insert') => void
  onAnnotatedScreenshot?: (attachment: ChatAttachment, requirement: string, sendImmediately: boolean) => void | Promise<void>
}

const kindLabels: Record<OfficeDocumentKind, string> = {
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  html: 'HTML 页面',
  pdf: 'PDF',
  image: '图片',
  legacy: '旧版 Office',
}

function DocumentIcon({ kind, size = 18 }: { kind: OfficeDocumentKind; size?: number }) {
  if (kind === 'excel') return <FileSpreadsheet size={size} />
  if (kind === 'powerpoint') return <Presentation size={size} />
  if (kind === 'html') return <FileCode2 size={size} />
  if (kind === 'image') return <ImageIcon size={size} />
  return <FileText size={size} />
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function OfficeArtifactPane({ filePath, workspacePath, onClose, onAskAI, onAnnotatedScreenshot }: OfficeArtifactPaneProps) {
  const paneRef = useRef<HTMLElement>(null)
  const [document, setDocument] = useState<OfficeDocumentState | null>(null)
  const [busy, setBusy] = useState('open')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [pdfRefreshKey, setPdfRefreshKey] = useState(0)
  const [panePercent, setPanePercent] = useState(() => {
    const stored = Number(window.localStorage.getItem('zsense.officePaneWidthPercent'))
    return Number.isFinite(stored) && stored >= 38 && stored <= 75 ? stored : 58
  })

  useEffect(() => {
    const container = paneRef.current?.parentElement
    if (!container) return
    container.style.setProperty('--office-pane-width', `${panePercent}%`)
    window.localStorage.setItem('zsense.officePaneWidthPercent', String(panePercent))
    return () => { container.style.removeProperty('--office-pane-width') }
  }, [panePercent])

  const setPaneFromClientX = (clientX: number) => {
    const container = paneRef.current?.parentElement
    if (!container) return
    const bounds = container.getBoundingClientRect()
    const percent = ((bounds.right - clientX) / bounds.width) * 100
    setPanePercent(Math.round(Math.min(75, Math.max(38, percent)) * 10) / 10)
  }

  const resizeFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setPaneFromClientX(event.clientX)
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') return setPanePercent(58)
    setPanePercent((current) => Math.min(75, Math.max(38, current + (event.key === 'ArrowLeft' ? 2 : -2))))
  }

  const requestClose = useCallback(async () => {
    const dirtyKind = document?.kind === 'html' ? ' HTML' : document?.kind === 'word' ? ' Word' : document?.kind === 'pdf' ? ' PDF' : ' Excel'
    if (hasUnsavedChanges && !window.confirm(`这个${dirtyKind}文件还有未保存的修改，确定放弃修改并关闭吗？`)) return
    if (hasUnsavedChanges && window.zsenseDesktop && document?.kind === 'html') {
      try { await unwrapDesktop(window.zsenseDesktop.office.discardHtml({ filePath: document.filePath, clientId: 'office-pane' })) }
      catch (reason) { setFeedback({ tone: 'error', message: `放弃 HTML 修改失败：${errorMessage(reason)}` }); return }
    }
    if (hasUnsavedChanges && window.zsenseDesktop && document?.kind === 'word') {
      try { await unwrapDesktop(window.zsenseDesktop.office.discardWord({ filePath: document.filePath, clientId: 'office-pane' })) }
      catch (reason) { setFeedback({ tone: 'error', message: `放弃 Word 修改失败：${errorMessage(reason)}` }); return }
    }
    onClose()
  }, [document, hasUnsavedChanges, onClose])

  useEffect(() => {
    let cancelled = false
    setDocument(null)
    setBusy('open')
    setFeedback(null)
    setEditorOpen(false)
    setFindText('')
    setReplaceText('')
    setHasUnsavedChanges(false)
    setPdfRefreshKey((current) => current + 1)
    if (!window.zsenseDesktop) {
      setBusy('')
      setFeedback({ tone: 'error', message: '本地文件只能在 ZSense 桌面应用中打开。' })
      return () => { cancelled = true }
    }
    unwrapDesktop(window.zsenseDesktop.office.open(filePath)).then((nextDocument) => {
      if (cancelled) return
      setDocument(nextDocument)
    }).catch((reason) => {
      if (!cancelled) setFeedback({ tone: 'error', message: errorMessage(reason) })
    }).finally(() => {
      if (!cancelled) setBusy('')
    })
    return () => { cancelled = true }
  }, [filePath])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') return
      if (editorOpen) setEditorOpen(false)
      else void requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editorOpen, requestClose])

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    setFeedback(null)
    try { await action() }
    catch (reason) { setFeedback({ tone: 'error', message: errorMessage(reason) }) }
    finally { setBusy('') }
  }

  const refresh = () => run('refresh', async () => {
    if (!window.zsenseDesktop || !document) return
    if (document.kind === 'pdf' && hasUnsavedChanges && !window.confirm('重新读取会放弃当前未保存的 PDF 修改，确定继续吗？')) return
    if (document.kind === 'excel' && hasUnsavedChanges) {
      if (!window.confirm('重新读取会放弃当前未保存的修改，确定继续吗？')) return
      await unwrapDesktop(window.zsenseDesktop.office.discardWorkbook({ filePath: document.filePath, clientId: 'office-pane' }))
      setHasUnsavedChanges(false)
    }
    if (document.kind === 'html' && hasUnsavedChanges) {
      if (!window.confirm('重新读取会放弃当前未保存的 HTML 修改，确定继续吗？')) return
      await unwrapDesktop(window.zsenseDesktop.office.discardHtml({ filePath: document.filePath, clientId: 'office-pane' }))
      setHasUnsavedChanges(false)
    }
    if (document.kind === 'word' && hasUnsavedChanges) {
      if (!window.confirm('重新读取会放弃当前未保存的 Word 修改，确定继续吗？')) return
      await unwrapDesktop(window.zsenseDesktop.office.discardWord({ filePath: document.filePath, clientId: 'office-pane' }))
      setHasUnsavedChanges(false)
    }
    setDocument(await unwrapDesktop(window.zsenseDesktop.office.refresh(document.filePath)))
    if (document.kind === 'pdf') { setHasUnsavedChanges(false); setPdfRefreshKey((current) => current + 1) }
    setFeedback({ tone: 'success', message: '已从磁盘重新读取最新内容。' })
  })

  const reveal = () => run('reveal', async () => {
    if (!window.zsenseDesktop || !document) return
    await unwrapDesktop(window.zsenseDesktop.office.reveal(document.filePath))
  })

  const openExternally = () => run('external', async () => {
    if (!window.zsenseDesktop || !document) return
    await unwrapDesktop(window.zsenseDesktop.office.openExternally(document.filePath))
  })

  const submitReplacement = (event: FormEvent) => {
    event.preventDefault()
    void run('replace', async () => {
      if (!window.zsenseDesktop || !document) return
      const result = await unwrapDesktop(window.zsenseDesktop.office.replaceText({ filePath: document.filePath, find: findText, replace: replaceText }))
      setDocument(result.document)
      setFeedback({ tone: 'success', message: result.message })
    })
  }

  const showEditToggle = Boolean(document?.editable && document.kind !== 'excel')
  const showDocumentEditDrawer = Boolean(document?.editable && document.kind !== 'excel' && document.kind !== 'html' && document.kind !== 'word' && document.kind !== 'pdf')
  const externalOpenLabel = document?.kind === 'image' ? '使用系统图片查看器打开' : document?.kind === 'pdf' ? '使用系统默认 PDF 应用打开' : '使用 Office / WPS 打开'
  const documentDescription = document?.kind === 'image'
    ? `${kindLabels.image} · ${formatBytes(document.size)} · 本地预览`
    : document ? `${kindLabels[document.kind]} · ${formatBytes(document.size)} · ${document.editable ? '本地可编辑' : '需要转换格式'}` : ''

  return (
    <aside ref={paneRef} className={`office-artifact-pane ${editorOpen ? 'editor-open' : ''}`} aria-label="对话文件查看与编辑器">
      <div
        className="office-artifact-resize-handle"
        role="separator"
        aria-label="调整文件编辑区域宽度"
        aria-orientation="vertical"
        aria-valuemin={38}
        aria-valuemax={75}
        aria-valuenow={Math.round(panePercent)}
        tabIndex={0}
        onPointerDown={resizeFromPointer}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setPaneFromClientX(event.clientX) }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
        onDoubleClick={() => setPanePercent(58)}
        onKeyDown={resizeFromKeyboard}
        title="拖动调整宽度，双击恢复默认"
      ><span /></div>
      <header className="office-artifact-header">
        <span className={`office-file-icon ${document?.kind || 'legacy'}`}>
          {document ? <DocumentIcon kind={document.kind} size={18} /> : <FileText size={18} />}
        </span>
        <span className="office-artifact-title">
          <strong title={document?.filePath || filePath}>{document?.name || filePath.split(/[\\/]/).pop() || '本地文件'}</strong>
          <small>{document ? documentDescription : busy ? '正在打开本地文件…' : feedback?.tone === 'error' ? '文件路径已失效或无法读取' : '等待打开本地文件'}</small>
        </span>
        <div className="office-artifact-actions">
          {showEditToggle && <button className={`office-edit-mode-toggle ${editorOpen ? 'active' : ''}`} type="button" onClick={() => setEditorOpen((current) => !current)} aria-pressed={editorOpen} aria-label={document?.kind === 'html' ? editorOpen ? '退出可视化编辑，切换到预览' : '进入可视化编辑' : document?.kind === 'pdf' ? editorOpen ? '退出 PDF 编辑' : '进入 PDF 编辑' : editorOpen ? '收起编辑工具' : '打开编辑工具'} title={document?.kind === 'html' ? editorOpen ? '切换到正常预览' : '进入可视化编辑' : document?.kind === 'pdf' ? editorOpen ? '退出 PDF 编辑' : '进入 PDF 编辑' : '打开编辑工具'}>{editorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}<span>{document?.kind === 'html' ? editorOpen ? '可视化编辑' : '进入编辑' : document?.kind === 'pdf' ? editorOpen ? 'PDF 编辑中' : '进入编辑' : '编辑工具'}</span></button>}
          <button type="button" onClick={() => void refresh()} disabled={!document || Boolean(busy)} aria-label="刷新文件" title="刷新"><RefreshCw className={busy === 'refresh' ? 'spin' : ''} size={16} /></button>
          <button type="button" onClick={() => void reveal()} disabled={!document || Boolean(busy)} aria-label="在文件夹中显示" title="在文件夹中显示"><FolderOpen size={16} /></button>
          <button type="button" onClick={() => void openExternally()} disabled={!document || Boolean(busy)} aria-label={externalOpenLabel} title={externalOpenLabel}><ExternalLink size={16} /></button>
          <button type="button" onClick={() => void requestClose()} aria-label="关闭文件" title={hasUnsavedChanges ? '关闭文件（有未保存修改）' : '关闭文件'}><X size={17} /></button>
        </div>
      </header>

      <div className="office-artifact-body">
        {busy && !document && <div className="office-artifact-state"><LoaderCircle className="spin" size={24} /><strong>{busy === 'retry' ? '正在重新读取文件' : '正在打开文件'}</strong><span>ZSense 正在本机读取内容…</span></div>}
        {!busy && feedback?.tone === 'error' && !document && <div className="office-artifact-state error" role="alert"><AlertTriangle size={25} /><strong>无法打开这个文件</strong><span>{feedback.message}</span><button className="button secondary small" type="button" onClick={() => void run('retry', async () => { if (!window.zsenseDesktop) return; const nextDocument = await unwrapDesktop(window.zsenseDesktop.office.open(filePath)); setDocument(nextDocument); setFeedback({ tone: 'success', message: '文件已重新读取。' }) })}>重试</button></div>}

        {document?.editable && document.kind === 'excel' && <Suspense fallback={<div className="office-artifact-state"><LoaderCircle className="spin" size={24} /><strong>正在启动表格引擎</strong><span>首次打开需要加载本地编辑组件…</span></div>}><SpreadsheetEditor document={document} workspacePath={workspacePath} onDocumentChange={setDocument} onFeedback={setFeedback} onDirtyChange={setHasUnsavedChanges} onAskAI={onAskAI} /></Suspense>}

        {document?.editable && document.kind === 'html' && <HtmlArtifactEditor document={document} workspacePath={workspacePath} editing={editorOpen} onDocumentChange={setDocument} onFeedback={setFeedback} onDirtyChange={setHasUnsavedChanges} onAskAI={onAskAI} />}

        {document?.editable && document.kind === 'word' && <Suspense fallback={<div className="office-artifact-state"><LoaderCircle className="spin" size={24} /><strong>正在启动 Word 编辑器</strong><span>正在建立本地手动保存会话…</span></div>}><WordDocumentEditor document={document} workspacePath={workspacePath} editing={editorOpen} onDocumentChange={setDocument} onFeedback={setFeedback} onDirtyChange={setHasUnsavedChanges} onAskAI={onAskAI} /></Suspense>}

        {document?.editable && document.kind === 'pdf' && <Suspense fallback={<div className="office-artifact-state"><LoaderCircle className="spin" size={24} /><strong>正在启动 PDF 编辑器</strong></div>}><PdfDocumentEditor key={pdfRefreshKey} document={document} workspacePath={workspacePath} editing={editorOpen} onDocumentChange={setDocument} onFeedback={setFeedback} onDirtyChange={setHasUnsavedChanges} onAskAI={onAskAI} onAnnotatedScreenshot={onAnnotatedScreenshot} /></Suspense>}

        {document?.kind === 'image' && <section className="office-artifact-image-preview" aria-label={`${document.name} 大图预览`}>
          <img key={document.previewUrl} src={document.previewUrl} alt={document.name} draggable={false} onError={() => setFeedback({ tone: 'error', message: '图片解码失败，可尝试使用系统图片查看器打开。' })} />
        </section>}

        {document?.editable && document.kind !== 'excel' && document.kind !== 'html' && document.kind !== 'word' && document.kind !== 'pdf' && <section className="office-artifact-preview" aria-label={`${document.name} 预览`}>
          <iframe key={document.previewUrl} src={document.previewUrl} sandbox="allow-scripts" title={`${document.name} 本地预览`} />
        </section>}

        {feedback && document && <div className={`office-artifact-feedback ${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>{feedback.tone === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<span>{feedback.message}</span><button type="button" onClick={() => setFeedback(null)} aria-label="关闭提示"><X size={13} /></button></div>}

        {showDocumentEditDrawer && editorOpen && <aside className="office-artifact-editor" aria-label="Office 编辑工具">
          <header><div><strong>编辑工具</strong><small>查找文字并写回原文件</small></div><button type="button" onClick={() => setEditorOpen(false)} aria-label="收起编辑工具"><X size={15} /></button></header>
          <div className="office-edit-note"><CheckCircle2 size={16} /><span><strong>点击操作后才会保存</strong><small>所有处理均在本机完成，不会上传文件。</small></span></div>

          <form className="office-edit-card" onSubmit={submitReplacement}>
            <header><FilePenLine size={17} /><span><strong>查找与替换</strong><small>保留版式并修改匹配文字</small></span></header>
            <label><span>查找文字</span><textarea value={findText} onChange={(event) => setFindText(event.target.value)} required rows={3} placeholder="输入原来的文字" /></label>
            <label><span>替换为</span><textarea value={replaceText} onChange={(event) => setReplaceText(event.target.value)} rows={3} placeholder="留空可删除匹配文字" /></label>
            <button className="button primary" disabled={!findText.trim() || Boolean(busy)}>{busy === 'replace' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{busy === 'replace' ? '正在保存…' : '替换并保存'}</button>
          </form>
        </aside>}

        {document?.kind === 'legacy' && <section className="office-artifact-legacy"><AlertTriangle size={27} /><strong>需要先转换为新版格式</strong><p>{document.message}</p><button className="button primary small" type="button" onClick={() => void openExternally()}><ExternalLink size={15} />使用 Office / WPS 打开</button></section>}
      </div>
    </aside>
  )
}
