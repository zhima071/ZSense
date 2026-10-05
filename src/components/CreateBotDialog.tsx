import { Check, X } from 'lucide-react'
import { FormEvent, useEffect, useRef, useState } from 'react'
import type { Bot } from '../types'

interface CreateBotDialogProps {
  open: boolean
  onClose: () => void
  onCreate: (bot: Bot) => void
  defaultModel?: string
}

const colors = ['#8b5cf6', '#38bdf8', '#10b981', '#f59e0b', '#f472b6']
export function CreateBotDialog({ open, onClose, onCreate, defaultModel }: CreateBotDialogProps) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(colors[0])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  if (!open) return null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !role.trim()) return
    const normalized = name.trim()
    onCreate({
      id: `${normalized.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')}-${Date.now()}`,
      name: normalized,
      initials: normalized.slice(0, 2).toUpperCase(),
      role: role.trim(),
      description: description.trim() || '一个由 ZSense Agent Core 驱动的专属 Bot。',
      status: 'online',
      color,
      modelProvider: '',
      model: '',
      memoryCount: 0,
      memorySize: '0 KB',
      channels: ['web'],
      lastActive: '刚刚',
      conversations: 0,
      successRate: 100,
      prompt: `你是 ${normalized}，${role.trim()}。请在行动前确认目标，并将稳定的用户偏好写入你的独立记忆空间。`,
      memories: [],
    })
    setName('')
    setRole('')
    setDescription('')
  }

  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="create-bot-title">
        <div className="dialog-header">
          <div><span className="eyebrow">NEW BOT</span><h2 id="create-bot-title">创建一个专属 Bot</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </div>
        <p className="dialog-intro">每个 Bot 都会获得独立身份、记忆命名空间和消息路由。</p>
        <div className="form-grid">
          <label>
            <span>Bot 名称</span>
            <input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Nova" required />
          </label>
          <label>
            <span>角色</span>
            <input value={role} onChange={(event) => setRole(event.target.value)} placeholder="例如：代码审查助手" required />
          </label>
          <label className="full-field">
            <span>一句话描述</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个 Bot 负责什么？" rows={3} />
          </label>
          <fieldset className="full-field">
            <legend>标识色</legend>
            <div className="color-picker">
              {colors.map((value) => (
                <button key={value} type="button" className={color === value ? 'selected' : ''} style={{ '--swatch': value } as React.CSSProperties} onClick={() => setColor(value)} aria-label={`选择颜色 ${value}`}>
                  {color === value && <Check size={15} />}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="full-field bot-gateway-hint"><Check size={16} /><span><strong>Web Chat 会自动启用</strong><small>钉钉、飞书等外部机器人请在创建 Bot 后，到“消息网关”为它添加独立账号。</small></span></div>
        </div>
        <div className="isolation-note">
          <Check size={16} />
          <span><strong>严格隔离已开启</strong><small>记忆将存储在独立的 Bot 命名空间中；模型默认跟随 ZSense 全局配置{defaultModel ? `（${defaultModel}）` : ''}。</small></span>
        </div>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={!name.trim() || !role.trim()}>创建 Bot</button>
        </div>
      </form>
    </div>
  )
}
