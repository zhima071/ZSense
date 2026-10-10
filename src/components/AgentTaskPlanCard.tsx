import { AlertTriangle, CheckCircle2, ChevronDown, Circle, GitBranch, LoaderCircle, XCircle } from 'lucide-react'
import type { AgentTaskPlanSnapshot, AgentTaskRecord } from '../types'

const phaseLabels: Record<AgentTaskPlanSnapshot['phase'], string> = {
  planning: '正在拆分任务', scheduled: '任务已安排', running: '并行执行中',
  validating: '主 Agent 汇总校验', complete: '已完成汇总', error: '执行中断', cancelled: '已停止',
}
const taskLabels: Record<AgentTaskRecord['status'], string> = {
  pending: '待处理', queued: '等待执行', running: '执行中', waiting: '等待依赖或文件锁',
  completed: '已完成', failed: '失败', blocked: '依赖未完成', cancelled: '已停止',
}

function TaskIcon({ status }: { status: AgentTaskRecord['status'] }) {
  if (status === 'running') return <LoaderCircle size={14} className="spin" />
  if (status === 'completed') return <CheckCircle2 size={14} />
  if (status === 'failed' || status === 'blocked') return <AlertTriangle size={14} />
  if (status === 'cancelled') return <XCircle size={14} />
  return <Circle size={14} />
}

export function AgentTaskPlanCard({ plan }: { plan?: AgentTaskPlanSnapshot }) {
  if (!plan) return null
  const completed = plan.tasks.filter((task) => task.status === 'completed').length
  const active = ['planning', 'scheduled', 'running', 'validating'].includes(plan.phase)
  const running = active ? plan.tasks.filter((task) => task.status === 'running').length : 0
  const names = new Map(plan.tasks.map((task) => [task.id, task.title]))
  return <section className={`agent-task-plan ${plan.phase}`} aria-label="多 Agent 任务计划">
    <header>
      <GitBranch size={15} aria-hidden="true" /><strong>任务计划</strong>
      <span>{completed}/{plan.tasks.length} 已完成</span>
      <small role="status">{phaseLabels[plan.phase]}{running > 0 ? ` · ${running} 路运行` : ''}</small>
    </header>
    {plan.message && <p className="agent-task-plan-message">{plan.message}</p>}
    <ol>
      {plan.tasks.map((task) => <li key={task.id} data-task-id={task.id} data-task-status={task.status} className={task.status}>
        <span className="agent-task-icon" aria-hidden="true"><TaskIcon status={task.status} /></span>
        <div>
          <div className="agent-task-title"><strong>{task.title}</strong><small>{!active && task.status === 'running' ? '最后确认：执行中' : taskLabels[task.status]}</small>{task.durationMs != null && <time>{(Math.max(0, task.durationMs) / 1000).toFixed(1)} s</time>}</div>
          {task.goal && task.goal !== task.title && <p>{task.goal}</p>}
          {task.dependencies.length > 0 && <small className="agent-task-dependencies">依赖：{task.dependencies.map((id) => names.get(id) || id).join('、')}</small>}
          {task.error && <p className="agent-task-error">{task.error}</p>}
          {(task.output || task.expectedOutputs.length > 0 || task.writeResources.length > 0 || task.toolCallCount != null) && <details>
            <summary><ChevronDown size={12} aria-hidden="true" />查看交付与执行详情{task.toolCallCount != null ? ` · ${task.toolCallCount} 次工具调用` : ''}</summary>
            {task.expectedOutputs.length > 0 && <p>交付：{task.expectedOutputs.join('；')}</p>}
            {task.writeResources.length > 0 && <p>写入范围：{task.writeResources.join('、')}</p>}
            {task.output && <pre>{task.output}</pre>}
          </details>}
        </div>
      </li>)}
    </ol>
    {plan.phase === 'planning' && plan.tasks.length === 0 && <p className="agent-task-plan-message"><LoaderCircle className="spin" size={13} aria-hidden="true" />正在识别目标、依赖与交付结果…</p>}
  </section>
}
