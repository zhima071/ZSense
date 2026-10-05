import {
  AlertTriangle, ArrowUpRight, Bot, Check, Circle, Copy, Hand, Image as ImageIcon, LoaderCircle,
  Maximize2, MousePointer2, Paintbrush, Redo2, Save, Scissors, Square, StickyNote, Trash2, Type, Undo2,
  X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { ChatAttachment } from '../types'
import { ScreenshotAnnotationDialog } from './ScreenshotAnnotationDialog'

type CanvasTool = 'select' | 'hand' | 'rectangle' | 'ellipse' | 'text' | 'note' | 'arrow'
type CanvasNodeType = Exclude<CanvasTool, 'select' | 'hand'> | 'image' | 'pdf'

interface CanvasNode {
  id: string
  type: CanvasNodeType
  x: number
  y: number
  width: number
  height: number
  rotation: number
  text: string
  fill: string
  stroke: string
  strokeWidth: number
  fontSize: number
  textColor: string
  opacity: number
  assetPath: string
  assetName: string
  sourceFingerprint: string
  sourcePath: string
  sourceConversationId: string
  fromX: number
  fromY: number
  toX: number
  toY: number
  locked: boolean
}

interface CanvasPage { id: string; name: string; nodes: CanvasNode[] }
interface CanvasDocument {
  format: 'zsense-canvas'; version: 1; id: string; title: string; createdAt: string; updatedAt: string
  activePageId: string; pages: CanvasPage[]
}

interface ZSenseCanvasPaneProps {
  workspacePath: string
  conversationId: string
  importPath?: string
  importRequestKey?: number
  onClose: () => void
  onAskAI: (prompt: string, behavior: 'send' | 'insert') => void
  onAnnotatedScreenshot: (attachment: ChatAttachment, requirement: string, sendImmediately: boolean) => void | Promise<void>
}

interface Point { x: number; y: number }
interface Interaction {
  kind: 'pan' | 'move' | 'resize' | 'draw'
  pointerId: number
  startClient: Point
  startCanvas: Point
  startPan: Point
  nodeId?: string
  handle?: 'nw' | 'ne' | 'sw' | 'se'
  node?: CanvasNode
  before?: CanvasDocument
}

const toolItems: Array<{ id: CanvasTool; label: string; icon: typeof MousePointer2 }> = [
  { id: 'select', label: '选择', icon: MousePointer2 },
  { id: 'hand', label: '平移画布', icon: Hand },
  { id: 'rectangle', label: '矩形', icon: Square },
  { id: 'ellipse', label: '圆形', icon: Circle },
  { id: 'text', label: '文字', icon: Type },
  { id: 'note', label: '便签', icon: StickyNote },
  { id: 'arrow', label: '箭头', icon: ArrowUpRight },
]

const palette = ['#ffffff', '#dbeafe', '#dcfce7', '#fef3c7', '#fee2e2', '#ede9fe', '#172033']
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const newId = () => `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))

function assetUrl(workspacePath: string, assetPath: string) {
  const url = new URL('zsense-canvas://asset/file')
  url.searchParams.set('workspacePath', workspacePath)
  url.searchParams.set('assetPath', assetPath)
  return url.toString()
}

function nodeLabel(node: CanvasNode) {
  return node.text || node.assetName || ({ rectangle: '矩形', ellipse: '圆形', note: '便签', arrow: '箭头', text: '文字', image: '图片', pdf: 'PDF' } as Record<string, string>)[node.type] || '画布元素'
}

function savedTimeLabel(value: string) {
  if (!value) return '尚未保存'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '已手动保存'
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  const time = date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return sameDay ? `保存于 ${time}` : `保存于 ${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`
}

export function ZSenseCanvasPane({ workspacePath, conversationId, importPath = '', importRequestKey = 0, onClose, onAskAI, onAnnotatedScreenshot }: ZSenseCanvasPaneProps) {
  const paneRef = useRef<HTMLElement>(null)
  const surfaceRef = useRef<SVGSVGElement>(null)
  const documentRef = useRef<CanvasDocument | null>(null)
  const historyRef = useRef<CanvasDocument[]>([])
  const historyIndexRef = useRef(-1)
  const importedRequestRef = useRef('')
  const interactionRef = useRef<Interaction | null>(null)
  const savedSnapshotRef = useRef('')
  const dirtyRef = useRef(false)
  const clientIdRef = useRef(`canvas-${newId()}`)
  const [document, setDocument] = useState<CanvasDocument | null>(null)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [selectionId, setSelectionId] = useState('')
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 })
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 })
  const [panePercent, setPanePercent] = useState(() => {
    const stored = Number(window.localStorage.getItem('zsense.canvasPaneWidthPercent'))
    return Number.isFinite(stored) && stored >= 42 && stored <= 78 ? stored : 62
  })
  const [busy, setBusy] = useState<'loading' | 'importing' | 'saving' | ''>('loading')
  const [savedAt, setSavedAt] = useState('')
  const [dirty, setDirty] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [capturePreparing, setCapturePreparing] = useState(false)
  const [capturedScreenshot, setCapturedScreenshot] = useState<{ dataUrl: string; name: string } | null>(null)

  const page = useMemo(() => document?.pages.find((item) => item.id === document.activePageId) || document?.pages[0], [document])
  const selected = page?.nodes.find((node) => node.id === selectionId) || null
  const inspectorStyle = useMemo<CSSProperties | undefined>(() => {
    if (!selected) return undefined
    const availableWidth = Math.max(180, surfaceSize.width - 24)
    const isFile = selected.type === 'image' || selected.type === 'pdf'
    const preferredWidth = isFile ? clamp(selected.width * viewport.zoom, 320, 420) : 300
    const panelWidth = Math.min(preferredWidth, availableWidth)
    const anchorX = viewport.x + (selected.x + selected.width / 2) * viewport.zoom
    const maximumLeft = Math.max(12, surfaceSize.width - panelWidth - 12)
    const top = viewport.y + (selected.y + selected.height) * viewport.zoom + 12
    return {
      left: clamp(anchorX - panelWidth / 2, 12, maximumLeft),
      top,
      width: panelWidth,
      maxHeight: Math.max(120, surfaceSize.height - top - 12),
    }
  }, [selected, surfaceSize, viewport])

  useEffect(() => { documentRef.current = document }, [document])
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const update = () => setSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  const updateDirtyState = useCallback((next: CanvasDocument) => {
    const nextDirty = JSON.stringify(next) !== savedSnapshotRef.current
    dirtyRef.current = nextDirty
    setDirty(nextDirty)
  }, [])

  const resetHistory = useCallback((next: CanvasDocument) => {
    const snapshot = clone(next)
    historyRef.current = [snapshot]
    historyIndexRef.current = 0
    setDocument(snapshot)
  }, [])

  const record = useCallback((next: CanvasDocument) => {
    const snapshot = clone(next)
    const prefix = historyRef.current.slice(0, historyIndexRef.current + 1)
    historyRef.current = [...prefix, snapshot].slice(-100)
    historyIndexRef.current = historyRef.current.length - 1
    setDocument(snapshot)
    updateDirtyState(snapshot)
  }, [updateDirtyState])

  const recordCurrent = useCallback(() => {
    if (!documentRef.current) return
    const current = clone(documentRef.current)
    const previous = historyRef.current[historyIndexRef.current]
    if (previous && JSON.stringify(previous) === JSON.stringify(current)) return
    const prefix = historyRef.current.slice(0, historyIndexRef.current + 1)
    historyRef.current = [...prefix, current].slice(-100)
    historyIndexRef.current = historyRef.current.length - 1
  }, [])

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    const snapshot = clone(historyRef.current[historyIndexRef.current])
    setDocument(snapshot)
    updateDirtyState(snapshot)
  }, [updateDirtyState])

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    historyIndexRef.current += 1
    const snapshot = clone(historyRef.current[historyIndexRef.current])
    setDocument(snapshot)
    updateDirtyState(snapshot)
  }, [updateDirtyState])

  useEffect(() => {
    if (!window.zsenseDesktop?.canvas) { setBusy(''); setFeedback('ZSense 画布仅支持桌面应用。'); return }
    let cancelled = false
    setBusy('loading')
    unwrapDesktop(window.zsenseDesktop.canvas.load(workspacePath)).then((result) => {
      if (cancelled) return
      const next = result.document as CanvasDocument
      savedSnapshotRef.current = JSON.stringify(next)
      dirtyRef.current = false
      setDirty(false)
      setSavedAt(result.savedAt || '')
      resetHistory(next)
      setBusy('')
    }).catch((reason) => { if (!cancelled) { setBusy(''); setFeedback(`画布加载失败：${errorMessage(reason)}`) } })
    return () => { cancelled = true }
  }, [resetHistory, workspacePath])

  useEffect(() => window.zsenseDesktop?.canvas?.onChanged((event) => {
    if (event.workspacePath !== workspacePath || event.sourceClientId === clientIdRef.current) return
    if (dirtyRef.current) {
      setFeedback('画布有未保存更改，暂未覆盖为外部更新。请先保存后再重新打开。')
      return
    }
    const next = event.document as CanvasDocument
    savedSnapshotRef.current = JSON.stringify(next)
    setSavedAt(next.updatedAt || '')
    setDirty(false)
    resetHistory(next)
  }), [resetHistory, workspacePath])

  const focusNode = useCallback((node: Pick<CanvasNode, 'x' | 'y' | 'width' | 'height'>) => {
    window.requestAnimationFrame(() => {
      const bounds = surfaceRef.current?.getBoundingClientRect()
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return
      setViewport((current) => {
        const inspectorSpace = 220
        const fitZoom = clamp(Math.min((bounds.width - 96) / Math.max(node.width, 1), (bounds.height - inspectorSpace - 72) / Math.max(node.height, 1), 1.35), .2, 2)
        const zoom = clamp(Math.min(Math.max(current.zoom, .35), fitZoom), .2, 2)
        const renderedHeight = node.height * zoom
        const groupTop = Math.max(24, (bounds.height - renderedHeight - inspectorSpace - 12) / 2)
        return {
          zoom,
          x: bounds.width / 2 - (node.x + node.width / 2) * zoom,
          y: groupTop - node.y * zoom,
        }
      })
    })
  }, [])

  const saveCanvas = useCallback(async () => {
    const current = documentRef.current
    if (!current || !window.zsenseDesktop?.canvas || busy) return
    setBusy('saving')
    setFeedback('')
    try {
      const result = await unwrapDesktop(window.zsenseDesktop.canvas.save(workspacePath, current, clientIdRef.current))
      const saved = clone(result.document as CanvasDocument)
      historyRef.current[historyIndexRef.current] = saved
      savedSnapshotRef.current = JSON.stringify(saved)
      dirtyRef.current = false
      setDocument(saved)
      setDirty(false)
      setSavedAt(result.savedAt)
      setFeedback('')
    } catch (reason) {
      setFeedback(`画布保存失败：${errorMessage(reason)}`)
    } finally {
      setBusy('')
    }
  }, [busy, workspacePath])

  useEffect(() => {
    if (!importPath || !document || busy === 'loading' || !window.zsenseDesktop?.canvas) return
    const requestId = `${importRequestKey}:${importPath}`
    if (requestId === importedRequestRef.current) return
    importedRequestRef.current = requestId
    setBusy('importing')
    setFeedback('')
    unwrapDesktop(window.zsenseDesktop.canvas.importFile(workspacePath, importPath, clientIdRef.current, documentRef.current, conversationId)).then((result) => {
      const next = result.document as CanvasDocument
      if (result.existing) {
        setDocument(next)
        updateDirtyState(next)
      } else {
        record(next)
      }
      setSelectionId(result.node.id)
      setTool('select')
      setFeedback('')
      focusNode(result.node)
    }).catch((reason) => setFeedback(`文件加入画布失败：${errorMessage(reason)}`)).finally(() => setBusy(''))
  }, [busy, conversationId, document, focusNode, importPath, importRequestKey, record, updateDirtyState, workspacePath])

  useEffect(() => {
    const container = paneRef.current?.parentElement
    if (!container) return
    container.style.setProperty('--canvas-pane-width', `${panePercent}%`)
    window.localStorage.setItem('zsense.canvasPaneWidthPercent', String(panePercent))
    return () => { container.style.removeProperty('--canvas-pane-width') }
  }, [panePercent])

  const canvasPoint = useCallback((clientX: number, clientY: number): Point => {
    const bounds = surfaceRef.current?.getBoundingClientRect()
    return bounds ? { x: (clientX - bounds.left - viewport.x) / viewport.zoom, y: (clientY - bounds.top - viewport.y) / viewport.zoom } : { x: 0, y: 0 }
  }, [viewport])

  const updateNode = useCallback((nodeId: string, patch: Partial<CanvasNode>, commit = false) => {
    const current = documentRef.current
    if (!current) return
    const next = clone(current)
    const activePage = next.pages.find((item) => item.id === next.activePageId) || next.pages[0]
    const index = activePage.nodes.findIndex((node) => node.id === nodeId)
    if (index < 0) return
    activePage.nodes[index] = { ...activePage.nodes[index], ...patch, id: activePage.nodes[index].id }
    if (commit) record(next)
    else {
      setDocument(next)
      updateDirtyState(next)
    }
  }, [record, updateDirtyState])

  const addNode = useCallback((node: Partial<CanvasNode>) => {
    const current = documentRef.current
    if (!current) return
    const next = clone(current)
    const activePage = next.pages.find((item) => item.id === next.activePageId) || next.pages[0]
    const complete: CanvasNode = {
      id: node.id || newId(), type: node.type || 'rectangle', x: node.x || 0, y: node.y || 0,
      width: Math.max(24, node.width || 240), height: Math.max(24, node.height || 140), rotation: 0,
      text: node.text || '', fill: node.fill || '#ffffff', stroke: node.stroke || '#2563eb', strokeWidth: 2,
      fontSize: node.fontSize || 18, textColor: '#172033', opacity: 1, assetPath: '', assetName: '',
      sourceFingerprint: node.sourceFingerprint || '', sourcePath: node.sourcePath || '', sourceConversationId: node.sourceConversationId || '',
      fromX: node.fromX || 0, fromY: node.fromY || 0, toX: node.toX || node.width || 180, toY: node.toY || node.height || 100, locked: false,
    }
    activePage.nodes.push(complete)
    record(next)
    setSelectionId(complete.id)
  }, [record])

  const deleteSelected = useCallback(() => {
    const current = documentRef.current
    if (!current || !selectionId) return
    const next = clone(current)
    const activePage = next.pages.find((item) => item.id === next.activePageId) || next.pages[0]
    activePage.nodes = activePage.nodes.filter((node) => node.id !== selectionId)
    record(next)
    setSelectionId('')
  }, [record, selectionId])

  const duplicateSelected = useCallback(() => {
    if (!selected) return
    addNode({ ...selected, id: newId(), x: selected.x + 24, y: selected.y + 24, sourceFingerprint: '', sourcePath: '', sourceConversationId: '' })
  }, [addNode, selected])

  const beginSurface = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 && event.button !== 1) return
    const point = canvasPoint(event.clientX, event.clientY)
    if (event.button === 1 || tool === 'hand' || event.altKey) {
      interactionRef.current = { kind: 'pan', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startCanvas: point, startPan: { x: viewport.x, y: viewport.y } }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (tool === 'select') { setSelectionId(''); return }
    const type = tool as CanvasNodeType
    const node: CanvasNode = {
      id: newId(), type, x: point.x, y: point.y, width: type === 'text' ? 240 : 1, height: type === 'text' ? 72 : 1,
      rotation: 0, text: type === 'text' ? '输入文字' : type === 'note' ? '新便签' : '',
      fill: type === 'note' ? '#fef3c7' : '#ffffff', stroke: '#2563eb', strokeWidth: 2, fontSize: 18,
      textColor: '#172033', opacity: 1, assetPath: '', assetName: '', sourceFingerprint: '', sourcePath: '', sourceConversationId: '',
      fromX: 0, fromY: 0, toX: 1, toY: 1, locked: false,
    }
    interactionRef.current = { kind: 'draw', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startCanvas: point, startPan: { x: viewport.x, y: viewport.y }, node, before: clone(documentRef.current!) }
    const next = clone(documentRef.current!)
    ;(next.pages.find((item) => item.id === next.activePageId) || next.pages[0]).nodes.push(node)
    setDocument(next)
    updateDirtyState(next)
    setSelectionId(node.id)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const beginNode = (event: ReactPointerEvent<SVGGElement>, node: CanvasNode) => {
    if (tool !== 'select' || node.locked || event.button !== 0) return
    event.stopPropagation()
    setSelectionId(node.id)
    const point = canvasPoint(event.clientX, event.clientY)
    interactionRef.current = { kind: 'move', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startCanvas: point, startPan: { x: viewport.x, y: viewport.y }, nodeId: node.id, node: clone(node), before: clone(documentRef.current!) }
    surfaceRef.current?.setPointerCapture(event.pointerId)
  }

  const beginResize = (event: ReactPointerEvent<SVGCircleElement>, handle: Interaction['handle']) => {
    if (!selected) return
    event.stopPropagation()
    interactionRef.current = { kind: 'resize', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startCanvas: canvasPoint(event.clientX, event.clientY), startPan: { x: viewport.x, y: viewport.y }, nodeId: selected.id, node: clone(selected), handle, before: clone(documentRef.current!) }
    surfaceRef.current?.setPointerCapture(event.pointerId)
  }

  const movePointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    if (interaction.kind === 'pan') {
      setViewport((current) => ({ ...current, x: interaction.startPan.x + event.clientX - interaction.startClient.x, y: interaction.startPan.y + event.clientY - interaction.startClient.y }))
      return
    }
    const point = canvasPoint(event.clientX, event.clientY)
    if (interaction.kind === 'move' && interaction.node && interaction.nodeId) {
      updateNode(interaction.nodeId, { x: interaction.node.x + point.x - interaction.startCanvas.x, y: interaction.node.y + point.y - interaction.startCanvas.y })
      return
    }
    if (interaction.kind === 'draw' && interaction.node) {
      const x = Math.min(interaction.startCanvas.x, point.x)
      const y = Math.min(interaction.startCanvas.y, point.y)
      const width = Math.max(1, Math.abs(point.x - interaction.startCanvas.x))
      const height = Math.max(1, Math.abs(point.y - interaction.startCanvas.y))
      updateNode(interaction.node.id, interaction.node.type === 'arrow'
        ? { x: interaction.startCanvas.x, y: interaction.startCanvas.y, width, height, fromX: 0, fromY: 0, toX: point.x - interaction.startCanvas.x, toY: point.y - interaction.startCanvas.y }
        : { x, y, width, height })
      return
    }
    if (interaction.kind === 'resize' && interaction.node && interaction.nodeId) {
      const original = interaction.node
      let x = original.x; let y = original.y; let width = original.width; let height = original.height
      const dx = point.x - interaction.startCanvas.x; const dy = point.y - interaction.startCanvas.y
      if (interaction.handle?.includes('e')) width = Math.max(24, original.width + dx)
      if (interaction.handle?.includes('s')) height = Math.max(24, original.height + dy)
      if (interaction.handle?.includes('w')) { x = Math.min(original.x + original.width - 24, original.x + dx); width = Math.max(24, original.width - dx) }
      if (interaction.handle?.includes('n')) { y = Math.min(original.y + original.height - 24, original.y + dy); height = Math.max(24, original.height - dy) }
      updateNode(interaction.nodeId, { x, y, width, height })
    }
  }

  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    if (surfaceRef.current?.hasPointerCapture(event.pointerId)) surfaceRef.current.releasePointerCapture(event.pointerId)
    interactionRef.current = null
    if (interaction.kind !== 'pan') recordCurrent()
    if (interaction.kind === 'draw') setTool('select')
  }

  const onWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    if (!event.ctrlKey && !event.metaKey) {
      setViewport((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
      return
    }
    const bounds = surfaceRef.current?.getBoundingClientRect()
    if (!bounds) return
    const factor = Math.exp(-event.deltaY * 0.002)
    setViewport((current) => {
      const zoom = clamp(current.zoom * factor, 0.15, 4)
      const px = event.clientX - bounds.left; const py = event.clientY - bounds.top
      const wx = (px - current.x) / current.zoom; const wy = (py - current.y) / current.zoom
      return { zoom, x: px - wx * zoom, y: py - wy * zoom }
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const command = event.metaKey || event.ctrlKey
      if (command && event.key.toLowerCase() === 's') { event.preventDefault(); void saveCanvas(); return }
      if (target?.matches('input,textarea,[contenteditable="true"]')) return
      if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
      if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected() }
      if (event.key === 'Escape') { setTool('select'); setSelectionId('') }
      const shortcuts: Partial<Record<string, CanvasTool>> = { v: 'select', h: 'hand', r: 'rectangle', o: 'ellipse', t: 'text', n: 'note', a: 'arrow' }
      if (!command && shortcuts[event.key.toLowerCase()]) setTool(shortcuts[event.key.toLowerCase()]!)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteSelected, duplicateSelected, redo, saveCanvas, undo])

  const setPaneFromClientX = (clientX: number) => {
    const container = paneRef.current?.parentElement
    if (!container) return
    const bounds = container.getBoundingClientRect()
    setPanePercent(Math.round(clamp(((bounds.right - clientX) / bounds.width) * 100, 42, 78) * 10) / 10)
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') return setPanePercent(62)
    setPanePercent((current) => clamp(current + (event.key === 'ArrowLeft' ? 2 : -2), 42, 78))
  }

  const askAI = () => {
    if (!selected) return
    const details = selected.assetPath ? `文件：${selected.assetPath}` : `文字：${selected.text || '无'}；位置：(${Math.round(selected.x)}, ${Math.round(selected.y)})；尺寸：${Math.round(selected.width)}×${Math.round(selected.height)}`
    onAskAI(`请查看当前工作区 ZSense 画布中选中的“${nodeLabel(selected)}”（ID：${selected.id}，类型：${selected.type}）。${details}。请先读取画布状态，再根据我的后续要求处理这个元素。`, 'insert')
  }

  const captureCanvas = async () => {
    if (!surfaceRef.current || !window.zsenseDesktop?.screenshot || capturing) return
    setCapturing(true)
    setCapturePreparing(true)
    setFeedback('')
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())))
      const bounds = surfaceRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.round(bounds.left))
      const y = Math.max(0, Math.round(bounds.top))
      const width = Math.max(1, Math.round(Math.min(bounds.right, window.innerWidth) - x))
      const height = Math.max(1, Math.round(Math.min(bounds.bottom, window.innerHeight) - y))
      const result = await unwrapDesktop(window.zsenseDesktop.screenshot.captureRegion({ x, y, width, height }))
      setCapturedScreenshot({ dataUrl: result.dataUrl, name: result.name || 'ZSense-画布截图.png' })
    } catch (reason) {
      setFeedback(`画布截图失败：${errorMessage(reason)}`)
    } finally {
      setCapturePreparing(false)
      setCapturing(false)
    }
  }

  const statusText = busy === 'loading' ? '正在载入…' : busy === 'importing' ? '正在导入…' : busy === 'saving' ? '正在保存…' : dirty ? '有未保存更改' : savedTimeLabel(savedAt)
  const feedbackIsError = /失败|错误|不可用/.test(feedback)

  return <aside ref={paneRef} className={`zsense-canvas-pane ${capturePreparing ? 'is-capturing' : ''}`} aria-label="ZSense 画布">
    <div className="zsense-canvas-resize-handle" role="separator" aria-label="调整 ZSense 画布区域宽度" aria-orientation="vertical" aria-valuemin={42} aria-valuemax={78} aria-valuenow={Math.round(panePercent)} tabIndex={0}
      onPointerDown={(event) => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); setPaneFromClientX(event.clientX) } }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setPaneFromClientX(event.clientX) }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onDoubleClick={() => setPanePercent(62)} onKeyDown={resizeFromKeyboard} title="拖动调整宽度，双击恢复默认"><span /></div>
    <header className="zsense-canvas-header">
      <span className="zsense-canvas-icon"><Paintbrush size={17} /></span>
      <span className="zsense-canvas-title"><strong>ZSense 画布</strong><small>{statusText} · {page?.nodes.length || 0} 个元素</small></span>
      {busy ? <LoaderCircle className="spin" size={15} aria-label={statusText} /> : dirty ? <AlertTriangle className="zsense-canvas-unsaved-icon" size={15} aria-label="有未保存更改" /> : <Check size={15} aria-label="画布已保存" />}
      <button type="button" className="screenshot-trigger" onClick={() => void captureCanvas()} disabled={!document || Boolean(busy) || capturing} aria-label="截取当前画布并批注" title="截图并批注">{capturing ? <LoaderCircle className="spin" size={16} /> : <Scissors size={17} />}</button>
      <button type="button" className={dirty ? 'save-needed' : ''} onClick={() => void saveCanvas()} disabled={!document || Boolean(busy) || !dirty} aria-label="手动保存画布" title={dirty ? '保存画布' : '没有需要保存的更改'}><Save size={16} /></button>
      <button type="button" onClick={onClose} aria-label="关闭 ZSense 画布" title="关闭画布"><X size={17} /></button>
    </header>
    <div className="zsense-canvas-body">
      <nav className="zsense-canvas-toolbar" aria-label="画布工具">
        {toolItems.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={tool === item.id ? 'active' : ''} onClick={() => setTool(item.id)} aria-label={item.label} aria-pressed={tool === item.id} title={`${item.label}${({ select: ' (V)', hand: ' (H)', rectangle: ' (R)', ellipse: ' (O)', text: ' (T)', note: ' (N)', arrow: ' (A)' } as Record<string, string>)[item.id]}`}><Icon size={17} /></button> })}
        <span className="divider" />
        <button type="button" onClick={undo} aria-label="撤销" title="撤销"><Undo2 size={17} /></button>
        <button type="button" onClick={redo} aria-label="重做" title="重做"><Redo2 size={17} /></button>
      </nav>
      <svg ref={surfaceRef} className={`zsense-canvas-surface tool-${tool}`} tabIndex={0} aria-label="无限画布编辑区域" onPointerDown={beginSurface} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer} onWheel={onWheel}>
        <defs>
          <pattern id="zsense-canvas-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#cbd5e1" /></pattern>
          <marker id="zsense-arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="context-stroke" /></marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#zsense-canvas-grid)" pointerEvents="none" />
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          {page?.nodes.map((node) => <g key={node.id} className={`zsense-canvas-node ${selectionId === node.id ? 'selected' : ''}`} transform={`translate(${node.x} ${node.y}) rotate(${node.rotation})`} opacity={node.opacity} onPointerDown={(event) => beginNode(event, node)} onDoubleClick={(event) => { event.stopPropagation(); setSelectionId(node.id) }} role="img" aria-label={nodeLabel(node)}>
            {node.type === 'rectangle' && <rect width={node.width} height={node.height} rx="10" fill={node.fill} stroke={node.stroke} strokeWidth={node.strokeWidth} />}
            {node.type === 'ellipse' && <ellipse cx={node.width / 2} cy={node.height / 2} rx={node.width / 2} ry={node.height / 2} fill={node.fill} stroke={node.stroke} strokeWidth={node.strokeWidth} />}
            {(node.type === 'text' || node.type === 'note') && <><rect width={node.width} height={node.height} rx={node.type === 'note' ? 8 : 4} fill={node.type === 'note' ? node.fill : 'rgba(255,255,255,.78)'} stroke={node.type === 'note' ? '#f59e0b' : node.stroke} strokeWidth={node.type === 'note' ? 1 : node.strokeWidth} /><foreignObject x="8" y="6" width={Math.max(1, node.width - 16)} height={Math.max(1, node.height - 12)} pointerEvents="none"><div className="zsense-canvas-node-text" style={{ color: node.textColor, fontSize: `${node.fontSize}px` }}>{node.text}</div></foreignObject></>}
            {node.type === 'arrow' && <line x1={node.fromX} y1={node.fromY} x2={node.toX} y2={node.toY} stroke={node.stroke} strokeWidth={Math.max(2, node.strokeWidth)} markerEnd="url(#zsense-arrowhead)" />}
            {node.type === 'image' && <foreignObject width={node.width} height={node.height}><div className="zsense-canvas-file-node"><img src={assetUrl(workspacePath, node.assetPath)} alt={node.assetName || '画布图片'} draggable={false} /></div></foreignObject>}
            {node.type === 'pdf' && <foreignObject width={node.width} height={node.height}><div className="zsense-canvas-file-node pdf"><header><span><ImageIcon size={14} />{node.assetName}</span></header><embed src={assetUrl(workspacePath, node.assetPath)} type="application/pdf" /></div></foreignObject>}
          </g>)}
          {selected && selected.type !== 'arrow' && <g className="zsense-canvas-selection" transform={`translate(${selected.x} ${selected.y}) rotate(${selected.rotation})`}>
            <rect width={selected.width} height={selected.height} fill="none" stroke="#2563eb" strokeWidth={1.5 / viewport.zoom} vectorEffect="non-scaling-stroke" />
            {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => <circle key={handle} className={`resize-handle ${handle}`} cx={handle.includes('e') ? selected.width : 0} cy={handle.includes('s') ? selected.height : 0} r={6 / viewport.zoom} fill="#fff" stroke="#2563eb" strokeWidth={1.5 / viewport.zoom} onPointerDown={(event) => beginResize(event, handle)} />)}
          </g>}
        </g>
      </svg>
      <div className="zsense-canvas-zoom" aria-label="缩放控制"><button type="button" onClick={() => setViewport((current) => ({ ...current, zoom: clamp(current.zoom / 1.2, .15, 4) }))} aria-label="缩小" title="缩小"><ZoomOut size={15} /></button><span>{Math.round(viewport.zoom * 100)}%</span><button type="button" onClick={() => setViewport((current) => ({ ...current, zoom: clamp(current.zoom * 1.2, .15, 4) }))} aria-label="放大" title="放大"><ZoomIn size={15} /></button><button type="button" onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })} aria-label="重置画布视图" title="重置视图"><Maximize2 size={15} /></button></div>
      {selected && <aside className={`zsense-canvas-inspector ${selected.type === 'image' || selected.type === 'pdf' ? 'file-inspector' : ''}`} style={inspectorStyle} aria-label="选中元素属性">
        <header><span><strong title={nodeLabel(selected)}>{nodeLabel(selected)}</strong><small>{selected.type} · {selected.id.slice(-8)}</small></span><button type="button" onClick={() => setSelectionId('')} aria-label="关闭属性面板" title="关闭属性面板"><X size={14} /></button></header>
        {(selected.type === 'image' || selected.type === 'pdf') && <dl className="zsense-canvas-file-info">
          <div><dt>文件</dt><dd title={selected.assetName}>{selected.assetName || '未命名文件'}</dd></div>
          <div><dt>类型</dt><dd>{selected.type === 'image' ? '图片' : 'PDF 文档'}</dd></div>
          <div><dt>画布尺寸</dt><dd>{Math.round(selected.width)} × {Math.round(selected.height)}</dd></div>
        </dl>}
        {(selected.type === 'text' || selected.type === 'note') && <label><span>文字</span><textarea value={selected.text} onChange={(event) => updateNode(selected.id, { text: event.target.value })} onBlur={recordCurrent} rows={3} /></label>}
        {!['image', 'pdf', 'arrow'].includes(selected.type) && <div className="zsense-canvas-palette" aria-label="填充颜色">{palette.map((color) => <button key={color} type="button" className={selected.fill === color ? 'active' : ''} style={{ background: color }} onClick={() => updateNode(selected.id, { fill: color }, true)} aria-label={`填充颜色 ${color}`} title={color} />)}</div>}
        <div className="zsense-canvas-inspector-actions"><button type="button" onClick={askAI} title="向 AI 询问这个元素"><Bot size={14} />问 AI</button><button type="button" onClick={duplicateSelected} title="复制选中元素"><Copy size={14} />复制</button><button type="button" className="danger" onClick={deleteSelected} title="删除选中元素"><Trash2 size={14} />删除</button></div>
      </aside>}
      {feedback && feedbackIsError && <div className="zsense-canvas-feedback error" role="alert"><AlertTriangle size={14} /><span>{feedback}</span><button type="button" onClick={() => setFeedback('')} aria-label="关闭错误提示"><X size={13} /></button></div>}
    </div>
    {capturedScreenshot && <ScreenshotAnnotationDialog sourceDataUrl={capturedScreenshot.dataUrl} sourceName={capturedScreenshot.name} workspacePath={workspacePath} onClose={() => setCapturedScreenshot(null)} onComplete={onAnnotatedScreenshot} />}
  </aside>
}
