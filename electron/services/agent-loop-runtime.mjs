import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const TERMINAL_PHASES = new Set(['complete', 'cancelled', 'failed'])

const TRANSITIONS = Object.freeze({
  preparing: new Set(['steering', 'model', 'cancelled', 'failed']),
  steering: new Set(['model', 'cancelled', 'failed']),
  model: new Set(['steering', 'tools', 'complete', 'cancelled', 'failed']),
  tools: new Set(['steering', 'model', 'finalizing', 'cancelled', 'failed']),
  finalizing: new Set(['steering', 'complete', 'cancelled', 'failed']),
  complete: new Set(),
  cancelled: new Set(),
  failed: new Set(),
})

export class SteeringInterrupt extends Error {
  constructor(message = '收到运行中追加指令，正在重新规划。') {
    super(message)
    this.name = 'SteeringInterrupt'
    this.code = 'ZSENSE_STEERING_INTERRUPT'
  }
}

export function isSteeringInterrupt(error) {
  return error?.code === 'ZSENSE_STEERING_INTERRUPT' || error?.name === 'SteeringInterrupt'
}

export class AgentRunStateMachine {
  constructor({ requestId, onTransition = () => undefined } = {}) {
    this.requestId = String(requestId || '')
    this.phase = 'preparing'
    this.step = 0
    this.revision = 0
    this.updatedAt = new Date().toISOString()
    this.onTransition = onTransition
  }

  transition(nextPhase, detail = {}) {
    const target = String(nextPhase || '')
    if (target === this.phase) return this.snapshot(detail)
    if (!TRANSITIONS[this.phase]?.has(target)) throw new Error(`Agent 运行状态不能从 ${this.phase} 转换到 ${target}。`)
    const previousPhase = this.phase
    this.phase = target
    this.revision += 1
    this.updatedAt = new Date().toISOString()
    const event = this.snapshot({ previousPhase, ...detail })
    this.onTransition(event)
    return event
  }

  startModelStep() {
    if (!['model', 'finalizing'].includes(this.phase)) throw new Error('只有模型或收尾阶段才能创建新的 Agent 步骤。')
    this.step += 1
    return this.step
  }

  terminal() { return TERMINAL_PHASES.has(this.phase) }

  snapshot(extra = {}) {
    return { requestId: this.requestId, phase: this.phase, step: this.step, revision: this.revision, updatedAt: this.updatedAt, ...extra }
  }
}

function safeContent(content) {
  if (typeof content === 'string') return content.slice(0, 120_000)
  if (!Array.isArray(content)) return String(content ?? '').slice(0, 120_000)
  return content.map((part) => part?.type === 'image_url'
    ? { type: 'text', text: `[未持久化的运行中图像：${String(part.name || '图片').slice(0, 200)}]` }
    : { ...part, text: typeof part?.text === 'string' ? part.text.slice(0, 120_000) : part?.text }).slice(0, 32)
}

function safeCursor(cursor) {
  return {
    sessionId: String(cursor.sessionId || ''),
    requestId: String(cursor.requestId || ''),
    conversationId: String(cursor.conversationId || ''),
    status: String(cursor.status || 'running'),
    phase: String(cursor.phase || 'preparing'),
    step: Math.max(0, Number(cursor.step || 0)),
    updatedAt: new Date().toISOString(),
    canonicalMessages: (cursor.canonicalMessages || []).slice(-160).map((item) => ({ ...item, content: safeContent(item.content) })),
    agentSteps: (cursor.agentSteps || []).slice(-100).map((item) => ({
      ...item,
      reasoning: String(item.reasoning || '').slice(0, 120_000),
      content: String(item.content || '').slice(0, 120_000),
      tools: (item.tools || []).slice(-100).map((tool) => ({ ...tool, input: String(tool.input || '').slice(0, 48_000), output: String(tool.output || '').slice(0, 48_000) })),
    })),
    reasoning: String(cursor.reasoning || '').slice(-240_000),
    usage: cursor.usage && typeof cursor.usage === 'object' ? cursor.usage : {},
    peakContextUsed: Math.max(0, Number(cursor.peakContextUsed || 0)),
    pendingSteering: (cursor.pendingSteering || []).slice(0, 100).map((item) => ({
      id: String(item?.id || ''),
      content: String(item?.content || '').slice(0, 8_000),
      receivedAt: String(item?.receivedAt || ''),
      source: item?.source === 'agent' ? 'agent' : 'user',
      intent: ['adjust', 'supplement', 'next'].includes(item?.intent) ? item.intent : 'supplement',
      attachments: (item?.attachments || []).slice(0, 8).map((attachment) => ({
        id: String(attachment?.id || ''),
        name: String(attachment?.name || '').slice(0, 240),
        path: String(attachment?.path || '').slice(0, 4_000),
        workspaceRelativePath: String(attachment?.workspaceRelativePath || '').slice(0, 4_000),
        size: Math.max(0, Number(attachment?.size || 0)),
        mimeType: String(attachment?.mimeType || '').slice(0, 200),
        kind: attachment?.kind === 'image' ? 'image' : 'file',
      })),
    })),
    pendingToolCalls: (cursor.pendingToolCalls || []).slice(0, 100).map((call) => ({ id: String(call?.id || ''), name: String(call?.name || ''), arguments: call?.arguments || {} })),
  }
}

