import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Columns2, Copy, FileDown, FilePlus2, FileSearch, FolderPlus, Highlighter, ListChecks, LoaderCircle, MessageSquareText, Minus, MousePointer2, PanelLeft, RefreshCw, Redo2, RotateCcw, RotateCw, Save, SaveAll, ScanSearch, Square, Circle, Strikethrough, Trash2, Type, Underline, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, Util, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PointerEvent as ReactPointerEvent, type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { ChatAttachment, OfficeDocumentState } from '../types'
import { ScreenshotAnnotationDialog } from './ScreenshotAnnotationDialog'

GlobalWorkerOptions.workerSrc = workerSrc

type Tool = 'select' | 'ask' | 'text' | 'highlight' | 'underline' | 'strikeout' | 'rectangle' | 'ellipse' | 'line' | 'cover'
type PageAction = 'rotateLeft' | 'rotateRight' | 'delete' | 'duplicate' | 'moveUp' | 'moveDown' | 'insertBlank' | 'extract' | 'merge'
type Rect = { x: number; y: number; width: number; height: number }
type Operation = Rect & { id: string; page: number; type: Exclude<Tool, 'select' | 'ask'>; color: string; fontSize?: number; text?: string; pngDataUrl?: string; strokeWidth?: number }
type TextSpan = { text: string; left: number; top: number; width: number; height: number; size: number; angle: number }
type SearchHit = { page: number; snippet: string; order: number }

interface Props {
  document: OfficeDocumentState
  workspacePath?: string
  editing: boolean
  onDocumentChange: (document: OfficeDocumentState) => void
  onDirtyChange: (dirty: boolean) => void
  onFeedback: (feedback: { tone: 'success' | 'error'; message: string } | null) => void
  onAskAI?: (prompt: string, behavior: 'send' | 'insert') => void
  onAnnotatedScreenshot?: (attachment: ChatAttachment, requirement: string, sendImmediately: boolean) => void | Promise<void>
}

const tools: Array<{ id: Tool; label: string; icon: typeof MousePointer2 }> = [
  { id: 'select', label: '选择文字', icon: MousePointer2 },
  { id: 'ask', label: '划区问 AI', icon: ScanSearch },
  { id: 'text', label: '添加文字', icon: Type },
  { id: 'highlight', label: '高亮', icon: Highlighter },
  { id: 'underline', label: '下划线', icon: Underline },
  { id: 'strikeout', label: '删除线', icon: Strikethrough },
  { id: 'rectangle', label: '方框', icon: Square },
  { id: 'ellipse', label: '椭圆', icon: Circle },
  { id: 'line', label: '直线', icon: Minus },
  { id: 'cover', label: '白色遮盖', icon: Square },
]

const operationLabels: Record<Operation['type'], string> = { text: '文字', highlight: '高亮', underline: '下划线', strikeout: '删除线', rectangle: '方框', ellipse: '椭圆', line: '直线', cover: '白色遮盖' }
const palette = ['#fff176', '#f97316', '#ef4444', '#22c55e', '#2563eb', '#111827']
const MAX_MATCHES = 300
const MIN_ZOOM = .25
const MAX_ZOOM = 3
const clampZoom = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, +value.toFixed(2)))

function makeTextImage(text: string, fontSize: number, color: string) {
  const lines = text.split('\n').slice(0, 12)
  const scale = 2
  const canvas = window.document.createElement('canvas')
  const context = canvas.getContext('2d')!
  context.font = `${fontSize * scale}px system-ui, sans-serif`
  canvas.width = Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width), 8) + 8)
  canvas.height = Math.ceil(lines.length * fontSize * 1.4 * scale + 4)
  context.font = `${fontSize * scale}px system-ui, sans-serif`
  context.fillStyle = color
  context.textBaseline = 'top'
  lines.forEach((line, index) => context.fillText(line, 2, 2 + index * fontSize * 1.4 * scale))
  return { pngDataUrl: canvas.toDataURL('image/png'), width: canvas.width / scale, height: canvas.height / scale }
}

// 把底层库的原始报错翻译成用户能看懂的话，并标出「刷新一下就行」的情况。
function friendlyPdfError(reason: unknown) {
  const raw = errorMessage(reason)
  if (/PasswordException|password|encrypted|EncryptedPDFError/i.test(raw)) return '这个 PDF 有密码保护，暂时无法编辑。请先用其他工具解除密码后再打开。'
  if (/InvalidPDF|Invalid PDF|不是有效的 PDF/i.test(raw)) return '文件不是有效的 PDF，可能已经损坏。'
  if (/ENOENT|no such file or directory/i.test(raw)) return '文件已被移动或删除，刷新一下看看。'
  if (/已被其他程序修改/.test(raw)) return `${raw}（点上方「刷新」重新载入）`
  return raw
}

