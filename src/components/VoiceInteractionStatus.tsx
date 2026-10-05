import { AlertTriangle, AudioLines, LoaderCircle, Mic2, Square, Volume2 } from 'lucide-react'
import type { VoiceInteractionState } from '../types'

interface VoiceInteractionStatusProps {
  state: VoiceInteractionState
  message: string
  wakePhrase?: string
  targetLabel?: string
  disabled?: boolean
  onToggle: () => void
}

const labels: Record<VoiceInteractionState, string> = {
  idle: '语音未开启',
  standby: '等待“你好 ZSense”',
  starting: '正在启动',
  listening: '正在聆听',
  transcribing: '正在转写',
  thinking: 'AI 处理中',
  speaking: '正在说话',
  error: '语音出错',
}

const activeStates = new Set<VoiceInteractionState>(['starting', 'listening', 'transcribing', 'thinking', 'speaking'])

function StateIcon({ state }: { state: VoiceInteractionState }) {
  if (state === 'error') return <AlertTriangle size={17} />
  if (state === 'speaking') return <Volume2 size={17} />
  if (state === 'listening' || state === 'standby') return <AudioLines size={17} />
  if (state === 'starting' || state === 'transcribing' || state === 'thinking') return <LoaderCircle className="spin" size={17} />
  return <Mic2 size={17} />
}

export function VoiceInteractionStatus({ state, message, wakePhrase = '你好 ZSense', targetLabel, disabled = false, onToggle }: VoiceInteractionStatusProps) {
  const active = activeStates.has(state)
  const interruptible = state === 'thinking' || state === 'speaking'
  const action = interruptible ? '说话或点击，打断并重新输入' : active ? '停止语音交互' : state === 'error' ? '重试语音交互' : '开始语音交互'
  const detail = active && targetLabel ? `${targetLabel} · ${interruptible ? '直接说话或点击即可打断' : '点击停止'}` : message
  const label = state === 'standby' ? `等待“${wakePhrase}”` : labels[state]

  return (
    <button
      type="button"
      className={`voice-interaction-status ${active ? 'active' : ''} ${state}`}
      data-state={state}
      onClick={onToggle}
      disabled={disabled}
      aria-label={`${action}：${label}。${detail}`}
      aria-pressed={active}
      title={`${label} · ${detail}`}
    >
      <span className="voice-status-icon"><StateIcon state={state} /></span>
      <span className="voice-status-copy" aria-live="polite" aria-atomic="true">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      {state === 'listening' && <span className="voice-status-level" aria-hidden="true"><i /><i /><i /></span>}
      {active && state !== 'listening' && <span className={`voice-status-stop ${interruptible ? 'interrupt' : ''}`} aria-hidden="true">{interruptible ? <Mic2 size={11} /> : <Square size={9} />}</span>}
    </button>
  )
}
