import { ArrowDown } from 'lucide-react'
import { type RefObject, useEffect, useState } from 'react'

interface ChatScrollToBottomButtonProps {
  scrollRef: RefObject<HTMLDivElement | null>
  sidePanelOpen?: boolean
}

export function ChatScrollToBottomButton({ scrollRef, sidePanelOpen = false }: ChatScrollToBottomButtonProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const update = () => setVisible(element.scrollHeight - element.scrollTop - element.clientHeight > 120)
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollRef])

  if (!visible) return null
  return <button
    type="button"
    className={`chat-scroll-bottom ${sidePanelOpen ? 'with-side-panel' : ''}`}
    onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}
    aria-label="返回对话最底部"
    title="返回最底部"
  ><ArrowDown size={17} aria-hidden="true" /></button>
}
