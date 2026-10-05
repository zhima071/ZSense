import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, LoaderCircle, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChatToolEvent } from '../types'

interface ChatToolCallsProps {
  tools: ChatToolEvent[]
}

function formatToolDuration(value?: number) {
  if (value == null) return ''
  if (value < 1_000) return `${Math.max(0, Math.round(value))} 毫秒`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1_000)} 秒`
}

function ToolStatusIcon({ status }: Pick<ChatToolEvent, 'status'>) {
  if (status === 'running') return <LoaderCircle className="spin" size={14} aria-hidden="true" />
  if (status === 'complete') return <CheckCircle2 size={14} aria-hidden="true" />
  return <AlertTriangle size={14} aria-hidden="true" />
}

export function mergeChatToolEvent(tools: ChatToolEvent[], event: ChatToolEvent) {
  const next = [...tools]
  const index = next.findIndex((tool) => tool.toolId === event.toolId)
  if (index < 0) return [...next, event]
  next[index] = {
    ...next[index],
    ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined && value !== '')),
  } as ChatToolEvent
  return next
}

export function ChatToolCalls({ tools }: ChatToolCallsProps) {
  const runningCount = tools.filter((tool) => tool.status === 'running').length
  const failedCount = tools.filter((tool) => tool.status === 'error').length
  const [open, setOpen] = useState(runningCount > 0)
  const wasRunning = useRef(runningCount > 0)

  useEffect(() => {
    if (runningCount > 0) setOpen(true)
    else if (wasRunning.current) setOpen(false)
    wasRunning.current = runningCount > 0
  }, [runningCount])

  return (
    <details className="chat-tool-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span><Wrench size={14} aria-hidden="true" />工具调用</span>
        <small>{tools.length} 次{runningCount ? ` · ${runningCount} 次执行中` : failedCount ? ` · ${failedCount} 次失败` : ' · 已完成'}</small>
        <ChevronDown className="chat-tool-chevron" size={15} aria-hidden="true" />
      </summary>
      <div className="chat-tool-list">
        {tools.map((tool) => {
          const duration = formatToolDuration(tool.durationMs)
          const hasDetails = Boolean(tool.input || tool.output)
          return (
            <details className={`chat-tool-call ${tool.status}`} key={tool.toolId} open={tool.status === 'error' || undefined}>
              <summary>
                <span className="chat-tool-status"><ToolStatusIcon status={tool.status} /></span>
                <strong>{tool.name}</strong>
                {tool.detail && <small title={tool.detail}>{tool.detail}</small>}
                {duration && <time><Clock3 size={11} aria-hidden="true" />{duration}</time>}
                <ChevronDown className="chat-tool-chevron" size={14} aria-hidden="true" />
              </summary>
              <div className="chat-tool-detail">
                {tool.input && <section><h4>输入参数</h4><pre>{tool.input}</pre></section>}
                {tool.output && <section><h4>{tool.status === 'error' ? '错误详情' : '返回结果'}</h4><pre>{tool.output}</pre></section>}
                {!hasDetails && <p>Agent Core 仅返回了调用状态，暂无更多输入或输出详情。</p>}
              </div>
            </details>
          )
        })}
      </div>
    </details>
  )
}