export function PdfDocumentEditor({ document, workspacePath = '', editing, onDocumentChange, onDirtyChange, onFeedback, onAskAI, onAnnotatedScreenshot }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageDraft, setPageDraft] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState<'none' | 'width' | 'page'>('none')
  const [tool, setTool] = useState<Tool>('select')
  const [tab, setTab] = useState<'read' | 'annotate' | 'pages'>('read')
  const [inkColor, setInkColor] = useState('#2563eb')
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [pageBusy, setPageBusy] = useState(false)
  const [operations, setOperations] = useState<Operation[]>([])
  const [redo, setRedo] = useState<Operation[]>([])
  const [selectedText, setSelectedText] = useState('')
  const [textSpans, setTextSpans] = useState<TextSpan[]>([])
  const [draft, setDraft] = useState<{ x: number; y: number; text: string } | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number; currentX: number; currentY: number } | null>(null)
  const [screenshot, setScreenshot] = useState<{ dataUrl: string; name: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadProgress, setLoadProgress] = useState(0)
  const [saving, setSaving] = useState(false)
  const [modifiedAt, setModifiedAt] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)
  const [railOpen, setRailOpen] = useState(false)
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SearchHit[]>([])
  const [matchIndex, setMatchIndex] = useState(-1)
  const [searching, setSearching] = useState(false)
  const [selectedOpId, setSelectedOpId] = useState('')
  const [opsOpen, setOpsOpen] = useState(false)
  const [backupPath, setBackupPath] = useState('')
  const [stale, setStale] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const zoomRef = useRef(zoom)
  const zoomAnchorRef = useRef<{ clientX: number; clientY: number; pageX: number; pageY: number; fromZoom: number } | null>(null)
  const renderGeneration = useRef(0)
  const searchCache = useRef(new Map<number, string>())
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const pageAfterReload = useRef(1)
  const currentOps = operations.filter((item) => item.page === pageNumber)
  const viewport = page?.getViewport({ scale: zoom })
  const pageWidth = page ? page.view[2] - page.view[0] : 0
  const pageHeight = page ? page.view[3] - page.view[1] : 0
  const normalizedQuery = query.trim().toLowerCase()

  useEffect(() => { pdfRef.current = pdf }, [pdf])
  useEffect(() => { setPageDraft(String(pageNumber)) }, [pageNumber])
  useEffect(() => { if (!editing && !['select', 'ask'].includes(tool)) setTool('select') }, [editing, tool])
  useEffect(() => { onDirtyChange(operations.length > 0) }, [operations.length, onDirtyChange])

  // 载入：分块读取 → pdfjs 解析。reloadToken 用于「刷新」后重新读取同一个文件。
  useEffect(() => {
    let cancelled = false
    let loaded: PDFDocumentProxy | null = null
    setLoading(true)
    setLoadProgress(0)
    setPdf(null)
    setOperations([])
    setSelectedOpId('')
    searchCache.current.clear()
    setThumbs({})
    setMatches([])
    setQuery('')
    onDirtyChange(false)
    void (async () => {
      const source = await unwrapDesktop(window.zsenseDesktop!.pdf.read(document.filePath))
      const bytes = new Uint8Array(source.size)
      const chunkSize = 2 * 1024 * 1024
      for (let offset = 0; offset < source.size; offset += chunkSize) {
        if (cancelled) return
        const length = Math.min(chunkSize, source.size - offset)
        const chunk = await unwrapDesktop(window.zsenseDesktop!.pdf.readChunk({ filePath: document.filePath, expectedModifiedAt: source.modifiedAt, offset, length }))
        if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length) throw new Error('PDF 数据分块传输失败，请重新打开。')
        bytes.set(chunk, offset)
        if (!cancelled) setLoadProgress(Math.round((offset + length) / source.size * 100))
      }
      if (cancelled) return
      const task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true })
      loaded = await task.promise
      if (cancelled) { await loaded.destroy(); return }
      setPdf(loaded)
      setModifiedAt(source.modifiedAt)
      setPageNumber(Math.max(1, Math.min(loaded.numPages, pageAfterReload.current)))
      pageAfterReload.current = 1
      setStale(false)
      setLoading(false)
    })().catch((reason) => { if (!cancelled) { setLoading(false); onFeedback({ tone: 'error', message: `PDF 读取失败：${friendlyPdfError(reason)}` }) } })
    return () => { cancelled = true; void loaded?.destroy() }
  }, [document.filePath, document.modifiedAt, reloadToken])

  useEffect(() => {
    let cancelled = false
    setPage(null)
    if (pdf) void pdf.getPage(pageNumber).then((next) => { if (!cancelled) setPage(next) }).catch((reason) => onFeedback({ tone: 'error', message: friendlyPdfError(reason) }))
    return () => { cancelled = true }
  }, [pdf, pageNumber])

  useEffect(() => {
    if (!page || !viewport || !canvasRef.current) return
    let cancelled = false
    const generation = ++renderGeneration.current
    const canvas = canvasRef.current
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.ceil(viewport.width * ratio)
    canvas.height = Math.ceil(viewport.height * ratio)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    const context = canvas.getContext('2d')!
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const task = page.render({ canvasContext: context, viewport })
    void task.promise.then(async () => {
      const text = await page.getTextContent()
      if (cancelled || generation !== renderGeneration.current) return
      const spans: TextSpan[] = []
      for (const item of text.items) {
        if (!('str' in item) || !item.str) continue
        const transform = Util.transform(viewport.transform, item.transform)
        const size = Math.hypot(transform[2], transform[3]) || 12
        const angle = Math.atan2(transform[1], transform[0])
        spans.push({ text: item.str, left: transform[4], top: transform[5] - size, width: item.width * zoom, height: size, size, angle })
      }
      setTextSpans(spans)
    }).catch((reason) => { if (!cancelled) onFeedback({ tone: 'error', message: `PDF 页面渲染失败：${friendlyPdfError(reason)}` }) })
    return () => { cancelled = true; task.cancel(); page.cleanup() }
  }, [page, zoom])

  // 适配宽度 / 适配整页：跟随容器尺寸变化重算缩放。
  const applyFit = useCallback((mode: 'width' | 'page') => {
    const container = scrollRef.current
    const target = page
    if (!container || !target) return
    const base = target.getViewport({ scale: 1 })
    const availableWidth = Math.max(200, container.clientWidth - 48)
    const availableHeight = Math.max(200, container.clientHeight - 32)
    const next = mode === 'width' ? availableWidth / base.width : Math.min(availableWidth / base.width, availableHeight / base.height)
    zoomAnchorRef.current = null
    setZoom(clampZoom(next))
  }, [page])

  useEffect(() => {
    if (fitMode === 'none' || !page) return
    applyFit(fitMode)
    const container = scrollRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => applyFit(fitMode))
    observer.observe(container)
    return () => observer.disconnect()
  }, [fitMode, page, applyFit])

  // 缩略图：只渲染进入可视区的页，渲染完转成 dataURL 释放 canvas。
  useEffect(() => {
    const container = railOpen ? scrollRef.current?.parentElement?.querySelector('.pdf-thumb-list') : null
    const activePdf = pdfRef.current
    if (!railOpen || !container || !activePdf) return
    let cancelled = false
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || cancelled) continue
        const slot = entry.target as HTMLElement
        const index = Number(slot.dataset.thumb || 0)
        if (!index || thumbs[index]) continue
        observer.unobserve(slot)
        void activePdf.getPage(index).then(async (target) => {
          if (cancelled) return
          const base = target.getViewport({ scale: 1 })
          const scale = Math.min(1, 132 / base.width)
          const view = target.getViewport({ scale })
          const canvas = window.document.createElement('canvas')
          canvas.width = Math.ceil(view.width)
          canvas.height = Math.ceil(view.height)
          await target.render({ canvasContext: canvas.getContext('2d')!, viewport: view }).promise
          if (cancelled) return
          const url = canvas.toDataURL('image/jpeg', .7)
          setThumbs((current) => (current[index] ? current : { ...current, [index]: url }))
        }).catch(() => undefined)
      }
    }, { root: container, rootMargin: '160px' })
    for (const slot of container.querySelectorAll('[data-thumb]')) observer.observe(slot)
    return () => { cancelled = true; observer.disconnect() }
  }, [railOpen, thumbs, pdf])

  // 全文查找：逐页取文本并缓存，命中上限 300 条。
  useEffect(() => {
    const activePdf = pdfRef.current
    if (!normalizedQuery || !activePdf) { setMatches([]); setMatchIndex(-1); return }
    let cancelled = false
    setSearching(true)
    void (async () => {
      const hits: SearchHit[] = []
      for (let index = 1; index <= activePdf.numPages && hits.length < MAX_MATCHES; index += 1) {
        let text = searchCache.current.get(index)
        if (text === undefined) {
          const target = await activePdf.getPage(index)
          const content = await target.getTextContent()
          text = content.items.map((item) => ('str' in item ? item.str : '')).join('')
          searchCache.current.set(index, text)
        }
        const haystack = text.toLowerCase()
        let from = haystack.indexOf(normalizedQuery)
        while (from >= 0 && hits.length < MAX_MATCHES) {
          hits.push({ page: index, snippet: text.slice(Math.max(0, from - 18), from + normalizedQuery.length + 26).replace(/\s+/g, ' ').trim(), order: hits.length })
          from = haystack.indexOf(normalizedQuery, from + normalizedQuery.length)
        }
        if (cancelled) return
      }
      if (cancelled) return
      setSearching(false)
      setMatches(hits)
      setMatchIndex(hits.length ? 0 : -1)
      if (hits.length) setPageNumber(hits[0].page)
    })().catch(() => { if (!cancelled) { setSearching(false); setMatches([]) } })
    return () => { cancelled = true }
  }, [normalizedQuery, pdf])

  const jumpToMatch = (index: number) => {
    if (!matches.length) return
    const next = (index + matches.length) % matches.length
    setMatchIndex(next)
    setPageNumber(matches[next].page)
  }

  useEffect(() => {
    if (matchIndex < 0) return
    const hit = textLayerRef.current?.querySelector('.pdf-editor-text-hit')
    if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [matchIndex, page, textSpans])

  const refresh = () => {
    if (operations.length && !window.confirm('还有未保存的修改，刷新会丢弃它们。确定刷新吗？')) return
    setReloadToken((value) => value + 1)
    setStale(false)
  }

  // 用 pdfjs 的坐标换算把屏幕矩形映射到 PDF 页面坐标系（左下原点）。
  // 旧实现按像素比例直接换算，遇到带 /Rotate 的页面坐标就是错的，所以那时只能禁掉旋转页的编辑。
  const rectToPage = (rect: { x: number; y: number; width: number; height: number }) => {
    if (!viewport) return null
    const topLeft = viewport.convertToPdfPoint(rect.x, rect.y)
    const bottomRight = viewport.convertToPdfPoint(rect.x + rect.width, rect.y + rect.height)
    const minX = Math.min(topLeft[0], bottomRight[0])
    const maxX = Math.max(topLeft[0], bottomRight[0])
    const minY = Math.min(topLeft[1], bottomRight[1])
    const maxY = Math.max(topLeft[1], bottomRight[1])
    return { x: minX, y: pageHeight - maxY, width: maxX - minX, height: maxY - minY }
  }
  const pageRectToView = (item: { x: number; y: number; width: number; height: number }) => {
    if (!viewport) return { left: 0, top: 0, width: 0, height: 0 }
    const a = viewport.convertToViewportPoint(item.x, pageHeight - item.y)
    const b = viewport.convertToViewportPoint(item.x + item.width, pageHeight - item.y - item.height)
    return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) }
  }

  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = pageRef.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)) }
  }
  const commit = (operation: Operation) => { setOperations((current) => [...current, operation]); setRedo([]) }
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || !viewport || !page) return
    const end = point(event)
    const rect = { x: Math.min(drag.x, end.x), y: Math.min(drag.y, end.y), width: Math.abs(end.x - drag.x), height: Math.abs(end.y - drag.y) }
    setDrag(null)
    if (rect.width < 6 || rect.height < 6) return
    if (tool === 'ask') {
      const source = canvasRef.current!
      const crop = window.document.createElement('canvas')
      const ratio = source.width / viewport.width
      crop.width = Math.ceil(rect.width * ratio)
      crop.height = Math.ceil(rect.height * ratio)
      crop.getContext('2d')!.drawImage(source, rect.x * ratio, rect.y * ratio, rect.width * ratio, rect.height * ratio, 0, 0, crop.width, crop.height)
      setScreenshot({ dataUrl: crop.toDataURL('image/png'), name: `${document.name}-第${pageNumber}页选区.png` })
      return
    }
    const mapped = rectToPage(rect)
    if (!mapped) return
    commit({ id: crypto.randomUUID(), page: pageNumber, type: tool as Operation['type'], ...mapped, color: tool === 'highlight' && inkColor === '#2563eb' ? '#fff176' : tool === 'cover' ? '#ffffff' : inkColor, strokeWidth })
  }
  const saveText = () => {
    if (!draft?.text.trim() || !viewport || !page) return
    const image = makeTextImage(draft.text.slice(0, 2_000), 16, '#111827')
    const anchorPoint = rectToPage({ x: draft.x, y: draft.y, width: 0, height: 0 })
    if (!anchorPoint) return
    commit({ id: crypto.randomUUID(), page: pageNumber, type: 'text', x: anchorPoint.x, y: anchorPoint.y, width: Math.min(image.width / viewport.width * pageWidth, Math.max(8, pageWidth - anchorPoint.x)), height: Math.min(image.height / viewport.height * pageHeight, Math.max(8, pageHeight - anchorPoint.y)), color: '#111827', fontSize: 16, text: draft.text.slice(0, 2_000), pngDataUrl: image.pngDataUrl })
    setDraft(null)
  }

  const undo = () => setOperations((current) => { const removed = current.at(-1); if (removed) setRedo((items) => [...items, removed]); return current.slice(0, -1) })
  const redoLast = () => { const restored = redo.at(-1); if (restored) { setOperations((current) => [...current, restored]); setRedo((current) => current.slice(0, -1)) } }
  const removeOperation = (id: string) => { setSelectedOpId(''); setOperations((current) => current.filter((item) => item.id !== id)) }
  const recolor = (id: string, color: string) => setOperations((current) => current.map((item) => {
    if (item.id !== id) return item
    return item.type === 'text' && item.text ? { ...item, color, pngDataUrl: makeTextImage(item.text, item.fontSize || 16, color).pngDataUrl } : { ...item, color }
  }))

  const save = async (mode: 'overwrite' | 'copy' = 'overwrite') => {
    if (!operations.length || saving) return
    setSaving(true)
    try {
      if (mode === 'copy') {
        const result = await unwrapDesktop(window.zsenseDesktop!.pdf.saveAs({ filePath: document.filePath, expectedModifiedAt: modifiedAt, operations }))
        if (result?.canceled) return
        const target = result?.saved?.filePath || ''
        setOperations([])
        setRedo([])
        onDirtyChange(false)
        onFeedback({ tone: 'success', message: `已另存为 ${target}，原文件没有被改动。` })
        return
      }
      const saved = await unwrapDesktop(window.zsenseDesktop!.pdf.save({ filePath: document.filePath, expectedModifiedAt: modifiedAt, operations }))
      setOperations([])
      setRedo([])
      setBackupPath(saved?.backupPath || '')
      setStale(false)
      const refreshed = await unwrapDesktop(window.zsenseDesktop!.office.open(document.filePath))
      onDocumentChange(refreshed)
      onDirtyChange(false)
      onFeedback({ tone: 'success', message: saved?.backupPath ? `PDF 已写回原文件，保存前的版本备份在 ${saved.backupPath}` : 'PDF 已写回原文件。' })
    } catch (reason) {
      const message = friendlyPdfError(reason)
      if (/已被其他程序修改/.test(String(errorMessage(reason)))) setStale(true)
      onFeedback({ tone: 'error', message: `PDF 保存失败：${message}` })
    } finally { setSaving(false) }
  }

  const runPageAction = async (action: PageAction) => {
    if (!editing || !pdf || pageBusy) return
    if (operations.length) { onFeedback({ tone: 'error', message: '请先保存或撤销待保存的批注，再操作页面。' }); return }
    if (action === 'delete' && !window.confirm(`确定删除第 ${pageNumber} 页吗？保存前会自动备份原文件。`)) return
    setPageBusy(true)
    try {
      const result = await unwrapDesktop(window.zsenseDesktop!.pdf.pageAction({ filePath: document.filePath, expectedModifiedAt: modifiedAt, action, page: pageNumber }))
      if (result.canceled || !result.saved) return
      if (action === 'extract') { onFeedback({ tone: 'success', message: `第 ${pageNumber} 页已提取到 ${result.saved.filePath}；原文件未修改。` }); return }
      pageAfterReload.current = action === 'duplicate' || action === 'insertBlank' || action === 'merge' || action === 'moveDown' ? pageNumber + 1 : action === 'moveUp' ? pageNumber - 1 : pageNumber
      const refreshed = await unwrapDesktop(window.zsenseDesktop!.office.open(document.filePath))
      onDocumentChange(refreshed)
      onFeedback({ tone: 'success', message: result.saved.backupPath ? `页面操作已写入原文件；备份：${result.saved.backupPath}` : '页面操作已写入原文件。' })
    } catch (reason) {
      if (/已被其他程序修改/.test(errorMessage(reason))) setStale(true)
      onFeedback({ tone: 'error', message: `PDF 页面操作失败：${friendlyPdfError(reason)}` })
    } finally { setPageBusy(false) }
  }

  const setZoomManual = (next: number) => { zoomAnchorRef.current = null; setFitMode('none'); setZoom(clampZoom(next)) }

  // 更改缩放后把鼠标指向的 PDF 位置留在原处；普通滚轮不进入这里。
  useLayoutEffect(() => {
    zoomRef.current = zoom
    const anchor = zoomAnchorRef.current
    zoomAnchorRef.current = null
    const container = scrollRef.current
    const target = pageRef.current
    if (!anchor || !container || !target || anchor.fromZoom === zoom) return
    const next = target.getBoundingClientRect()
    const ratio = zoom / anchor.fromZoom
    container.scrollLeft += next.left + anchor.pageX * ratio - anchor.clientX
    container.scrollTop += next.top + anchor.pageY * ratio - anchor.clientY
  }, [zoom])

  // 原生非 passive 监听：浏览器默认的 Ctrl/⌘+滚轮页面缩放会被限制在 PDF 画布内。
  // 等滚轮短暂停下再重绘，避免大 PDF 每个 wheel 事件都取消并重启渲染。
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    let pendingZoom: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const target = pageRef.current
      if (!target) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1)
      const factor = Math.exp(-Math.max(-180, Math.min(180, delta)) * .002)
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (pendingZoom ?? zoomRef.current) * factor))
      if (nextZoom === (pendingZoom ?? zoomRef.current)) return
      const rect = target.getBoundingClientRect()
      zoomAnchorRef.current = {
        clientX: event.clientX, clientY: event.clientY,
        pageX: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
        pageY: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
        fromZoom: zoomRef.current,
      }
      pendingZoom = nextZoom
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (pendingZoom === null) return
        const next = clampZoom(pendingZoom)
        setFitMode('none')
        if (next !== zoomRef.current) setZoom(next)
        else zoomAnchorRef.current = null
        pendingZoom = null
      }, 80)
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => { container.removeEventListener('wheel', onWheel); if (timer) clearTimeout(timer) }
  }, [])

  // 快捷键仅在 PDF 面板获得焦点时生效，不抢对话输入框或其他面板的命令。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (!target || !rootRef.current?.contains(target) || target.closest('[role="dialog"]')) return
      const typing = Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
      const command = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (command && key === 'f') { event.preventDefault(); setFindOpen(true); findInputRef.current?.focus(); return }
      if (command && key === 's') { event.preventDefault(); void save(event.shiftKey ? 'copy' : 'overwrite'); return }
      if ((command && key === 'g') || event.key === 'F3') { event.preventDefault(); jumpToMatch(matchIndex + (event.shiftKey ? -1 : 1)); return }
      if (typing) return
      if (command && (key === '+' || key === '=' || event.code === 'NumpadAdd')) { event.preventDefault(); setZoomManual(zoom * 1.25); return }
      if (command && (key === '-' || key === '_' || event.code === 'NumpadSubtract')) { event.preventDefault(); setZoomManual(zoom / 1.25); return }
      if (command && key === '0') { event.preventDefault(); setZoomManual(1); return }
      if (command && key === 'z') { if (!operations.length && !redo.length) return; event.preventDefault(); if (event.shiftKey) redoLast(); else undo(); return }
      if (command && key === 'y') { if (!redo.length) return; event.preventDefault(); redoLast(); return }
      if (command || event.altKey) return
      if (event.key === 'Escape') { event.preventDefault(); setDraft(null); setSelectedOpId(''); setFindOpen(false); return }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); setPageNumber((value) => Math.max(1, value - 1)); return }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); setPageNumber((value) => Math.min(pdf?.numPages || value, value + 1)); return }
      if (event.key === 'Home') { event.preventDefault(); setPageNumber(1); return }
      if (event.key === 'End') { event.preventDefault(); setPageNumber(pdf?.numPages || 1); return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedOpId) { event.preventDefault(); removeOperation(selectedOpId) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const selectedOperation = operations.find((item) => item.id === selectedOpId)
  const zoomLabel = fitMode === 'width' ? '适配宽度' : fitMode === 'page' ? '适配整页' : `${Math.round(zoom * 100)}%`
  const matchedPages = useMemo(() => new Set(matches.map((hit) => hit.page)), [matches])

  return <section ref={rootRef} className="pdf-editor" aria-label="PDF 编辑器" tabIndex={0} onPointerDown={(event) => {
    const target = event.target as HTMLElement
    if (!target.closest('button, input, textarea, select, [contenteditable="true"], [role="dialog"]')) rootRef.current?.focus({ preventScroll: true })
  }}>
    <div className="pdf-editor-toolbar">
      <div className="pdf-editor-tabs" role="tablist" aria-label="PDF 功能区">{([['read', '阅读'], ['annotate', '批注'], ['pages', '页面']] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); if (id !== 'annotate' || tool === 'ask') setTool('select') }}>{label}</button>)}</div>
      <div className="pdf-editor-tool-group trailing">
        <button type="button" className={railOpen ? 'active' : ''} onClick={() => setRailOpen((value) => !value)} title="缩略图" aria-label="缩略图" aria-pressed={railOpen}><PanelLeft size={15} /></button>
        <button type="button" className={findOpen ? 'active' : ''} onClick={() => setFindOpen((value) => !value)} title="查找（Ctrl/⌘+F）" aria-label="查找"><FileSearch size={15} /></button>
        <button type="button" className={opsOpen ? 'active' : ''} onClick={() => setOpsOpen((value) => !value)} disabled={!operations.length} title={`待保存 ${operations.length} 项`} aria-label="待保存修改列表"><ListChecks size={15} /><span>{operations.length || ''}</span></button>
        {stale && <button type="button" className="pdf-stale" onClick={refresh} title="文件已被其他程序修改，点击刷新" aria-label="刷新文件"><RefreshCw size={15} /><span>刷新</span></button>}
        <button type="button" onClick={undo} disabled={!operations.length} title="撤销（Ctrl/⌘+Z）" aria-label="撤销"><Undo2 size={15} /></button>
        <button type="button" onClick={redoLast} disabled={!redo.length} title="重做（Ctrl/⌘+Shift+Z 或 Ctrl+Y）" aria-label="重做"><Redo2 size={15} /></button>
        <button type="button" onClick={() => void save('copy')} disabled={!operations.length || saving} title="另存为副本（Ctrl/⌘+Shift+S）" aria-label="另存为"><SaveAll size={15} /><span>另存为</span></button>
        <button className="pdf-save" type="button" onClick={() => void save('overwrite')} disabled={!operations.length || saving} title="保存并覆盖原文件（Ctrl/⌘+S，保存前自动备份）" aria-label="保存 PDF">{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}<span>保存</span></button>
      </div>
    </div>
    <div className="pdf-editor-ribbon" role="toolbar" aria-label={`${tab === 'pages' ? '页面' : tab === 'annotate' ? '批注' : '阅读'}工具`}>
      {tab !== 'pages' && tools.filter(({ id }) => tab === 'read' ? ['select', 'ask'].includes(id) : id !== 'ask').map(({ id, label, icon: Icon }) => <button key={id} type="button" className={tool === id ? 'active' : ''} disabled={pageBusy || (!editing && !['select', 'ask'].includes(id))} onClick={() => { setTool(id); setSelectedText(''); setSelectedOpId(''); window.getSelection()?.removeAllRanges() }} title={editing || ['select', 'ask'].includes(id) ? label : `${label}（先点「进入编辑」）`} aria-label={label} aria-pressed={tool === id}><Icon size={15} /><span>{label}</span></button>)}
      {tab === 'read' && <button type="button" onClick={() => void unwrapDesktop(window.zsenseDesktop!.pdf.openExternally(document.filePath)).catch((reason) => onFeedback({ tone: 'error', message: friendlyPdfError(reason) }))} title="使用系统默认 PDF 应用打开"><FileDown size={15} /><span>系统打开</span></button>}
      {tab === 'annotate' && <><span className="pdf-ribbon-divider" /><span className="pdf-ribbon-colors" aria-label="新批注颜色">{palette.map((color) => <button key={color} type="button" className={inkColor === color ? 'active' : ''} style={{ '--swatch': color } as CSSProperties} onClick={() => setInkColor(color)} title={`新批注颜色 ${color}`} aria-label={`新批注颜色 ${color}`} />)}</span><label className="pdf-stroke-control">线宽 <select value={strokeWidth} onChange={(event) => setStrokeWidth(Number(event.target.value))} aria-label="批注线宽"><option value={1}>1</option><option value={2}>2</option><option value={4}>4</option></select></label></>}
      {tab === 'pages' && <>
        <button type="button" disabled={!editing || pageBusy || !pdf} onClick={() => void runPageAction('rotateLeft')} title="当前页向左旋转 90°"><RotateCcw size={15} /><span>左旋</span></button>
        <button type="button" disabled={!editing || pageBusy || !pdf} onClick={() => void runPageAction('rotateRight')} title="当前页向右旋转 90°"><RotateCw size={15} /><span>右旋</span></button>
        <span className="pdf-ribbon-divider" />
        <button type="button" disabled={!editing || pageBusy || pageNumber <= 1} onClick={() => void runPageAction('moveUp')} title="当前页前移一页"><ArrowUp size={15} /><span>前移</span></button>
        <button type="button" disabled={!editing || pageBusy || !pdf || pageNumber >= pdf.numPages} onClick={() => void runPageAction('moveDown')} title="当前页后移一页"><ArrowDown size={15} /><span>后移</span></button>
        <button type="button" disabled={!editing || pageBusy || !pdf} onClick={() => void runPageAction('duplicate')} title="复制当前页并插到后面"><Copy size={15} /><span>复制页</span></button>
        <button type="button" disabled={!editing || pageBusy || !pdf} onClick={() => void runPageAction('insertBlank')} title="在当前页后插入同尺寸空白页"><FilePlus2 size={15} /><span>空白页</span></button>
        <button type="button" disabled={!editing || pageBusy || !pdf} onClick={() => void runPageAction('merge')} title="选择另一份 PDF，插入到当前页后"><FolderPlus size={15} /><span>合并</span></button>
        <button type="button" disabled={!editing || pageBusy || !pdf} onClick={() => void runPageAction('extract')} title="提取当前页并另存为 PDF，原文件不变"><FileDown size={15} /><span>提取</span></button>
        <button type="button" disabled={!editing || pageBusy || !pdf || pdf.numPages <= 1} onClick={() => void runPageAction('delete')} title="删除当前页（自动备份原文件）"><Trash2 size={15} /><span>删页</span></button>
        {pageBusy && <LoaderCircle className="spin" size={15} aria-label="正在处理页面" />}
      </>}
    </div>
    {findOpen && <div className="pdf-editor-find">
      <input ref={findInputRef} autoFocus value={query} placeholder="在整份 PDF 中查找…" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); jumpToMatch(matchIndex + (event.shiftKey ? -1 : 1)) } if (event.key === 'Escape') setFindOpen(false) }} aria-label="查找内容" />
      <span>{searching ? '查找中…' : matches.length ? `${matchIndex + 1} / ${matches.length}` : normalizedQuery ? '没有命中' : ''}</span>
      <button type="button" disabled={!matches.length} onClick={() => jumpToMatch(matchIndex - 1)} title="上一处" aria-label="上一处"><ChevronLeft size={15} /></button>
      <button type="button" disabled={!matches.length} onClick={() => jumpToMatch(matchIndex + 1)} title="下一处" aria-label="下一处"><ChevronRight size={15} /></button>
      <button type="button" onClick={() => { setFindOpen(false); setQuery('') }} title="关闭查找" aria-label="关闭查找"><X size={15} /></button>
    </div>}
    {opsOpen && <div className="pdf-editor-ops">
      <strong>待保存 {operations.length} 项</strong>
      <ul>{operations.map((item) => <li key={item.id}><button type="button" onClick={() => setPageNumber(item.page)}>第 {item.page} 页 · {operationLabels[item.type]}{item.text ? `：${item.text.slice(0, 18)}` : ''}</button><button type="button" onClick={() => removeOperation(item.id)} title="删除这一项" aria-label="删除这一项"><Trash2 size={13} /></button></li>)}</ul>
    </div>}
    <div className="pdf-editor-navigation">
      <button type="button" disabled={pageNumber <= 1} onClick={() => setPageNumber(1)} title="第一页" aria-label="第一页"><ChevronsLeft size={16} /></button>
      <button type="button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)} title="上一页（←）" aria-label="上一页"><ChevronLeft size={16} /></button>
      <input className="pdf-page-input" value={pageDraft} inputMode="numeric" onChange={(event) => setPageDraft(event.target.value.replace(/[^0-9]/g, ''))} onKeyDown={(event) => { if (event.key !== 'Enter') return; const next = Math.max(1, Math.min(pdf?.numPages || 1, Number(pageDraft) || 1)); setPageNumber(next); setPageDraft(String(next)) }} onBlur={() => setPageDraft(String(pageNumber))} aria-label="跳到页码" />
      <span>/ {pdf?.numPages || '—'}</span>
      <button type="button" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => setPageNumber((value) => value + 1)} title="下一页（→）" aria-label="下一页"><ChevronRight size={16} /></button>
      <button type="button" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => setPageNumber(pdf?.numPages || pageNumber)} title="最后一页" aria-label="最后一页"><ChevronsRight size={16} /></button>
      <i />
      <button type="button" onClick={() => setZoomManual(zoom - .25)} disabled={zoom <= .25} title="缩小" aria-label="缩小"><ZoomOut size={16} /></button>
      <button type="button" className="pdf-zoom-label" onClick={() => setZoomManual(1)} title="恢复到 100%" aria-label="恢复到 100%">{zoomLabel}</button>
      <button type="button" onClick={() => setZoomManual(zoom + .25)} disabled={zoom >= 3} title="放大" aria-label="放大"><ZoomIn size={16} /></button>
      <button type="button" className={fitMode === 'width' ? 'active' : ''} onClick={() => { setFitMode('width'); applyFit('width') }} title="适配宽度" aria-label="适配宽度"><Columns2 size={16} /></button>
      <button type="button" className={fitMode === 'page' ? 'active' : ''} onClick={() => { setFitMode('page'); applyFit('page') }} title="适配整页" aria-label="适配整页"><ScanSearch size={16} /></button>
      {selectedText && onAskAI && <button className="pdf-selected-ask" type="button" onClick={() => onAskAI(`请根据 PDF《${document.name}》第 ${pageNumber} 页所选内容回答：\n\n${selectedText.slice(0, 5_000)}`, 'insert')}><MessageSquareText size={15} />选中文字问 AI</button>}
    </div>
    <div className="pdf-editor-body">
      {railOpen && <aside className="pdf-thumb-list" aria-label="页面缩略图">{[...Array(pdf?.numPages || 0)].map((_, index) => {
        const number = index + 1
        return <button key={number} type="button" data-thumb={number} className={`pdf-thumb ${number === pageNumber ? 'active' : ''} ${matchedPages.has(number) ? 'matched' : ''}`} onClick={() => setPageNumber(number)} title={`第 ${number} 页`}><span className="pdf-thumb-frame">{thumbs[number] ? <img src={thumbs[number]} alt={`第 ${number} 页预览`} /> : <LoaderCircle className="spin" size={14} />}</span><em>{number}</em></button>
      })}</aside>}
      <div className="pdf-editor-scroll" ref={scrollRef}>
        {loading && <div className="pdf-editor-loading"><LoaderCircle className="spin" size={21} />正在本地加载 PDF{loadProgress ? ` · ${loadProgress}%` : '…'}</div>}
        {page && viewport && <div ref={pageRef} className={`pdf-editor-page tool-${tool}`} style={{ width: viewport.width, height: viewport.height }} onPointerDown={() => setSelectedOpId('')}>
          <canvas ref={canvasRef} aria-label={`PDF 第 ${pageNumber} 页`} />
          <div className="pdf-editor-text-layer" ref={textLayerRef} onMouseUp={() => { if (tool === 'select') setSelectedText(window.getSelection()?.toString().trim() || '') }}>{textSpans.map((span, index) => <span key={index} className={normalizedQuery && span.text.toLowerCase().includes(normalizedQuery) ? 'pdf-editor-text-hit' : ''} style={{ left: span.left, top: span.top, minWidth: span.width, height: span.height, fontSize: span.size, transform: `rotate(${span.angle}rad)` }}>{span.text}</span>)}</div>
          <div className="pdf-editor-annotations">{currentOps.map((item) => <div key={item.id} role="button" tabIndex={editing ? 0 : -1} aria-label={`第 ${item.page} 页 ${operationLabels[item.type]}`} className={`pdf-editor-operation ${item.type} ${item.id === selectedOpId ? 'selected' : ''}`} onClick={(event) => { if (!editing) return; event.stopPropagation(); setSelectedOpId(item.id) }} style={{ left: pageRectToView(item).left, top: pageRectToView(item).top, width: pageRectToView(item).width, height: pageRectToView(item).height, borderColor: item.color, color: item.type === 'text' ? item.color : undefined, '--annotation-color': item.color, '--annotation-width': `${item.strokeWidth || 2}px`, background: item.type === 'highlight' ? `${item.color}66` : item.type === 'cover' ? '#fff' : undefined } as CSSProperties}>{item.type === 'text' ? item.text : null}</div>)}</div>
          {selectedOperation && <div className="pdf-editor-op-actions" role="toolbar" aria-label="标注操作">
            {selectedOperation.type !== 'cover' && <span className="pdf-editor-op-colors" aria-label="改颜色">{palette.map((color) => <button key={color} type="button" className={selectedOperation.color === color ? 'active' : ''} style={{ background: color }} onClick={() => recolor(selectedOperation.id, color)} title={`改成 ${color}`} aria-label={`改成 ${color}`} />)}</span>}
            <button type="button" onClick={() => removeOperation(selectedOperation.id)} title="删除这个标注（Delete）" aria-label="删除这个标注"><Trash2 size={14} />删除</button>
          </div>}
          {tool !== 'select' && !pageBusy && <div className="pdf-editor-interaction" onPointerDown={(event) => { if (event.button !== 0) return; const start = point(event); if (tool === 'text') { setDraft({ ...start, text: '' }); return } event.currentTarget.setPointerCapture(event.pointerId); setDrag({ ...start, currentX: start.x, currentY: start.y }) }} onPointerMove={(event) => { if (drag) { const current = point(event); setDrag((value) => value ? { ...value, currentX: current.x, currentY: current.y } : null) } }} onPointerUp={finishDrag}>{drag && <div className="pdf-editor-drag" style={{ left: Math.min(drag.x, drag.currentX), top: Math.min(drag.y, drag.currentY), width: Math.abs(drag.x - drag.currentX), height: Math.abs(drag.y - drag.currentY) }} />}</div>}
          {draft && <div className="pdf-editor-text-draft" style={{ left: draft.x, top: draft.y }}><textarea autoFocus value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} placeholder="输入要添加的文字" rows={3} /><div><button type="button" onClick={() => setDraft(null)}>取消</button><button type="button" onClick={saveText} disabled={!draft.text.trim()}>插入</button></div></div>}
        </div>}
      </div>
    </div>
    <div className="pdf-editor-hint">{editing ? '批注需点击「保存」写回；页面整理操作会立即写入并自动备份。白色遮盖只改变外观，不会删除底层文字。' : '选择文字或划区可问 AI；点击「进入编辑」可使用批注与页面整理。'}{operations.length > 0 ? ` 待保存 ${operations.length} 项。` : ''}{' '}PDF 聚焦后：Ctrl/⌘+滚轮或 +/- 缩放，Ctrl/⌘+0 恢复 100%，Ctrl/⌘+F 查找、G/F3 下一处、S 保存、Shift+S 另存、Z/Y 撤销重做；PageUp/Down 翻页，Home/End 首尾页。</div>
    {screenshot && onAnnotatedScreenshot && <ScreenshotAnnotationDialog sourceDataUrl={screenshot.dataUrl} sourceName={screenshot.name} workspacePath={workspacePath} onClose={() => setScreenshot(null)} onComplete={onAnnotatedScreenshot} />}
  </section>
}
