import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_CONCURRENT_SUBAGENTS } from './agent-task-scheduler.mjs'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const MAX_STORED_TASKS = 500

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temporary, filePath)
}

function clipped(value, maximum) {
  const text = String(value ?? '')
  return text.length > maximum ? `${text.slice(0, maximum)}\n…（内容过长，已截断）` : text
}

function publicTask(task, { includeOutput = true } = {}) {
  return {
    id: task.id,
    title: task.title,
    task: task.task,
    status: task.status,
    parentRequestId: task.parentRequestId,
    rootRequestId: task.rootRequestId || task.parentRequestId,
    parentTaskId: task.parentTaskId || '',
    childTaskIds: task.childTaskIds || [],
    depth: Number(task.depth || 0),
    conversationId: task.conversationId,
    botId: task.botId,
    workspacePath: task.workspacePath,
    modelProvider: task.modelProvider,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    durationMs: task.durationMs,
    toolCallCount: task.toolCallCount,
    phase: task.phase || '',
    orchestrationPlanId: task.orchestrationPlanId || '',
    planTaskId: task.planTaskId || '',
    usage: task.usage || {},
    messages: (task.messages || []).slice(-50),
    ...(includeOutput ? { output: task.output, error: task.error, toolEvents: task.toolEvents } : {}),
  }
}

function visibleToContext(task, context = {}) {
  const requestId = String(context.requestId || '')
  const rootRequestId = String(context.rootRequestId || '')
  const sameBot = task.botId === String(context.botId || '__zsense_native__')
  const conversationId = String(context.conversationId || '')
  if (!sameBot || (conversationId && task.conversationId !== conversationId)) return false
  // A running model can see only its own request tree, not another run in the same conversation.
  if (requestId || rootRequestId) return (requestId && (task.parentRequestId === requestId || task.rootRequestId === requestId)) || (rootRequestId && task.rootRequestId === rootRequestId)
  return true
}

export class SubagentService {
  constructor({ rootPath, maxConcurrent = MAX_CONCURRENT_SUBAGENTS, maxPerParent = 5, maxDepth = 4 } = {}) {
    this.filePath = path.join(rootPath, 'capabilities', 'delegations.json')
    this.maxConcurrent = Math.max(1, Math.min(MAX_CONCURRENT_SUBAGENTS, Number(maxConcurrent) || MAX_CONCURRENT_SUBAGENTS))
    this.maxPerParent = Math.max(1, Math.min(12, Number(maxPerParent) || 5))
    this.maxDepth = Math.max(1, Math.min(8, Number(maxDepth) || 4))
    this.tasks = []
    this.queue = []
    this.running = new Map()
    this.runtimeContexts = new Map()
    this.waiters = new Map()
    this.waitingParents = new Set()
    this.parentWaitCounts = new Map()
    this.resumeWaiters = new Set()
    this.completedToolIds = new Map()
    this.runner = null
    this.closed = false
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    this.#restore()
  }

