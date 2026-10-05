import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { NATIVE_BOT_ID } from './database.mjs'

const MAX_PROMPT_CHARACTERS = 8_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const MIN_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 10 * 60_000

export const DEVICE_LINK_CHANNEL_ID = 'device-link'

function cleanText(value, maximum = 200) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum)
}

export function normalizeRemoteTimeout(value) {
  const timeout = Math.floor(Number(value) || DEFAULT_TIMEOUT_MS)
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, timeout))
}

export class DeviceTaskRunner {
  constructor({ rootPath, database, agentCore, secrets, notify = () => undefined, reasoningEffort = 'high' } = {}) {
    this.rootPath = rootPath
    this.database = database
    this.agentCore = agentCore
    this.secrets = secrets
    this.notify = notify
    this.reasoningEffort = reasoningEffort
    this.running = new Map()
  }

  inspect() {
    return { running: this.running.size, runningPeers: [...this.running.keys()] }
  }

  cancelPeer(deviceId) {
    const active = this.running.get(cleanText(deviceId, 100))
    if (!active) return false
    active.cancelled = true
    if (active.requestId) {
      try { this.agentCore?.cancelChat(active.requestId) } catch { /* 结果检查仍会阻止提交成功回复 */ }
    }
    return true
  }

  cancelAll() {
    for (const deviceId of this.running.keys()) this.cancelPeer(deviceId)
  }

  async run({ prompt, peer = {}, timeoutMs } = {}) {
    const message = cleanText(prompt, MAX_PROMPT_CHARACTERS)
    if (!message) throw new Error('远程任务内容不能为空。')
    const peerDeviceId = cleanText(peer.deviceId, 100)
    if (this.running.has(peerDeviceId)) throw new Error('对方已经有一条远程任务正在本机执行，请等它完成后再试。')
    const active = { conversationId: '', requestId: '', cancelled: false }
    this.running.set(peerDeviceId, active)
    try {
      return await this.#execute({ message, peer, peerDeviceId, timeoutMs, active })
    } finally {
      this.running.delete(peerDeviceId)
    }
  }

  async #execute({ message, peer, peerDeviceId, timeoutMs, active }) {
    const workspace = this.database.loadWorkspace()
    const modelConfiguration = workspace.modelConfiguration || {}
    const provider = cleanText(modelConfiguration.provider, 60)
    const model = cleanText(modelConfiguration.model, 200)
    if (!model) throw new Error('本机还没有配置默认模型，无法执行远程任务。')
    if (!this.agentCore?.supportsProvider(provider)) throw new Error(`本机 ZSense Agent Core 暂不支持 ${provider || '未配置'} 供应商。`)
    const runtimeStatus = await this.agentCore.inspect()
    if (active.cancelled) throw new Error('设备授权已撤销，远程任务已取消。')
    if (!runtimeStatus?.runnable) throw new Error(runtimeStatus?.message || '本机 ZSense Agent 运行内核尚未就绪。')
    const scopedSecret = this.secrets.get(`model:${provider}`)
    const legacySecret = workspace.modelConfiguration.provider === provider ? this.secrets.get('model:default') : {}
    const apiKey = scopedSecret.apiKey || legacySecret.apiKey || ''
    if (this.agentCore.requiresApiKey(provider) && !apiKey) throw new Error('本机默认模型的 API Key 尚未配置。')

    const workspacePath = workspace.settings.defaultWorkspacePath
      ? workspace.settings.defaultWorkspacePath
      : (() => { const fallback = path.join(this.rootPath, 'device-link', 'workspace'); fs.mkdirSync(fallback, { recursive: true }); return fallback })()

    const peerName = cleanText(peer.name, 80) || '已配对设备'
    const bot = workspace.bots.find((item) => item.id === NATIVE_BOT_ID) || null
    const settings = workspace.settings
    const memories = settings.memoryRecallLimit
      ? (await this.database.memoryService.recallMemories(NATIVE_BOT_ID, message, {
        limit: settings.memoryRecallLimit,
        characterBudget: Math.max(8_000, Math.min(24_000, Number(settings.memoryRecallLimit || 24) * 600)),
      })).memories
      : []
    // 远程请求只能带显式授予本机对话空间的技能，不能继承其它 Bot 的私有技能。
    const skills = workspace.skills.filter((skill) => skill.enabled !== false && Array.isArray(skill.assignedBotIds) && skill.assignedBotIds.includes(NATIVE_BOT_ID))

