import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type TooltipPlacement = 'above' | 'below'

interface TooltipState {
  label: string
  anchorLeft: number
  left: number
  arrowOffset: number
  top: number
  placement: TooltipPlacement
}

const TOOLTIP_DELAY_MS = 320
const TOOLTIP_EDGE_GUTTER = 12

function buttonFromEventTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>('button, [role="button"][aria-label]')
    : null
}

function isIconOnlyButton(button: HTMLElement): boolean {
  if (button.dataset.tooltip === 'off') return false
  if (button.dataset.tooltip) return true
  if (button.classList.contains('icon-button')) return true
  return !button.innerText.trim()
}

function labelledByText(button: HTMLElement): string {
  return String(button.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() || '')
    .filter(Boolean)
    .join(' ')
}

function tooltipLabel(button: HTMLElement): string {
  return String(
    button.dataset.tooltip
    || button.getAttribute('title')
    || button.getAttribute('aria-label')
    || labelledByText(button)
    || button.querySelector<HTMLElement>('.sr-only')?.textContent
    || button.querySelector<SVGTitleElement>('svg title')?.textContent
    || button.querySelector<HTMLImageElement>('img[alt]')?.alt
    || '',
  ).trim()
}

export function GlobalIconTooltips() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return
    const halfWidth = tooltipRef.current.offsetWidth / 2
    const minimumLeft = TOOLTIP_EDGE_GUTTER + halfWidth
    const maximumLeft = window.innerWidth - TOOLTIP_EDGE_GUTTER - halfWidth
    const left = minimumLeft > maximumLeft
      ? window.innerWidth / 2
      : Math.min(Math.max(tooltip.anchorLeft, minimumLeft), maximumLeft)
    const maximumArrowOffset = Math.max(0, halfWidth - 12)
    const arrowOffset = Math.min(Math.max(tooltip.anchorLeft - left, -maximumArrowOffset), maximumArrowOffset)
    if (Math.abs(left - tooltip.left) < 0.5 && Math.abs(arrowOffset - tooltip.arrowOffset) < 0.5) return
    setTooltip((current) => current ? { ...current, left, arrowOffset } : current)
  }, [tooltip])

  useEffect(() => {
    let timer: number | null = null
    let touchFocus = false
    let activeButton: HTMLElement | null = null
    let activeLabel = ''
    let removedTitle: string | null = null

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }

    const restoreNativeTitle = () => {
      if (activeButton && removedTitle !== null && !activeButton.hasAttribute('title')) {
        activeButton.setAttribute('title', removedTitle)
      }
      removedTitle = null
    }

    const hide = () => {
      clearTimer()
      restoreNativeTitle()
      activeButton = null
      activeLabel = ''
      setTooltip(null)
    }

    const reveal = (button: HTMLElement, label: string) => {
      if (!button.isConnected || activeButton !== button) return
      const bounds = button.getBoundingClientRect()
      const placement: TooltipPlacement = bounds.top < 64 ? 'below' : 'above'
      const center = bounds.left + bounds.width / 2
      setTooltip({
        label,
        anchorLeft: center,
        left: center,
        arrowOffset: 0,
        top: placement === 'below' ? bounds.bottom + 8 : bounds.top - 8,
        placement,
      })
    }

    const show = (button: HTMLElement, immediate = false) => {
      if (!isIconOnlyButton(button)) return
      const label = tooltipLabel(button)
      if (!label) return
      if (activeButton !== button) {
        hide()
        activeButton = button
        activeLabel = label
        removedTitle = button.getAttribute('title')
        if (removedTitle !== null) button.removeAttribute('title')
      }
      clearTimer()
      if (immediate) reveal(button, label)
      else timer = window.setTimeout(() => reveal(button, label), TOOLTIP_DELAY_MS)
    }

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const button = buttonFromEventTarget(event.target)
      if (!button || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return
      show(button)
    }

    const onPointerDown = (event: PointerEvent) => {
      touchFocus = event.pointerType === 'touch'
      if (touchFocus) hide()
    }

    const onPointerOut = (event: PointerEvent) => {
      const button = buttonFromEventTarget(event.target)
      if (!button || button !== activeButton) return
      if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return
      hide()
    }

    const onFocusIn = (event: FocusEvent) => {
      if (touchFocus) return
      const button = buttonFromEventTarget(event.target)
      if (button) show(button, true)
    }

    const onFocusOut = (event: FocusEvent) => {
      const button = buttonFromEventTarget(event.target)
      if (button && button === activeButton) hide()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      touchFocus = false
      if (event.key === 'Escape') hide()
    }

    const onTransitionEnd = (event: TransitionEvent) => {
      const button = activeButton
      if (event.propertyName === 'transform' && button && event.target === button && activeLabel) reveal(button, activeLabel)
    }

    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('transitionend', onTransitionEnd, true)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      clearTimer()
      restoreNativeTitle()
      activeButton = null
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('transitionend', onTransitionEnd, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])

  if (!tooltip) return null
  const style = {
    left: tooltip.left,
    top: tooltip.top,
    '--tooltip-arrow-offset': `${tooltip.arrowOffset}px`,
  } as CSSProperties
  return createPortal(<div
    ref={tooltipRef}
    id="zsense-global-icon-tooltip"
    className={`global-icon-tooltip ${tooltip.placement}`}
    style={style}
    role="tooltip"
  >{tooltip.label}</div>, document.body)
}
