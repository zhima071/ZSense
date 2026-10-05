import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  BookOpenText,
  Bold,
  CheckCircle2,
  Check,
  ChevronDown,
  FileDown,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  LoaderCircle,
  MessageSquarePlus,
  Minus,
  PanelBottom,
  PanelTop,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  Save,
  SeparatorHorizontal,
  Table2,
  Underline,
  Undo2,
  WandSparkles,
} from 'lucide-react'
import { CSSProperties, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { OfficeDocumentState, OfficeWordOperation, WordDocumentSession } from '../types'

interface WordDocumentEditorProps {
  document: OfficeDocumentState
  workspacePath?: string
  editing: boolean
  onDocumentChange: (document: OfficeDocumentState) => void
  onFeedback: (feedback: { tone: 'success' | 'error'; message: string } | null) => void
  onDirtyChange: (dirty: boolean) => void
  onAskAI?: (prompt: string, behavior: 'send' | 'insert') => void
}

interface WordSelection {
  path: string
  text: string
  blockText: string
  rangeSelected: boolean
  characterCount: number
  tag: string
  style: Record<string, string>
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null
  popupPlacement: 'top' | 'bottom'
}

interface WordDocumentStats {
  pageCount: number
  wordCount: number
  characterCount: number
}

function RibbonGroup({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return <section className={`word-ribbon-group ${className}`} aria-label={label}>
    <div className="word-ribbon-group-body">{children}</div>
    <small>{label}</small>
  </section>
}

function workspaceRelativePath(workspacePath: string | undefined, filePath: string) {
  const normalizedRoot = (workspacePath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/')
  if (normalizedRoot && normalizedFile.startsWith(`${normalizedRoot}/`)) return normalizedFile.slice(normalizedRoot.length + 1)
  return normalizedFile.split('/').pop() || normalizedFile
}

function WordSelectionAI({ selection, document, workspacePath, style, expanded, onExpandedChange, onAskAI }: {
  selection: WordSelection
  document: OfficeDocumentState
  workspacePath?: string
  style: CSSProperties
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onAskAI: (prompt: string, behavior: 'send' | 'insert') => void
}) {
  const [instruction, setInstruction] = useState('')
  const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

  const run = (behavior: 'send' | 'insert') => {
    const requirement = instruction.trim()
    if (!requirement) return
    onAskAI([
      '请读取并编辑当前 Word 文件。',
      `文件（相对于当前会话工作区）：${workspaceRelativePath(workspacePath, document.filePath)}`,
      `选中位置：${selection.path}`,
      `选中文字：${selection.text}`,
      '',
      `修改要求：${requirement}`,
      '只处理当前选中的文字或所在段落；如果会影响其他内容，请先说明并征得确认。',
    ].join('\n'), behavior)
    setInstruction('')
    onExpandedChange(false)
  }

  if (!expanded) return <button
    className="word-selection-ai-edit-button"
    type="button"
    style={style}
    onClick={() => onExpandedChange(true)}
    aria-label={`让 AI 编辑选中的 ${selection.characterCount} 个字符`}
    title="AI 编辑当前选区"
  ><WandSparkles size={14} /><span>AI 编辑</span></button>

  return <form className="word-selection-ai-prompt" style={style} onSubmit={(event) => { event.preventDefault(); run('send') }}>
    <WandSparkles size={15} />
    <input
      autoFocus
      value={instruction}
      onChange={(event) => setInstruction(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onExpandedChange(false); return }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run('insert') }
      }}
      aria-label="描述如何修改当前 Word 选区"
      placeholder="说说你想怎么修改"
    />
    <span className="word-selection-ai-submit-wrap">
      <button type="submit" disabled={!instruction.trim()} aria-label="发送 AI 编辑要求"><Check size={16} /></button>
      <span role="tooltip"><span><strong>发送</strong><kbd>↵</kbd></span><span><strong>添加</strong><kbd>{shortcutModifier} ↵</kbd></span></span>
    </span>
  </form>
}

const clientId = `word-editor-${Math.random().toString(36).slice(2)}`
const fontOptions = ['等线', '微软雅黑', '宋体', '黑体', 'Arial', 'Calibri', 'Times New Roman']
const sizeOptions = ['9', '10.5', '12', '14', '16', '18', '22', '26', '32']

function formatSavedTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

function operationKey(operation: OfficeWordOperation) {
  if (['setText', 'formatText', 'formatParagraph'].includes(operation.action)) return `${operation.action}:${operation.path || ''}`
  return ''
}

function mergeOperation(operations: OfficeWordOperation[], operation: OfficeWordOperation) {
  const key = operationKey(operation)
  if (!key) return [...operations, operation]
  const index = operations.findIndex((item) => operationKey(item) === key)
  if (index < 0) return [...operations, operation]
  const next = [...operations]
  next[index] = {
    ...next[index],
    ...operation,
    options: operation.options ? { ...(next[index].options || {}), ...operation.options } : next[index].options,
  }
  return next
}

export function WordDocumentEditor({ document, workspacePath, editing, onDocumentChange, onFeedback, onDirtyChange, onAskAI }: WordDocumentEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const operationsRef = useRef<OfficeWordOperation[]>([])
  const historyRef = useRef<OfficeWordOperation[][]>([[]])
  const historyIndexRef = useRef(0)
  const stageQueueRef = useRef<Promise<void>>(Promise.resolve())
  const latestStageRef = useRef(0)
  const [selection, setSelection] = useState<WordSelection | null>(null)
  const [selectionAiExpanded, setSelectionAiExpanded] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(0)
  const [historyLength, setHistoryLength] = useState(1)
  const [pendingCount, setPendingCount] = useState(0)
  const [busy, setBusy] = useState<'loading' | 'staging' | 'saving' | 'discarding' | ''>('loading')
  const [savedAt, setSavedAt] = useState(document.modifiedAt)
  const [previewReady, setPreviewReady] = useState(false)
  const [zoom, setZoom] = useState(100)
  const [documentStats, setDocumentStats] = useState<WordDocumentStats>({ pageCount: 1, wordCount: 0, characterCount: 0 })

  const sendToPreview = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ channel: 'zsense-word-editor-v1', ...message }, '*')
  }, [])

  const stageSnapshot = useCallback((operations: OfficeWordOperation[], message = '') => {
    if (!window.zsenseDesktop) return
    const stageId = ++latestStageRef.current
    setBusy('staging')
    stageQueueRef.current = stageQueueRef.current.catch(() => undefined).then(async () => {
      const result = await unwrapDesktop(window.zsenseDesktop!.office.stageWordOperations({ filePath: document.filePath, operations, clientId }))
      if (stageId === latestStageRef.current && result.document) {
        onDocumentChange(result.document)
        setPendingCount(result.pendingCount)
        onDirtyChange(result.dirty)
        if (message) onFeedback({ tone: 'success', message })
      }
    }).catch((reason) => {
      if (stageId === latestStageRef.current) onFeedback({ tone: 'error', message: `Word 修改失败：${errorMessage(reason)}` })
    }).finally(() => {
      if (stageId === latestStageRef.current) setBusy('')
    })
  }, [document.filePath, onDirtyChange, onDocumentChange, onFeedback])

  const commit = useCallback((operation: OfficeWordOperation, message = '') => {
    const next = mergeOperation(operationsRef.current, operation)
    operationsRef.current = next
    const history = historyRef.current.slice(0, historyIndexRef.current + 1)
    history.push(next)
    historyRef.current = history
    historyIndexRef.current = history.length - 1
    setHistoryIndex(historyIndexRef.current)
    setHistoryLength(history.length)
    setPendingCount(next.length)
    onDirtyChange(next.length > 0)
    stageSnapshot(next, message)
  }, [onDirtyChange, stageSnapshot])

  const updateDraft = useCallback((operation: OfficeWordOperation) => {
    const next = mergeOperation(operationsRef.current, operation)
    operationsRef.current = next
    setPendingCount(next.length)
    onDirtyChange(next.length > 0)
  }, [onDirtyChange])

  const restoreHistory = useCallback((index: number) => {
    const snapshot = historyRef.current[index]
    if (!snapshot) return
    const undoing = index < historyIndexRef.current
    historyIndexRef.current = index
    operationsRef.current = snapshot
    setHistoryIndex(index)
    setPendingCount(snapshot.length)
    onDirtyChange(snapshot.length > 0)
    stageSnapshot(snapshot, undoing ? '已撤销上一项修改。' : '已重做修改。')
  }, [onDirtyChange, stageSnapshot])

  useEffect(() => {
    let cancelled = false
    setBusy('loading')
    unwrapDesktop(window.zsenseDesktop!.office.getWord({ filePath: document.filePath })).then((session: WordDocumentSession) => {
      if (cancelled) return
      const initial = Array.isArray(session.operations) ? session.operations : []
      operationsRef.current = initial
      historyRef.current = [initial]
      historyIndexRef.current = 0
      setHistoryIndex(0)
      setHistoryLength(1)
      setPendingCount(session.pendingCount)
      setSavedAt(session.modifiedAt)
      onDirtyChange(session.dirty)
      onDocumentChange(session.document)
    }).catch((reason) => {
      if (!cancelled) onFeedback({ tone: 'error', message: `Word 编辑器启动失败：${errorMessage(reason)}` })
    }).finally(() => { if (!cancelled) setBusy('') })
    return () => { cancelled = true }
    // The session is keyed by the original file path. Preview URL changes must not recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.filePath])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data || {}
      if (data.channel !== 'zsense-word-editor-v1' || event.source !== iframeRef.current?.contentWindow) return
      if (data.type === 'ready') {
        setPreviewReady(true)
        sendToPreview({ type: 'set-editing', editing })
        sendToPreview({ type: 'set-zoom', zoom })
        if (selection?.path) sendToPreview({ type: 'focus-path', path: selection.path })
      } else if (data.type === 'document-stats') {
        setDocumentStats({
          pageCount: Math.max(1, Number(data.pageCount) || 1),
          wordCount: Math.max(0, Number(data.wordCount) || 0),
          characterCount: Math.max(0, Number(data.characterCount) || 0),
        })
      } else if (data.type === 'selection' && typeof data.path === 'string') {
        setSelection({
          path: data.path,
          text: String(data.text || ''),
          blockText: String(data.blockText || data.text || ''),
          rangeSelected: Boolean(data.rangeSelected),
          characterCount: Math.max(0, Number(data.characterCount) || 0),
          tag: String(data.tag || ''),
          style: data.style && typeof data.style === 'object' ? data.style : {},
          rect: data.rect && typeof data.rect === 'object' ? {
            left: Number(data.rect.left) || 0,
            top: Number(data.rect.top) || 0,
            right: Number(data.rect.right) || 0,
            bottom: Number(data.rect.bottom) || 0,
            width: Number(data.rect.width) || 0,
            height: Number(data.rect.height) || 0,
          } : null,
          popupPlacement: data.popupPlacement === 'top' ? 'top' : 'bottom',
        })
      } else if (data.type === 'text-draft' && typeof data.path === 'string') {
        setSelection((current) => {
          if (!current || current.path !== data.path) return current
          return { ...current, text: String(data.text || ''), blockText: String(data.text || ''), rangeSelected: false, characterCount: 0, rect: null, popupPlacement: 'bottom' }
        })
        updateDraft({ action: 'setText', path: data.path, text: String(data.text || '') })
      } else if (data.type === 'text-change' && typeof data.path === 'string') {
        commit({ action: 'setText', path: data.path, text: String(data.text || '') })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [commit, editing, selection?.path, sendToPreview, updateDraft, zoom])

  useEffect(() => {
    if (previewReady) sendToPreview({ type: 'set-editing', editing })
    if (!editing) setSelection(null)
  }, [editing, previewReady, sendToPreview])

  useEffect(() => {
    if (previewReady) sendToPreview({ type: 'set-zoom', zoom })
  }, [previewReady, sendToPreview, zoom])

  useEffect(() => { setPreviewReady(false) }, [document.previewUrl])

  const selectedPath = selection?.path || ''
  const canFormat = Boolean(editing && selectedPath && !busy)
  const dirty = pendingCount > 0
  const statusText = busy === 'loading' ? '正在启动编辑器…'
    : busy === 'staging' ? '正在生成预览…'
      : busy === 'saving' ? '正在保存…'
        : dirty ? `${pendingCount} 项未保存修改`
          : `已保存${savedAt ? ` · ${formatSavedTime(savedAt)}` : ''}`

  const formatText = (options: Record<string, string | number | boolean>) => {
    if (!selectedPath) return
    commit({ action: 'formatText', path: selectedPath, options })
  }
  const formatParagraph = (options: Record<string, string | number | boolean>) => {
    if (!selectedPath) return
    commit({ action: 'formatParagraph', path: selectedPath, options })
  }

  const save = async () => {
    if (!window.zsenseDesktop || busy) return
    setBusy('saving')
    try {
      sendToPreview({ type: 'commit-draft' })
      await new Promise((resolve) => window.setTimeout(resolve, 40))
      await stageQueueRef.current
      if (operationsRef.current.length) {
        await unwrapDesktop(window.zsenseDesktop.office.stageWordOperations({ filePath: document.filePath, operations: operationsRef.current, clientId }))
      }
      const result = await unwrapDesktop(window.zsenseDesktop.office.saveWord({ filePath: document.filePath, clientId }))
      operationsRef.current = []
      historyRef.current = [[]]
      historyIndexRef.current = 0
      setHistoryIndex(0)
      setHistoryLength(1)
      setPendingCount(0)
      setSavedAt(result.savedAt || new Date().toISOString())
      onDirtyChange(false)
      if (result.document) onDocumentChange(result.document)
      onFeedback({ tone: 'success', message: result.message })
    } catch (reason) { onFeedback({ tone: 'error', message: `Word 保存失败：${errorMessage(reason)}` }) }
    finally { setBusy('') }
  }

  const chooseImage = async () => {
    if (!window.zsenseDesktop || busy) return
    try {
      const filePath = await unwrapDesktop(window.zsenseDesktop.office.pickWordImage())
      if (filePath) commit({ action: 'insertImage', path: selectedPath || undefined, filePath, options: { width: '12cm' } }, '图片已加入 Word 工作副本。')
    } catch (reason) { onFeedback({ tone: 'error', message: errorMessage(reason) }) }
  }

  const insertLink = () => {
    if (!selectedPath) return
    const url = window.prompt('请输入链接地址（https:// 或 mailto:）')?.trim()
    if (!url) return
    commit({ action: 'insertLink', path: selectedPath, url, text: selection?.text.trim() || url }, '链接已加入 Word 工作副本。')
  }

  const openAiEditor = () => {
    if (!selection?.text.trim() || !onAskAI) return
    setSelectionAiExpanded(true)
  }

  useEffect(() => { setSelectionAiExpanded(false) }, [selection?.path, selection?.text])

  const selectionAiStyle = useMemo<CSSProperties>(() => {
    if (!selection?.rect) return {}
    const center = selection.rect.left + selection.rect.width / 2
    return selection.popupPlacement === 'top'
      ? { left: `min(calc(100% - 105px), max(105px, ${center}px))`, top: `${Math.max(8, selection.rect.top - 8)}px`, transform: 'translate(-50%, -100%)' }
      : { left: `min(calc(100% - 105px), max(105px, ${center}px))`, top: `${selection.rect.bottom + 8}px`, transform: 'translateX(-50%)' }
  }, [selection])

  const insertParagraph = () => {
    const text = window.prompt('请输入新段落内容')
    if (text === null) return
    commit({ action: 'insertParagraph', path: selectedPath || undefined, text: text.trim() || '新段落' }, '新段落已加入 Word 工作副本。')
  }

  const setHeaderOrFooter = (target: 'setHeader' | 'setFooter') => {
    const text = window.prompt(target === 'setHeader' ? '请输入页眉内容' : '请输入页脚内容')?.trim()
    if (!text) return
    commit({ action: target, text }, `${target === 'setHeader' ? '页眉' : '页脚'}已加入 Word 工作副本。`)
  }

  const changeZoom = (next: number) => setZoom(Math.max(50, Math.min(200, Math.round(next / 10) * 10)))

  const selectionLabel = useMemo(() => selection
    ? selection.rangeSelected
      ? `已选 ${selection.characterCount} 个字符 · ${selection.path}`
      : `正在编辑 ${selection.tag.toUpperCase()} · ${selection.path}`
    : '像 Word 一样单击定位、拖动选择文字并直接输入', [selection])

  return <section className={`word-document-editor ${editing ? 'editing' : ''}`} aria-label="Word 可视化编辑器">
    {editing && <div className="word-editor-chrome">
      <div className="word-editor-titlebar">
        <div className="word-quick-actions" aria-label="快速访问工具栏">
          <button type="button" disabled={!dirty || Boolean(busy)} onClick={() => void save()} title="手动保存（写回原文件）"><Save size={15} /></button>
          <button type="button" disabled={historyIndex <= 0 || Boolean(busy)} onClick={() => restoreHistory(historyIndex - 1)} title="撤销"><Undo2 size={15} /></button>
          <button type="button" disabled={historyIndex >= historyLength - 1 || Boolean(busy)} onClick={() => restoreHistory(historyIndex + 1)} title="重做"><Redo2 size={15} /></button>
        </div>
        <span className="word-editor-document-name"><FileText size={14} /><strong>{document.name}</strong><small>{dirty ? '未保存' : '已保存'}</small></span>
        <span className={`word-editor-save-state ${dirty ? 'dirty' : 'saved'}`}>{busy ? <LoaderCircle className="spin" size={12} /> : <CheckCircle2 size={12} />}{statusText}</span>
      </div>

      <div className="word-ribbon word-ribbon-unified" role="toolbar" aria-label="Word 编辑工具" onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }}>
        <RibbonGroup label="编辑工具" className="unified">
          <label title="字体"><span className="sr-only">字体</span><select disabled={!canFormat} value="" onChange={(event) => { if (event.target.value) formatText({ font: event.target.value }) }}><option value="">字体</option>{fontOptions.map((font) => <option key={font}>{font}</option>)}</select><ChevronDown size={10} /></label>
          <label className="word-size-select" title="字号"><span className="sr-only">字号</span><select disabled={!canFormat} value="" onChange={(event) => { if (event.target.value) formatText({ size: `${event.target.value}pt` }) }}><option value="">字号</option>{sizeOptions.map((size) => <option key={size}>{size}</option>)}</select><ChevronDown size={10} /></label>
          <button type="button" disabled={!canFormat} onClick={() => formatText({ bold: selection?.style.fontWeight !== '700' })} title="加粗" aria-label="加粗"><Bold size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatText({ italic: selection?.style.fontStyle !== 'italic' })} title="斜体" aria-label="斜体"><Italic size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatText({ underline: !selection?.style.textDecorationLine?.includes('underline') })} title="下划线" aria-label="下划线"><Underline size={13} /></button>
          <label className="word-color-control" title="文字颜色"><span>A</span><input type="color" disabled={!canFormat} defaultValue="#172033" onChange={(event) => formatText({ color: event.target.value })} /></label>
          <label className="word-color-control highlight" title="文字高亮"><span>ab</span><input type="color" disabled={!canFormat} defaultValue="#fff59d" onChange={(event) => formatText({ highlight: event.target.value })} /></label>
          <span className="word-ribbon-divider" aria-hidden="true" />
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ listStyle: 'bullet' })} title="项目符号" aria-label="项目符号"><List size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ listStyle: 'number' })} title="编号" aria-label="编号"><ListOrdered size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ indent: '0cm' })} title="减少缩进" aria-label="减少缩进"><IndentDecrease size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ indent: '1cm' })} title="增加缩进" aria-label="增加缩进"><IndentIncrease size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ align: 'left' })} title="左对齐" aria-label="左对齐"><AlignLeft size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ align: 'center' })} title="居中" aria-label="居中"><AlignCenter size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ align: 'right' })} title="右对齐" aria-label="右对齐"><AlignRight size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ align: 'justify' })} title="两端对齐" aria-label="两端对齐"><AlignJustify size={13} /></button>
          <label className="word-line-spacing" title="行距"><span className="sr-only">行距</span><select disabled={!canFormat} value="" onChange={(event) => { if (event.target.value) formatParagraph({ lineSpacing: event.target.value }) }}><option value="">行距</option><option value="1">1.0</option><option value="1.15">1.15</option><option value="1.5">1.5</option><option value="2">2.0</option></select><ChevronDown size={10} /></label>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ spaceBefore: '6pt' })} title="段前增加 6 磅" aria-label="段前增加 6 磅"><PanelTop size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ spaceAfter: '6pt' })} title="段后增加 6 磅" aria-label="段后增加 6 磅"><PanelBottom size={13} /></button>
          <span className="word-ribbon-divider" aria-hidden="true" />
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ style: 'Normal' })} title="正文" aria-label="正文"><Pilcrow size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ style: 'Heading 1' })} title="标题 1" aria-label="标题 1"><Heading1 size={14} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ style: 'Heading 2' })} title="标题 2" aria-label="标题 2"><Heading2 size={14} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ style: 'Heading 3' })} title="标题 3" aria-label="标题 3"><Heading3 size={14} /></button>
          <button className="word-ai-button" type="button" disabled={!selection?.text.trim() || !onAskAI || Boolean(busy)} onClick={openAiEditor} title="AI 编辑选中内容"><WandSparkles size={14} /><span>AI</span></button>
          <span className="word-ribbon-divider" aria-hidden="true" />
          <button type="button" disabled={Boolean(busy)} onClick={insertParagraph} title="插入段落" aria-label="插入段落"><Pilcrow size={13} /></button>
          <button type="button" disabled={Boolean(busy)} onClick={() => commit({ action: 'insertPageBreak', path: selectedPath || undefined }, '已插入分页符。')} title="插入分页符" aria-label="插入分页符"><SeparatorHorizontal size={13} /></button>
          <button type="button" disabled={Boolean(busy)} onClick={() => commit({ action: 'insertTable', path: selectedPath || undefined, options: { rows: 3, cols: 3 } }, '已插入 3 × 3 表格。')} title="插入 3 × 3 表格" aria-label="插入表格"><Table2 size={13} /></button>
          <button type="button" disabled={Boolean(busy)} onClick={() => void chooseImage()} title="插入图片" aria-label="插入图片"><ImagePlus size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={insertLink} title="插入链接" aria-label="插入链接"><Link2 size={13} /></button>
          <button type="button" disabled={Boolean(busy)} onClick={() => setHeaderOrFooter('setHeader')} title="设置页眉" aria-label="设置页眉"><PanelTop size={13} /></button>
          <button type="button" disabled={Boolean(busy)} onClick={() => setHeaderOrFooter('setFooter')} title="设置页脚" aria-label="设置页脚"><PanelBottom size={13} /></button>
          <button type="button" disabled={Boolean(busy)} onClick={() => commit({ action: 'insertToc', path: selectedPath || undefined }, '目录已加入工作副本。')} title="插入目录" aria-label="插入目录"><FileDown size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ style: 'Heading 1' })} title="设为一级标题" aria-label="设为一级标题"><BookOpenText size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => { const text = window.prompt('请输入批注内容')?.trim(); if (text) commit({ action: 'addComment', path: selectedPath, text }, '批注已加入工作副本。') }} title="添加批注" aria-label="添加批注"><MessageSquarePlus size={13} /></button>
          <button type="button" disabled={!canFormat} onClick={() => formatParagraph({ style: 'Quote' })} title="引用样式" aria-label="引用样式"><Quote size={13} /></button>
          <span className="word-ribbon-divider" aria-hidden="true" />
          <button type="button" onClick={() => changeZoom(zoom - 10)} disabled={zoom <= 50} title="缩小" aria-label="缩小"><Minus size={13} /></button>
          <button type="button" onClick={() => changeZoom(100)} title="恢复 100%" aria-label="恢复 100%"><span className="word-zoom-label">{zoom}%</span></button>
          <button type="button" onClick={() => changeZoom(zoom + 10)} disabled={zoom >= 200} title="放大" aria-label="放大"><Plus size={13} /></button>
        </RibbonGroup>
      </div>
    </div>}

    {editing && <div className="word-horizontal-ruler" aria-hidden="true"><span className="word-ruler-margin left" />{Array.from({ length: 10 }, (_, index) => <i key={index}>{index + 1}</i>)}<span className="word-ruler-margin right" /></div>}

    <div className="word-preview-shell">
      {busy === 'loading' && <div className="word-editor-loading"><LoaderCircle className="spin" size={23} /><span>正在建立本地 Word 编辑会话…</span></div>}
      <iframe
        ref={iframeRef}
        key={document.previewUrl}
        src={document.previewUrl}
        sandbox="allow-scripts"
        title={`${document.name} Word 本地预览`}
        onLoad={() => { setPreviewReady(true); sendToPreview({ type: 'set-editing', editing }); sendToPreview({ type: 'set-zoom', zoom }); if (selection?.path) sendToPreview({ type: 'focus-path', path: selection.path }) }}
      />
      {editing && selection?.rangeSelected && selection.rect && onAskAI && <WordSelectionAI key={`${selection.path}:${selection.text}`} selection={selection} document={document} workspacePath={workspacePath} style={selectionAiStyle} expanded={selectionAiExpanded} onExpandedChange={setSelectionAiExpanded} onAskAI={onAskAI} />}
    </div>

    <footer className="word-editor-statusbar">
      <span className={dirty ? 'dirty' : 'saved'}>{busy ? <LoaderCircle className="spin" size={13} /> : <CheckCircle2 size={13} />}<strong>{statusText}</strong></span>
      <span className="word-document-stats"><small>第 1 页，共 {documentStats.pageCount} 页</small><small>{documentStats.wordCount} 个词</small><small>{documentStats.characterCount} 个字符</small></span>
      <small className="word-selection-status" title={selection?.path || ''}>{selectionLabel}</small>
      <span className="word-status-zoom"><button type="button" onClick={() => changeZoom(zoom - 10)} disabled={zoom <= 50} aria-label="缩小"><Minus size={13} /></button><input type="range" min="50" max="200" step="10" value={zoom} onChange={(event) => changeZoom(Number(event.target.value))} aria-label="文档缩放" /><button type="button" onClick={() => changeZoom(zoom + 10)} disabled={zoom >= 200} aria-label="放大"><Plus size={13} /></button><strong>{zoom}%</strong></span>
    </footer>
  </section>
}
