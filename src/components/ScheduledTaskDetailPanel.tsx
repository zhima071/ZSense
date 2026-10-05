import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { CalendarClock, ExternalLink, Eye, EyeOff, FileText, LoaderCircle, Pause, Pencil, Play, RotateCcw, Trash2, X } from 'lucide-react'
import type { ScheduledTask, ScheduledTaskRun } from '../types'
import { folderLabel, formatDate, formatDuration, frequencyLabel, providerNames } from '../services/scheduled-task-format'

interface ScheduledTaskDetailPanelProps {
  task: ScheduledTask
  runs: ScheduledTaskRun[]
  /** 正在进行的操作（形如 run:<id>），与卡片上的按钮共用一套忙碌状态 */
  busy?: string
  onBusyChange?: (busy: string) => void
  onClose: () => void
  onRunNow: (id: string) => void | Promise<void>
  /** 不传时隐藏「编辑任务」（编辑表单只在定时任务页里） */
  onEdit?: (task: ScheduledTask) => void
  onToggle: (id: string, enabled: boolean) => void | Promise<void>
  /** 切换这个任务是否在总览页展示 */
  onToggleOverviewVisibility?: (id: string, visible: boolean) => void | Promise<void>
  onOpenWorkspace: (id: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onOpenConversation: (conversationId: string) => void
}

/**
 * 定时任务悬浮详情面板：定时任务页与总览页共用同一份实现，
 * 保证两处看到的内容、状态与按钮完全一致（总览点卡片直接开这个面板）。
 */
export function ScheduledTaskDetailPanel({ task, runs, busy = '', onBusyChange, onClose, onRunNow, onEdit, onToggle, onToggleOverviewVisibility, onOpenWorkspace, onDelete, onOpenConversation }: ScheduledTaskDetailPanelProps) {
  const latestRun = runs.find((run) => run.taskId === task.id)
  const running = latestRun?.status === 'running'
  const statusLabel = running ? '运行中' : task.status === 'active' ? '已启用' : task.status === 'completed' ? '已完成' : '已暂停'
  // Esc 关闭（遮罩点击关闭在下面处理）；放在组件里，总览页与定时任务页都生效
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const runAction = async (label: string, action: () => void | Promise<void>) => {
    onBusyChange?.(`${label}:${task.id}`)
    try { await action() } finally { onBusyChange?.('') }
  }

  return createPortal(
    <div className="scheduled-task-detail-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="scheduled-task-detail-panel" role="dialog" aria-modal="true" aria-labelledby="scheduled-task-detail-title">
        <header>
          <span className={`scheduled-task-icon ${running ? 'running' : task.status}`}><CalendarClock size={18} /></span>
          <div><h2 id="scheduled-task-detail-title">{task.name}</h2><small>{providerNames[task.modelProvider]} · {task.model}</small></div>
          <span className={`task-status ${running ? 'running' : task.status}`}>{statusLabel}</span>
          <button type="button" className="icon-button" aria-label="关闭任务详情" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="scheduled-task-detail-body">
          <section><h3>任务内容</h3><p className="scheduled-task-prompt">{task.prompt}</p></section>
          <section><h3>运行配置</h3><dl>
            <div><dt>计划</dt><dd>{frequencyLabel(task)}</dd></div>
            <div><dt>下次运行</dt><dd>{task.enabled ? formatDate(task.nextRunAt) : '已暂停'}</dd></div>
            <div><dt>模型</dt><dd>{providerNames[task.modelProvider]} · {task.model}</dd></div>
            <div><dt>工作区</dt><dd title={task.workspacePath}>{folderLabel(task.workspacePath)}</dd></div>
            <div><dt>任务记忆</dt><dd>{task.memoryEnabled ? '已开启 · 成功结果跨次复用' : '未开启'}</dd></div>
            <div><dt>进度</dt><dd>{task.runCount}{task.repeatCount ? ` / ${task.repeatCount}` : ' 次'}</dd></div>
          </dl></section>
          {latestRun && <section>
            <h3>最近一次运行</h3>
            <p className="scheduled-task-latest">{latestRun.status === 'running' ? '正在运行' : latestRun.status === 'success' ? '成功' : '失败'} · {formatDate(latestRun.startedAt)} · 耗时 {formatDuration(latestRun.durationMs)}{latestRun.error ? ` · ${latestRun.error}` : ''}</p>
            {latestRun.conversationId && <button type="button" className="button secondary small" onClick={() => { onClose(); onOpenConversation(latestRun.conversationId!) }}><FileText size={14} />查看完整对话</button>}
          </section>}
        </div>
        <footer className="scheduled-task-detail-actions">
          <button className="button secondary small" disabled={running || busy === `run:${task.id}`} onClick={() => void runAction('run', () => onRunNow(task.id))}>{running || busy === `run:${task.id}` ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}立即运行</button>
          {onEdit && <button className="button secondary small" onClick={() => { onClose(); onEdit(task) }}><Pencil size={14} />编辑任务</button>}
          <button className="button secondary small" disabled={busy === `toggle:${task.id}`} onClick={() => void runAction('toggle', () => onToggle(task.id, !task.enabled))}>{task.enabled ? <Pause size={14} /> : <RotateCcw size={14} />}{task.enabled ? '暂停任务' : '继续任务'}</button>
          {onToggleOverviewVisibility && <button className="button secondary small" disabled={busy === `overview:${task.id}`} aria-pressed={task.showOnOverview} title={task.showOnOverview ? '当前会显示在总览页，点击隐藏' : '当前不在总览页显示，点击显示'} onClick={() => void runAction('overview', () => onToggleOverviewVisibility(task.id, !task.showOnOverview))}>{task.showOnOverview ? <Eye size={14} /> : <EyeOff size={14} />}{task.showOnOverview ? '在总览页显示' : '不在总览页显示'}</button>}
          <button className="button secondary small" onClick={() => void runAction('workspace', () => onOpenWorkspace(task.id))}><ExternalLink size={14} />打开工作区</button>
          <button className="button danger-outline small" onClick={() => { if (window.confirm(`确定删除定时任务“${task.name}”吗？运行历史将一并删除。`)) { void runAction('delete', async () => { await onDelete(task.id); onClose() }) } }}><Trash2 size={14} />删除任务</button>
        </footer>
      </section>
    </div>, document.body,
  )
}
