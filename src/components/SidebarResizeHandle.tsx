import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { normalizeSidebarPanelWidth, SIDEBAR_PANEL_DEFAULT_WIDTH, SIDEBAR_PANEL_MAX_WIDTH, SIDEBAR_PANEL_MIN_WIDTH } from '../services/sidebar-panel-width'

interface SidebarResizeHandleProps {
  width: number
  onWidthChange: (width: number) => void
}

export function SidebarResizeHandle({ width, onWidthChange }: SidebarResizeHandleProps) {
  const [renderedWidth, setRenderedWidth] = useState(width)
  const currentWidthRef = useRef(width)
  const commitRef = useRef(onWidthChange)
  commitRef.current = onWidthChange
  const frameRef = useRef<number | null>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; currentWidth: number; shell: HTMLElement; handle: HTMLDivElement } | null>(null)

  const renderWidth = useCallback((next: number, shell: HTMLElement, updateState = true) => {
    shell.style.setProperty('--sidebar-panel-width', `${next}px`)
    currentWidthRef.current = next
    if (updateState) setRenderedWidth(next)
  }, [])

  const finishDrag = useCallback((restoreStart = false, updateState = true) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    const next = restoreStart ? drag.startWidth : drag.currentWidth
    renderWidth(next, drag.shell, updateState)
    document.body.classList.remove('is-resizing-sidebar')
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
    commitRef.current(next)
  }, [renderWidth])

  useEffect(() => {
    if (dragRef.current) return
    currentWidthRef.current = width
    setRenderedWidth(width)
  }, [width])

  useEffect(() => {
    const stop = () => finishDrag()
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('blur', stop)
      finishDrag(false, false)
    }
  }, [finishDrag])

  const commitWidth = (value: number) => {
    const shell = handleRef.current?.closest<HTMLElement>('.app-shell')
    if (!shell) return
    const next = normalizeSidebarPanelWidth(value)
    renderWidth(next, shell)
    commitRef.current(next)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return
    const shell = event.currentTarget.closest<HTMLElement>('.app-shell')
    if (!shell) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: currentWidthRef.current, currentWidth: currentWidthRef.current, shell, handle: event.currentTarget }
    document.body.classList.add('is-resizing-sidebar')
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    drag.currentWidth = normalizeSidebarPanelWidth(drag.startWidth + event.clientX - drag.startX)
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      const active = dragRef.current
      if (active) renderWidth(active.currentWidth, active.shell)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && dragRef.current) {
      event.preventDefault()
      finishDrag(true)
      return
    }
    if (dragRef.current) return
    const step = event.shiftKey ? 24 : 8
    const next = event.key === 'ArrowLeft' ? currentWidthRef.current - step
      : event.key === 'ArrowRight' ? currentWidthRef.current + step
        : event.key === 'Home' ? SIDEBAR_PANEL_MIN_WIDTH
          : event.key === 'End' ? SIDEBAR_PANEL_MAX_WIDTH : undefined
    if (next === undefined) return
    event.preventDefault()
    commitWidth(next)
  }

  return <div ref={handleRef} className="sidebar-resize-handle" role="separator" aria-label="调整会话列表宽度" aria-orientation="vertical" aria-controls="sidebar-panel" aria-valuemin={SIDEBAR_PANEL_MIN_WIDTH} aria-valuemax={SIDEBAR_PANEL_MAX_WIDTH} aria-valuenow={renderedWidth} aria-valuetext={`${renderedWidth} 像素`} tabIndex={0} title="左右拖动调整宽度；双击恢复默认；方向键微调" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => { if (dragRef.current?.pointerId === event.pointerId) finishDrag() }} onPointerCancel={(event) => { if (dragRef.current?.pointerId === event.pointerId) finishDrag() }} onLostPointerCapture={(event) => { if (dragRef.current?.pointerId === event.pointerId) finishDrag() }} onKeyDown={onKeyDown} onDoubleClick={() => commitWidth(SIDEBAR_PANEL_DEFAULT_WIDTH)}><span aria-hidden="true" /></div>
}
