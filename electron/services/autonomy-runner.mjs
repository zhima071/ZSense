import { randomUUID } from 'node:crypto'
import { NATIVE_BOT_ID } from './database.mjs'
import { createMemoryScope } from './memory-scope.mjs'

const POLL_INTERVAL_MS = 15_000

function nativeIdentity(workspace) {
  return {
    id: NATIVE_BOT_ID,
    name: 'ZSense AI',
    role: 'ZSense AI 助理',
    description: '独立于业务 Bot 的 AI 对话空间。',
    prompt: '你是 ZSense AI 助理。使用当前 ZSense 工作区、工具、记忆和实时状态完成用户任务。',
    memories: workspace.nativeMemories || [],
  }
}

function taskEntries(state) {
  const goals = Object.values(state.goals || {}).flat().filter((item) => item.status === 'active' && item.enabled !== false)
  const loops = (state.loops || []).filter((item) => item.status === 'active' && item.enabled !== false)
  const heartbeats = (state.heartbeats || []).filter((item) => item.status === 'active' && item.enabled !== false)
  return [
    ...goals.map((item) => ({ ...item, kind: 'goal' })),
    ...loops.map((item) => ({ ...item, kind: 'loop' })),
    ...heartbeats.map((item) => ({ ...item, kind: 'heartbeat' })),
  ]
}

function findTask(state, kind, id) {
  if (kind === 'goal') return Object.values(state.goals || {}).flat().find((item) => item.id === id) || null
  const key = kind === 'loop' ? 'loops' : 'heartbeats'
  return (state[key] || []).find((item) => item.id === id) || null
}

function modelConfiguration(workspace, bot, task, conversation) {
  const provider = task.modelProvider || conversation?.modelProvider || bot?.modelProvider || workspace.modelConfiguration.provider
  const model = task.model || conversation?.model || bot?.model || workspace.modelConfiguration.model
  return workspace.availableModelConfigurations.find((item) => item.provider === provider && item.model === model)
    || (workspace.modelConfiguration.provider === provider && workspace.modelConfiguration.model === model ? workspace.modelConfiguration : null)
}

export class AutonomyRunner {
  constructor({ database, capabilityService, agentCore, secrets, onChanged = () => {}, notify = () => {} }) {
    this.database = database
    this.capabilityService = capabilityService
    this.agentCore = agentCore
    this.secrets = secrets
    this.onChanged = onChanged
    this.notify = notify
    this.timer = null
    this.active = new Set()
    this.stopping = false
  }

  start() {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
    this.timer.unref?.()
    setTimeout(() => void this.tick(), 1_000).unref?.()
  }

