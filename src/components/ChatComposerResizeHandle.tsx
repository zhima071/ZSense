import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { useDisplaySettings } from './DisplaySettingsContext'

export const CHAT_COMPOSER_MIN_HEIGHT = 80
export const CHAT_COMPOSER_MAX_HEIGHT = 320
export const CHAT_COMPOSER_DEFAULT_HEIGHT = 88
export const CHAT_COMPOSER_AUTO_MIN_HEIGHT = 56
const SCROLL_EDGE_TOLERANCE = 3

function clampHeight(value: number) {
  return Math.min(CHAT_COMPOSER_MAX_HEIGHT, Math.max(CHAT_COMPOSER_MIN_HEIGHT, Math.round(value)))
}

function clampRenderedHeight(value: number) {
  return Math.min(CHAT_COMPOSER_MAX_HEIGHT, Math.max(CHAT_COMPOSER_AUTO_MIN_HEIGHT, Math.round(value)))
}

interface ChatComposerResizeHandleProps {
  composerRef: RefObject<HTMLFormElement>
  transcriptRef: RefObject<HTMLDivElement>
  resetKey?: string | number
}

export function ChatComposerResizeHandle({ composerRef, transcriptRef, resetKey }: ChatComposerResizeHandleProps) {
  const display = useDisplaySettings()
  const [height, setHeight] = useState(() => clampHeight(display.chatInputHeight))
  const restingHeightRef = useRef(clampHeight(display.chatInputHeight))
  const renderedHeightRef = useRef(clampHeight(display.chatInputHeight))
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number; currentHeight: number } | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const heightAnimationFrameRef = useRef<number | null>(null)
  const lastScrollTopRef = useRef(0)

  const applyRenderedHeight = (nextHeight: number) => {
    const clampedHeight = clampRenderedHeight(nextHeight)
    renderedHeightRef.current = clampedHeight
    const composer = composerRef.current
    composer?.style.setProperty('--chat-input-height', `${clampedHeight}px`)
    composer?.classList.toggle('is-scroll-collapsed', clampedHeight < restingHeightRef.current - 1)
    setHeight((current) => current === clampedHeight ? current : clampedHeight)
    return clampedHeight
  }

  const applyManualHeight = (nextHeight: number) => {
    const clampedHeight = clampHeight(nextHeight)
    dragRef.current && (dragRef.current.currentHeight = clampedHeight)
    return applyRenderedHeight(clampedHeight)
  }

  const cancelHeightAnimation = () => {
    if (heightAnimationFrameRef.current === null) return
    window.cancelAnimationFrame(heightAnimationFrameRef.current)
    heightAnimationFrameRef.current = null
  }

  const animateToHeight = (nextHeight: number, keepAtBottom = false) => {
    cancelHeightAnimation()
    const targetHeight = clampRenderedHeight(nextHeight)
    const keepTranscriptAtBottom = () => {
      if (!keepAtBottom || !transcriptRef.current) return
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
      lastScrollTopRef.current = transcriptRef.current.scrollTop
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      applyRenderedHeight(targetHeight)
      keepTranscriptAtBottom()
      return
    }
    const step = () => {
      const difference = targetHeight - renderedHeightRef.current
      if (Math.abs(difference) <= 1) {
        applyRenderedHeight(targetHeight)
        keepTranscriptAtBottom()
        heightAnimationFrameRef.current = null
        return
      }
      applyRenderedHeight(renderedHeightRef.current + Math.sign(difference) * Math.max(1, Math.abs(difference) * 0.2))
      keepTranscriptAtBottom()
      heightAnimationFrameRef.current = window.requestAnimationFrame(step)
    }
    heightAnimationFrameRef.current = window.requestAnimationFrame(step)
  }

  const commitHeight = (nextHeight: number) => {
    const clampedHeight = clampHeight(nextHeight)
    restingHeightRef.current = clampedHeight
    applyManualHeight(clampedHeight)
    void display.onChatInputHeightChange?.(clampedHeight)
  }

  useEffect(() => {
    const restingHeight = clampHeight(display.chatInputHeight)
    restingHeightRef.current = restingHeight
    const transcript = transcriptRef.current
    const distanceFromBottom = transcript ? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight : 0
    if (!dragRef.current && (distanceFromBottom <= SCROLL_EDGE_TOLERANCE || renderedHeightRef.current > restingHeight)) applyRenderedHeight(restingHeight)
  }, [display.chatInputHeight])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return
    lastScrollTopRef.current = transcript.scrollTop

    const resizeFromScroll = () => {
      scrollFrameRef.current = null
      const scrollTop = transcript.scrollTop
      const delta = scrollTop - lastScrollTopRef.current
      lastScrollTopRef.current = scrollTop
      if (dragRef.current || Math.abs(delta) < 1) return
      const distanceFromBottom = Math.max(0, transcript.scrollHeight - scrollTop - transcript.clientHeight)
      if (transcript.scrollHeight <= transcript.clientHeight + 1) {
        animateToHeight(restingHeightRef.current)
        return
      }
      if (delta < -1) {
        cancelHeightAnimation()
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) applyRenderedHeight(CHAT_COMPOSER_AUTO_MIN_HEIGHT)
        else applyRenderedHeight(renderedHeightRef.current - Math.min(24, Math.max(2, Math.abs(delta) * 0.42)))
        return
      }
      if (delta > 1 && distanceFromBottom <= SCROLL_EDGE_TOLERANCE) animateToHeight(restingHeightRef.current, true)
    }

    const onScroll = () => {
      if (scrollFrameRef.current !== null) return
      scrollFrameRef.current = window.requestAnimationFrame(resizeFromScroll)
    }

    transcript.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      transcript.removeEventListener('scroll', onScroll)
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [transcriptRef])

  useEffect(() => {
    cancelHeightAnimation()
    const transcript = transcriptRef.current
    if (transcript) lastScrollTopRef.current = transcript.scrollTop
    applyRenderedHeight(restingHeightRef.current)
  }, [resetKey])

  useEffect(() => () => {
    document.body.classList.remove('is-resizing-chat-composer')
    cancelHeightAnimation()
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !composerRef.current) return
    event.preventDefault()
    cancelHeightAnimation()
    const textarea = composerRef.current.querySelector('textarea')
    const startHeight = clampHeight(textarea?.getBoundingClientRect().height || height)
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight, currentHeight: startHeight }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing-chat-composer')
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    applyManualHeight(drag.startHeight - (event.clientY - drag.startY))
  }

  const finishPointerResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    document.body.classList.remove('is-resizing-chat-composer')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    commitHeight(drag.currentHeight)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextHeight: number | undefined
    if (event.key === 'ArrowUp') nextHeight = height + 8
    if (event.key === 'ArrowDown') nextHeight = height - 8
    if (event.key === 'PageUp') nextHeight = height + 32
    if (event.key === 'PageDown') nextHeight = height - 32
    if (event.key === 'Home') nextHeight = CHAT_COMPOSER_MIN_HEIGHT
    if (event.key === 'End') nextHeight = CHAT_COMPOSER_MAX_HEIGHT
    if (nextHeight === undefined) return
    event.preventDefault()
    commitHeight(nextHeight)
  }

  return (
    <div
      className="chat-composer-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`调整输入框高度，当前 ${height} 像素`}
      aria-valuemin={CHAT_COMPOSER_AUTO_MIN_HEIGHT}
      aria-valuemax={CHAT_COMPOSER_MAX_HEIGHT}
      aria-valuenow={height}
      tabIndex={0}
      title="浏览历史时自动收起；回到底部自动展开。也可上下拖动手动调整高度"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointerResize}
      onPointerCancel={finishPointerResize}
      onKeyDown={onKeyDown}
      onDoubleClick={() => commitHeight(CHAT_COMPOSER_DEFAULT_HEIGHT)}
    >
      <span aria-hidden="true" />
    </div>
  )
}
