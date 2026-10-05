import { ArrowUpRight, Check, Eraser, LoaderCircle, Maximize2, MousePointer2, Pencil, Redo2, Square, Type, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { ChatAttachment } from '../types'

type AnnotationTool = 'pen' | 'arrow' | 'rectangle' | 'text'
interface Point { x: number; y: number }
type AnnotationOperation =
  | { type: 'pen'; color: string; width: number; points: Point[] }
  | { type: 'arrow'; color: string; width: number; from: Point; to: Point }
  | { type: 'rectangle'; color: string; width: number; from: Point; to: Point }
  | { type: 'text'; color: string; at: Point; text: string; fontSize: number }

interface ScreenshotAnnotationDialogProps {
  sourceDataUrl: string
  sourceName: string
  workspacePath: string
  onClose: () => void
  onComplete: (attachment: ChatAttachment, requirement: string, sendImmediately: boolean) => void | Promise<void>
}

const colors = ['#dc2626', '#2563eb', '#059669', '#111827']
const minimumZoom = .25
const maximumZoom = 4
const zoomStep = .15
const tools: Array<{ id: AnnotationTool; label: string; icon: typeof Pencil }> = [
  { id: 'pen', label: '画笔', icon: Pencil },
  { id: 'arrow', label: '箭头', icon: ArrowUpRight },
  { id: 'rectangle', label: '矩形', icon: Square },
  { id: 'text', label: '文字', icon: Type },
]

function pointDistance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y) }

function drawArrow(context: CanvasRenderingContext2D, from: Point, to: Point, color: string, width: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const head = Math.max(13, width * 4)
  context.save()
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.stroke()
  context.beginPath()
  context.moveTo(to.x, to.y)
  context.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
  context.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
  context.closePath()
  context.fill()
  context.restore()
}

