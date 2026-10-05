// 设备互联的数据提供者：把本机内容按 scope 暴露给已配对设备。
// 边界：状态/内容与文件分别授权；结构化配置脱敏，已知凭据文件禁止远程读取；
// 文件读取有大小上限并在二进制时明确说明。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEVICE_FILE_LIMIT_BYTES = 2 * 1024 * 1024
const REDACT_KEY_PATTERN = /(api[-_]?key|apikey|token|secret|password|passwd|credential|private[-_]?key|authorization|cookie)/i
const SENSITIVE_FILE_PATTERN = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|p12|pfx|key)|zsense-secrets\.json|credentials(?:\.[^.]+)?|.*token.*)$/i
export const DEVICE_DATA_SCOPES = ['overview', 'bots', 'conversations', 'conversation', 'skills', 'memories', 'scheduledTasks', 'settings', 'directory', 'file']

export function redactDeviceSecrets(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => redactDeviceSecrets(entry, depth + 1))
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    if (REDACT_KEY_PATTERN.test(key)) {
      output[key] = typeof entry === 'boolean' ? entry : '[已隐藏：凭据不外发]'
      continue
    }
    output[key] = redactDeviceSecrets(entry, depth + 1)
  }
  return output
}

function directoryListing(target) {
  const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 500).map((entry) => {
    const full = path.join(target, entry.name)
    let size = 0
    try { size = entry.isDirectory() ? 0 : fs.statSync(full).size } catch { size = 0 }
    return { name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', size }
  })
  return { path: target, entries }
}

function fileContent(target, maxBytes) {
  const actual = fs.realpathSync(target)
  const parts = actual.split(path.sep)
  if (parts.some((part) => ['.ssh', '.gnupg', 'device-link'].includes(part.toLowerCase())) || SENSITIVE_FILE_PATTERN.test(path.basename(actual))) {
    throw new Error('安全策略禁止通过设备互联读取凭据或密钥文件。')
  }
  const stats = fs.statSync(actual)
  if (!stats.isFile()) throw new Error('目标不是文件。')
  const limit = Math.max(1_000, Math.min(DEVICE_FILE_LIMIT_BYTES, Number(maxBytes) || DEVICE_FILE_LIMIT_BYTES))
  if (stats.size > limit) {
    const handle = fs.openSync(actual, 'r')
    try {
      const buffer = Buffer.alloc(limit)
      const read = fs.readSync(handle, buffer, 0, limit, 0)
      return { path: target, size: stats.size, truncated: true, content: buffer.subarray(0, read).toString('utf8') }
    } finally { fs.closeSync(handle) }
  }
  const buffer = fs.readFileSync(actual)
  if (buffer.includes(0)) return { path: target, size: stats.size, truncated: false, binary: true, content: '' }
  return { path: target, size: stats.size, truncated: false, content: buffer.toString('utf8') }
}