export class AgentRunCursorStore {
  constructor(rootPath) {
    this.filePath = rootPath ? path.join(rootPath, 'runs', 'agent-cursors.json') : ''
    this.cursors = []
    if (!this.filePath) return
    try {
      const parsed = JSON.parse(fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath, 'utf8') : '[]')
      this.cursors = Array.isArray(parsed) ? parsed.slice(-100) : []
    } catch { this.cursors = [] }
  }

  #save() {
    if (!this.filePath) return
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    // 游标在每个阶段与追加时都会重写；不保存空白缩进可减少主进程同步序列化和磁盘写入。
    fs.writeFileSync(temporary, JSON.stringify(this.cursors.slice(-100)), 'utf8')
    fs.renameSync(temporary, this.filePath)
  }

  resumable(sessionId, conversationId = '') {
    const cursor = [...this.cursors].reverse().find((item) => item.sessionId === sessionId && (!conversationId || item.conversationId === conversationId))
    return cursor && ['running', 'interrupted'].includes(cursor.status) ? cursor : null
  }

  upsert(cursor) {
    if (!this.filePath || !cursor?.sessionId) return null
    const normalized = safeCursor(cursor)
    const index = this.cursors.findIndex((item) => item.sessionId === normalized.sessionId)
    if (index >= 0) this.cursors[index] = normalized
    else this.cursors.push(normalized)
    this.cursors = this.cursors.slice(-100)
    this.#save()
    return normalized
  }

  finish(sessionId, status, detail = {}) {
    if (!this.filePath || !sessionId) return
    const index = this.cursors.findIndex((item) => item.sessionId === sessionId)
    if (index < 0) return
    // 已结束的运行不会被恢复，只保留末尾少量步骤用于排查：把整份工具历史长期留在游标文件里，
    // 会让每次保存的大小（和耗时）随运行次数线性增长。
    const finishedSteps = Array.isArray(this.cursors[index].agentSteps) ? this.cursors[index].agentSteps.slice(-8).map((step) => ({
      step: step?.step,
      status: step?.status,
      outcome: step?.outcome,
      toolCallCount: step?.toolCallCount,
      durationMs: step?.durationMs,
      startedAt: step?.startedAt,
      ...(step?.error ? { error: String(step.error).slice(0, 400) } : {}),
    })) : []
    this.cursors[index] = {
      ...this.cursors[index],
      ...detail,
      status,
      phase: status,
      canonicalMessages: [],
      pendingSteering: [],
      pendingToolCalls: [],
      agentSteps: finishedSteps,
      updatedAt: new Date().toISOString(),
    }
    this.#save()
  }
}

export function normalizeToolCallIds(calls = []) {
  const seen = new Set()
  for (const call of calls) {
    let id = String(call?.id || '').trim()
    if (!id || seen.has(id)) id = `tool-${randomUUID()}`
    call.id = id
    seen.add(id)
  }
  return calls
}

export function validateToolCall(call, definition) {
  if (!definition) return `未知工具：${String(call?.name || '').slice(0, 100)}。请只使用本轮提供的工具名称。`
  const args = call?.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return `${call.name} 的参数必须是完整的 JSON 对象；本次没有执行。`
  const schema = definition.parameters || {}
  const check = (value, rule, location, depth = 0) => {
    if (!rule || depth > 8) return null
    const types = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : []
    const matches = (type) => type === 'null' ? value === null
      : type === 'array' ? Array.isArray(value)
        : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : type === 'integer' ? Number.isInteger(value)
            : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
              : typeof value === type
    if (types.length && !types.some(matches)) return `${location} 类型不正确`
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return `${location} 不在允许值中`
    if (Array.isArray(value)) {
      if (Number.isInteger(rule.minItems) && value.length < rule.minItems) return `${location} 项数不足`
      if (Number.isInteger(rule.maxItems) && value.length > rule.maxItems) return `${location} 项数过多`
      if (rule.items) for (let index = 0; index < value.length; index += 1) {
        const issue = check(value[index], rule.items, `${location}[${index}]`, depth + 1)
        if (issue) return issue
      }
    } else if (value !== null && typeof value === 'object') {
      const missing = (rule.required || []).filter((key) => !Object.hasOwn(value, key))
      if (missing.length) return `${location} 缺少必填参数：${missing.slice(0, 5).join('、')}`
      if (rule.additionalProperties === false && rule.properties) {
        const unknown = Object.keys(value).filter((key) => !Object.hasOwn(rule.properties, key))
        if (unknown.length) return `${location} 不支持参数：${unknown.slice(0, 5).join('、')}`
      }
      for (const [key, item] of Object.entries(value)) {
        if (!rule.properties?.[key]) continue
        const issue = check(item, rule.properties[key], `${location}.${key}`, depth + 1)
        if (issue) return issue
      }
    }
    return null
  }
  const issue = check(args, schema, call.name)
  if (issue) return `${issue}；本次没有执行。`
  return null
}

