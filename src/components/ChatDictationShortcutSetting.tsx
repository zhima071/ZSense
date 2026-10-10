import { Keyboard } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import {
  DEFAULT_CHAT_DICTATION_SHORTCUT,
  eventToChatDictationShortcut,
  normalizeChatDictationShortcut,
  readableChatDictationShortcut,
} from '../services/chat-dictation-shortcut'

interface ChatDictationShortcutSettingProps {
  value?: string
  onChange: (shortcut: string) => void
  disabled?: boolean
}

export function ChatDictationShortcutSetting({ value, onChange, disabled = false }: ChatDictationShortcutSettingProps) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')
  const shortcut = normalizeChatDictationShortcut(value)
  const platform = window.zsenseDesktop?.platform
  const label = readableChatDictationShortcut(shortcut, platform)

  const changeShortcut = (next: string) => {
    onChange(next)
    setRecording(false)
    setError('')
  }

  const captureKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setRecording(false)
      setError('')
      return
    }
    // Ordinary keys keep their usual input/navigation behavior.
    if (!event.shiftKey || !(event.metaKey || event.ctrlKey)) return
    const next = eventToChatDictationShortcut(event.nativeEvent, platform)
    event.preventDefault()
    event.stopPropagation()
    if (next) changeShortcut(next)
    else if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) {
      setError('请使用 Ctrl/⌘ + Shift + 字母、数字或 F1–F12，可加 Alt；截图默认 8 及关闭、退出用的 W/Q 已保留。')
    }
  }

  return <div className="global-screenshot-row chat-dictation-shortcut-row">
    <span className="setting-icon"><Keyboard size={18} /></span>
    <span className="global-screenshot-copy"><strong>聊天听写快捷键</strong><small>在 ZSense 聊天窗口内开始或结束听写，文字写入输入框。修改后保存设置即可立即生效。</small></span>
    <div className="global-screenshot-controls">
      {recording ? <input autoFocus readOnly value="请按 Ctrl/⌘ + Shift + 按键…" onKeyDown={captureKey} onBlur={() => setRecording(false)} aria-label="录制聊天听写快捷键" data-chat-dictation-shortcut-recording="true" />
        : <button type="button" className="global-screenshot-key" onClick={() => { setRecording(true); setError('') }} disabled={disabled} title="点击后按下新的快捷键，Esc 取消" aria-label={`设置聊天听写快捷键，当前 ${label}`}>{label}</button>}
      <button type="button" className="button secondary small" onClick={() => changeShortcut(DEFAULT_CHAT_DICTATION_SHORTCUT)} disabled={disabled || shortcut === DEFAULT_CHAT_DICTATION_SHORTCUT}>恢复默认</button>
      <button type="button" className="button secondary small" onClick={() => changeShortcut('')} disabled={disabled || !shortcut}>关闭快捷键</button>
    </div>
    <div className="global-screenshot-feedback" aria-live="polite">
      {recording && <small>按 Esc 取消录制。支持字母、数字、F1–F12，可额外按住 Alt。</small>}
      {error && <small className="error" role="alert">{error}</small>}
      {!shortcut && <small>快捷键已关闭；仍可点击聊天输入框旁的听写按钮。</small>}
    </div>
  </div>
}
