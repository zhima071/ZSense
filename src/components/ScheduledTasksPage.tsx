import {
  ArchiveX,
  Brain,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Cpu,
  FileText,
  FolderOpen,
  Filter,
  Eye,
  EyeOff,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelConfiguration, ScheduledTask, ScheduledTaskFrequency, ScheduledTaskInput, ScheduledTaskRun, Skill } from '../types'
import { MarkdownMessage } from './MarkdownMessage'
import { folderLabel, formatDate, formatDuration, frequencyLabel, frequencyOptions, providerNames, weekdayNames } from '../services/scheduled-task-format'
import { ScheduledTaskDetailPanel } from './ScheduledTaskDetailPanel'

function initialInput(task: ScheduledTask | undefined, models: ModelConfiguration[], defaultWorkspacePath: string, skills: Skill[]): ScheduledTaskInput {
  const savedModel = models[0]
  const installedSkillIds = new Set(skills.map((skill) => skill.id))
  return {
    name: task?.name || '',
    frequency: task?.frequency || 'daily',
    timeOfDay: task?.timeOfDay || '09:00',
    weekday: task?.weekday ?? 1,
    dayOfMonth: task?.dayOfMonth ?? 1,
    cronExpression: task?.cronExpression || '',
    modelProvider: task?.modelProvider || savedModel?.provider || 'openrouter',
    model: task?.model || savedModel?.model || '',
    prompt: task?.prompt || '',
    memoryEnabled: task?.memoryEnabled ?? true,
    skillIds: task?.skillIds.filter((skillId) => installedSkillIds.has(skillId)) || [],
    deliveryTarget: 'local',
    repeatCount: task?.repeatCount || 0,
    enabled: task?.enabled ?? true,
    workspacePath: task?.workspacePath || defaultWorkspacePath,
  }
}

interface ScheduledTaskDialogProps {
  task?: ScheduledTask
  runs: ScheduledTaskRun[]
  models: ModelConfiguration[]
  skills: Skill[]
  defaultWorkspacePath: string
  busy: boolean
  onClose: () => void
  onPickWorkspace: () => Promise<string>
  onOpenConversation: (conversationId: string) => void
  onSave: (input: ScheduledTaskInput) => Promise<void>
}