export function closeInterruptedToolCalls(messages = [], pendingToolCalls = []) {
  if (!pendingToolCalls.length) return messages
  const pendingIds = new Set(pendingToolCalls.map((call) => String(call.id)))
  let assistantIndex = messages.findLastIndex((item) => item.role === 'assistant' && item.toolCalls?.some((call) => pendingIds.has(String(call.id))))
  if (assistantIndex < 0) {
    messages.push({ role: 'assistant', content: '', toolCalls: pendingToolCalls })
    assistantIndex = messages.length - 1
  }
  const answered = new Set(messages.slice(assistantIndex + 1).filter((item) => item.role === 'tool').map((item) => String(item.toolCallId)))
  for (const call of pendingToolCalls) {
    if (answered.has(String(call.id))) continue
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: '上次运行在此工具调用期间中断，执行结果未知。不得盲目重放写入或外部操作；请先只读检查当前状态。' })
  }
  return messages
}

export class AgentProgressGuard {
  constructor() {
    this.lastFingerprint = ''
    this.repeatedRounds = 0
    this.lastFailures = new Set()
  }

  observe(results = []) {
    const fingerprint = createHash('sha256').update(JSON.stringify(results.map(({ call, toolEvent, output }) => [
      call.name, call.arguments, toolEvent.status, output,
    ]))).digest('hex')
    this.repeatedRounds = fingerprint === this.lastFingerprint ? this.repeatedRounds + 1 : 1
    this.lastFingerprint = fingerprint
    const failures = new Set()
    const hasSuccessfulWork = results.some(({ toolEvent }) => toolEvent.status === 'complete')
    for (const { call, toolEvent, output } of results) {
      if (toolEvent.status !== 'error') continue
      const key = toolEvent.validationError
        ? `${call.name}\0${toolEvent.validationError}`
        : `${call.name}\0${JSON.stringify(call.arguments)}\0${output}`
      failures.add(key)
      if (!hasSuccessfulWork && this.lastFailures.has(key)) return { stalled: true, reason: '同一工具请求连续返回相同错误' }
    }
    this.lastFailures = hasSuccessfulWork ? new Set() : failures
    if (this.repeatedRounds >= 3) return { stalled: true, reason: '连续 3 轮执行了相同工具并得到相同结果' }
    return { stalled: false, reason: '' }
  }
}

function pathKeys(argumentsValue = {}) {
  const keys = []
  for (const name of ['path', 'filePath', 'source', 'destination', 'taskId', 'server']) {
    const value = argumentsValue?.[name]
    if (typeof value === 'string' && value.trim()) keys.push(`${name}:${value.trim()}`)
  }
  return keys
}

export function buildToolDependencyGraph(calls = [], { profileFor = () => ({ parallelSafe: false }) } = {}) {
  const nodes = []
  let lastBarrier = -1
  let openParallel = []
  for (const [index, call] of calls.entries()) {
    const profile = profileFor(call) || { parallelSafe: false }
    const parallelSafe = profile.parallelSafe === true
    const dependencies = new Set()
    if (lastBarrier >= 0) dependencies.add(lastBarrier)
    if (!parallelSafe) {
      for (const dependency of openParallel) dependencies.add(dependency)
      if (index > 0 && !dependencies.size) dependencies.add(index - 1)
      lastBarrier = index
      openParallel = []
    } else openParallel.push(index)
    nodes.push({
      index,
      id: String(call?.id || `tool-${index + 1}`),
      call,
      parallelSafe,
      resources: pathKeys(call?.arguments),
      dependencies: [...dependencies],
    })
  }
  return nodes
}

export async function executeToolDependencyGraph(nodes = [], executor, { maxConcurrent = 4, signal, onBatch = () => undefined } = {}) {
  const results = new Array(nodes.length)
  const pending = new Set(nodes.map((node) => node.index))
  const completed = new Set()
  const limit = Math.max(1, Math.min(8, Number(maxConcurrent) || 4))
  while (pending.size) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('工具执行已取消。')
    const ready = nodes.filter((node) => pending.has(node.index) && node.dependencies.every((dependency) => completed.has(dependency)))
    if (!ready.length) throw new Error('工具依赖图存在无法解析的循环依赖。')
    const batch = ready.slice(0, limit)
    onBatch(batch)
    const settled = await Promise.allSettled(batch.map(async (node) => ({ node, result: await executor(node) })))
    const rejected = settled.find((item) => item.status === 'rejected')
    if (rejected) throw rejected.reason
    for (const item of settled) {
      results[item.value.node.index] = item.value.result
      pending.delete(item.value.node.index)
      completed.add(item.value.node.index)
    }
  }
  return results
}