  async tick() {
    if (this.stopping) return
    const now = Date.now()
    const due = taskEntries(this.capabilityService.state()).filter((item) => {
      const next = Date.parse(item.nextRunAt || '')
      return (!Number.isFinite(next) || next <= now) && !this.active.has(item.id)
    }).slice(0, 3)
    await Promise.allSettled(due.map((item) => this.#run(item)))
  }

  #prompt(task) {
    if (task.kind === 'goal') return [
      '这是 ZSense 持续目标的下一轮执行。请继续实际推进目标，不要只汇报计划。',
      `目标：${task.objective}`,
      task.successCriteria ? `成功条件：${task.successCriteria}` : '',
      task.statusNote ? `上一轮状态：${task.statusNote}` : '',
      '如已满足成功条件，必须调用 goal_manage 的 complete；如暂时无法推进，更新 statusNote 并说明阻塞原因。',
    ].filter(Boolean).join('\n\n')
    if (task.kind === 'heartbeat') return [
      '这是当前会话的 ZSense 心跳检查。',
      task.prompt,
      '只有发现实质变化、任务完成、失败或需要用户操作时才正常回复；没有变化时只回复 NO_CHANGE。',
    ].join('\n\n')
    return `这是 ZSense 循环任务“${task.name || task.id}”的一次执行。\n\n${task.prompt}\n\n请实际执行并给出本次结果。`
  }

  async #run(task) {
    this.active.add(task.id)
    const startedAt = Date.now()
    try {
      const workspace = this.database.loadWorkspace()
      const bot = task.scope === NATIVE_BOT_ID ? nativeIdentity(workspace) : workspace.bots.find((item) => item.id === task.scope)
      if (!bot) throw new Error('持续任务所属 Bot 已被删除。')
      if (task.scope !== NATIVE_BOT_ID && bot.status === 'paused') {
        this.capabilityService.updateAutonomyItem(task.kind, task.id, { nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(), lastError: '所属 Bot 已暂停。' })
        return
      }
      let conversation = task.conversationId ? this.database.getConversation(task.conversationId, task.scope) : null
      const config = modelConfiguration(workspace, bot, task, conversation)
      if (!config) throw new Error('持续任务使用的模型已经不可用。')
      const scopedSecret = this.secrets.get(`model:${config.provider}`)
      const legacySecret = workspace.modelConfiguration.provider === config.provider ? this.secrets.get('model:default') : {}
      const secret = scopedSecret.apiKey ? scopedSecret : legacySecret
      if (this.agentCore.requiresApiKey(config.provider) && !secret.apiKey) throw new Error('持续任务模型的 API Key 尚未配置。')
      const workspacePath = task.workspacePath || conversation?.workspacePath || workspace.settings.defaultWorkspacePath
      if (!workspacePath) throw new Error('持续任务没有可用工作区。')
      if (!conversation) {
        const title = task.kind === 'goal' ? `持续目标 · ${String(task.objective || '').slice(0, 48)}` : task.kind === 'heartbeat' ? '会话心跳' : `循环任务 · ${task.name || task.id}`
        const id = task.scope === NATIVE_BOT_ID
          ? this.database.createNativeConversation(title, { channelId: 'scheduled', runtimeEngine: 'zsense-core', modelProvider: config.provider, model: config.model, reasoningEffort: task.reasoningEffort || 'high', workspacePath })
          : this.database.createConversation(task.scope, title, { channelId: 'scheduled', runtimeEngine: 'zsense-core', modelProvider: config.provider, model: config.model, reasoningEffort: task.reasoningEffort || 'high', workspacePath })
        conversation = this.database.getConversation(id, task.scope)
        this.capabilityService.updateAutonomyItem(task.kind, task.id, { conversationId: id })
      }
      const prompt = this.#prompt(task)
      const legacyMessages = conversation.messages || []
      const memoryScope = createMemoryScope({workspacePath})
      const memories = (await this.database.memoryService.recallMemories(task.scope, prompt, { ...memoryScope,limit: workspace.settings.memoryRecallLimit, characterBudget: 5_000 })).memories
      const skills = workspace.skills.filter((skill) => task.scope === NATIVE_BOT_ID ? skill.assignedBotIds.length > 0 : skill.assignedBotIds.includes(task.scope))
      const requestId = `autonomy-${randomUUID()}`
      const result = await this.agentCore.chatStream({
        requestId,
        bot,
        message: prompt,
        model: config.model,
        modelProvider: config.provider,
        contextWindow: config.contextWindow || 0,
        apiKey: secret.apiKey || '',
        baseUrl: config.baseUrl || '',
        reasoningEffort: task.reasoningEffort || 'high',
        workspacePath,
        runtimeSessionId: conversation.runtimeSessionId || '',
        legacyMessages,
        skills,
        memories,
        memoryScope,
        settings: workspace.settings,
        appContext: {
          automation: { id: task.id, kind: task.kind },
          currentBot: { id: bot.id, name: bot.name, status: bot.status, modelProvider: config.provider, model: config.model },
          currentConversation: { id: conversation.id, botId: bot.id, kind: task.scope === NATIVE_BOT_ID ? 'native' : 'bot', workspacePath, modelProvider: config.provider, model: config.model },
          isolation: '自治任务只能访问当前 Bot 的空间，不得读取或推断其他 Bot 的内容和状态。',
        },
      })
      this.database.setConversationRuntimeSession(conversation.id, 'zsense-core', result.sessionId)
      const output = String(result.output || '').trim()
      const quiet = task.kind === 'heartbeat' && /^NO_CHANGE[.!。！]?$/i.test(output)
      if (!quiet) {
        this.database.addMessage(conversation.id, 'system', `【ZSense ${task.kind === 'goal' ? '持续目标' : task.kind === 'heartbeat' ? '心跳' : '循环任务'}】${prompt}`)
        this.database.addMessage(conversation.id, 'assistant', output, { reasoning: result.reasoning || '', agentSteps: result.agentSteps || [], modelProvider: config.provider, model: config.model, durationMs: result.durationMs, outputTokens: result.usage?.outputTokens })
        this.notify('completion', task.kind === 'goal' ? '持续目标有新进展' : task.kind === 'heartbeat' ? '会话心跳发现变化' : `${task.name || '循环任务'}已执行`, output.slice(0, 180))
      }
      const latest = findTask(this.capabilityService.state(), task.kind, task.id)
      if (!latest) return
      if (task.kind === 'goal') {
        const iterationCount = Number(latest.iterationCount || 0) + 1
        if (latest.status !== 'active') this.capabilityService.updateAutonomyItem('goal', task.id, { iterationCount, lastRunAt: new Date().toISOString(), lastDurationMs: Date.now() - startedAt, lastError: '' })
        else if (iterationCount >= Number(latest.maxIterations || 8)) this.capabilityService.updateAutonomyItem('goal', task.id, { status: 'blocked', enabled: false, iterationCount, statusNote: '达到自动继续上限，需要用户确认后恢复。', lastRunAt: new Date().toISOString(), lastDurationMs: Date.now() - startedAt })
        else this.capabilityService.updateAutonomyItem('goal', task.id, { iterationCount, statusNote: quiet ? latest.statusNote || '' : output.slice(0, 4000), nextRunAt: new Date(Date.now() + 3_000).toISOString(), lastRunAt: new Date().toISOString(), lastDurationMs: Date.now() - startedAt })
      } else {
        const interval = Math.max(1, Number(latest.intervalMinutes) || 30)
        this.capabilityService.updateAutonomyItem(task.kind, task.id, { nextRunAt: new Date(Date.now() + interval * 60_000).toISOString(), lastRunAt: new Date().toISOString(), lastDurationMs: Date.now() - startedAt, lastOutput: quiet ? 'NO_CHANGE' : output.slice(0, 4000), lastError: '' })
      }
      this.onChanged(this.database.loadWorkspace())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retryDelay = task.kind === 'goal' ? 60_000 : Math.max(60_000, Number(task.intervalMinutes || 30) * 60_000)
      this.capabilityService.updateAutonomyItem(task.kind, task.id, { nextRunAt: new Date(Date.now() + retryDelay).toISOString(), lastRunAt: new Date().toISOString(), lastDurationMs: Date.now() - startedAt, lastError: message })
      this.notify('completion', 'ZSense 自动任务执行失败', message.slice(0, 180))
    } finally {
      this.active.delete(task.id)
    }
  }

  async shutdown() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const deadline = Date.now() + 5_000
    while (this.active.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
