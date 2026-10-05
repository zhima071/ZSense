import { AlertTriangle, AudioLines, LoaderCircle, MicOff } from 'lucide-react'
import type { VoiceWakeStatus } from '../types'

interface VoiceWakeToggleProps {
  enabled: boolean
  status: VoiceWakeStatus
  busy: boolean
  onToggle: () => void
}

export function VoiceWakeToggle({ enabled, status, busy, onToggle }: VoiceWakeToggleProps) {
  const failed = enabled && (status.state === 'error' || status.state === 'unavailable')
  const label = busy ? '正在切换语音唤醒' : enabled ? failed ? '关闭语音唤醒；当前监听异常' : '关闭语音唤醒' : '开启语音唤醒'
  const detail = enabled ? status.message : '语音唤醒已关闭'

  return (
    <button
      type="button"
      className={`icon-button voice-wake-toggle ${enabled ? 'enabled' : ''} ${failed ? 'error' : ''}`}
      onClick={onToggle}
      disabled={busy}
      aria-label={label}
      aria-pressed={enabled}
      title={`${label} · ${detail}`}
    >
      {busy ? <LoaderCircle className="spin" size={18} /> : failed ? <AlertTriangle size={18} /> : enabled ? <AudioLines size={18} /> : <MicOff size={18} />}
    </button>
  )
}
