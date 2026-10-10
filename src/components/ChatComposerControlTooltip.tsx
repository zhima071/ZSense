import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface ChatComposerControlTooltipProps {
  className?: string
  children: ReactNode
}

interface TooltipPosition {
  left: number
  top: number
  arrowLeft: number
  maxWidth: number
  placement: 'top' | 'bottom'
}

// A sentinel keeps the control's DOM structure unchanged while the bubble is
// rendered outside the composer's overflow boundary.
export function ChatComposerControlTooltip({ className = '', children }: ChatComposerControlTooltipProps) {
  const id = useId()
  const sentinelRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<TooltipPosition | null>(null)

  useEffect(() => {
    const anchor = sentinelRef.current?.parentElement
    if (!anchor) return
    let hovered = false
    let focused = false
    let dismissed = false
    let pointerActivated = false

    const update = () => setOpen(!dismissed && (hovered || focused))
    const enter = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      hovered = true
      // Disabled → enabled transitions can emit pointerenter without an
      // actual mouse movement. Keep an activated control suppressed until
      // the pointer really leaves its bounds or keyboard navigation resumes.
      if (!pointerActivated) dismissed = false
      update()
    }
    const leave = (event: PointerEvent) => {
      hovered = false
      const bounds = anchor.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom) pointerActivated = false
      update()
    }
    const focus = (event: FocusEvent) => {
      focused = true
      // A pointer activation focuses the same control after pointerdown. Do
      // not reopen the bubble over the native select or newly opened picker.
      if (!pointerActivated && !(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) dismissed = false
      update()
    }
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return
      focused = false
      update()
    }
    const dismiss = () => { dismissed = true; setOpen(false) }
    const pointerdown = () => { pointerActivated = true; dismiss() }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') pointerActivated = false
      if (event.key === 'Escape' || ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Node && anchor.contains(event.target))) dismiss()
    }

    anchor.addEventListener('pointerenter', enter)
    anchor.addEventListener('pointerleave', leave)
    anchor.addEventListener('focusin', focus)
    anchor.addEventListener('focusout', blur)
    // The native select or picker must remain unobstructed after activation.
    anchor.addEventListener('pointerdown', pointerdown)
    anchor.addEventListener('click', dismiss)
    document.addEventListener('keydown', keydown)
    return () => {
      anchor.removeEventListener('pointerenter', enter)
      anchor.removeEventListener('pointerleave', leave)
      anchor.removeEventListener('focusin', focus)
      anchor.removeEventListener('focusout', blur)
      anchor.removeEventListener('pointerdown', pointerdown)
      anchor.removeEventListener('click', dismiss)
      document.removeEventListener('keydown', keydown)
    }
  }, [])

  useLayoutEffect(() => {
    const anchor = sentinelRef.current?.parentElement
    if (!open || !anchor) { setPosition(null); return }
    const tooltip = tooltipRef.current
    if (!tooltip) return

    const describedElements = [anchor, ...anchor.querySelectorAll<HTMLElement>('select, input, button, [tabindex]')]
    for (const element of describedElements) {
      const describedBy = (element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      element.setAttribute('aria-describedby', [...new Set([...describedBy, id])].join(' '))
    }

    let frame = 0
    const measure = () => {
      frame = 0
      const bounds = anchor.getBoundingClientRect()
      const gutter = 8
      const gap = 7
      const viewport = window.visualViewport
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportTop = viewport?.offsetTop || 0
      const viewportWidth = viewport?.width || window.innerWidth
      const viewportHeight = viewport?.height || window.innerHeight
      const maxWidth = Math.max(0, viewportWidth - gutter * 2)
      tooltip.style.maxWidth = `${maxWidth}px`
      // Measure the layout box, not a scale-in animation's transformed box.
      const bubble = { width: tooltip.offsetWidth, height: tooltip.offsetHeight }
      const center = bounds.left + bounds.width / 2
      const left = Math.max(viewportLeft + gutter, Math.min(center - bubble.width / 2, viewportLeft + viewportWidth - bubble.width - gutter))
      const placement = bounds.top - bubble.height - gap >= viewportTop + gutter ? 'top' : 'bottom'
      const preferredTop = placement === 'top' ? bounds.top - bubble.height - gap : bounds.bottom + gap
      const top = Math.max(viewportTop + gutter, Math.min(preferredTop, viewportTop + viewportHeight - bubble.height - gutter))
      const arrowLeft = Math.max(14, Math.min(center - left, bubble.width - 14))
      setPosition((current) => current && current.left === left && current.top === top && current.arrowLeft === arrowLeft && current.placement === placement && current.maxWidth === maxWidth
        ? current
        : { left, top, arrowLeft, placement, maxWidth })
    }
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(anchor)
    observer?.observe(tooltip)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
      for (const element of describedElements) {
        const remaining = (element.getAttribute('aria-describedby') || '').split(/\s+/).filter((item) => item && item !== id)
        if (remaining.length) element.setAttribute('aria-describedby', remaining.join(' '))
        else element.removeAttribute('aria-describedby')
      }
    }
  }, [open, id, children])

  const style = {
    left: position?.left || 0,
    top: position?.top || 0,
    maxWidth: position?.maxWidth ?? Math.max(0, (window.visualViewport?.width || window.innerWidth) - 16),
    visibility: position ? 'visible' : 'hidden',
    '--chat-tooltip-arrow-left': `${position?.arrowLeft || 0}px`,
  } as CSSProperties

  return <>
    <span ref={sentinelRef} hidden aria-hidden="true" />
    {open && createPortal(<div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className={`chat-control-tooltip chat-control-detail ${className}`}
      data-placement={position?.placement || 'top'}
      style={style}
      // React portals still bubble through the originating control. Do not
      // activate a workspace picker, attachment picker, or form from the tip.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
    >{children}</div>, document.body)}
  </>
}