function ScheduledTaskDialog({ task, runs, models, skills, defaultWorkspacePath, busy, onClose, onPickWorkspace, onOpenConversation, onSave }: ScheduledTaskDialogProps) {
  const [draft, setDraft] = useState(() => initialInput(task, models, defaultWorkspacePath, skills))
  const [activePanel, setActivePanel] = useState<'settings' | 'memory'>('settings')
  const [selectedRecentRunId, setSelectedRecentRunId] = useState('')
  const [error, setError] = useState('')
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const frequency = frequencyOptions.find((item) => item.value === draft.frequency)!
  const selectedModelKey = `${draft.modelProvider}:${draft.model}`
  const missingSkillCount = useMemo(() => {
    if (!task?.skillIds.length) return 0
    const installedSkillIds = new Set(skills.map((skill) => skill.id))
    return task.skillIds.filter((skillId) => !installedSkillIds.has(skillId)).length
  }, [skills, task])
  const successfulRuns = useMemo(() => task
    ? runs
      .filter((run) => run.taskId === task.id && run.status === 'success' && run.output.trim())
      .sort((left, right) => String(right.finishedAt || right.startedAt).localeCompare(String(left.finishedAt || left.startedAt)))
      .slice(0, 30)
    : [], [runs, task])
  const recentRunMemories = successfulRuns.slice(0, 2)
  const selectedRecentMemory = recentRunMemories.find((memory) => memory.id === selectedRecentRunId) || recentRunMemories[0]
  const injectedMemoryCount = recentRunMemories.length + (task?.memorySummary ? 1 : 0)
  const injectedCharacterCount = Math.min(4_000, task?.memorySummary.length || 0) + recentRunMemories.reduce((total, memory) => total + Math.min(3_000, memory.output.length), 0)

  useEffect(() => {
    nameRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && !busy && onClose()
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft.name.trim()) return setError('请输入任务名称。')
    if (draft.frequency === 'custom' && !/^(?:\S+\s+){4}\S+$/.test(draft.cronExpression.trim())) return setError('请输入标准 5 段 Cron 表达式，例如 0 9 * * 1-5。')
    if (!draft.model || !models.some((item) => item.provider === draft.modelProvider && item.model === draft.model)) return setError('请先在设置里保存配置或同步官网模型，并为任务重新选择有效模型。')
    if (!draft.prompt.trim()) return setError('请输入任务要执行的内容。')
    setError('')
    try { await onSave({ ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存任务失败，请检查填写内容。') }
  }

  const pickWorkspace = async () => {
    setPickingWorkspace(true)
    setError('')
    try {
      const workspacePath = await onPickWorkspace()
      if (workspacePath) setDraft((current) => ({ ...current, workspacePath }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '选择任务工作区失败。')
    } finally {
      setPickingWorkspace(false)
    }
  }

  return (
    <div className="modal-layer scheduled-task-modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className={`scheduled-task-dialog ${activePanel === 'memory' ? 'memory-view' : ''}`} role="dialog" aria-modal="true" aria-labelledby="scheduled-task-dialog-title" onSubmit={submit}>
        <header>
          <div><small>{task ? 'EDIT SCHEDULE' : 'NEW SCHEDULE'}</small><h2 id="scheduled-task-dialog-title">{task ? '编辑任务' : '创建任务'}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭创建任务窗口"><X size={19} /></button>
        </header>
        {task && <nav className="scheduled-task-tabs" role="tablist" aria-label="编辑任务内容">
          <button type="button" role="tab" id="scheduled-task-settings-tab" aria-selected={activePanel === 'settings'} aria-controls="scheduled-task-settings-panel" className={activePanel === 'settings' ? 'active' : ''} onClick={() => setActivePanel('settings')}><FileText size={15} />任务配置</button>
          <button type="button" role="tab" id="scheduled-task-memory-tab" aria-selected={activePanel === 'memory'} aria-controls="scheduled-task-memory-panel" className={activePanel === 'memory' ? 'active' : ''} onClick={() => setActivePanel('memory')}><Brain size={15} />任务记忆 <b>{injectedMemoryCount}</b></button>
        </nav>}
        {(!task || activePanel === 'settings') && <div className="scheduled-task-form" id="scheduled-task-settings-panel" role={task ? 'tabpanel' : undefined} aria-labelledby={task ? 'scheduled-task-settings-tab' : undefined}>
          <label className="full-field"><span>名称 <i>*</i></span><span className="input-with-count"><input ref={nameRef} value={draft.name} maxLength={200} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="任务名称" /><small>{draft.name.length} / 200</small></span></label>
          <label><span>运行频率 <i>*</i></span><select value={draft.frequency} onChange={(event) => setDraft({ ...draft, frequency: event.target.value as ScheduledTaskFrequency })}>{frequencyOptions.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
          {frequency.needsWeekday && <label><span>星期</span><select value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })}>{weekdayNames.map((name, index) => <option value={index} key={name}>{name}</option>)}</select></label>}
          {frequency.needsDayOfMonth && <label><span>每月日期</span><input type="number" min={1} max={31} value={draft.dayOfMonth} onChange={(event) => setDraft({ ...draft, dayOfMonth: Math.max(1, Math.min(31, Number(event.target.value) || 1)) })} /><small>选择 29–31 日时，没有该日期的月份会跳过。</small></label>}
          {frequency.needsTime && <label><span>执行时间</span><input type="time" value={draft.timeOfDay} onChange={(event) => setDraft({ ...draft, timeOfDay: event.target.value })} /></label>}
          {frequency.needsCron && <label className="full-field"><span>Cron 表达式 <i>*</i></span><input value={draft.cronExpression} onChange={(event) => setDraft({ ...draft, cronExpression: event.target.value })} placeholder="0 9 * * 1-5" spellCheck={false} /><small>本机时区 · 5 段格式：分钟 小时 日期 月份 星期。支持 *、列表、范围和步长，例如 */15 8-18 * * 1-5。</small></label>}
          <label className={frequency.needsTime && !frequency.needsWeekday ? '' : 'full-field'}><span>可用模型 <i>*</i></span><select value={selectedModelKey} onChange={(event) => { const selected = models.find((item) => `${item.provider}:${item.model}` === event.target.value); if (selected) setDraft({ ...draft, modelProvider: selected.provider, model: selected.model }) }}><option value="">选择模型…</option>{models.map((item) => <option key={`${item.provider}:${item.model}`} value={`${item.provider}:${item.model}`}>{providerNames[item.provider]} · {item.model}{item.apiKeyConfigured || item.provider === 'nous' ? '' : '（缺少 API Key）'}</option>)}</select><small>来自“设置 → AI 模型”中已保存的配置和最近一次官网模型同步。</small></label>
          <div className="full-field scheduled-workspace-field" role="group" aria-labelledby="scheduled-workspace-label">
            <span id="scheduled-workspace-label">任务工作区</span>
            <div className={draft.workspacePath ? 'selected' : ''}>
              <FolderOpen size={18} aria-hidden="true" />
              <span><strong title={draft.workspacePath || '由 ZSense 自动创建'}>{draft.workspacePath ? folderLabel(draft.workspacePath) : '自动创建独立工作区'}</strong><small title={draft.workspacePath}>{draft.workspacePath || '保存后由 ZSense 为这个任务创建专属文件夹'}</small></span>
              <button type="button" className="button secondary small" onClick={() => void pickWorkspace()} disabled={busy || pickingWorkspace}>{pickingWorkspace ? <LoaderCircle className="spin" size={14} /> : <FolderOpen size={14} />}{draft.workspacePath ? '更换' : '选择文件夹'}</button>
              {draft.workspacePath && <button type="button" className="button ghost small" onClick={() => setDraft({ ...draft, workspacePath: defaultWorkspacePath })} disabled={busy || pickingWorkspace}>恢复默认</button>}
            </div>
            <small>ZSense Agent Core 生成的文件只会写入这里；未单独指定时继承全局默认工作区。更换目录不会移动或删除旧文件。</small>
          </div>
          <label className="full-field"><span>提示词 <i>*</i></span><span className="textarea-with-count"><textarea value={draft.prompt} maxLength={5000} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="描述每次要执行的内容、期望结果和文件格式" rows={6} /><small>{draft.prompt.length} / 5000</small></span></label>
          <label className={`full-field scheduled-memory-option ${draft.memoryEnabled ? 'enabled' : ''}`}><input type="checkbox" checked={draft.memoryEnabled} onChange={(event) => setDraft({ ...draft, memoryEnabled: event.target.checked })} /><Brain size={18} /><span><strong>启用任务记忆</strong><small>每次成功后更新滚动摘要；下次只召回摘要与最近两次成功结果，原始历史不会全部注入。失败运行不会写入记忆。</small></span></label>
          <fieldset className="full-field scheduled-skill-picker"><legend>技能</legend><p>选择本次任务优先使用的已安装技能；不选择时仍可使用当前启用的共享技能。</p>{missingSkillCount > 0 && <p className="scheduled-skill-warning">已自动移除 {missingSkillCount} 个已卸载或失效的技能，保存后会更新任务配置。</p>}<div>{skills.filter((skill) => skill.enabled).map((skill) => <label key={skill.id}><input type="checkbox" checked={draft.skillIds.includes(skill.id)} onChange={(event) => setDraft({ ...draft, skillIds: event.target.checked ? [...draft.skillIds, skill.id] : draft.skillIds.filter((id) => id !== skill.id) })} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>)}{!skills.some((skill) => skill.enabled) && <small className="scheduled-empty-inline">暂无已启用技能</small>}</div></fieldset>
          <label><span>投递目标</span><select value="local" disabled><option value="local">本地 · 任务运行历史</option></select><small>执行对话只在任务运行历史中显示，文件只保存在任务独立工作区。</small></label>
          <label><span>重复次数（可选）</span><input type="number" min={0} max={100000} value={draft.repeatCount || ''} onChange={(event) => setDraft({ ...draft, repeatCount: Math.max(0, Number(event.target.value) || 0) })} placeholder="留空表示无限重复" /><small>达到次数后自动完成并停止；0 表示无限重复。</small></label>
        </div>}
        {task && activePanel === 'memory' && <section className="scheduled-memory-panel" id="scheduled-task-memory-panel" role="tabpanel" aria-labelledby="scheduled-task-memory-tab">
          <div className="scheduled-memory-summary" aria-label="任务记忆摘要">
            <article><Brain size={17} /><span><small>滚动摘要</small><strong>{task.memorySummary ? '已生成' : '待下次成功后生成'}</strong></span></article>
            <article><Clock3 size={17} /><span><small>近期结果</small><strong>{recentRunMemories.length} / 2 条</strong></span></article>
            <article><FileText size={17} /><span><small>预计注入</small><strong>约 {Math.min(8_000, injectedCharacterCount).toLocaleString('zh-CN')} 字符</strong></span></article>
          </div>
          <div className="scheduled-memory-policy-note"><Brain size={16} /><span><strong>上下文不会随运行次数持续增长</strong><small>下一次运行只使用滚动摘要和最近两次成功结果，总预算约 8,000 字符；下方 {successfulRuns.length} 条原始记录仅供查看。</small></span></div>
          <section className="scheduled-memory-rollup" aria-labelledby="scheduled-memory-rollup-title">
            <header>
              <span><Brain size={16} /><span><strong id="scheduled-memory-rollup-title">滚动摘要</strong><small>后台在每次成功运行后合并更新，自动去除重复和过时信息。</small></span></span>
              <b>{task.memorySummaryRunCount} 次结果</b>
            </header>
            {task.memorySummary
              ? <div className="scheduled-memory-rollup-body"><p>{task.memorySummary}</p><small>最后更新：{formatDate(task.memorySummaryUpdatedAt)}</small></div>
              : <div className="scheduled-memory-empty"><Brain size={23} /><span><strong>尚未生成滚动摘要</strong><small>升级后的下一次成功运行会在后台生成；已有历史仍完整保留。</small></span></div>}
          </section>
          <section className="scheduled-memory-library context-memory" aria-labelledby="scheduled-memory-context-title">
            <header>
              <span><Clock3 size={16} /><span><strong id="scheduled-memory-context-title">最近两次成功结果</strong><small>作为近期上下文参与下一次运行，每条最多使用前 3,000 字符。</small></span></span>
              <b>{recentRunMemories.length} 条</b>
            </header>
            {recentRunMemories.length ? <div className="scheduled-memory-reader">
              <nav aria-label="选择近期运行结果">
                {recentRunMemories.map((memory, index) => <button key={memory.id} type="button" className={selectedRecentMemory?.id === memory.id ? 'active' : ''} aria-pressed={selectedRecentMemory?.id === memory.id} onClick={() => setSelectedRecentRunId(memory.id)}><span><strong>{formatDate(memory.finishedAt || memory.startedAt)}</strong><small>{memory.output.length.toLocaleString('zh-CN')} 字符 · 注入 {Math.min(3_000, memory.output.length).toLocaleString('zh-CN')}</small></span><b>{index === 0 ? '最近' : '上一次'}</b></button>)}
              </nav>
              {selectedRecentMemory && <article aria-label={`${formatDate(selectedRecentMemory.finishedAt || selectedRecentMemory.startedAt)} 的运行结果`}>
                <header><span><strong>{formatDate(selectedRecentMemory.finishedAt || selectedRecentMemory.startedAt)}</strong><small>完整结果 · 下一次最多注入前 {Math.min(3_000, selectedRecentMemory.output.length).toLocaleString('zh-CN')} 字符</small></span>{selectedRecentMemory.conversationId && <button type="button" className="button secondary small" onClick={() => { onClose(); onOpenConversation(selectedRecentMemory.conversationId!) }}><FileText size={13} />查看完整对话</button>}</header>
                <div className="scheduled-memory-reader-content"><MarkdownMessage content={selectedRecentMemory.output} /></div>
              </article>}
            </div> : <div className="scheduled-memory-empty"><Brain size={23} /><span><strong>还没有近期结果</strong><small>任务成功运行后，最近两次结果会显示在这里。</small></span></div>}
          </section>
          <section className="scheduled-memory-library scheduled-memory-archive" aria-labelledby="scheduled-memory-archive-title">
            <header>
              <span><ArchiveX size={16} /><span><strong id="scheduled-memory-archive-title">原始成功记录</strong><small>完整保留用于查看和审计，不会随着数量增长全部注入 Agent。</small></span></span>
              <b>{successfulRuns.length} 条</b>
            </header>
            <div className="scheduled-memory-storage"><strong>存储位置</strong><code>zsense.sqlite3 → scheduled_task_runs.output</code><small>滚动摘要存储在 scheduled_tasks.memory_summary；数据只属于当前任务。</small></div>
            <div className="scheduled-memory-list scheduled-memory-archive-list">
              {successfulRuns.map((memory) => <details key={memory.id}>
                <summary><span><strong>{formatDate(memory.finishedAt || memory.startedAt)}</strong><small>{memory.output.length.toLocaleString('zh-CN')} 字符 · 原始成功结果</small></span><span>仅查看</span></summary>
                <p>{memory.output}</p>
                {memory.conversationId && <button type="button" className="button secondary small" onClick={() => { onClose(); onOpenConversation(memory.conversationId!) }}><FileText size={13} />查看完整对话</button>}
              </details>)}
              {!successfulRuns.length && <div className="scheduled-memory-empty"><ArchiveX size={23} /><span><strong>还没有原始成功记录</strong><small>成功运行后会完整保存在这里，失败结果不会进入任务记忆。</small></span></div>}
            </div>
          </section>
        </section>}
        {error && <div className="scheduled-form-error" role="alert">{error}</div>}
        {!models.length && <div className="scheduled-form-error" role="alert">还没有可用模型，请先前往“设置 → AI 模型”保存配置或刷新官网列表。</div>}
        <footer><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy || !models.length}>{busy ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}{busy ? '保存中…' : task ? '保存' : '创建'}</button></footer>
      </form>
    </div>
  )
}

interface ScheduledTasksPageProps {
  tasks: ScheduledTask[]
  runs: ScheduledTaskRun[]
  models: ModelConfiguration[]
  skills: Skill[]
  defaultWorkspacePath: string
  onCreate: (input: ScheduledTaskInput) => Promise<void>
  onUpdate: (id: string, input: ScheduledTaskInput) => Promise<void>
  onToggle: (id: string, enabled: boolean) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onDeleteRun: (id: string) => Promise<void>
  onRunNow: (id: string) => Promise<void>
  /** 切换这个任务是否在总览页展示 */
  onToggleOverviewVisibility: (id: string, visible: boolean) => Promise<void>
  onPickWorkspace: () => Promise<string>
  onOpenWorkspace: (id: string) => Promise<void>
  onOpenConversation: (conversationId: string) => void
  /** 从总览卡片“编辑任务”跳过来时，直接打开这个任务的编辑表单 */
  editingTaskId?: string
  onEditingTaskHandled?: () => void
}

export function ScheduledTasksPage({ tasks, runs, models, skills, defaultWorkspacePath, onCreate, onUpdate, onToggle, onDelete, onDeleteRun, onRunNow, onToggleOverviewVisibility, onPickWorkspace, onOpenWorkspace, onOpenConversation, editingTaskId, onEditingTaskHandled }: ScheduledTasksPageProps) {
  const [sortBy, setSortBy] = useState<'name' | 'time'>('name')
  const [ascending, setAscending] = useState(true)
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null)
  const [busy, setBusy] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [runFilters, setRunFilters] = useState({ taskName: '', from: '', to: '', status: 'all' as 'all' | ScheduledTaskRun['status'] })
  const visibleTasks = useMemo(() => [...tasks].sort((a, b) => {
    const direction = ascending ? 1 : -1
    if (sortBy === 'name') return direction * a.name.localeCompare(b.name, 'zh-CN')
    return direction * String(a.nextRunAt || '9999').localeCompare(String(b.nextRunAt || '9999'))
  }), [ascending, sortBy, tasks])
  const visibleRuns = useMemo(() => runs.filter((run) => {
    if (runFilters.taskName.trim() && !run.taskName.toLocaleLowerCase('zh-CN').includes(runFilters.taskName.trim().toLocaleLowerCase('zh-CN'))) return false
    if (runFilters.status !== 'all' && run.status !== runFilters.status) return false
    const started = new Date(run.startedAt)
    if (Number.isNaN(started.getTime())) return !runFilters.from && !runFilters.to
    const localDate = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, '0')}-${String(started.getDate()).padStart(2, '0')}`
    if (runFilters.from && localDate < runFilters.from) return false
    if (runFilters.to && localDate > runFilters.to) return false
    return true
  }), [runFilters, runs])

  const chooseSort = (next: 'name' | 'time') => {
    if (sortBy === next) setAscending((current) => !current)
    else { setSortBy(next); setAscending(true) }
  }

  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  // 从总览卡片点「编辑任务」跳过来：直接打开这个任务的表单
  useEffect(() => {
    if (!editingTaskId) return
    const target = tasks.find((task) => task.id === editingTaskId)
    if (target) setEditing(target)
    onEditingTaskHandled?.()
  }, [editingTaskId, tasks])

  const detailTask = detailTaskId ? tasks.find((task) => task.id === detailTaskId) || null : null
  const detailLatestRun = detailTask ? runs.find((run) => run.taskId === detailTask.id) : undefined
  const detailRunning = detailLatestRun?.status === 'running'

  const runAction = async (id: string, label: string, action: () => Promise<void>) => {
    setBusy(`${label}:${id}`)
    try { await action() } finally { setBusy('') }
  }

  return (
    <div className="page scheduled-tasks-page">
      <section className="panel scheduled-tasks-board">
        <header className="scheduled-tasks-heading"><div><span className="eyebrow">AUTOMATION</span><h1>定时任务</h1><p>由 ZSense Agent Core 在应用运行期间自动执行，结果进入任务运行历史。</p></div><div className="scheduled-sort-actions"><button className={sortBy === 'name' ? 'active' : ''} onClick={() => chooseSort('name')}>名称排序 {sortBy === 'name' ? ascending ? '↑' : '↓' : '↕'}</button><button className={sortBy === 'time' ? 'active' : ''} onClick={() => chooseSort('time')}>时间排序 {sortBy === 'time' ? ascending ? '↑' : '↓' : '↕'}</button><i /><button className="button primary" onClick={() => setEditing('new')}><Plus size={17} />创建任务</button></div></header>
        <div className="scheduled-task-list">
          {visibleTasks.map((task) => {
            const latestRun = runs.find((run) => run.taskId === task.id)
            const isRunning = latestRun?.status === 'running'
            const statusLabel = isRunning ? '运行中' : task.status === 'active' ? '已启用' : task.status === 'completed' ? '已完成' : '已暂停'
            return <article className="scheduled-task-card" key={task.id}>
              <button type="button" className="scheduled-task-open" aria-label={`查看定时任务 ${task.name} 的详细信息`} onClick={() => setDetailTaskId(task.id)}>
                <span className="scheduled-task-card-head">
                  <span className={`scheduled-task-icon ${isRunning ? 'running' : task.status}`}><CalendarClock size={16} /></span>
                  <span className={`task-status ${isRunning ? 'running' : task.status}`}>{statusLabel}</span>
                </span>
                <strong className="scheduled-task-name" title={task.name}>{task.name}</strong>
                <span className="scheduled-task-when"><Clock3 size={12} />{frequencyLabel(task)}</span>
                <span className="scheduled-task-next">{task.enabled ? `下次 ${formatDate(task.nextRunAt)}` : '已暂停，不再自动运行'}</span>
              </button>
              <button type="button" className={`scheduled-task-quick ${isRunning ? 'is-running' : ''}`} title={isRunning ? '任务正在运行' : '立即运行'} aria-label={`立即运行 ${task.name}`} disabled={isRunning || busy === `run:${task.id}`} onClick={() => void runAction(task.id, 'run', () => onRunNow(task.id))}>{isRunning || busy === `run:${task.id}` ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}</button>
              <button type="button" className={`scheduled-task-quick ${task.showOnOverview ? 'is-visible' : ''}`} title={task.showOnOverview ? '当前会显示在总览页，点击隐藏' : '当前不在总览页显示，点击显示'} aria-label={`${task.showOnOverview ? '不再在总览页展示' : '在总览页展示'} ${task.name}`} aria-pressed={task.showOnOverview} disabled={busy === `overview:${task.id}`} onClick={() => void runAction(task.id, 'overview', () => onToggleOverviewVisibility(task.id, !task.showOnOverview))}>{busy === `overview:${task.id}` ? <LoaderCircle className="spin" size={14} /> : task.showOnOverview ? <Eye size={14} /> : <EyeOff size={14} />}</button>
            </article>
          })}
          {!visibleTasks.length && <div className="scheduled-empty"><CalendarClock size={42} /><strong>暂无定时任务</strong><p>创建一个任务，让 ZSense 按计划自动完成重复工作。</p><button className="button primary" onClick={() => setEditing('new')}><Plus size={16} />创建第一个任务</button></div>}
        </div>
        <section className="scheduled-run-history">
          <header><div><h2>运行历史</h2><p>筛选每次执行的时间、状态、模型与完整任务对话；这些对话不会进入普通对话列表，删除记录会同时删除该次完整对话。</p></div><div className="scheduled-run-heading-actions"><span>{visibleRuns.length}{visibleRuns.length !== runs.length ? ` / ${runs.length}` : ''} 次运行</span><button type="button" className={`button secondary small ${filtersOpen ? 'active' : ''}`} onClick={() => setFiltersOpen((current) => !current)} aria-expanded={filtersOpen}><Filter size={14} />筛选</button></div></header>
          {filtersOpen && <div className="scheduled-run-filters" role="search" aria-label="筛选定时任务运行记录"><label><span>任务名称</span><input value={runFilters.taskName} onChange={(event) => setRunFilters({ ...runFilters, taskName: event.target.value })} placeholder="输入任务名称" /></label><label><span>开始日期</span><input type="date" value={runFilters.from} onChange={(event) => setRunFilters({ ...runFilters, from: event.target.value })} /></label><label><span>结束日期</span><input type="date" value={runFilters.to} onChange={(event) => setRunFilters({ ...runFilters, to: event.target.value })} /></label><label><span>运行状态</span><select value={runFilters.status} onChange={(event) => setRunFilters({ ...runFilters, status: event.target.value as typeof runFilters.status })}><option value="all">全部</option><option value="running">运行中</option><option value="success">成功</option><option value="failed">失败</option></select></label><button type="button" className="button ghost small" onClick={() => setRunFilters({ taskName: '', from: '', to: '', status: 'all' })}>清除筛选</button></div>}
          <div className="scheduled-run-list">{visibleRuns.map((run) => <article key={run.id}><span className={`scheduled-run-icon ${run.status}`}>{run.status === 'running' ? <LoaderCircle className="spin" size={17} /> : run.status === 'success' ? <CheckCircle2 size={17} /> : <ArchiveX size={17} />}</span><div className="scheduled-run-copy"><div><strong>{run.taskName}</strong><span>{run.status === 'running' ? '运行中' : run.status === 'success' ? '成功' : '失败'}</span></div><p>{run.error || run.output || (run.status === 'running' ? 'ZSense Agent Core 正在执行任务…' : '没有返回内容')}</p><div className="scheduled-run-meta"><small><Clock3 size={12} />{formatDate(run.startedAt)} · 耗时 {formatDuration(run.durationMs)}</small><small title={run.model ? `${run.modelProvider ? providerNames[run.modelProvider] : '未知供应商'} · ${run.model}` : '旧版本运行记录未保存模型'}><Cpu size={12} />运行模型：{run.model ? `${run.modelProvider ? providerNames[run.modelProvider] : '未知供应商'} · ${run.model}` : '未记录模型'}</small></div></div><div className="scheduled-run-actions">{run.conversationId && <button className="button secondary small" onClick={() => onOpenConversation(run.conversationId!)}><FileText size={14} />查看完整对话</button>}<button className="button danger-outline small" disabled={run.status === 'running' || Boolean(busy)} title={run.status === 'running' ? '运行中的记录不能删除' : '删除这条运行记录及完整对话'} onClick={() => { if (window.confirm('确定删除这次运行记录吗？该次运行产生的完整对话也会被删除，且无法撤销。')) void runAction(run.id, 'delete-run', () => onDeleteRun(run.id)) }}>{busy === `delete-run:${run.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}删除记录</button></div></article>)}{!visibleRuns.length && <div className="scheduled-history-empty"><ArchiveX size={30} /><strong>{runs.length ? '没有符合条件的记录' : '暂无运行历史'}</strong><p>{runs.length ? '请调整筛选条件后重试。' : '任务首次运行后会在这里显示详细结果。'}</p></div>}</div>
        </section>
      </section>
      {detailTask && <ScheduledTaskDetailPanel
        task={detailTask}
        runs={runs}
        busy={busy}
        onBusyChange={setBusy}
        onClose={() => setDetailTaskId(null)}
        onRunNow={onRunNow}
        onEdit={(task) => setEditing(task)}
        onToggle={onToggle}
        onOpenWorkspace={onOpenWorkspace}
        onDelete={onDelete}
        onOpenConversation={onOpenConversation}
      />}
      {editing && <ScheduledTaskDialog task={editing === 'new' ? undefined : editing} runs={runs} models={models} skills={skills} defaultWorkspacePath={defaultWorkspacePath} busy={busy === 'save'} onClose={() => setEditing(null)} onPickWorkspace={onPickWorkspace} onOpenConversation={onOpenConversation} onSave={async (input) => { setBusy('save'); try { if (editing === 'new') await onCreate(input); else await onUpdate(editing.id, input); setEditing(null) } finally { setBusy('') } }} />}
    </div>
  )
}