    const startedAt = new Date()
    let refusedOperations = 0
    const approvalHandler = async (_question, _choices, metadata = {}) => {
      refusedOperations += 1
      const label = cleanText(metadata.label, 120) || '需要审批的操作'
      throw new Error(`远程任务不能代替本机用户审批：${label} 已拒绝。请在本机前台会话中执行该操作。`)
    }

    const conversationId = this.database.createNativeConversation(`远程任务 · ${peerName}`, {
      channelId: DEVICE_LINK_CHANNEL_ID,
      runtimeEngine: 'zsense-core',
      modelProvider: provider,
      model,
      reasoningEffort: this.reasoningEffort,
      workspacePath,
    })
    this.database.addMessage(conversationId, 'user', `【来自设备 ${peerName}】${message}`)
    active.conversationId = conversationId
    const requestId = `device-link-${randomUUID()}`
    active.requestId = requestId
    const budget = normalizeRemoteTimeout(timeoutMs)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      try { this.agentCore.cancelChat(requestId) } catch { /* 内核取消失败仍由下面的结果检查报告 */ }
    }, budget)
    try {
      if (active.cancelled) throw new Error('设备授权已撤销，远程任务已取消。')
      const result = await this.agentCore.chatStream({
        requestId,
        bot,
        message,
        model,
        modelProvider: provider,
        contextWindow: modelConfiguration.contextWindow || 0,
        apiKey,
        baseUrl: modelConfiguration.baseUrl || '',
        reasoningEffort: this.reasoningEffort,
        workspacePath,
        runtimeSessionId: '',
        skills,
        memories,
        settings,
        approvalHandler,
        appContext: {
          remoteDevice: { deviceId: peerDeviceId, name: peerName, platform: cleanText(peer.platform, 20) },
          currentBot: bot ? { id: bot.id, name: bot.name, status: bot.status, modelProvider: provider, model } : undefined,
          currentConversation: { id: conversationId, botId: NATIVE_BOT_ID, kind: 'native', workspacePath, modelProvider: provider, model },
          isolation: '远程任务只使用本机默认模型与工作区；不得读取、推断或披露任何 Bot 的私有内容、会话、记忆与网关配置，也不能代替本机用户批准敏感操作。',
        },
        onEvent: (event) => {
          if (event?.type === 'started' && event.sessionId) this.database.setConversationRuntimeSession(conversationId, 'zsense-core', event.sessionId)
        },
      })
      if (active.cancelled) throw new Error('设备授权已撤销，远程任务已取消。')
      if (timedOut) throw new Error(`远程任务超过 ${Math.round(budget / 1_000)} 秒，已终止。`)
      const finishedAt = new Date()
      const durationMs = Number.isFinite(result.durationMs) ? Math.max(0, Math.round(result.durationMs)) : finishedAt.getTime() - startedAt.getTime()
      const output = String(result.output || '').trim()
      this.database.setConversationRuntimeSession(conversationId, 'zsense-core', result.sessionId)
      if (result.usage) this.database.updateConversationOptions(conversationId, NATIVE_BOT_ID, { usage: result.usage })
      this.database.addMessage(conversationId, 'assistant', output || '（没有返回内容）', {
        reasoning: String(result.reasoning || ''),
        agentSteps: Array.isArray(result.agentSteps) ? result.agentSteps : [],
        modelProvider: provider,
        model,
        durationMs,
        outputTokens: result.usage?.outputTokens,
      })
      this.database.completeNativeConversation(conversationId)
      const summary = {
        output,
        conversationId,
        model,
        modelProvider: provider,
        reasoningEffort: this.reasoningEffort,
        durationMs,
        usage: { inputTokens: Number(result.usage?.inputTokens || 0), outputTokens: Number(result.usage?.outputTokens || 0) },
        toolCalls: Array.isArray(result.agentSteps) ? result.agentSteps.length : 0,
        refusedOperations,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      }
      try { this.notify('completion', `远程任务已完成（${peerName}）`, output.slice(0, 180) || '对方设备请求的任务已执行完成。') } catch { /* 通知失败不影响任务结果 */ }
      return summary
    } catch (error) {
      const message_ = timedOut ? `远程任务超过 ${Math.round(budget / 1_000)} 秒，已终止。` : error instanceof Error ? error.message : '远程任务执行失败。'
      this.database.addMessage(conversationId, 'system', `远程任务失败：${message_}`, { modelProvider: provider, model })
      try { this.notify('approval', `远程任务失败（${peerName}）`, message_) } catch { /* 通知失败不影响错误返回 */ }
      throw new Error(message_)
    } finally {
      clearTimeout(timeout)
    }
  }
}
