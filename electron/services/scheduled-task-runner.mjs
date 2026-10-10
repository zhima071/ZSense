import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { NATIVE_BOT_ID } from './database.mjs'
import { redactSensitiveText } from './redaction.mjs'
import { nativeWorkspaceIdentity } from './workspace-context.mjs'
import { createMemoryScope } from './memory-scope.mjs'

const CHECK_INTERVAL_MS = 15_000

function scheduledTime(task, from) {
  const [hours, minutes] = String(task.timeOfDay || '09:00').split(':').map(Number)
  const result = new Date(from)
  result.setSeconds(0, 0)
  result.setHours(Number.isInteger(hours) ? hours : 9, Number.isInteger(minutes) ? minutes : 0, 0, 0)
  return result
}

function cronField(source, minimum, maximum, label, normalize = (value) => value) {
  const values = new Set()
  const addRange = (start, end, step = 1) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(step) || step < 1 || start < minimum || end > maximum || start > end) throw new Error(`${label}字段无效。`)
    for (let value = start; value <= end; value += step) values.add(normalize(value))
  }
  for (const segment of String(source || '').split(',')) {
    const [base, stepSource] = segment.split('/')
    const step = stepSource === undefined ? 1 : Number(stepSource)
    if (base === '*') addRange(minimum, maximum, step)
    else if (/^\d+-\d+$/.test(base)) {
      const [start, end] = base.split('-').map(Number)
      addRange(start, end, step)
    } else if (/^\d+$/.test(base) && stepSource === undefined) addRange(Number(base), Number(base))
    else throw new Error(`${label}字段无效。`)
  }
  return values
}

export function parseCronExpression(expression) {
  const parts = String(expression || '').trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('Cron 表达式必须包含 5 段：分钟 小时 日期 月份 星期。')
  return {
    minutes: cronField(parts[0], 0, 59, '分钟'),
    hours: cronField(parts[1], 0, 23, '小时'),
    days: cronField(parts[2], 1, 31, '日期'),
    months: cronField(parts[3], 1, 12, '月份'),
    weekdays: cronField(parts[4], 0, 7, '星期', (value) => value === 7 ? 0 : value),
  }
}

function nextCronRun(expression, from) {
  const cron = parseCronExpression(expression)
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)
  const maximum = 2 * 366 * 24 * 60
  for (let index = 0; index < maximum; index += 1) {
    if (cron.minutes.has(candidate.getMinutes())
      && cron.hours.has(candidate.getHours())
      && cron.days.has(candidate.getDate())
      && cron.months.has(candidate.getMonth() + 1)
      && cron.weekdays.has(candidate.getDay())) return candidate.toISOString()
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  throw new Error('Cron 表达式在未来两年内没有可执行时间。')
}

export function nextScheduledRun(task, fromValue = new Date()) {
  const from = new Date(fromValue)
  if (Number.isNaN(from.getTime())) throw new Error('无法计算定时任务的下次执行时间。')
  if (task.frequency === 'every-5m' || task.frequency === 'every-15m' || task.frequency === 'every-30m' || task.frequency === 'hourly') {
    const minutes = task.frequency === 'every-5m' ? 5 : task.frequency === 'every-15m' ? 15 : task.frequency === 'every-30m' ? 30 : 60
    return new Date(from.getTime() + minutes * 60_000).toISOString()
  }
  if (task.frequency === 'daily') {
    const result = scheduledTime(task, from)
    if (result <= from) result.setDate(result.getDate() + 1)
    return result.toISOString()
  }
  if (task.frequency === 'weekdays') {
    const result = scheduledTime(task, from)
    if (result <= from) result.setDate(result.getDate() + 1)
    while (result.getDay() === 0 || result.getDay() === 6) result.setDate(result.getDate() + 1)
    return result.toISOString()
  }
  if (task.frequency === 'weekly') {
    const result = scheduledTime(task, from)
    const targetWeekday = Number.isInteger(task.weekday) ? task.weekday : 1
    let days = (targetWeekday - result.getDay() + 7) % 7
    if (days === 0 && result <= from) days = 7
    result.setDate(result.getDate() + days)
    return result.toISOString()
  }
  if (task.frequency === 'monthly') {
    const targetDay = Math.max(1, Math.min(31, Number(task.dayOfMonth) || 1))
    for (let offset = 0; offset < 24; offset += 1) {
      const base = new Date(from.getFullYear(), from.getMonth() + offset, targetDay)
      if (base.getDate() !== targetDay) continue
      const result = scheduledTime(task, base)
      if (result > from) return result.toISOString()
    }
    throw new Error('无法计算每月任务的下次执行时间。')
  }
  if (task.frequency === 'custom') return nextCronRun(task.cronExpression, from)
  throw new Error('不支持的定时任务运行频率。')
}

