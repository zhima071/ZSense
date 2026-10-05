import { CalendarClock, FolderOpen, Pause, Pencil, Play, Plus } from 'lucide-react'
import type { ScheduledTask } from '../types'

const FREQUENCY_LABELS: Record<string, string> = {
  once: '仅一次', daily: '每天', weekly: '每周', monthly: '每月', cron: '自定义',
}

interface BotScheduledTasksProps {
  botName: string
  tasks: ScheduledTask[]
  onRunNow: (id: string) => void | Promise<void>
  onToggle: (id: string, enabled: boolean) => void | Promise<void>
  onEdit: (task: ScheduledTask) => void
  onOpenWorkspace: (id: string) => void | Promise<void>
  onCreate: () => void
}

/** Bot 工作区的「定时任务」板块：只列出归属这个 Bot 的任务 */
export function BotScheduledTasks({ botName, tasks, onRunNow, onToggle, onEdit, onOpenWorkspace, onCreate }: BotScheduledTasksProps) {
  return (
    <div className="bot-tasks-panel">
      <section className="panel">
        <div className="panel-header">
          <div><h2>定时任务</h2><p>只属于 {botName} 的任务，用它自己的模型、记忆与技能执行</p></div>
          <button className="primary-button" onClick={onCreate}><Plus size={15} />新建任务</button>
        </div>
        {tasks.length === 0 ? (
          <p className="bot-task-empty">这个 Bot 还没有定时任务。点「新建任务」创建的默认归属 {botName}。</p>
        ) : (
          <ul className="bot-task-list">
            {tasks.map((task) => (
              <li key={task.id} className="bot-task-row">
                <span className={task.enabled ? 'bot-task-dot on' : 'bot-task-dot'} />
                <div className="bot-task-main">
                  <strong>{task.name}</strong>
                  <small>
                    {FREQUENCY_LABELS[task.frequency] || task.frequency} {task.timeOfDay}
                    {' · '}{task.enabled ? '已启用' : '已暂停'}
                    {task.nextRunAt ? ` · 下次 ${String(task.nextRunAt).slice(5, 16)}` : ''}
                  </small>
                </div>
                <div className="bot-task-actions">
                  <button className="icon-button" title="立即运行" aria-label={`立即运行 ${task.name}`} onClick={() => void onRunNow(task.id)}><Play size={15} /></button>
                  <button className="icon-button" title={task.enabled ? '暂停' : '启用'} aria-label={`${task.enabled ? '暂停' : '启用'} ${task.name}`} onClick={() => void onToggle(task.id, !task.enabled)}>{task.enabled ? <Pause size={15} /> : <Play size={15} />}</button>
                  <button className="icon-button" title="编辑任务" aria-label={`编辑 ${task.name}`} onClick={() => onEdit(task)}><Pencil size={15} /></button>
                  <button className="icon-button" title="打开工作区" aria-label={`打开 ${task.name} 的工作区`} onClick={() => void onOpenWorkspace(task.id)}><FolderOpen size={15} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel isolation-card">
        <span className="boundary-icon"><CalendarClock size={20} /></span>
        <div><strong>按 Bot 归属</strong><p>这里的任务只在 {botName} 的空间里运行，不会读取其他 Bot 的记忆与技能。</p></div>
      </section>
    </div>
  )
}
