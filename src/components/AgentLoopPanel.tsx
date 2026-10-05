import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, Clock3, ListTree, LoaderCircle, PanelRightClose, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentLoopStep, ChatStreamEvent, ChatToolEvent } from '../types'
import { ChatToolCalls, mergeChatToolEvent } from './ChatToolCalls'

interface AgentLoopSource {
  agentSteps?: AgentLoopStep[]
  reasoning?: string
  tools?: ChatToolEvent[]
  streaming?: boolean
}

interface AgentLoopPanelProps {
  source?: AgentLoopSource
  open: boolean
  showReasoning: boolean
  onClose: () => void
}

interface AgentLoopTriggerProps {
  source: AgentLoopSource
  onClick: () => void
}

const emptyStep = (step: number, startedAt = new Date().toISOString()): AgentLoopStep => ({
  step,
  status: 'running',
  outcome: 'thinking',
  reasoning: '',
  content: '',
  tools: [],
  startedAt,
  toolCallCount: 0,
})

function stepForEvent(steps: AgentLoopStep[], event: Extract<ChatStreamEvent, { type: 'agent-step' | 'reasoning' | 'answer' | 'tool' }>) {
  const requested = Math.max(1, Number(event.step || steps.at(-1)?.step || 1))
  const index = steps.findIndex((item) => item.step === requested)
  if (index >= 0) return { index, step: steps[index] }
  const step = emptyStep(requested, event.type === 'agent-step' && event.startedAt ? event.startedAt : undefined)
  steps.push(step)
  return { index: steps.length - 1, step }
}

export function mergeAgentLoopEvent(current: AgentLoopStep[], event: ChatStreamEvent): AgentLoopStep[] {
  if (event.type !== 'agent-step' && event.type !== 'reasoning' && event.type !== 'answer' && event.type !== 'tool') return current
  const next = current.map((item) => ({ ...item, tools: [...(item.tools || [])] }))
  const target = stepForEvent(next, event)
  const step = target.step

  if (event.type === 'agent-step') {
    next[target.index] = event.phase === 'started'
      ? { ...step, status: event.status, outcome: event.outcome, startedAt: event.startedAt || step.startedAt }
      : {
          ...step,
          status: event.status,
          outcome: event.outcome,
          reasoning: event.reasoning ?? step.reasoning,
          content: event.content ?? step.content,
          tools: event.tools ?? step.tools,
          durationMs: event.durationMs,
          toolCallCount: event.toolCallCount ?? step.toolCallCount,
          error: event.error,
        }
  } else if (event.type === 'reasoning') {
    next[target.index] = { ...step, reasoning: event.replace ? event.delta : `${step.reasoning || ''}${event.delta}` }
  } else if (event.type === 'answer') {
    next[target.index] = { ...step, content: `${step.content || ''}${event.delta}` }
  } else {
    next[target.index] = { ...step, tools: mergeChatToolEvent(step.tools || [], event), toolCallCount: Math.max(step.toolCallCount || 0, step.tools.some((tool) => tool.toolId === event.toolId) ? step.tools.length : step.tools.length + 1) }
  }

  return next.sort((left, right) => left.step - right.step)
}

export function agentLoopStepsFor(source?: AgentLoopSource): AgentLoopStep[] {
  if (source?.agentSteps?.length) return source.agentSteps
  if (!source?.reasoning && !source?.tools?.length) return []
  return [{
    ...emptyStep(1),
    status: source.streaming ? 'running' : 'complete',
    outcome: source.tools?.length ? 'tool_calls' : 'final_answer',
    reasoning: source.reasoning || '',
    tools: source.tools || [],
    toolCallCount: source.tools?.length || 0,
  }]
}