function drawOperation(context: CanvasRenderingContext2D, operation: AnnotationOperation) {
  if (operation.type === 'pen') {
    if (operation.points.length < 2) return
    context.save()
    context.strokeStyle = operation.color
    context.lineWidth = operation.width
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(operation.points[0].x, operation.points[0].y)
    operation.points.slice(1).forEach((point) => context.lineTo(point.x, point.y))
    context.stroke()
    context.restore()
    return
  }
  if (operation.type === 'arrow') {
    drawArrow(context, operation.from, operation.to, operation.color, operation.width)
    return
  }
  if (operation.type === 'rectangle') {
    context.save()
    context.strokeStyle = operation.color
    context.lineWidth = operation.width
    context.lineJoin = 'round'
    context.strokeRect(operation.from.x, operation.from.y, operation.to.x - operation.from.x, operation.to.y - operation.from.y)
    context.restore()
    return
  }
  context.save()
  context.font = `700 ${operation.fontSize}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  context.lineJoin = 'round'
  context.lineWidth = Math.max(3, operation.fontSize * .18)
  context.strokeStyle = 'rgba(255, 255, 255, .94)'
  context.strokeText(operation.text, operation.at.x, operation.at.y)
  context.fillStyle = operation.color
  context.fillText(operation.text, operation.at.x, operation.at.y)
  context.restore()
}

function fileNameFor(sourceName: string) {
  const stem = sourceName.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 70) || '截图'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-')
  return `${stem}-批注-${stamp}.png`
}

export function ScreenshotAnnotationDialog({ sourceDataUrl, sourceName, workspacePath, onClose, onComplete }: ScreenshotAnnotationDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const sourceImageRef = useRef<HTMLImageElement | null>(null)
  const activeRef = useRef<AnnotationOperation | null>(null)
  const zoomRef = useRef(1)
  const [imageReady, setImageReady] = useState(false)
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 })
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 })
  const [zoom, setZoom] = useState(1)
  const [tool, setTool] = useState<AnnotationTool>('pen')
  const [color, setColor] = useState(colors[0])
  const [lineWidth, setLineWidth] = useState(5)
  const [textDraft, setTextDraft] = useState('')
  const [requirement, setRequirement] = useState('')
  const [operations, setOperations] = useState<AnnotationOperation[]>([])
  const [redoOperations, setRedoOperations] = useState<AnnotationOperation[]>([])
  const [previewRevision, setPreviewRevision] = useState(0)
  const [busy, setBusy] = useState<'add' | 'send' | ''>('')
  const [error, setError] = useState('')

  const render = useCallback((extra?: AnnotationOperation | null) => {
    const canvas = canvasRef.current
    const image = sourceImageRef.current
    if (!canvas || !image || !imageReady) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    operations.forEach((operation) => drawOperation(context, operation))
    if (extra) drawOperation(context, extra)
  }, [imageReady, operations])

  useEffect(() => {
    const image = new Image()
    image.onload = () => {
      const maximumSide = 4096
      const maximumPixels = 16_000_000
      const scale = Math.min(1, maximumSide / Math.max(image.naturalWidth, image.naturalHeight), Math.sqrt(maximumPixels / Math.max(1, image.naturalWidth * image.naturalHeight)))
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      setCanvasSize({ width: canvas.width, height: canvas.height })
      sourceImageRef.current = image
      setImageReady(true)
    }
    image.onerror = () => setError('截图内容无法载入，请重新截图。')
    image.src = sourceDataUrl
    return () => { sourceImageRef.current = null }
  }, [sourceDataUrl])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const updateSize = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight })
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const applyZoom = useCallback((value: number, anchor?: { x: number; y: number }) => {
    const next = Math.min(maximumZoom, Math.max(minimumZoom, Math.round(value * 100) / 100))
    if (Math.abs(next - zoomRef.current) < .001) return
    const stage = stageRef.current
    const canvas = canvasRef.current
    const stageBounds = stage?.getBoundingClientRect()
    const before = canvas?.getBoundingClientRect()
    const x = anchor?.x ?? (stageBounds ? stageBounds.left + stageBounds.width / 2 : 0)
    const y = anchor?.y ?? (stageBounds ? stageBounds.top + stageBounds.height / 2 : 0)
    const imageX = before?.width ? Math.min(1, Math.max(0, (x - before.left) / before.width)) : .5
    const imageY = before?.height ? Math.min(1, Math.max(0, (y - before.top) / before.height)) : .5
    zoomRef.current = next
    setZoom(next)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!stage || !canvas) return
      const after = canvas.getBoundingClientRect()
      stage.scrollLeft += after.left + imageX * after.width - x
      stage.scrollTop += after.top + imageY * after.height - y
    }))
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * .002)
      applyZoom(zoomRef.current * factor, { x: event.clientX, y: event.clientY })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [applyZoom])

  useEffect(() => { render(activeRef.current) }, [previewRevision, render])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) setRedoOperations((redo) => {
          const operation = redo[0]
          if (!operation) return redo
          setOperations((current) => [...current, operation])
          return redo.slice(1)
        })
        else setOperations((current) => {
          const operation = current[current.length - 1]
          if (!operation) return current
          setRedoOperations((redo) => [operation, ...redo])
          return current.slice(0, -1)
        })
      }
      if ((event.metaKey || event.ctrlKey) && ['+', '=', '-', '_', '0'].includes(event.key)) {
        event.preventDefault()
        if (event.key === '0') applyZoom(1)
        else applyZoom(zoomRef.current + (event.key === '-' || event.key === '_' ? -zoomStep : zoomStep))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyZoom, busy, onClose])

  const fitScale = Math.min(1, Math.max(1, stageSize.width - 28) / canvasSize.width, Math.max(1, stageSize.height - 28) / canvasSize.height)
  const displayWidth = Math.max(1, Math.round(canvasSize.width * fitScale * zoom))
  const displayHeight = Math.max(1, Math.round(canvasSize.height * fitScale * zoom))

  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    return { x: (event.clientX - bounds.left) * canvas.width / Math.max(1, bounds.width), y: (event.clientY - bounds.top) * canvas.height / Math.max(1, bounds.height) }
  }

  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!imageReady || busy || event.button !== 0) return
    const at = canvasPoint(event)
    if (tool === 'text') {
      const text = textDraft.trim()
      if (!text) { setError('请先输入要添加到截图上的文字。'); return }
      const fontSize = Math.max(18, Math.round(event.currentTarget.width / 42))
      setOperations((current) => [...current, { type: 'text', color, at, text: text.slice(0, 120), fontSize }])
      setRedoOperations([])
      setError('')
      return
    }
    const width = lineWidth * Math.max(1, event.currentTarget.width / Math.max(900, event.currentTarget.getBoundingClientRect().width))
    activeRef.current = tool === 'pen'
      ? { type: 'pen', color, width, points: [at] }
      : { type: tool, color, width, from: at, to: at }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPreviewRevision((current) => current + 1)
  }

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current
    if (!active || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const at = canvasPoint(event)
    if (active.type === 'pen') active.points.push(at)
    else if (active.type !== 'text') active.to = at
    setPreviewRevision((current) => current + 1)
  }

  const end = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current
    if (!active) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    activeRef.current = null
    const meaningful = active.type === 'pen'
      ? active.points.length > 1 && pointDistance(active.points[0], active.points[active.points.length - 1]) > 2
      : active.type !== 'text' && pointDistance(active.from, active.to) > 3
    if (meaningful) {
      setOperations((current) => [...current, active])
      setRedoOperations([])
    } else setPreviewRevision((current) => current + 1)
  }

  const undo = () => setOperations((current) => {
    const operation = current[current.length - 1]
    if (!operation) return current
    setRedoOperations((redo) => [operation, ...redo])
    return current.slice(0, -1)
  })
  const redo = () => setRedoOperations((current) => {
    const operation = current[0]
    if (!operation) return current
    setOperations((history) => [...history, operation])
    return current.slice(1)
  })

  const complete = async (sendImmediately: boolean) => {
    const canvas = canvasRef.current
    if (!canvas || !imageReady || busy) return
    if (!workspacePath) { setError('当前对话没有工作区，无法保存批注截图。'); return }
    if (!window.zsenseDesktop?.chat.resolvePastedAttachments) { setError('截图批注只在 ZSense 桌面应用中可用。'); return }
    setBusy(sendImmediately ? 'send' : 'add')
    setError('')
    try {
      render()
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法生成批注图片。')), 'image/png'))
      const file = new File([blob], fileNameFor(sourceName), { type: 'image/png', lastModified: Date.now() })
      const staged = await unwrapDesktop(window.zsenseDesktop.chat.resolvePastedAttachments([file], workspacePath))
      const attachment = staged[0]
      if (!attachment) throw new Error('批注截图没有成功写入当前工作区。')
      await onComplete(attachment, requirement.trim(), sendImmediately)
      onClose()
    } catch (reason) {
      setError(`批注截图处理失败：${errorMessage(reason)}`)
    } finally { setBusy('') }
  }

  return createPortal(<div className="screenshot-annotation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="screenshot-annotation-dialog" role="dialog" aria-modal="true" aria-labelledby="screenshot-annotation-title">
      <header>
        <span><strong id="screenshot-annotation-title">截图批注</strong><small title={sourceName}>{sourceName}</small></span>
        <button type="button" onClick={onClose} disabled={Boolean(busy)} aria-label="关闭截图批注" title="关闭"><X size={18} /></button>
      </header>
      <div className="screenshot-annotation-toolbar" aria-label="截图批注工具">
        <div className="screenshot-annotation-tools">{tools.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={tool === item.id ? 'active' : ''} onClick={() => setTool(item.id)} aria-label={item.label} title={item.label} aria-pressed={tool === item.id}><Icon size={16} /></button> })}</div>
        <span className="screenshot-annotation-divider" />
        <div className="screenshot-annotation-colors" aria-label="批注颜色">{colors.map((item) => <button key={item} type="button" className={color === item ? 'active' : ''} style={{ '--annotation-color': item } as React.CSSProperties} onClick={() => setColor(item)} aria-label={`使用颜色 ${item}`} title={item} aria-pressed={color === item} />)}</div>
        <label className="screenshot-annotation-width"><span>粗细</span><select value={lineWidth} onChange={(event) => setLineWidth(Number(event.target.value))} aria-label="批注线条粗细"><option value={3}>细</option><option value={5}>中</option><option value={8}>粗</option></select></label>
        <span className="screenshot-annotation-divider" />
        <button type="button" onClick={undo} disabled={!operations.length} aria-label="撤销批注" title="撤销"><Undo2 size={16} /></button>
        <button type="button" onClick={redo} disabled={!redoOperations.length} aria-label="重做批注" title="重做"><Redo2 size={16} /></button>
        <button type="button" onClick={() => { setOperations([]); setRedoOperations([]) }} disabled={!operations.length} aria-label="清空批注" title="清空批注"><Eraser size={16} /></button>
        <span className="screenshot-annotation-divider" />
        <div className="screenshot-annotation-zoom" role="group" aria-label="截图缩放">
          <button type="button" onClick={() => applyZoom(zoomRef.current - zoomStep)} disabled={zoom <= minimumZoom} aria-label="缩小截图" title="缩小（Ctrl/⌘ + -）"><ZoomOut size={16} /></button>
          <output aria-live="polite" aria-label={`当前缩放比例 ${Math.round(zoom * 100)}%`}>{Math.round(zoom * 100)}%</output>
          <button type="button" onClick={() => applyZoom(zoomRef.current + zoomStep)} disabled={zoom >= maximumZoom} aria-label="放大截图" title="放大（Ctrl/⌘ + +）"><ZoomIn size={16} /></button>
          <button type="button" onClick={() => applyZoom(1)} disabled={zoom === 1} aria-label="适应窗口" title="适应窗口（Ctrl/⌘ + 0）"><Maximize2 size={16} /></button>
          <small>Ctrl/⌘ + 滚轮</small>
        </div>
        <small>{operations.length} 个批注</small>
      </div>
      {tool === 'text' && <label className="screenshot-annotation-text"><span>批注文字</span><input value={textDraft} onChange={(event) => setTextDraft(event.target.value)} placeholder="输入文字后在截图上点击放置" maxLength={120} autoFocus /></label>}
      <div ref={stageRef} className="screenshot-annotation-stage">
        {!imageReady && !error && <span className="screenshot-annotation-loading"><LoaderCircle className="spin" size={20} />正在载入截图…</span>}
        <div className="screenshot-annotation-scroll-content" style={{ width: displayWidth + 28, height: displayHeight + 28 }}>
          <canvas ref={canvasRef} className={`tool-${tool}`} style={{ width: displayWidth, height: displayHeight }} aria-label="截图批注画布" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
        </div>
      </div>
      <label className="screenshot-annotation-requirement"><span>给 Agent 的要求</span><textarea value={requirement} onChange={(event) => setRequirement(event.target.value)} placeholder="例如：请重点检查红框中的数据，并给出修改建议" rows={3} maxLength={4000} /></label>
      {error && <div className="screenshot-annotation-error" role="alert">{error}</div>}
      <footer>
        <span><MousePointer2 size={14} />截图将保存到当前会话工作区，只发送给当前对话。</span>
        <button type="button" className="button secondary" onClick={() => void complete(false)} disabled={!imageReady || Boolean(busy)}>{busy === 'add' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}添加到输入框</button>
        <button type="button" className="button primary" onClick={() => void complete(true)} disabled={!imageReady || Boolean(busy)}>{busy === 'send' ? <LoaderCircle className="spin" size={15} /> : <ArrowUpRight size={15} />}发送到当前对话</button>
      </footer>
    </section>
  </div>, document.body)
}