function configuredModel(workspace, task) {
  const match = workspace.availableModelConfigurations.find((item) => item.provider === task.modelProvider && item.model === task.model)
  if (match) return match
  if (workspace.modelConfiguration.provider === task.modelProvider && workspace.modelConfiguration.model === task.model) return workspace.modelConfiguration
  throw new Error('任务选择的模型配置已不存在，请编辑任务并重新选择已保存模型。')
}

export class ScheduledTaskRunner {
  constructor({ database, agentCore = null, secrets, userDataDirectory, onChanged = () => {}, notify = () => {} }) {
    this.database = database
    this.agentCore = agentCore
    this.secrets = secrets
    this.rootPath = path.join(userDataDirectory, 'scheduled-task-workspaces')
    this.onChanged = onChanged
    this.notify = notify
    this.timer = null
    this.activePromise = null
    this.runningTaskIds = new Set()
    this.queuedTaskIds = new Set()
    this.memorySummaryPromises = new Map()
    fs.mkdirSync(this.rootPath, { recursive: true })
    this.database.recoverInterruptedScheduledTaskRuns()
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, CHECK_INTERVAL_MS)
    this.timer.unref?.()
    void this.tick()
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.activePromise
    await Promise.allSettled([...this.memorySummaryPromises.values()])
  }

  create(input) {
    const now = new Date()
    const id = `task-${randomUUID()}`
    const workspacePath = String(input.workspacePath || '').trim() || path.join(this.rootPath, id)
    fs.mkdirSync(workspacePath, { recursive: true })
    const task = {
      ...input,
      id,
      workspacePath,
      nextRunAt: input.enabled ? nextScheduledRun(input, now) : null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    const workspace = this.database.createScheduledTask(task)
    this.#emit(workspace)
    return workspace
  }

  update(taskId, input) {
    if (this.runningTaskIds.has(taskId) || this.queuedTaskIds.has(taskId)) throw new Error('任务正在运行或等待运行，请完成后再编辑。')
    const now = new Date()
    const workspacePath = String(input.workspacePath || '').trim() || path.join(this.rootPath, taskId)
    fs.mkdirSync(workspacePath, { recursive: true })
    const workspace = this.database.updateScheduledTask(taskId, {
      ...input,
      workspacePath,
      nextRunAt: input.enabled ? nextScheduledRun(input, now) : null,
      updatedAt: now.toISOString(),
    })
    this.#emit(workspace)
    return workspace
  }

  toggle(taskId, enabled) {
    const task = this.database.getScheduledTask(taskId)
    if (!task) throw new Error('定时任务不存在或已经被删除。')
    const workspace = this.database.setScheduledTaskEnabled(taskId, enabled, enabled ? nextScheduledRun(task, new Date()) : null)
    this.#emit(workspace)
    if (enabled) void this.tick()
    return workspace
  }

  delete(taskId) {
    if (this.runningTaskIds.has(taskId) || this.queuedTaskIds.has(taskId)) throw new Error('任务正在运行或等待运行，请完成后再删除。')
    const workspace = this.database.deleteScheduledTask(taskId)
    this.#emit(workspace)
    return workspace
  }

  deleteRun(runId) {
    const workspace = this.database.deleteScheduledTaskRun(runId)
    this.#emit(workspace)
    return workspace
  }

  openWorkspace(taskId) {
    const task = this.database.getScheduledTask(taskId)
    if (!task) throw new Error('定时任务不存在或已经被删除。')
    fs.mkdirSync(task.workspacePath, { recursive: true })
    return task.workspacePath
  }

  runNow(taskId) {
    const task = this.database.getScheduledTask(taskId)
    if (!task) throw new Error('定时任务不存在或已经被删除。')
    if (this.runningTaskIds.has(taskId) || this.queuedTaskIds.has(taskId)) throw new Error('这个任务已经在运行或等待运行。')
    this.queuedTaskIds.add(taskId)
    const previous = this.activePromise
    const promise = (async () => {
      if (previous) await previous
      this.queuedTaskIds.delete(taskId)
      return this.#execute(task)
    })()
    const active = promise.finally(() => { if (this.activePromise === active) this.activePromise = null })
    this.activePromise = active
    return { accepted: true, taskId }
  }

  tick() {
    if (this.activePromise) return this.activePromise
    const promise = (async () => {
      const dueTasks = this.database.getDueScheduledTasks(new Date().toISOString())
      for (const task of dueTasks) {
        if (!this.runningTaskIds.has(task.id)) await this.#execute(task)
      }
    })()
    const active = promise.finally(() => { if (this.activePromise === active) this.activePromise = null })
    this.activePromise = active
    return this.activePromise
  }

  #emit(workspace = this.database.loadWorkspace()) {
    try { this.onChanged(workspace) } catch { /* a closed renderer must not stop scheduled work */ }
  }

  #memorySummaryContext(taskId, sourceRunId, expectedRevision) {
    const currentTask = this.database.getScheduledTask(taskId)
    if (!currentTask?.memoryEnabled) return { reason: '任务已删除或任务记忆已关闭' }
    if (Number(currentTask.memoryRevision || 0) !== expectedRevision) return { reason: '任务记忆已被清空、编辑或重新配置' }
    const sourceRun = this.database.getScheduledTaskRun(sourceRunId)
    if (!sourceRun || sourceRun.taskId !== taskId || sourceRun.status !== 'success') return { reason: '来源成功运行已删除或失效' }
    return { task: currentTask }
  }

  #queueMemorySummaryRefresh({ task, sourceRunId, expectedRevision, modelConfiguration, apiKey, output }) {
    if (!task.memoryEnabled || !output.trim() || typeof this.agentCore?.summarizeScheduledTaskMemory !== 'function') return
    const cancelled = (reason) => {
      console.info('ZSense 定时任务滚动摘要已取消：', { taskId: task.id, sourceRunId, reason })
    }
    const previous = this.memorySummaryPromises.get(task.id)
    const pipeline = (async () => {
      if (previous) await previous.catch(() => undefined)
      const current = this.#memorySummaryContext(task.id, sourceRunId, expectedRevision)
      if (!current.task) { cancelled(current.reason); return }
      const currentTask = current.task
      const summary = await this.agentCore.summarizeScheduledTaskMemory({
        taskName: currentTask.name,
        taskPrompt: currentTask.prompt,
        previousSummary: currentTask.memorySummary,
        latestOutput: output,
        model: modelConfiguration.model,
        modelProvider: modelConfiguration.provider,
        apiKey,
        baseUrl: modelConfiguration.baseUrl || '',
      })
      if (!summary.trim()) return
      const latest = this.#memorySummaryContext(task.id, sourceRunId, expectedRevision)
      if (!latest.task || latest.task.prompt !== currentTask.prompt) { cancelled(latest.reason || '任务提示已更改'); return }
      const workspace = this.database.updateScheduledTaskMemorySummary(task.id, summary, { expectedRevision, sourceRunId })
      if (!workspace) { cancelled('提交前任务记忆或来源运行已失效'); return }
      this.#emit(workspace)
    })().catch((error) => {
      console.warn('ZSense 定时任务滚动摘要更新失败：', redactSensitiveText(error instanceof Error ? error.message : String(error)))
    })
    const tracked = pipeline.finally(() => {
      if (this.memorySummaryPromises.get(task.id) === tracked) this.memorySummaryPromises.delete(task.id)
    })
    this.memorySummaryPromises.set(task.id, tracked)
  }

  async #execute(task) {
    task = this.database.getScheduledTask(task.id) || task
    const memoryRevision = Number(task.memoryRevision || 0)
    this.runningTaskIds.add(task.id)
    const startedAt = new Date()
    const runId = `task-run-${randomUUID()}`
    const nextRunAt = task.enabled ? nextScheduledRun(task, startedAt) : task.nextRunAt
    this.database.startScheduledTaskRun(task.id, runId, startedAt.toISOString(), nextRunAt)
    this.#emit()
    let conversationId = ''
    try {
      const workspace = this.database.loadWorkspace()
      const modelConfiguration = configuredModel(workspace, task)
      const scopedSecret = this.secrets.get(`model:${modelConfiguration.provider}`)
      const legacySecret = workspace.modelConfiguration.provider === modelConfiguration.provider ? this.secrets.get('model:default') : {}
      const apiKey = scopedSecret.apiKey || legacySecret.apiKey || ''
      if (!this.agentCore?.supportsProvider(modelConfiguration.provider)) throw new Error(`ZSense Agent Core 暂不支持任务模型供应商 ${modelConfiguration.provider}。`)
      const runtimeStatus = await this.agentCore.inspect()
      if (!runtimeStatus.runnable) throw new Error(runtimeStatus.message || 'ZSense Agent 运行内核尚未就绪。')
      if (this.agentCore.requiresApiKey(modelConfiguration.provider) && !apiKey) throw new Error('任务所用模型的 API Key 尚未配置。')

      const bot = nativeWorkspaceIdentity(workspace)
      const safeText = workspace.settings.sensitiveDataRedaction ? redactSensitiveText : (value) => value

      fs.mkdirSync(task.workspacePath, { recursive: true })
      conversationId = this.database.createNativeConversation(`定时任务：${task.name}`, {
        channelId: 'scheduled',
        runtimeEngine: 'zsense-core',
        modelProvider: modelConfiguration.provider,
        model: modelConfiguration.model,
        reasoningEffort: 'high',
        workspacePath: task.workspacePath,
      })
      this.database.addMessage(conversationId, 'user', task.prompt)
      const selectedSkillNames = workspace.skills.filter((skill) => task.skillIds.includes(skill.id)).map((skill) => skill.name)
      const instruction = [
        `你正在执行 ZSense 定时任务“${task.name}”。`,
        task.memoryEnabled ? '本任务已开启任务记忆：可以参考系统提供的相关长期记忆、本任务滚动摘要和最近两次成功结果；完整原始历史不会全部注入。若旧结果与本次提示冲突，以本次提示为准。' : '本任务未开启任务记忆：只根据本次提示和当前工作区执行。',
        selectedSkillNames.length ? `本次任务优先使用这些已安装技能：${selectedSkillNames.join('、')}。` : '本次任务可使用 ZSense 当前已启用的共享技能。',
        `所有生成文件必须只写入当前任务工作区：${task.workspacePath}`,
        '完成后直接给出执行结果与生成文件清单。',
        '',
        task.prompt,
      ].join('\n')
      const toolEvents = []
      const requestId = `scheduled-${randomUUID()}`
      const selectedSkills = workspace.skills.filter((skill) => task.skillIds.length ? task.skillIds.includes(skill.id) : skill.assignedBotIds.length > 0)
      const memoryLimit = workspace.settings.memoryRecallLimit
      const recalledMemories = task.memoryEnabled
        ? (await this.database.memoryService.recallMemories(NATIVE_BOT_ID, task.prompt, {
          ...createMemoryScope({ workspacePath: task.workspacePath }),
          limit: memoryLimit,
          characterBudget: 5_000,
        })).memories
        : []
      const taskRunMemories = task.memoryEnabled
        ? this.database.recallScheduledTaskMemories(task.id, task.prompt, {
          characterBudget: 8_000,
        }).memories
        : []
      const result = await this.agentCore.chatStream({
        requestId,
        bot,
        message: instruction,
        model: modelConfiguration.model,
        modelProvider: modelConfiguration.provider,
        contextWindow: modelConfiguration.contextWindow || 0,
        apiKey,
        baseUrl: modelConfiguration.baseUrl || '',
        skills: selectedSkills,
        memories: [...recalledMemories, ...taskRunMemories],
        memoryScope: createMemoryScope({ workspacePath: task.workspacePath }),
        settings: workspace.settings,
        appContext: {
          scheduledTask: { id: task.id, name: task.name, workspacePath: task.workspacePath, memoryEnabled: task.memoryEnabled, recalledTaskRuns: taskRunMemories.length },
          currentBot: { id: bot.id, name: bot.name, status: bot.status },
          gatewayConnections: [],
          isolation: '定时任务不注入业务 Bot 的私有内容、状态、记忆、会话或网关。',
        },
        reasoningEffort: 'high',
        workspacePath: task.workspacePath,
        source: 'zsense-scheduled',
        onEvent: (event) => {
          if (event.type === 'started' && event.sessionId) this.database.setConversationRuntimeSession(conversationId, 'zsense-core', event.sessionId)
          if (event.type === 'tool') {
            const cleaned = { ...event }
            for (const key of ['detail', 'input', 'output']) {
              if (typeof cleaned[key] === 'string') cleaned[key] = safeText(cleaned[key])
            }
            const current = toolEvents.find((item) => item.toolId === cleaned.toolId)
            if (current) Object.assign(current, cleaned)
            else toolEvents.push(cleaned)
          }
        },
      })
      this.database.setConversationRuntimeSession(conversationId, 'zsense-core', result.sessionId)
      if (result.usage) this.database.updateConversationOptions(conversationId, NATIVE_BOT_ID, { usage: result.usage })
      const output = safeText(result.output)
      const finishedAt = new Date()
      const runDurationMs = finishedAt.getTime() - startedAt.getTime()
      const responseDurationMs = Number.isFinite(result.durationMs) ? Math.max(0, Math.round(result.durationMs)) : runDurationMs
      const agentSteps = Array.isArray(result.agentSteps) ? result.agentSteps.map((step) => ({
        ...step,
        reasoning: safeText(step.reasoning || ''),
        content: safeText(step.content || ''),
        error: safeText(step.error || ''),
        tools: Array.isArray(step.tools) ? step.tools.map((tool) => ({ ...tool, detail: safeText(tool.detail || ''), input: safeText(tool.input || ''), output: safeText(tool.output || '') })) : [],
      })) : []
      this.database.addMessage(conversationId, 'assistant', output, {
        reasoning: safeText(result.reasoning || ''),
        agentSteps,
        toolEvents,
        modelProvider: modelConfiguration.provider,
        model: modelConfiguration.model,
        durationMs: responseDurationMs,
        outputTokens: result.usage?.outputTokens,
      })
      this.database.completeNativeConversation(conversationId)
      const nextWorkspace = this.database.finishScheduledTaskRun({
        taskId: task.id,
        runId,
        status: 'success',
        finishedAt: finishedAt.toISOString(),
        durationMs: runDurationMs,
        conversationId,
        output,
      })
      this.#emit(nextWorkspace)
      this.#queueMemorySummaryRefresh({ task, sourceRunId: runId, expectedRevision: memoryRevision, modelConfiguration, apiKey, output })
      this.notify('completion', `定时任务已完成：${task.name}`, '执行结果已写入运行历史，滚动记忆摘要将在后台更新。')
      return nextWorkspace
    } catch (error) {
      const message = error instanceof Error ? error.message : '定时任务执行失败。'
      if (conversationId) this.database.addMessage(conversationId, 'system', message)
      const finishedAt = new Date()
      const nextWorkspace = this.database.finishScheduledTaskRun({
        taskId: task.id,
        runId,
        status: 'failed',
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        conversationId,
        error: message,
      })
      this.#emit(nextWorkspace)
      this.notify('completion', `定时任务失败：${task.name}`, '任务未完成，请返回 ZSense 运行历史查看已脱敏的错误信息。')
      return nextWorkspace
    } finally {
      this.runningTaskIds.delete(task.id)
    }
  }
}