function durationLabel(value?: number) {
  if (value == null) return ''
  if (value < 1_000) return `${Math.max(0, Math.round(value))} ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
}

function outcomeLabel(step: AgentLoopStep) {
  const tools = step.tools || []
  if (step.status === 'running') return tools.some((tool) => tool.status === 'running') ? '执行工具' : '模型推理'
  if (step.status === 'error') return '执行中断'
  if (step.outcome === 'final_answer') return '生成最终回答'
  if (step.outcome === 'steered') return '收到追加指令，已重新规划'
  if (step.outcome === 'stalled') return '检测到持续无进展，已诚实收尾'
  return `完成 ${step.toolCallCount || tools.length} 次工具调用`
}

function compactPreview(value?: string) {
  const normalized = String(value || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[`*_>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''
  return normalized.length > 180 ? `${normalized.slice(0, 180).trimEnd()}…` : normalized
}

function clippedStructuredField(source: string, field: 'stdout' | 'stderr') {
  const marker = `"${field}": "`
  const start = source.indexOf(marker)
  if (start < 0) return ''
  return source
    .slice(start + marker.length, start + marker.length + 1_200)
    .split('\n…（内容过长，已截断）')[0]
    .replace(/\\r\\n|\\n|\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function toolStageResult(tool: ChatToolEvent) {
  const rawOutput = String(tool.output || '')
  let structured: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(rawOutput)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) structured = parsed as Record<string, unknown>
  } catch {
    structured = null
  }
  const processStatus = String(structured?.status || '')
  const failed = tool.status === 'error' || processStatus === 'failed' || processStatus === 'terminated'
  const running = tool.status === 'running' || processStatus === 'running'
  const partialStdout = structured ? '' : clippedStructuredField(rawOutput, 'stdout')
  const partialStderr = structured ? '' : clippedStructuredField(rawOutput, 'stderr')
  const preferred = failed
    ? structured?.stderr || partialStderr || structured?.stdout || partialStdout || structured?.error || structured?.message
    : structured?.stdout || partialStdout || structured?.stderr || partialStderr || structured?.message
  const fallback = rawOutput.trimStart().startsWith('{') ? tool.detail : rawOutput || tool.detail
  const detail = compactPreview(typeof preferred === 'string' ? preferred : fallback)
  const state = failed ? '执行失败' : running ? '正在执行' : '执行完成'
  return `${tool.name} ${state}${detail ? `：${detail}` : ''}`
}

function stageResultPreview(step: AgentLoopStep) {
  const content = compactPreview(step.content)
  if (content) return content
  const error = compactPreview(step.error)
  if (error) return `本轮中断：${error}`
  const lastTool = step.tools?.at(-1)
  if (lastTool) return toolStageResult(lastTool)
  return outcomeLabel(step)
}

function StepStatusIcon({ status }: Pick<AgentLoopStep, 'status'>) {
  if (status === 'running') return <LoaderCircle className="spin" size={14} aria-hidden="true" />
  if (status === 'error') return <AlertTriangle size={14} aria-hidden="true" />
  return <CheckCircle2 size={14} aria-hidden="true" />
}