export function createDeviceDataProvider({ database, localStatusProvider = null }) {
  if (!database) throw new Error('设备数据提供者缺少数据库。')
  return async function collectDeviceData({ scope = 'overview', query = {} } = {}) {
    const normalizedScope = String(scope || 'overview')
    if (!DEVICE_DATA_SCOPES.includes(normalizedScope)) throw new Error(`不支持的数据范围：${normalizedScope}`)
    const workspace = database.loadWorkspace()
    if (normalizedScope === 'overview') {
      const status = localStatusProvider ? await localStatusProvider() : {}
      return {
        ...status,
        workspace: { bots: workspace.bots.length, conversations: workspace.conversations.length, skills: workspace.skills.length, scheduledTasks: workspace.scheduledTasks.length },
      }
    }
    if (normalizedScope === 'bots') {
      return {
        bots: workspace.bots.map((bot) => ({
          id: bot.id, name: bot.name, role: bot.role, description: bot.description, status: bot.status,
          modelProvider: bot.modelProvider, model: bot.model, memoryCount: bot.memoryCount, conversations: bot.conversations,
          channels: bot.channels, skills: (workspace.skills || []).filter((skill) => (skill.assignedBotIds || []).includes(bot.id)).map((skill) => skill.name),
          prompt: bot.prompt, lastActive: bot.lastActive,
        })),
        nativeBot: workspace.nativeBot ? { id: workspace.nativeBot.id, name: workspace.nativeBot.name, memoryCount: workspace.nativeBot.memoryCount, conversations: workspace.nativeBot.conversations } : null,
      }
    }
    if (normalizedScope === 'conversations') {
      const limit = Math.max(1, Math.min(100, Number(query.limit) || 30))
      const botId = String(query.botId || '')
      const conversations = workspace.conversations
        .filter((conversation) => !botId || conversation.botId === botId)
        .slice(0, limit)
        .map((conversation) => ({
          id: conversation.id, botId: conversation.botId, title: conversation.title, channelId: conversation.channelId,
          messageCount: (conversation.messages || []).length, updatedAt: conversation.updatedAt,
          lastMessage: String((conversation.messages || []).at(-1)?.content || '').slice(0, 200),
        }))
      return { total: workspace.conversations.length, limit, conversations }
    }
    if (normalizedScope === 'conversation') {
      const conversationId = String(query.conversationId || '').trim()
      if (!conversationId) throw new Error('读取对话内容需要提供 conversationId（先用 scope=conversations 列出）。')
      const conversation = workspace.conversations.find((item) => item.id === conversationId)
      if (!conversation) throw new Error('这台设备上没有这个会话。')
      const limit = Math.max(1, Math.min(500, Number(query.limit) || 200))
      const messages = (conversation.messages || []).slice(-limit).map((message) => ({
        id: message.id, role: message.role, content: message.content, reasoning: message.reasoning || '',
        createdAt: message.createdAt, model: message.model, modelProvider: message.modelProvider,
        durationMs: message.durationMs ?? null, attachments: message.attachments || [],
      }))
      return { id: conversation.id, botId: conversation.botId, title: conversation.title, channelId: conversation.channelId, updatedAt: conversation.updatedAt, messageCount: (conversation.messages || []).length, messages }
    }
    if (normalizedScope === 'skills') {
      return {
        skills: workspace.skills.map((skill) => ({
          id: skill.id, name: skill.name, description: skill.description, category: skill.category, version: skill.version,
          enabled: skill.enabled, source: skill.source, assignedBotIds: skill.assignedBotIds, usageCount: skill.usageCount, installPath: skill.installPath,
        })),
      }
    }
    if (normalizedScope === 'memories') {
      const botId = String(query.botId || '')
      const bots = [workspace.nativeBot, ...workspace.bots].filter(Boolean).filter((bot) => !botId || bot.id === botId)
      return {
        memories: bots.flatMap((bot) => (bot.memories || []).map((memory) => ({
          id: memory.id, botId: bot.id, botName: bot.name, title: memory.title, content: memory.excerpt, type: memory.type, updatedAt: memory.updatedAt,
        }))),
      }
    }
    if (normalizedScope === 'scheduledTasks') {
      return {
        tasks: workspace.scheduledTasks.map((task) => ({ id: task.id, name: task.name, prompt: task.prompt, schedule: task.schedule, enabled: task.enabled, nextRunAt: task.nextRunAt, lastRunAt: task.lastRunAt, lastStatus: task.lastStatus, botId: task.botId })),
        runs: (workspace.scheduledTaskRuns || []).slice(0, 50).map((run) => ({ id: run.id, taskId: run.taskId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, summary: String(run.summary || '').slice(0, 500) })),
      }
    }
    if (normalizedScope === 'settings') {
      return { settings: redactDeviceSecrets(workspace.settings || {}), modelConfiguration: redactDeviceSecrets(workspace.modelConfiguration || {}), storagePath: workspace.storagePath || '' }
    }
    if (normalizedScope === 'directory') {
      const target = path.resolve(String(query.path || os.homedir()))
      if (!fs.statSync(target).isDirectory()) throw new Error('目标不是目录。')
      return directoryListing(target)
    }
    const rawPath = String(query.path || '').trim()
    if (!rawPath) throw new Error('读取文件需要提供 path。')
    return fileContent(path.resolve(rawPath), query.maxBytes)
  }
}
