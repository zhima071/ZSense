import { LoaderCircle, Mic } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_CHAT_DICTATION_SHORTCUT, matchesChatDictationShortcut, readableChatDictationShortcut } from '../services/chat-dictation-shortcut'
import { VOICE_LANGUAGE } from '../services/voice-language'
import { startVoiceTextCapture, voiceTextRecognitionSupported, type VoiceTextCaptureHandle } from '../services/voice-wake'

export const CHAT_DICTATION_ACTIVITY_EVENT = 'zsense:chat-dictation-activity'

interface ChatDictationButtonProps {
  contextKey: string
  disabled?: boolean
  shortcut?: string
  onTranscript: (text: string) => void
  onError: (message: string) => void
}

type DictationPhase = 'idle' | 'recording' | 'transcribing'

// Both composers share one renderer. Only its current owner may resume wake
// listening; a cancelled transcription can finish after another owner starts.
let activeDictation: { id: symbol; cancel: () => void } | null = null

function notifyActivity(active: boolean) {
  window.dispatchEvent(new CustomEvent(CHAT_DICTATION_ACTIVITY_EVENT, { detail: { active } }))
}

function releaseDictation(id: symbol | null) {
  if (!id || activeDictation?.id !== id) return
  activeDictation = null
  notifyActivity(false)
}

function dictationError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '麦克风权限未开启，请在系统设置中允许 ZSense 访问麦克风后重试。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '未找到可用麦克风，请连接麦克风后重试。'
  if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风暂时无法使用，请检查是否被其他应用占用。'
  return error instanceof Error ? error.message : String(error || '中文听写失败，请重试。')
}

function visibleElement(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none'
}

function ownsShortcutScope(button: HTMLButtonElement, event: KeyboardEvent): boolean {
  if (!visibleElement(button) || document.hidden) return false
  const form = button.closest('form.chat-composer')
  if (!form) return false
  const dialogs = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]')].filter(visibleElement)
  const activeDialog = dialogs.at(-1)
  if (activeDialog && !activeDialog.contains(button)) return false
  const target = event.target instanceof Element ? event.target : document.activeElement
  if (target?.closest('[data-chat-dictation-shortcut-recording="true"]')) return false
  const targetForm = target?.closest('form.chat-composer')
  if (targetForm) return targetForm === form
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return false
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.chat-dictation-button')]
    .filter((candidate) => visibleElement(candidate) && (!activeDialog || activeDialog.contains(candidate)))
  return buttons.at(-1) === button
}

export function ChatDictationButton({ contextKey, disabled = false, shortcut = DEFAULT_CHAT_DICTATION_SHORTCUT, onTranscript, onError }: ChatDictationButtonProps) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const phaseRef = useRef(phase)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const captureRef = useRef<VoiceTextCaptureHandle | null>(null)
  const leaseRef = useRef<symbol | null>(null)
  const generationRef = useRef(0)
  const currentPropsRef = useRef({ contextKey, disabled, onTranscript, onError })
  currentPropsRef.current = { contextKey, disabled, onTranscript, onError }
  phaseRef.current = phase
  const updatePhase = useCallback((next: DictationPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const cancelCapture = useCallback(() => {
    generationRef.current += 1
    captureRef.current?.cancel()
    captureRef.current = null
    releaseDictation(leaseRef.current)
    leaseRef.current = null
  }, [])

  useLayoutEffect(() => {
    cancelCapture()
    updatePhase('idle')
    return cancelCapture
  }, [contextKey, disabled, cancelCapture, updatePhase])

  useEffect(() => {
    const cancel = () => {
      cancelCapture()
      updatePhase('idle')
    }
    const handleVisibility = () => {
      if (document.hidden) cancel()
    }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', handleVisibility)
      cancelCapture()
    }
  }, [cancelCapture, updatePhase])

  const toggleDictation = () => {
    if (disabled || phaseRef.current === 'transcribing') return
    if (captureRef.current) {
      captureRef.current.stop()
      updatePhase('transcribing')
      return
    }
    if (!voiceTextRecognitionSupported()) {
      onError('当前安装缺少本地 Whisper 听写组件或麦克风支持。')
      return
    }
    activeDictation?.cancel()
    const generation = ++generationRef.current
    const captureContext = contextKey
    const lease = Symbol('chat-dictation')
    leaseRef.current = lease
    activeDictation = { id: lease, cancel: () => { cancelCapture(); updatePhase('idle') } }
    notifyActivity(true)
    updatePhase('recording')
    const isCurrent = () => generation === generationRef.current
      && currentPropsRef.current.contextKey === captureContext
      && !currentPropsRef.current.disabled
    const capture = startVoiceTextCapture({
      language: VOICE_LANGUAGE,
      manualStop: true,
      timeoutMs: 35_000,
      onTranscribing: () => { if (isCurrent()) updatePhase('transcribing') },
    })
    captureRef.current = capture
    void capture.result.then((result) => {
      if (isCurrent()) currentPropsRef.current.onTranscript(result.transcript)
    }).catch((error: unknown) => {
      if (isCurrent() && !(error instanceof Error && error.name === 'AbortError')) {
        currentPropsRef.current.onError(dictationError(error))
      }
    }).finally(() => {
      if (generation === generationRef.current) {
        captureRef.current = null
        updatePhase('idle')
      }
      releaseDictation(lease)
      if (leaseRef.current === lease) leaseRef.current = null
    })
  }

  const toggleRef = useRef(toggleDictation)
  toggleRef.current = toggleDictation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const button = buttonRef.current
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
        || currentPropsRef.current.disabled || !button || !ownsShortcutScope(button, event)) return
      if (event.key === 'Escape' && leaseRef.current && activeDictation?.id === leaseRef.current) {
        event.preventDefault()
        cancelCapture()
        updatePhase('idle')
        return
      }
      if (phaseRef.current === 'transcribing' || button.disabled
        || !matchesChatDictationShortcut(event, shortcut, window.zsenseDesktop?.platform)) return
      event.preventDefault()
      toggleRef.current()
    }
    // React's input handlers run before this bubbling window listener, so
    // recording a shortcut in Settings cannot start dictation underneath it.
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcut, cancelCapture, updatePhase])

  const label = phase === 'recording' ? '结束中文听写并转写（Esc 取消）'
    : phase === 'transcribing' ? '正在使用本地 Whisper 转写（Esc 取消）'
      : '开始中文听写（本地 Whisper，最长 35 秒）'
  const shortcutLabel = shortcut ? readableChatDictationShortcut(shortcut, window.zsenseDesktop?.platform) : ''

  return (
    <button
      type="button"
      ref={buttonRef}
      className={`icon-button chat-dictation-button${phase === 'recording' ? ' is-recording' : phase === 'transcribing' ? ' is-transcribing' : ''}`}
      onClick={toggleDictation}
      disabled={disabled || phase === 'transcribing'}
      aria-label={label}
      aria-pressed={phase === 'recording'}
      aria-busy={phase === 'transcribing'}
      title={shortcutLabel ? `${label} · 快捷键：${shortcutLabel}` : label}
    >
      {phase === 'transcribing' ? <LoaderCircle className="spin" size={17} /> : <Mic size={17} />}
    </button>
  )
}