function AgentLoopStepCard({ step, showReasoning }: { step: AgentLoopStep; showReasoning: boolean }) {
  const [open, setOpen] = useState(step.status === 'running')

  useEffect(() => {
    setOpen(step.status === 'running')
  }, [step.status])

  const duration = durationLabel(step.durationMs)
  const tools = step.tools || []
  const hasReasoning = Boolean(step.reasoning?.trim())
  const hasContent = Boolean(step.content?.trim())
  const hasToolDetails = tools.length > 0
  const recordedToolCount = Math.max(step.toolCallCount || 0, tools.length)
  const hasVisibleDetails = (showReasoning && hasReasoning) || hasContent || hasToolDetails || Boolean(step.error)
  const stageResult = stageResultPreview(step)
  const bodyId = `agent-loop-step-${step.step}-body`
  return (
    <article className={`agent-loop-step ${step.status} ${open ? 'is-open' : ''}`} data-agent-step={step.step}>
      <button type="button" className={`agent-loop-step-summary ${stageResult ? 'has-stage-result' : ''}`} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((current) => !current)}>
        <span className="agent-loop-step-index">{step.step}</span>
        <span className="agent-loop-step-title">
          <span className="agent-loop-step-heading">
            <strong>第 {step.step} 轮</strong>
            <small>{outcomeLabel(step)}</small>
            {duration && <time><Clock3 size={11} aria-hidden="true" />{duration}</time>}
          </span>
          {stageResult && <span className="agent-loop-step-preview"><b>{step.outcome === 'final_answer' ? '最终结果：' : '阶段结果：'}</b>{stageResult}</span>}
        </span>
        <span className="agent-loop-step-status"><StepStatusIcon status={step.status} /></span>
        <ChevronDown className="agent-loop-step-chevron" size={14} aria-hidden="true" />
      </button>
      {open && <div id={bodyId} className="agent-loop-step-body">
        {showReasoning && hasReasoning && <section><h4><BrainCircuit size={13} aria-hidden="true" />推理过程</h4><pre>{step.reasoning}</pre></section>}
        {!showReasoning && hasReasoning && <p className="agent-loop-step-notice"><BrainCircuit size={13} aria-hidden="true" />推理过程显示已关闭，可在“设置 → 显示”中开启。</p>}
        {hasContent && <section><h4><ListTree size={13} aria-hidden="true" />{step.outcome === 'final_answer' ? '本轮最终结果' : '本轮阶段结果'}</h4><pre>{step.content}</pre></section>}
        {hasToolDetails && <section><h4><Wrench size={13} aria-hidden="true" />本轮工具</h4><ChatToolCalls tools={tools} /></section>}
        {!hasToolDetails && recordedToolCount > 0 && <p className="agent-loop-step-notice"><Wrench size={13} aria-hidden="true" />已记录 {recordedToolCount} 次工具调用，但这条旧记录没有保存输入和输出详情。</p>}
        {step.error && <div className="agent-loop-step-error"><AlertTriangle size={13} aria-hidden="true" />{step.error}</div>}
        {!hasVisibleDetails && !(hasReasoning && !showReasoning) && recordedToolCount === 0 && <p className="agent-loop-step-waiting">{step.status === 'running' ? '正在等待模型返回本轮结果…' : '本轮已完成，没有返回可展示的过程内容。'}</p>}
      </div>}
    </article>
  )
}

export function AgentLoopTrigger({ source, onClick }: AgentLoopTriggerProps) {
  const steps = agentLoopStepsFor(source)
  if (!steps.length) return null
  const running = steps.some((step) => step.status === 'running')
  return <button type="button" className={`agent-loop-trigger ${running ? 'running' : ''}`} onClick={onClick} aria-label={`查看 Agent Loop，共 ${steps.length} 轮`} title="查看分轮执行过程"><ListTree size={12} aria-hidden="true" /><span>Agent · {steps.length} 轮</span>{running && <i aria-hidden="true" />}</button>
}

export function AgentLoopPanel({ source, open, showReasoning, onClose }: AgentLoopPanelProps) {
  const steps = agentLoopStepsFor(source)
  const timelineRef = useRef<HTMLDivElement>(null)
  const runningStep = [...steps].reverse().find((step) => step.status === 'running')
  const running = Boolean(runningStep)
  const completed = steps.filter((step) => step.status === 'complete').length

  useEffect(() => {
    if (!open || !runningStep) return
    const card = timelineRef.current?.querySelector<HTMLElement>(`[data-agent-step="${runningStep.step}"]`)
    card?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [open, runningStep?.step])

  if (!open || !steps.length) return null

  return (
    <aside className="agent-loop-panel" aria-label="Agent Loop 执行过程">
      <header>
        <span className={`agent-loop-panel-icon ${running ? 'running' : ''}`}><ListTree size={17} aria-hidden="true" /></span>
        <span><strong>Agent 执行过程</strong><small>{running ? `正在执行第 ${runningStep?.step || 1} 轮` : `${completed}/${steps.length} 轮已完成`}</small></span>
        <button type="button" onClick={onClose} aria-label="收起 Agent 执行过程" title="收起"><PanelRightClose size={17} /></button>
      </header>
      <div className="agent-loop-timeline" ref={timelineRef}>
        {steps.map((step) => <AgentLoopStepCard key={step.step} step={step} showReasoning={showReasoning} />)}
      </div>
    </aside>
  )
}