  #restore() {
    let parsed = []
    try { parsed = JSON.parse(fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath, 'utf8') : '[]') } catch { parsed = [] }
    const now = new Date().toISOString()
    let changed = false
    this.tasks = (Array.isArray(parsed) ? parsed : []).filter((item) => item?.id && item?.task).slice(-MAX_STORED_TASKS).map((item) => {
      const normalized = { ...item, rootRequestId: item.rootRequestId || item.parentRequestId || '', childTaskIds: item.childTaskIds || [], messages: item.messages || [] }
      if (!['queued', 'running'].includes(item.status)) return normalized
      changed = true
      return { ...normalized, status: 'interrupted', error: '应用上次退出时子 Agent 尚未完成。', finishedAt: now, durationMs: Number(item.durationMs || 0) }
    })
    if (changed) this.#save()
  }

  #save() {
    const serializable = this.tasks.slice(-MAX_STORED_TASKS).map(({ agentRequestId: _agentRequestId, ...task }) => task)
    atomicJson(this.filePath, serializable)
  }

  #find(id, context = {}) {
    const task = this.tasks.find((item) => item.id === String(id || ''))
    if (!task || !visibleToContext(task, context)) throw new Error('子 Agent 任务不存在或不属于当前会话。')
    return task
  }

  #notify(task) {
    for (const resolve of this.waiters.get(task.id) || []) resolve()
    this.waiters.delete(task.id)
  }

  #publish(task) {
    try { this.runtimeContexts.get(task.id)?.onTaskUpdate?.(publicTask(task)) } catch { /* Progress cannot stop execution. */ }
  }

  #recordEvent(task, event) {
    if (event?.type === 'status' || event?.type === 'agent-state') {
      task.phase = String(event.phase || event.message || '')
      this.#publish(task)
      return
    }
    if (event?.type !== 'tool') return
    task.phase = `${String(event.name || '')}:${String(event.status || '')}`
    if (!['complete', 'error'].includes(event.status)) { this.#publish(task); return }
    if (event.toolId) {
      const completed = this.completedToolIds.get(task.id) || new Set()
      if (completed.has(event.toolId)) return
      completed.add(event.toolId)
      this.completedToolIds.set(task.id, completed)
    }
    task.toolEvents = [...(task.toolEvents || []), {
      name: String(event.name || ''),
      status: event.status,
      durationMs: Number(event.durationMs || 0),
      detail: clipped(event.detail || '', 500),
    }].slice(-50)
    task.toolCallCount = Number(task.toolCallCount || 0) + 1
    task.updatedAt = new Date().toISOString()
    this.#save()
    this.#publish(task)
  }

  setRunner(runner) {
    if (!runner || typeof runner.run !== 'function') throw new Error('子 Agent 运行器无效。')
    this.runner = runner
  }

  async create(input = {}, context = {}) {
    if (this.closed) throw new Error('子 Agent 服务正在关闭。')
    if (!this.runner) throw new Error('子 Agent 运行器尚未初始化。')
    const depth = Number(context.delegationDepth || 0) + 1
    if (depth > this.maxDepth) throw new Error(`子 Agent 任务树最多支持 ${this.maxDepth} 层。请让当前 Agent 直接完成或先汇总已有结果。`)
    const taskText = clipped(input.task, 12_000).trim()
    if (!taskText) throw new Error('子 Agent 任务内容不能为空。')
    const parentRequestId = String(context.requestId || '')
    if (!parentRequestId) throw new Error('无法识别当前主 Agent 请求。')
    const parentTaskId = String(context.parentTaskId || '')
    const rootRequestId = String(context.rootRequestId || parentRequestId)
    const createdThisTurn = this.tasks.filter((item) => (parentTaskId ? item.parentTaskId === parentTaskId : item.parentRequestId === parentRequestId)).length
    const perParentLimit = context.orchestrationPlanId ? 6 : this.maxPerParent
    if (createdThisTurn >= perParentLimit) throw new Error(`单轮最多创建 ${perParentLimit} 个子 Agent 任务。`)

    const now = new Date().toISOString()
    const task = {
      id: `delegate-${Date.now()}-${randomUUID().slice(0, 8)}`,
      agentRequestId: `subagent-${randomUUID()}`,
      title: clipped(input.title || taskText.split(/\r?\n/)[0] || '子任务', 160),
      task: taskText,
      status: 'queued',
      parentRequestId,
      rootRequestId,
      parentTaskId,
      childTaskIds: [],
      depth,
      conversationId: String(context.conversationId || ''),
      botId: String(context.botId || '__zsense_native__'),
      workspacePath: String(context.workspaceRoot || ''),
      modelProvider: String(context.modelProvider || ''),
      model: String(context.model || ''),
      reasoningEffort: String(context.reasoningEffort || 'high'),
      orchestrationPlanId: String(context.orchestrationPlanId || ''),
      planTaskId: String(input.planTaskId || ''),
      phase: '',
      usage: {},
      createdAt: now,
      updatedAt: now,
      startedAt: '',
      finishedAt: '',
      durationMs: 0,
      toolCallCount: 0,
      toolEvents: [],
      messages: [],
      output: '',
      error: '',
      cancelRequested: false,
    }
    this.tasks.push(task)
    if (parentTaskId) {
      const parent = this.tasks.find((item) => item.id === parentTaskId)
      if (parent) parent.childTaskIds = [...new Set([...(parent.childTaskIds || []), task.id])]
    }
    this.queue.push(task.id)
    this.runtimeContexts.set(task.id, context.delegateRuntime || {})
    this.#save()
    queueMicrotask(() => void this.#drain())
    return publicTask(task)
  }

  async #drain() {
    if (this.closed || !this.runner) return
    while (this.queue.length) {
      // Nested children use the same worker limit. A parent must first enter
      // status(waitMs) and yield its slot; resumption is gated below as well.
      if (this.running.size - this.waitingParents.size >= this.maxConcurrent) break
      const [id] = this.queue.splice(0, 1)
      const task = this.tasks.find((item) => item.id === id)
      if (!task || task.status !== 'queued') continue
      void this.#run(task)
    }
  }

  async #run(task) {
    const startedAt = Date.now()
    task.status = 'running'
    task.startedAt = new Date(startedAt).toISOString()
    task.updatedAt = task.startedAt
    this.running.set(task.id, task.agentRequestId)
    this.#save()
    this.#publish(task)
    try {
      const result = await this.runner.run({ task: publicTask(task), requestId: task.agentRequestId, runtime: this.runtimeContexts.get(task.id) || {}, onEvent: (event) => this.#recordEvent(task, event) })
      task.status = task.cancelRequested ? 'cancelled' : 'completed'
      task.output = clipped(result?.output || result?.stdout || '', 120_000)
      task.error = ''
      task.usage = result?.usage && typeof result.usage === 'object' ? { inputTokens: Number(result.usage.inputTokens || 0), outputTokens: Number(result.usage.outputTokens || 0), totalTokens: Number(result.usage.totalTokens || 0), contextUsed: Number(result.usage.contextUsed || 0), contextMax: Number(result.usage.contextMax || 0) } : {}
    } catch (error) {
      task.status = task.cancelRequested ? 'cancelled' : 'failed'
      task.error = clipped(error instanceof Error ? error.message : '子 Agent 执行失败。', 20_000)
      task.usage = error?.usage && typeof error.usage === 'object' ? { ...error.usage } : {}
    } finally {
      task.finishedAt = new Date().toISOString()
      task.updatedAt = task.finishedAt
      task.durationMs = Date.now() - startedAt
      this.running.delete(task.id)
      this.waitingParents.delete(task.id)
      this.parentWaitCounts.delete(task.id)
      this.completedToolIds.delete(task.id)
      for (const resume of this.resumeWaiters) resume()
      this.resumeWaiters.clear()
      this.#publish(task)
      this.runtimeContexts.delete(task.id)
      this.#save()
      this.#notify(task)
      void this.#drain()
    }
  }

  async status(input = {}, context = {}) {
    const waitMs = Math.max(0, Math.min(60_000, Number(input.waitMs) || 0))
    if (!input.taskId) return this.list(context)
    const task = this.#find(input.taskId, context)
    if (waitMs && !TERMINAL_STATUSES.has(task.status)) {
      const parentId = String(context.parentTaskId || '')
      const waitingParent = parentId && this.running.has(parentId) && parentId !== task.id
      if (waitingParent) {
        this.parentWaitCounts.set(parentId, (this.parentWaitCounts.get(parentId) || 0) + 1)
        this.waitingParents.add(parentId)
        for (const resume of this.resumeWaiters) resume()
        this.resumeWaiters.clear()
        void this.#drain()
      }
      try { await new Promise((resolve) => {
        const listeners = this.waiters.get(task.id) || []
        const timer = setTimeout(() => {
          const current = this.waiters.get(task.id) || []
          this.waiters.set(task.id, current.filter((item) => item !== done))
          done()
        }, waitMs)
        const done = () => { clearTimeout(timer); resolve() }
        listeners.push(done)
        this.waiters.set(task.id, listeners)
      }) } finally {
        if (waitingParent) {
          const count = (this.parentWaitCounts.get(parentId) || 1) - 1
          if (count) this.parentWaitCounts.set(parentId, count)
          else {
            this.parentWaitCounts.delete(parentId)
            // Keep status(waitMs) bounded. If no worker slot is free, the Core waits before its next model/tool step.
            if (this.running.size - this.waitingParents.size < this.maxConcurrent) this.waitingParents.delete(parentId)
          }
        }
      }
    }
    return publicTask(task)
  }

  async message(input = {}, context = {}) {
    const content = clipped(input.message, 8_000).trim()
    if (!content) throw new Error('Agent 消息不能为空。')
    const senderTaskId = String(context.parentTaskId || '')
    let targetTask = null
    if (input.taskId) targetTask = this.#find(input.taskId, context)
    else if (senderTaskId) {
      const sender = this.#find(senderTaskId, context)
      targetTask = sender.parentTaskId ? this.#find(sender.parentTaskId, context) : sender
    }
    if (!targetTask) throw new Error('请指定当前任务树中的目标子 Agent。')
    const toParent = !input.taskId && Boolean(senderTaskId)
    const toRoot = toParent && senderTaskId === targetTask.id && !targetTask.parentTaskId
    const event = {
      id: `delegate-message-${Date.now()}-${randomUUID().slice(0, 8)}`,
      fromTaskId: senderTaskId,
      toTaskId: toRoot ? '' : targetTask.id,
      direction: toParent ? 'to_parent' : 'to_agent',
      content,
      createdAt: new Date().toISOString(),
      delivered: false,
    }
    targetTask.messages = [...(targetTask.messages || []), event].slice(-100)
    const requestId = toRoot ? targetTask.rootRequestId : this.running.get(targetTask.id)
    if (requestId && typeof this.runner?.steer === 'function') {
      try {
        await this.runner.steer(requestId, content)
        event.delivered = true
        event.deliveredAt = new Date().toISOString()
      } catch (error) {
        event.error = clipped(error instanceof Error ? error.message : '消息投递失败。', 1_000)
      }
    }
    targetTask.updatedAt = new Date().toISOString()
    this.#save()
    this.#notify(targetTask)
    return { accepted: true, targetTaskId: toRoot ? '' : targetTask.id, delivered: event.delivered, message: event }
  }

  list(context = {}) {
    return this.tasks.filter((task) => visibleToContext(task, context)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50).map((task) => publicTask(task, { includeOutput: TERMINAL_STATUSES.has(task.status) }))
  }

  async cancel(input = {}, context = {}) {
    const task = this.#find(input.taskId, context)
    if (TERMINAL_STATUSES.has(task.status)) return publicTask(task)
    if (task.cancelRequested) return publicTask(task)
    task.cancelRequested = true
    // Explicit task cancellation also invalidates its queued/running descendants.
    for (const child of this.tasks.filter((candidate) => candidate.parentTaskId === task.id && !TERMINAL_STATUSES.has(candidate.status))) await this.cancel({ taskId: child.id }, context)
    if (task.status === 'queued') {
      task.status = 'cancelled'
      task.finishedAt = new Date().toISOString()
      task.updatedAt = task.finishedAt
      this.queue = this.queue.filter((id) => id !== task.id)
      this.#publish(task)
      this.runtimeContexts.delete(task.id)
      this.#save()
      this.#notify(task)
      return publicTask(task)
    }
    const requestId = this.running.get(task.id)
    if (requestId && typeof this.runner?.cancel === 'function') await this.runner.cancel(requestId)
    return publicTask(task)
  }

  async cancelRequest(requestId) {
    const direct = this.tasks.filter((task) => task.parentRequestId === requestId && !TERMINAL_STATUSES.has(task.status))
    for (const task of direct) await this.cancel({ taskId: task.id }, { requestId, rootRequestId: task.rootRequestId, conversationId: task.conversationId, botId: task.botId })
  }

  async waitForExecutionSlot(taskId, signal) {
    if (!taskId || !this.waitingParents.has(taskId)) return
    while (!this.closed && this.running.has(taskId) && this.running.size - this.waitingParents.size >= this.maxConcurrent) {
      if (signal?.aborted) throw signal.reason || new Error('子任务等待已取消。')
      await new Promise((resolve, reject) => {
        const resume = () => { signal?.removeEventListener('abort', abort); this.resumeWaiters.delete(resume); resolve() }
        const abort = () => { this.resumeWaiters.delete(resume); reject(signal.reason || new Error('子任务等待已取消。')) }
        this.resumeWaiters.add(resume)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
    if (signal?.aborted) throw signal.reason || new Error('子任务等待已取消。')
    this.waitingParents.delete(taskId)
  }

  async steerRequest(requestId, message, { intent = 'supplement' } = {}) {
    const direct = this.tasks.filter((task) => task.parentRequestId === requestId && !TERMINAL_STATUSES.has(task.status))
    for (const task of direct) {
      if (intent === 'adjust') { await this.cancel({ taskId: task.id }, { requestId, rootRequestId: task.rootRequestId, conversationId: task.conversationId, botId: task.botId }); continue }
      await this.message({ taskId: task.id, message }, { requestId, rootRequestId: task.rootRequestId, conversationId: task.conversationId, botId: task.botId })
      await this.steerRequest(this.running.get(task.id) || task.agentRequestId, message, { intent })
    }
  }

  inspect() {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 }
    for (const task of this.tasks) if (Object.prototype.hasOwnProperty.call(counts, task.status)) counts[task.status] += 1
    const recent = [...this.tasks].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    return {
      ...counts,
      totalCount: this.tasks.length,
      activeCount: counts.queued + counts.running,
      maxConcurrent: this.maxConcurrent,
      maxPerTurn: this.maxPerParent,
      maxDepth: this.maxDepth,
      recentTask: recent ? publicTask(recent, { includeOutput: false }) : null,
    }
  }

  shutdown() {
    this.closed = true
    this.queue = []
    for (const resume of this.resumeWaiters) resume()
    this.resumeWaiters.clear()
    for (const [taskId, requestId] of this.running.entries()) {
      const task = this.tasks.find((item) => item.id === taskId)
      if (task) task.cancelRequested = true
      try { this.runner?.cancel?.(requestId) } catch { /* application is already closing */ }
    }
  }
}
