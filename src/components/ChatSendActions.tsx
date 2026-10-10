import { ArrowUp, Square } from 'lucide-react'

interface ChatSendActionsProps {
  sending: boolean
  disabled: boolean
  onStop: () => void
}

export function ChatSendActions({ sending, disabled, onStop }: ChatSendActionsProps) {
  const sendLabel = sending ? '调整本轮' : '发送消息'
  return (
    <span className="chat-send-actions" role="group" aria-label="对话发送操作">
      {sending && <button className="chat-send stop" type="button" onClick={onStop} aria-label="停止当前轮次" title="停止当前轮次"><Square size={14} /></button>}
      <button className={`chat-send ${sending ? 'steer' : ''}`} type="submit" disabled={disabled} aria-label={sendLabel} title={sendLabel}><ArrowUp size={18} /></button>
    </span>
  )
}
