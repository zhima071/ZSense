import { app, BrowserWindow, clipboard, dialog, nativeImage, shell, webContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { cloneForRenderer, NATIVE_BOT_ID } from './services/database.mjs'
import { redactSensitiveText } from './services/redaction.mjs'
import { nativeWorkspaceIdentity } from './services/workspace-context.mjs'
import { stageChatAttachments, stagePastedImageAttachments } from './services/chat-attachment-service.mjs'
import { readPdfDocument, readPdfDocumentChunk, savePdfDocument, transformPdfPages } from './services/pdf-document-service.mjs'
import { fetchOfficialModelCatalog } from './services/model-catalog-service.mjs'
import { createMemoryMaintenanceQueue, shouldExtractMemory } from './services/memory-intelligence.mjs'
import { defaultUpdateFeedUrl } from './services/update-service.mjs'
import { connectTrustedRemote, createPinnedLanFetch } from './services/remote-trust-connect.mjs'
import { listWorkspaceDirectories } from './services/workspace-directory-picker.mjs'

const channelIds = new Set(['web', 'telegram', 'discord', 'slack', 'wecom', 'weixin', 'dingtalk', 'feishu', 'webhook'])
const externalChannelIds = new Set([...channelIds].filter((id) => id !== 'web'))
const botStatuses = new Set(['online', 'paused', 'offline'])
const memoryTypes = new Set(['fact', 'preference', 'episode'])
const modelProviders = new Set(['openrouter', 'openai', 'anthropic', 'google', 'deepseek', 'zai', 'kimi-coding-cn', 'nous', 'custom'])
const reasoningEfforts = new Set(['none', 'low', 'high', 'max'])
const interactionModes = new Set(['text', 'voice'])
const responseLanguages = new Set(['auto', 'zh-CN', 'en-US'])
const scheduledTaskFrequencies = new Set(['every-5m', 'every-15m', 'every-30m', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'])
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.ico'])
const attachmentLimit = 8
const htmlEmbeddedImageSizeLimit = 4 * 1024 * 1024
const portableConfigurationFormat = 'zsense-portable-configuration'
const portableConfigurationSchemaVersion = 1
const trustedLanWindows = new Map()

app.on('certificate-error', (event, contents, url, _error, certificate, callback) => {
  const trusted = trustedLanWindows.get(contents.id)
  if (!trusted) return
  try {
    const actual = String(certificate?.fingerprint || '').replace(/:/g, '').toUpperCase()
    if (new URL(url).origin !== trusted.origin || actual !== trusted.fingerprint) return
    event.preventDefault()
    callback(true)
  } catch { /* 非目标页面的证书错误继续按 Electron 默认规则拒绝。 */ }
})

async function openTrustedLanWindow(url, fingerprint) {
  const origin = new URL(url).origin
  const window = new BrowserWindow({
    width: 1220, height: 860, minWidth: 760, minHeight: 540, show: false,
    title: 'ZSense · 设备直连',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: `zsense-trusted-lan-${randomUUID()}` },
  })
  trustedLanWindows.set(window.webContents.id, { origin, fingerprint })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      if (new URL(target).origin === origin) void window.loadURL(target)
      else if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    } catch { /* 忽略无效跳转。 */ }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin === origin) return
      event.preventDefault()
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    } catch { event.preventDefault() }
  })
  window.on('closed', () => trustedLanWindows.delete(window.webContents.id))
  try {
    await window.loadURL(url)
    window.show()
  } catch (error) {
    window.destroy()
    throw error
  }
}
const portableConfigurationMaxBytes = 12 * 1024 * 1024
const channelFields = {
  web: { public: [], secret: [], required: [] },
  telegram: { public: ['TELEGRAM_ALLOWED_USERS', 'TELEGRAM_WEBHOOK_URL', 'TELEGRAM_WEBHOOK_PORT'], secret: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'], required: ['TELEGRAM_BOT_TOKEN'] },
  discord: { public: ['DISCORD_ALLOWED_USERS'], secret: ['DISCORD_BOT_TOKEN'], required: ['DISCORD_BOT_TOKEN'] },
  slack: { public: ['SLACK_ALLOWED_USERS'], secret: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'], required: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] },
  wecom: { public: ['WECOM_BOT_ID', 'WECOM_ALLOWED_USERS', 'WECOM_WEBSOCKET_URL'], secret: ['WECOM_SECRET'], required: ['WECOM_BOT_ID', 'WECOM_SECRET'] },
  weixin: {
    public: ['WEIXIN_ACCOUNT_ID', 'WEIXIN_BASE_URL', 'WEIXIN_DM_POLICY', 'WEIXIN_ALLOWED_USERS', 'WEIXIN_GROUP_POLICY', 'WEIXIN_GROUP_ALLOWED_USERS'],
    secret: ['WEIXIN_TOKEN'],
    required: ['WEIXIN_ACCOUNT_ID', 'WEIXIN_TOKEN'],
  },
  dingtalk: { public: ['DINGTALK_CLIENT_ID', 'DINGTALK_AI_CARD_TEMPLATE_ID', 'DINGTALK_ALLOWED_USERS'], secret: ['DINGTALK_CLIENT_SECRET'], required: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'] },
  feishu: { public: ['FEISHU_APP_ID', 'FEISHU_ALLOWED_USERS', 'FEISHU_CONNECTION_MODE', 'FEISHU_WEBHOOK_PORT'], secret: ['FEISHU_APP_SECRET', 'FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN'], required: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] },
  webhook: { public: ['WEBHOOK_PATH', 'WEBHOOK_ALLOWED_ORIGINS'], secret: ['WEBHOOK_SIGNING_SECRET'], required: ['WEBHOOK_PATH', 'WEBHOOK_SIGNING_SECRET'] },
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 格式无效`)
  return value
}

function text(value, label, maximum = 10_000) {
  if (typeof value !== 'string') throw new Error(`${label} 必须是文本`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${label} 长度无效`)
  return normalized
}

function optionalText(value, label, maximum = 10_000) {
  if (value === undefined || value === null || value === '') return ''
  return text(value, label, maximum)
}

function htmlSource(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8 * 1024 * 1024) throw new Error('HTML 内容长度无效')
  return value
}

function number(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} 数值无效`)
  return value
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = number(value, label, minimum, maximum)
  if (!Number.isInteger(normalized)) throw new Error(`${label} 必须是整数`)
  return normalized
}

function binary(value, label) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new Error(`${label}格式无效`)
}

function oneOf(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} 无效`)
  return value
}

function attachmentMimeType(filePath, kind) {
  const extension = path.extname(filePath).toLowerCase()
  const known = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
    '.html': 'text/html', '.htm': 'text/html', '.xhtml': 'application/xhtml+xml',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return known[extension] || (kind === 'image' ? 'image/*' : 'application/octet-stream')
}

function attachmentFromPath(filePath, id = randomUUID()) {
  const resolvedPath = path.resolve(String(filePath || ''))
  let stats
  try { stats = fs.statSync(resolvedPath) } catch { throw new Error(`附件不存在或无法读取：${path.basename(resolvedPath) || '未知文件'}`) }
  if (!stats.isFile()) throw new Error(`附件不是文件：${path.basename(resolvedPath)}`)
  if (stats.size <= 0) throw new Error(`附件内容为空：${path.basename(resolvedPath)}`)
  const kind = imageExtensions.has(path.extname(resolvedPath).toLowerCase()) ? 'image' : 'file'
  return {
    id: String(id || randomUUID()).slice(0, 180),
    name: path.basename(resolvedPath),
    path: resolvedPath,
    size: stats.size,
    mimeType: attachmentMimeType(resolvedPath, kind),
    kind,
  }
}

function validateChatAttachments(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > attachmentLimit) throw new Error(`每次最多添加 ${attachmentLimit} 个附件。`)
  const attachments = value.map((item) => {
    const attachment = object(item, '附件')
    return attachmentFromPath(text(attachment.path, '附件路径', 4_000), optionalText(attachment.id, '附件 ID', 180) || randomUUID())
  })
  return attachments
}

function validateWorkspaceDirectory(value, label = '会话工作区') {
  if (typeof value !== 'string') throw new Error(`${label}必须是文件夹路径。`)
  const requestedPath = value.trim()
  if (!requestedPath) throw new Error(`请先选择${label}文件夹。`)
  if (requestedPath.length > 4_000 || !path.isAbsolute(requestedPath)) throw new Error(`${label}必须使用有效的绝对路径。`)
  let resolvedPath
  let stats
  try {
    resolvedPath = fs.realpathSync.native(path.resolve(requestedPath))
    stats = fs.statSync(resolvedPath)
  } catch {
    throw new Error(`${label}不存在或无法访问，请重新选择文件夹。`)
  }
  if (!stats.isDirectory()) throw new Error(`${label}必须是文件夹。`)
  return resolvedPath
}

function validateMemory(input) {
  const item = object(input, '记忆')
  return {
    id: text(item.id, '记忆 ID', 180), title: text(item.title, '记忆标题', 200),
    excerpt: text(item.excerpt, '记忆内容', 20_000), type: oneOf(item.type, memoryTypes, '记忆类型'),
    updatedAt: text(item.updatedAt, '更新时间', 100), source: text(item.source, '记忆来源', 200),
  }
}

function validateBot(input) {
  const bot = object(input, 'Bot')
  const channels = Array.isArray(bot.channels) ? bot.channels.map((id) => oneOf(id, channelIds, '渠道')) : []
  const model = optionalText(bot.model, '模型', 300)
  const requestedModelProvider = optionalText(bot.modelProvider, '模型供应商', 80)
  const modelProvider = requestedModelProvider ? oneOf(requestedModelProvider, modelProviders, '模型供应商') : ''
  if (model && !modelProvider) throw new Error('选择模型 ID 时必须同时选择已保存的模型供应商')
  return {
    id: text(bot.id, 'Bot ID', 180), name: text(bot.name, 'Bot 名称', 120), initials: text(bot.initials, 'Bot 缩写', 8),
    role: text(bot.role, 'Bot 角色', 200), description: text(bot.description, 'Bot 描述', 2_000),
    status: oneOf(bot.status, botStatuses, 'Bot 状态'), color: text(bot.color, 'Bot 颜色', 32),
    modelProvider, model, memoryCount: number(bot.memoryCount, '记忆数量'),
    memorySize: text(bot.memorySize, '记忆大小', 80), channels: [...new Set(channels)],
    lastActive: text(bot.lastActive, '最后活动时间', 100), conversations: number(bot.conversations, '会话数量'),
    successRate: number(bot.successRate, '成功率', 0, 100), prompt: text(bot.prompt, '系统提示词', 40_000),
    memories: Array.isArray(bot.memories) ? bot.memories.slice(0, 5_000).map(validateMemory) : [],
  }
}

function validatedRecord(value, allowedKeys, label, maximum = 2_000) {
  const record = object(value || {}, label)
  const allowed = new Set(allowedKeys)
  const result = {}
  for (const [key, raw] of Object.entries(record)) {
    if (!allowed.has(key)) throw new Error(`${label}包含不支持的字段：${key}`)
    result[key] = optionalText(raw, key, maximum)
  }
  return result
}

function validateGatewayConnectionConfiguration(input) {
  const value = object(input, '机器人账号配置')
  const provider = oneOf(value.provider, externalChannelIds, '渠道类型')
  const definition = channelFields[provider]
  const config = validatedRecord(value.config, definition.public, '渠道配置')
  if (provider === 'weixin') {
    oneOf(config.WEIXIN_DM_POLICY || 'pairing', new Set(['pairing', 'allowlist', 'disabled']), '微信私聊授权方式')
    oneOf(config.WEIXIN_GROUP_POLICY || 'disabled', new Set(['disabled', 'allowlist', 'open']), '微信群消息策略')
    if (config.WEIXIN_DM_POLICY === 'allowlist' && !config.WEIXIN_ALLOWED_USERS) throw new Error('微信私聊白名单不能为空')
    if (config.WEIXIN_GROUP_POLICY === 'allowlist' && !config.WEIXIN_GROUP_ALLOWED_USERS) throw new Error('微信群白名单不能为空')
    if (config.WEIXIN_BASE_URL) {
      const url = new URL(config.WEIXIN_BASE_URL)
      if (url.protocol !== 'https:') throw new Error('微信 iLink API 地址必须使用 HTTPS')
    }
  }
  const clearSecrets = Array.isArray(value.clearSecrets)
    ? value.clearSecrets.map((key) => oneOf(key, new Set(definition.secret), '待清除凭证'))
    : []
  return {
    id: optionalText(value.id, '机器人账号 ID', 180),
    provider,
    name: text(value.name, '机器人账号名称', 120),
    botId: text(value.botId, '目标 Bot', 180),
    enabled: Boolean(value.enabled),
    config,
    secrets: validatedRecord(value.secrets, definition.secret, '渠道凭证', 8_000),
    clearSecrets,
  }
}

function validateModelConfiguration(input) {
  const value = object(input, '模型配置')
  const provider = oneOf(value.provider, modelProviders, '模型供应商')
  const baseUrl = optionalText(value.baseUrl, 'API Base URL', 500)
  if (baseUrl) {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API Base URL 仅支持 HTTP 或 HTTPS')
  }
  const apiKeyName = text(value.apiKeyName, 'API 密钥变量名', 80)
  if (!/^[A-Z][A-Z0-9_]+$/.test(apiKeyName)) throw new Error('API 密钥变量名格式无效')
  return {
    provider,
    model: text(value.model, '模型 ID', 300),
    baseUrl,
    apiKeyName,
    apiKey: optionalText(value.apiKey, 'API 密钥', 8_000),
    clearApiKey: Boolean(value.clearApiKey),
  }
}

function validateModelCatalogRequest(input) {
  const value = object(input, '模型列表请求')
  const provider = oneOf(value.provider, modelProviders, '模型供应商')
  const baseUrl = optionalText(value.baseUrl, 'API Base URL', 500)
  if (baseUrl) {
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API Base URL 仅支持 HTTP 或 HTTPS')
  }
  const apiKeyName = text(value.apiKeyName, 'API 密钥变量名', 80)
  if (!/^[A-Z][A-Z0-9_]+$/.test(apiKeyName)) throw new Error('API 密钥变量名格式无效')
  return {
    provider,
    baseUrl,
    apiKeyName,
    apiKey: optionalText(value.apiKey, 'API 密钥', 8_000),
    forceRefresh: Boolean(value.forceRefresh),
  }
}

function validateSkillEditorInput(input, requireId = false) {
  const skill = object(input, '技能')
  const repositoryUrl = optionalText(skill.repositoryUrl, '技能仓库地址', 1_000)
  if (repositoryUrl) {
    const parsed = new URL(repositoryUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('技能仓库地址仅支持 HTTP 或 HTTPS')
  }
  return {
    ...(requireId ? { id: text(skill.id, '技能 ID', 180) } : {}),
    name: text(skill.name, '技能名称', 160),
    description: text(skill.description, '技能描述', 2_000),
    version: text(skill.version, '技能版本', 80),
    repositoryUrl,
    content: text(skill.content, 'SKILL.md 内容', 500_000),
    enabled: Boolean(skill.enabled),
    assignedBotIds: Array.isArray(skill.assignedBotIds) ? [...new Set(skill.assignedBotIds.map((botId) => text(botId, 'Bot ID', 180)))] : [],
  }
}

function validateSkillAssignmentInput(input) {
  const value = object(input, '技能分配请求')
  return {
    skillId: text(value.skillId, '技能 ID', 180),
    botIds: Array.isArray(value.botIds) ? [...new Set(value.botIds.map((botId) => text(botId, 'Bot ID', 180)))] : [],
  }
}

function validateSettings(input) {
  const settings = object(input, '设置')
  const gatewayUrl = text(settings.gatewayUrl, 'Gateway URL', 500)
  const defaultWorkspacePath = optionalText(settings.defaultWorkspacePath, '默认全局工作区', 4_000)
  const url = new URL(gatewayUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Gateway URL 仅支持 HTTP 或 HTTPS')
  const updateFeedUrl = optionalText(settings.updateFeedUrl, '更新检查地址', 2_000)
  if (updateFeedUrl) {
    let feedUrl
    try { feedUrl = new URL(updateFeedUrl) } catch { throw new Error('更新检查地址不是有效网址') }
    if (!['http:', 'https:'].includes(feedUrl.protocol)) throw new Error('更新检查地址仅支持 HTTP 或 HTTPS')
  }
  return {
    firstRunSetupCompleted: Boolean(settings.firstRunSetupCompleted),
    defaultWorkspacePath: defaultWorkspacePath ? validateWorkspaceDirectory(defaultWorkspacePath, '默认全局工作区') : '',
    hiddenSidebarBotIds: Array.isArray(settings.hiddenSidebarBotIds)
      ? [...new Set(settings.hiddenSidebarBotIds.slice(0, 100).map((id) => text(id, '侧栏 Bot ID', 180)))]
      : [],
    gatewayUrl,
    updateFeedUrl,
    strictMemory: Boolean(settings.strictMemory),
    autoApprovalEnabled: Boolean(settings.autoApprovalEnabled),
    webAccessEnabled: Boolean(settings.webAccessEnabled),
    autoExtractMemory: Boolean(settings.autoExtractMemory),
    memoryPeriodicReview: Boolean(settings.memoryPeriodicReview),
    memoryReviewInterval: integer(settings.memoryReviewInterval, '记忆复盘间隔', 2, 100),
    memoryRecallLimit: integer(settings.memoryRecallLimit, '单轮记忆召回数量', 1, 100),
    memoryMaxItems: integer(settings.memoryMaxItems, '单个空间记忆上限', 50, 5_000),
    bindChannelIdentity: Boolean(settings.bindChannelIdentity),
    runWhileLocked: Boolean(settings.runWhileLocked),
    appLockEnabled: Boolean(settings.appLockEnabled),
    appLockPasswordConfigured: Boolean(settings.appLockPasswordConfigured),
    computerUseEnabled: Boolean(settings.computerUseEnabled),
    browserEnabled: settings.browserEnabled !== false,
    browserWebLinkTarget: oneOf(settings.browserWebLinkTarget || 'system', new Set(['zsense', 'system']), '网页链接打开位置'),
    browserLocalUrlTarget: oneOf(settings.browserLocalUrlTarget || 'zsense', new Set(['zsense', 'system']), '本地网址打开位置'),
    browserShowFullUrl: Boolean(settings.browserShowFullUrl),
    browserScreenshotPolicy: oneOf(settings.browserScreenshotPolicy || 'always', new Set(['always', 'ask', 'never']), '浏览器截图策略'),
    browserDownloadPath: optionalText(settings.browserDownloadPath, '浏览器下载目录', 4_000),
    browserAskDownloadLocation: Boolean(settings.browserAskDownloadLocation),
    browserHistoryAccess: oneOf(settings.browserHistoryAccess || 'ask', new Set(['ask', 'allow', 'block']), '浏览历史访问策略'),
    browserWebMcpEnabled: settings.browserWebMcpEnabled !== false,
    browserAgentBrowsePermission: oneOf(settings.browserAgentBrowsePermission || 'ask', new Set(['ask', 'allow', 'block']), 'Agent 浏览权限'),
    browserAgentDownloadPermission: oneOf(settings.browserAgentDownloadPermission || 'ask', new Set(['ask', 'allow', 'block']), 'Agent 下载权限'),
    browserAgentUploadPermission: oneOf(settings.browserAgentUploadPermission || 'ask', new Set(['ask', 'allow', 'block']), 'Agent 上传权限'),
    browserFullCdpAccess: Boolean(settings.browserFullCdpAccess),
    contextAutoCompression: Boolean(settings.contextAutoCompression),
    contextCompressionThreshold: number(settings.contextCompressionThreshold, '压缩阈值', 0.5, 0.95),
    contextCompressionTargetRatio: number(settings.contextCompressionTargetRatio, '压缩目标比例', 0.1, 0.8),
    contextCompressionProtectLastN: integer(settings.contextCompressionProtectLastN, '保护最近消息数', 0, 500),
    contextCompressionProtectFirstN: integer(settings.contextCompressionProtectFirstN, '保护开头消息数', 0, 500),
    sensitiveDataRedaction: Boolean(settings.sensitiveDataRedaction),
    streamingResponse: Boolean(settings.streamingResponse),
    compactMode: Boolean(settings.compactMode),
    showReasoning: Boolean(settings.showReasoning),
    showUsage: Boolean(settings.showUsage),
    inlineDiff: Boolean(settings.inlineDiff),
    completionSound: Boolean(settings.completionSound),
    approvalSound: Boolean(settings.approvalSound),
    approvalDesktopNotification: Boolean(settings.approvalDesktopNotification),
    completionDesktopNotification: Boolean(settings.completionDesktopNotification),
    chatInputHeight: integer(settings.chatInputHeight, '聊天输入框高度', 80, 320),
    voiceWakeEnabled: Boolean(settings.voiceWakeEnabled),
    voiceWakePhrase: text(settings.voiceWakePhrase || '你好 ZSense', '语音唤醒词', 32),
    voiceWakeSound: Boolean(settings.voiceWakeSound),
    voiceWakeStartNewConversation: Boolean(settings.voiceWakeStartNewConversation),
    voiceWakeSensitivity: number(settings.voiceWakeSensitivity, '语音唤醒灵敏度', 0.2, 0.9),
    voiceWakeConfirmationFrames: integer(settings.voiceWakeConfirmationFrames, '语音唤醒确认帧数', 1, 8),
    voiceConversationEnabled: Boolean(settings.voiceConversationEnabled),
    voiceAutoSpeak: Boolean(settings.voiceAutoSpeak),
    voiceContinuousConversation: Boolean(settings.voiceContinuousConversation),
    voiceTtsVoice: text(settings.voiceTtsVoice || 'Xiaoyu', '本地 TTS 音色', 80),
    voiceTtsSpeed: number(settings.voiceTtsSpeed ?? 1, '本地 TTS 语速', 0.7, 1.5),
    responseLanguage: oneOf(settings.responseLanguage || 'zh-CN', responseLanguages, '回复与播报语言'),
  }
}

function validateScheduledTaskInput(input) {
  const value = object(input, '定时任务')
  const timeOfDay = text(value.timeOfDay || '09:00', '运行时间', 5)
  const workspacePath = optionalText(value.workspacePath, '任务工作区', 4_000)
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)) throw new Error('运行时间必须使用 HH:mm 格式。')
  const frequency = oneOf(value.frequency, scheduledTaskFrequencies, '运行频率')
  const cronExpression = optionalText(value.cronExpression, '自定义调度表达式', 120)
  if (frequency === 'custom' && !/^(?:\S+\s+){4}\S+$/.test(cronExpression)) throw new Error('自定义调度必须填写标准 5 段 Cron 表达式。')
  return {
    name: text(value.name, '任务名称', 200),
    frequency,
    timeOfDay,
    weekday: integer(value.weekday, '星期', 0, 6),
    dayOfMonth: integer(value.dayOfMonth || 1, '每月日期', 1, 31),
    cronExpression,
    modelProvider: oneOf(value.modelProvider, modelProviders, '模型供应商'),
    model: text(value.model, '模型 ID', 300),
    prompt: text(value.prompt, '提示词', 5_000),
    memoryEnabled: value.memoryEnabled !== false,
    skillIds: Array.isArray(value.skillIds) ? [...new Set(value.skillIds.slice(0, 40).map((id) => text(id, '技能 ID', 180)))] : [],
    deliveryTarget: oneOf(value.deliveryTarget || 'local', new Set(['local']), '投递目标'),
    repeatCount: integer(value.repeatCount || 0, '重复次数', 0, 10_000),
    enabled: value.enabled !== false,
    workspacePath: workspacePath ? validateWorkspaceDirectory(workspacePath, '任务工作区') : '',
  }
}

export function portableConfigurationFromWorkspace(workspace, appVersion) {
  const exportedAt = new Date().toISOString()
  const settings = {
    ...workspace.settings,
    firstRunSetupCompleted: true,
    defaultWorkspacePath: '',
  }
  const portableModel = (configuration) => ({
    provider: configuration.provider,
    model: configuration.model,
    baseUrl: configuration.baseUrl || '',
    apiKeyName: configuration.apiKeyName,
    apiKeyConfigured: false,
    updatedAt: configuration.updatedAt || exportedAt,
    contextWindow: Number(configuration.contextWindow || 0),
  })
  return {
    format: portableConfigurationFormat,
    schemaVersion: portableConfigurationSchemaVersion,
    exportedAt,
    appVersion,
    sourcePlatform: process.platform,
    data: {
      settings,
      bots: workspace.bots.map((bot) => ({
        ...bot,
        memories: [],
        memoryCount: 0,
        memorySize: '0 KB',
        conversations: 0,
        channels: ['web'],
        lastActive: '尚未运行',
      })),
      modelConfiguration: workspace.modelConfiguration.model ? portableModel(workspace.modelConfiguration) : null,
      savedModelConfigurations: workspace.savedModelConfigurations.map(portableModel),
      skills: workspace.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        repositoryUrl: skill.repositoryUrl || '',
        content: skill.content,
        enabled: skill.enabled,
        assignedBotIds: skill.assignedBotIds,
      })),
      scheduledTasks: workspace.scheduledTasks.map((task) => ({
        ...task,
        enabled: false,
        status: 'paused',
        workspacePath: '',
        nextRunAt: null,
        lastRunAt: null,
        runCount: 0,
      })),
      gatewayProfiles: workspace.gatewayConnections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        botId: connection.botId,
        profileName: connection.profileName,
        config: connection.config,
        enabled: false,
      })),
    },
    omitted: ['passwords', 'apiKeys', 'gatewaySecrets', 'conversations', 'memories', 'files', 'machineSpecificPaths'],
  }
}

export async function importPortableConfiguration({ payload, database, skillManager }) {
  if (payload?.format !== portableConfigurationFormat || Number(payload?.schemaVersion) !== portableConfigurationSchemaVersion) {
    throw new Error('这不是受支持的 ZSense 跨平台配置文件。')
  }
  const data = object(payload.data, '配置数据')
  const counts = { bots: 0, models: 0, skills: 0, scheduledTasks: 0, gatewayProfiles: 0 }
  let workspace = database.loadWorkspace()

  for (const rawBot of (Array.isArray(data.bots) ? data.bots : []).slice(0, 100)) {
    const bot = validateBot({ ...rawBot, memories: [], memoryCount: 0, memorySize: '0 KB', conversations: 0, channels: ['web'], lastActive: '尚未运行' })
    if (bot.id === NATIVE_BOT_ID) continue
    workspace = database.getBot(bot.id) ? database.updateBot(bot) : database.createBot(bot)
    counts.bots += 1
  }

  const importedModels = Array.isArray(data.savedModelConfigurations) ? data.savedModelConfigurations.slice(0, 2_000) : []
  const defaultModel = data.modelConfiguration && typeof data.modelConfiguration === 'object' ? data.modelConfiguration : null
  const modelKeys = new Set()
  for (const rawModel of [...importedModels, ...(defaultModel ? [defaultModel] : [])]) {
    const model = validateModelConfiguration({ ...rawModel, apiKey: '', clearApiKey: false })
    const key = `${model.provider}\u0000${model.model}`
    if (modelKeys.has(key)) continue
    modelKeys.add(key)
    workspace = database.loadWorkspace()
    const apiKeyConfigured = workspace.availableModelConfigurations.some((item) => item.provider === model.provider && item.apiKeyConfigured)
      || (workspace.modelConfiguration.provider === model.provider && workspace.modelConfiguration.apiKeyConfigured)
    database.upsertPortableModelConfiguration({
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
      apiKeyName: model.apiKeyName,
      apiKeyConfigured,
      updatedAt: new Date().toISOString(),
    }, false)
    counts.models += 1
  }
  if (defaultModel) {
    const model = validateModelConfiguration({ ...defaultModel, apiKey: '', clearApiKey: false })
    workspace = database.loadWorkspace()
    const apiKeyConfigured = workspace.availableModelConfigurations.some((item) => item.provider === model.provider && item.apiKeyConfigured)
      || (workspace.modelConfiguration.provider === model.provider && workspace.modelConfiguration.apiKeyConfigured)
    database.upsertPortableModelConfiguration({ ...model, apiKeyConfigured, updatedAt: new Date().toISOString() }, true)
  }

  for (const rawSkill of (Array.isArray(data.skills) ? data.skills : []).slice(0, 500)) {
    const knownBotIds = new Set(database.loadBotIds())
    const input = validateSkillEditorInput({
      ...rawSkill,
      assignedBotIds: Array.isArray(rawSkill?.assignedBotIds) ? rawSkill.assignedBotIds.filter((id) => knownBotIds.has(id)) : [],
    })
    const existing = skillManager.getSkill(optionalText(rawSkill?.id, '技能 ID', 180))
      || skillManager.listSkills().find((skill) => skill.name === input.name)
    if (existing) database.updateSkill(existing.id, input)
    else database.createSkill(input)
    counts.skills += 1
  }

  workspace = database.loadWorkspace()
  const knownBotIds = new Set(workspace.bots.map((bot) => bot.id))
  const knownSkillIds = new Set(workspace.skills.map((skill) => skill.id))
  for (const rawConnection of (Array.isArray(data.gatewayProfiles) ? data.gatewayProfiles : []).slice(0, 500)) {
    if (!knownBotIds.has(rawConnection?.botId)) continue
    const imported = validateGatewayConnectionConfiguration({ ...rawConnection, enabled: false, secrets: {}, clearSecrets: [] })
    const existing = database.findGatewayConnection(imported.botId, imported.provider)
    database.upsertGatewayConnection({
      id: existing?.id || imported.id || randomUUID(),
      provider: imported.provider,
      name: imported.name,
      botId: imported.botId,
      profileName: existing?.profileName || optionalText(rawConnection?.profileName, '网关空间名称', 180) || `zsense-${imported.botId}`,
      status: existing?.configured ? 'paused' : 'setup',
      latency: '—',
      messages: existing?.messages || 0,
      configured: Boolean(existing?.configured),
      config: imported.config,
      secretKeys: existing?.secretKeys || [],
      secretScope: existing?.secretScope || `gateway:${imported.id || randomUUID()}`,
      updatedAt: new Date().toISOString(),
    })
    counts.gatewayProfiles += 1
  }

  for (const rawTask of (Array.isArray(data.scheduledTasks) ? data.scheduledTasks : []).slice(0, 500)) {
    const task = validateScheduledTaskInput({
      ...rawTask,
      enabled: false,
      workspacePath: '',
      skillIds: Array.isArray(rawTask?.skillIds) ? rawTask.skillIds.filter((id) => knownSkillIds.has(id)) : [],
    })
    const id = optionalText(rawTask?.id, '定时任务 ID', 180) || randomUUID()
    const now = new Date().toISOString()
    const portableTask = { ...task, id, enabled: false, workspacePath: '', nextRunAt: null, createdAt: rawTask?.createdAt || now, updatedAt: now }
    if (database.getScheduledTask(id)) database.updateScheduledTask(id, portableTask)
    else database.createScheduledTask(portableTask)
    counts.scheduledTasks += 1
  }

  workspace = database.loadWorkspace()
  if (data.settings && typeof data.settings === 'object') {
    const importedSettings = validateSettings({
      ...workspace.settings,
      ...data.settings,
      firstRunSetupCompleted: true,
      defaultWorkspacePath: workspace.settings.defaultWorkspacePath,
    })
    workspace = database.updateSettings(importedSettings)
  }
  return { workspace, counts }
}

function publicHandle(ipcMain, name, handler) {
  // 防御：Electron 对同一通道重复 handle 会直接抛错，并把原始异常抛到界面上
  // （曾出现 "Attempted to register a second handler"，用户在切换安全锁时看到红字）。
  // 注册前先清掉同名通道，重复注册就是无声覆盖，永远不再变成用户可见的错误。
  try { ipcMain.removeHandler(name) } catch { /* 未注册过，忽略 */ }
  ipcMain.handle(name, async (event, payload) => {
    try { return { ok: true, data: cloneForRenderer(await handler(payload, event)) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '未知错误' } }
  })
}

// 设备互联快照：只保留会话需要知道的字段（有没有配对、对方授权了什么、在不在线）。
function currentDeviceLinkSnapshot(service) {
  if (!service) return null
  try {
    const status = service.inspect()
    return {
      enabled: status.enabled === true,
      running: status.running === true,
      localDevice: {
        name: status.device?.name || '',
        addresses: status.device?.addresses || [],
        port: Number(status.device?.port) || 0,
      },
      paired: (status.trustedPeers || []).map((peer) => ({
        deviceId: peer.deviceId,
        name: peer.name,
        platformLabel: peer.platformLabel,
        online: peer.online === true,
        allowStatus: peer.access?.allowStatus === true,
        allowTasks: peer.access?.allowTasks === true,
      })),
      nearby: (status.discoveredDevices || []).filter((device) => device.paired !== true).map((device) => ({
        name: device.name,
        platformLabel: device.platformLabel,
      })),
    }
  } catch { return null }
}

export function registerIpcHandlers({ ipcMain, database, agentCore, browserService, capabilityService, computerUseService, mcpService, gatewayService, officeTaskService = null, voiceService, inspectApplicationRuntime = () => agentCore.inspect(), secrets, skillManager, auth, officeWorkspace, canvasService, deviceLinkService, webBridgeService = null, updateService = null, deployBundledAgentResources = () => undefined, scheduledTaskRunner, notify, onWorkspaceChanged = () => undefined, microphoneAccessStatus = () => 'unknown', requestMicrophoneAccess = async () => 'unknown', onVoiceWakeDetected = () => ({ phrase: '你好 ZSense', detectedAt: new Date().toISOString() }), onRunWhileLockedChanged = () => undefined, appVersion = 'unknown' }) {
  const enqueueMemoryMaintenance = createMemoryMaintenanceQueue()
  publicHandle(ipcMain, 'zsense:auth:status', (_payload, event) => auth.status(event.sender.id))
  publicHandle(ipcMain, 'zsense:auth:lock', (_payload, event) => {
    voiceService.stopWake()
    return auth.lock(event.sender.id)
  })
  publicHandle(ipcMain, 'zsense:auth:unlock', (payload, event) => auth.unlock(event.sender.id, object(payload, '解锁信息')))
  publicHandle(ipcMain, 'zsense:auth:set-lock-password', (payload, event) => {
    const status = auth.setLockPassword(event.sender.id, object(payload, '安全锁密码'))
    webBridgeService?.revokeRemoteSessions()
    onWorkspaceChanged(database.loadWorkspace())
    return status
  })
  // ── 邮箱：绑定、状态、以及用邮箱验证码重置安全锁密码 ──────────────
  // 验证码由交换中心发出（发往它自己配置的收件邮箱），应用只负责转达与校验，
  // 因此交换中心不会变成任人可用的发信口。
  const hubBaseUrl = () => String(deviceLinkService?.hubUrl?.() || 'https://hub.zsense.space').replace(/\/+$/, '')
  publicHandle(ipcMain, 'zsense:auth:account-password:status', () => ({ configured: auth.accountPasswordConfigured() }))
  publicHandle(ipcMain, 'zsense:auth:account-password:set', (payload, event) => {
    const result = auth.setAccountPassword(event.sender.id, object(payload, '远程访问密码'))
    webBridgeService?.revokeRemoteSessions()
    return result
  })
  publicHandle(ipcMain, 'zsense:auth:email:status', () => auth.emailStatus())
  publicHandle(ipcMain, 'zsense:auth:email:set', () => { throw new Error('绑定邮箱必须完成验证码验证。') })
  // 绑定邮箱：先给这个邮箱发验证码（交换中心只允许发给它自己的收件邮箱），验证通过才允许写入绑定
  publicHandle(ipcMain, 'zsense:auth:email:bind-send', async (payload) => {
    const email = text(object(payload, '邮箱验证请求').email, '邮箱', 160)
    const device = await deviceLinkService.refreshRemoteIdentity({ requireRegistration: true })
    const deviceId = device?.remote?.deviceId
    if (!deviceId || !device?.remote?.registeredAt) throw new Error(device?.remote?.lastError || '设备尚未在交换中心完成注册，请在设备互联中查看具体错误。')
    let response
    try {
      response = await fetch(`${hubBaseUrl()}/__hub/api/app/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose: 'device-bind', deviceId }) })
    } catch {
      throw new Error('连不上 ZSense 交换中心，验证码没发出去；请检查网络后重试。')
    }
    const result = await response.json().catch(() => null)
    if (!response.ok || result?.ok === false) throw new Error(result?.error || '验证码发送失败。')
    return { masked: result?.data?.masked || '', expiresInSeconds: Number(result?.data?.expiresInSeconds) || 0 }
  })
  publicHandle(ipcMain, 'zsense:auth:email:bind-verify', async (payload, event) => {
    auth.requireUser(event.sender.id)
    const value = object(payload, '邮箱绑定验证')
    const email = text(value.email, '邮箱', 160)
    await deviceLinkService.bindVerifiedEmail(email, text(value.code, '验证码', 12))
    const status = auth.setEmail(event.sender.id, { email })
    onWorkspaceChanged(database.loadWorkspace())
    return status
  })
  publicHandle(ipcMain, 'zsense:auth:email:send-code', async () => {
    const email = auth.boundEmail()
    if (!email) throw new Error('还没有绑定邮箱；请先在设置里绑定邮箱。')
    let response
    try {
      response = await fetch(`${hubBaseUrl()}/__hub/api/app/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
    } catch {
      throw new Error('连不上 ZSense 交换中心，验证码没发出去；请检查网络后重试。')
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || '验证码发送失败。')
    return { masked: payload?.data?.masked || '', expiresInSeconds: Number(payload?.data?.expiresInSeconds) || 0 }
  })
  publicHandle(ipcMain, 'zsense:auth:email:reset', async (payload, event) => {
    const value = object(payload, '邮箱重置请求')
    const email = auth.boundEmail()
    if (!email) throw new Error('还没有绑定邮箱；请先在设置里绑定邮箱。')
    let response
    try {
      response = await fetch(`${hubBaseUrl()}/__hub/api/app/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: text(value.code, '验证码', 12) }) })
    } catch {
      throw new Error('连不上 ZSense 交换中心，验证码没法校验；请检查网络后重试。')
    }
    const result = await response.json().catch(() => null)
    if (!response.ok || result?.ok === false) throw new Error(result?.error || '验证码不正确或已过期。')
    const status = auth.resetLockPassword(event.sender.id, { email, password: value.password })
    webBridgeService?.revokeRemoteSessions()
    onWorkspaceChanged(database.loadWorkspace())
    return status
  })
  // ── 首启引导（① 用户名 ② 邮箱验证码 ③ 可选安全锁 ④ 设备号/子域名）──
  publicHandle(ipcMain, 'zsense:onboarding:status', () => ({ completed: database.loadSettings()?.onboardingCompleted === true }))
  publicHandle(ipcMain, 'zsense:onboarding:set-name', (payload, event) => {
    const user = auth.requireUser(event.sender.id)
    const value = object(payload, '用户名')
    const displayName = text(value.displayName, '用户名', 40).trim()
    if (displayName.length < 2) throw new Error('用户名至少需要 2 个字。')
    const username = (String(value.username || displayName).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `user-${Date.now().toString(36)}`).slice(0, 32)
    database.updateUser(user.id, { username, displayName, updatedAt: new Date().toISOString() })
    // 设备名跟随账号名：改完立刻同步，不用重启应用
    void deviceLinkService.syncDeviceNameFromOwner?.()
    onWorkspaceChanged(database.loadWorkspace())
    return { username, displayName }
  })
  publicHandle(ipcMain, 'zsense:onboarding:complete', (_payload, event) => {
    auth.requireUser(event.sender.id)
    const workspace = database.updateSettings({ ...database.loadSettings(), onboardingCompleted: true })
    onWorkspaceChanged(workspace)
    return { completed: true }
  })
  publicHandle(ipcMain, 'zsense:auth:users:list', (_payload, event) => auth.listUsers(event.sender.id))
  publicHandle(ipcMain, 'zsense:auth:users:create', (payload, event) => auth.createUser(event.sender.id, object(payload, '新用户')))
  publicHandle(ipcMain, 'zsense:auth:users:update', (payload, event) => auth.updateUser(event.sender.id, object(payload, '用户资料')))
  publicHandle(ipcMain, 'zsense:auth:users:delete', (payload, event) => auth.deleteUser(event.sender.id, text(payload, '用户 ID', 180)))

  const safeHandle = (_ipcMain, name, handler) => publicHandle(ipcMain, name, async (payload, event) => {
    auth.requireUser(event.sender.id)
    return handler(payload, event)
  })

  safeHandle(ipcMain, 'zsense:clipboard:write-text', (payload) => {
    if (typeof payload !== 'string' || !payload.length || payload.length > 2_000_000) throw new Error('复制内容为空或超过 2,000,000 个字符。')
    clipboard.writeText(payload)
    return true
  })
  safeHandle(ipcMain, 'zsense:web-bridge:status', () => (webBridgeService ? webBridgeService.inspect() : { supported: false, enabled: false, running: false, urls: [], sessions: [] }))
  safeHandle(ipcMain, 'zsense:web-bridge:set-enabled', async (payload) => {
    if (!webBridgeService) throw new Error('局域网 Web 访问服务不可用。')
    const enabled = Boolean(payload)
    // 同时写进设置：应用重启后按设置自动恢复
    database.updateSettings({ webAccessEnabled: enabled })
    return webBridgeService.setEnabled(enabled)
  })
  safeHandle(ipcMain, 'zsense:web-bridge:rotate-code', () => {
    if (!webBridgeService) throw new Error('局域网 Web 访问服务不可用。')
    return webBridgeService.rotateAccessCode()
  })
  safeHandle(ipcMain, 'zsense:web-bridge:revoke-session', (payload) => {
    if (!webBridgeService) throw new Error('局域网 Web 访问服务不可用。')
    return webBridgeService.revokeSession(text(payload, '会话标记', 40))
  })
  // 本机安全锁状态只供界面展示；远程连接有独立的设备密钥与网页认证。
  deviceLinkService.ownerNameProvider = () => {
    try { return database.listUsers()?.[0]?.displayName || '' } catch { return '' }
  }
  void deviceLinkService.refreshRemoteIdentity?.()
  deviceLinkService.appLockProvider = () => {
    try { return Boolean(database.getSetting('appLockEnabled')) } catch { return false }
  }
  // 同邮箱自动发现已关闭：客户端自报的邮箱或 emailHash 不能作为中心身份。
  // 免密进入只由首次配对交换的设备公钥验证。
  if (webBridgeService) {
    webBridgeService.deviceTrustVerifier = (id, nonce, signature) => deviceLinkService.verifyRemoteChallenge(id, nonce, signature)
    webBridgeService.remoteAgentTaskProvider = ({ deviceId, prompt, timeoutMs }) => deviceLinkService.runTaskFromCloudPeer(deviceId, prompt, timeoutMs)
    webBridgeService.remoteAgentTaskCanceler = (deviceId) => deviceId ? deviceLinkService.cancelRemoteTaskFromPeer(deviceId) : deviceLinkService.cancelAllRemoteTasks()
    webBridgeService.remoteAccessAllowed = () => Boolean(deviceLinkService.inspect().remote.enabled)
    deviceLinkService.onPeerRevoked = (deviceId) => webBridgeService.revokeTrustedDevice(deviceId)
    deviceLinkService.onRemoteDisabled = () => webBridgeService.revokeRemoteSessions()
    webBridgeService.pairingCodeProvider = () => deviceLinkService.currentPairingCode?.() || ''
    webBridgeService.deviceIdentityProvider = () => deviceLinkService.identityPublicKey()
    webBridgeService.directCandidatesProvider = () => deviceLinkService.signedDirectEndpoints()
    webBridgeService.onRemotePeerConnected = (deviceId, name, publicKey) => {
      const accepted = deviceLinkService.rememberRemotePeer?.(deviceId, name, publicKey)
      if (accepted !== true) return false
      deviceLinkService.refreshPairingCode?.()
      return true
    }
  }
  // 局域网沿用安全锁/访问口令；公网网页登录在安全锁关闭时必须验证远程访问密码。
  if (webBridgeService) {
    webBridgeService.remoteUnlockVerifier = (password) => {
      try { return auth.verifyAppLock(password) } catch (error) { return { ok: false, code: 'error', error: error instanceof Error ? error.message : String(error) } }
    }
    webBridgeService.remoteLoginVerifier = (password) => {
      try { return auth.verifyRemotePassword(password) } catch (error) { return { ok: false, code: 'error', error: error instanceof Error ? error.message : String(error) } }
    }
    deviceLinkService.webBridgeInfoProvider = () => {
      const bridge = webBridgeService.inspect()
      return bridge.running && bridge.certificate
        ? { port: bridge.port, fingerprint: String(bridge.certificate.fingerprint || '').replace(/:/g, '').toUpperCase(), ipv6Listening: bridge.ipv6Listening === true }
        : null
    }
  }
  safeHandle(ipcMain, 'zsense:device-link:set-remote-enabled', (payload) => deviceLinkService.setRemoteEnabled(Boolean(payload && typeof payload === 'object' ? payload.enabled : payload)))
  safeHandle(ipcMain, 'zsense:device-link:revoke-remote-identity', () => deviceLinkService.revokeRemoteIdentity())
  safeHandle(ipcMain, 'zsense:device-link:set-remote-upstream', (payload) => deviceLinkService.setRemoteUpstreamMode(payload === 'local' ? 'local' : 'auto'))
  safeHandle(ipcMain, 'zsense:device-link:set-remote-hostname', (payload) => deviceLinkService.setRemoteHostname(text(payload, '远程域名', 120)))
  safeHandle(ipcMain, 'zsense:device-link:set-remote-token', (payload) => deviceLinkService.setRemoteToken(text(payload, '隧道令牌', 2_000)))
  // 对方返回的不是我们的 JSON，多半是云端通道错误页（隧道断了），
  // 这种情况必须和「对方拒绝」分开提示，否则用户会以为是对方没点接受。
  const remoteChannelError = (response, body) => {
    const text = String(body || '')
    const tunnelDown = response.status === 530 || response.status === 502 || /cloudflare|1033|tunnel/i.test(text)
    if (tunnelDown) {
      return `对方的公网通道现在不通（云端返回 ${response.status}：隧道未连接），不是对方拒绝。请在对方设备上关掉再打开一次「设备互联」，或者重启对方上的 ZSense 后重试。`
    }
    return `对方返回了异常响应（HTTP ${response.status}），这次连接没有成功，请稍后重试。`
  }
  // 已配对设备免密进入：一次性挑战 → 设备私钥签名 → 一次性票据。
  // 首次公网配对：填中心设备号 + 配对码，向对方换票据后直接打开（新号为 8 位，兼容已迁移旧号）
  publicHandle(ipcMain, 'zsense:device-link:pair-connect', async (payload, event) => {
    auth.requireUser(event.sender.id)
    const value = object(payload, '配对连接请求')
    const deviceId = text(value.deviceId, '对方设备号', 60).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,58}$/.test(deviceId)) throw new Error('设备号格式不正确。新设备号为 8 位，迁移后的旧号也可以继续使用。')
    const code = text(value.code, '配对码', 12).trim()
    if (!/^\d{6}$/.test(code)) throw new Error('配对码是对方设备上显示的 6 位数字。')
    const origin = `https://${deviceId}.zsense.space`
    const ownId = String(deviceLinkService.inspect()?.remote?.deviceId || '')
    if (!/^[a-z0-9][a-z0-9-]{1,58}$/.test(ownId)) throw new Error('本机还没有完成交换中心设备号注册，请确认能访问 hub.zsense.space 后重试。')
    let response
    try {
      response = await fetch(`${origin}/bridge/pair-ticket`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zsense-device': ownId },
        body: JSON.stringify({ code, name: String(deviceLinkService.inspect()?.device?.name || ''), identityPublicKey: deviceLinkService.identityPublicKey() }),
      })
    } catch {
      throw new Error('连不上对方设备，请确认它在线并且已打开设备互联。')
    }
    const body = await response.text().catch(() => '')
    let result = null
    try { result = body ? JSON.parse(body) : null } catch { result = null }
    if (!response.ok || result?.ok === false) {
      if (result?.error) throw new Error(result.error)
      throw new Error(remoteChannelError(response, body))
    }
    if (!deviceLinkService.rememberRemotePeer(deviceId, result?.data?.deviceName || deviceId, result?.data?.identityPublicKey || '')) {
      throw new Error('对方没有返回有效设备公钥，请将两端应用更新到新版后重试。')
    }
    const path = result?.data?.entryPath || ''
    return { url: path ? `${origin}${path}` : origin, deviceId }
  })
  publicHandle(ipcMain, 'zsense:device-link:trust-connect', async (payload, event) => {
    auth.requireUser(event.sender.id)
    const deviceId = text(object(payload, '免密连接请求').deviceId, '设备号', 60).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,58}$/.test(deviceId)) throw new Error('设备号格式不正确。')
    const origin = `https://${deviceId}.zsense.space`
    const ownId = String(deviceLinkService.inspect()?.remote?.deviceId || '')
    if (!/^[a-z0-9][a-z0-9-]{1,58}$/.test(ownId)) throw new Error('本机还没有完成交换中心设备号注册，请确认能访问 hub.zsense.space 后重试。')
    const lan = await deviceLinkService.resolveTrustedLanEndpoint(deviceId)
    if (lan) {
      try {
        const direct = await connectTrustedRemote({
          origin: `https://${lan.address}:${lan.port}`,
          ownId,
          targetId: deviceId,
          signChallenge: (target, nonce) => deviceLinkService.signRemoteChallenge(target, nonce),
          fetchImpl: createPinnedLanFetch(lan.fingerprint),
        })
        await openTrustedLanWindow(direct.url, lan.fingerprint)
        return { ...direct, opened: true, connectionMode: 'lan' }
      } catch (error) {
        if (/证书|身份|授权|签名|拒绝|trusted|forbidden|cert|ssl|tls/i.test(String(error?.message || ''))) throw error
        // 端点在验签后突然离线时才尝试现有云端链路。
      }
    }
    try {
      const result = await connectTrustedRemote({
        origin,
        ownId,
        targetId: deviceId,
        signChallenge: (target, nonce) => deviceLinkService.signRemoteChallenge(target, nonce),
      })
      const directCandidates = deviceLinkService.verifySignedDirectEndpoints(deviceId, result.directCandidates)
      if (directCandidates.length) {
        try {
          const direct = await Promise.any(directCandidates.map((candidate) => connectTrustedRemote({
            origin: `https://[${candidate.address}]:${candidate.port}`,
            ownId,
            targetId: deviceId,
            signChallenge: (target, nonce) => deviceLinkService.signRemoteChallenge(target, nonce),
            fetchImpl: createPinnedLanFetch(candidate.fingerprint),
            timeoutMs: 900,
          }).then((ticket) => ({ ticket, candidate }))))
          await openTrustedLanWindow(direct.ticket.url, direct.candidate.fingerprint)
          return { ...direct.ticket, opened: true, connectionMode: 'p2p' }
        } catch { /* IPv6 端到端不可达或入站防火墙拒绝时沿用已取得的云端票据。 */ }
      }
      return { ...result, opened: false, connectionMode: 'cloud' }
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('连接对方设备超时，请确认它在线且网络通畅。')
      if (error instanceof TypeError) throw new Error('连不上对方设备，请确认它在线并且已打开设备互联。')
      throw error
    }
  })
  safeHandle(ipcMain, 'zsense:device-link:status', () => {
    // 界面刷新状态时后台探一次公网可达性（不阻塞返回），这样「启动中」能及时变成「已连接」
    void deviceLinkService.probeRemoteReachability?.()
    return deviceLinkService.inspect()
  })
  safeHandle(ipcMain, 'zsense:device-link:set-enabled', (payload) => deviceLinkService.setEnabled(Boolean(payload)))
  safeHandle(ipcMain, 'zsense:device-link:set-name', (payload) => deviceLinkService.setDeviceName(text(payload, '设备名称', 80)))
  safeHandle(ipcMain, 'zsense:device-link:refresh-code', () => deviceLinkService.refreshPairingCode())
  safeHandle(ipcMain, 'zsense:device-link:refresh', () => deviceLinkService.refresh())
  safeHandle(ipcMain, 'zsense:device-link:pair', (payload) => {
    const value = object(payload, '设备配对请求')
    return deviceLinkService.pair(text(value.deviceId, '设备 ID', 100), text(value.code, '安全配对码', 32))
  })
  safeHandle(ipcMain, 'zsense:device-link:pair-by-address', (payload) => {
    const value = object(payload, '设备直连请求')
    return deviceLinkService.pairByAddress({
      address: text(value.address, '对方地址', 128),
      port: value.port === undefined || value.port === null || value.port === '' ? 0 : integer(value.port, '对方端口', 1, 65_535),
      code: text(value.code, '安全配对码', 32),
    })
  })
  safeHandle(ipcMain, 'zsense:device-link:connect', (payload) => deviceLinkService.connect(text(payload, '设备 ID', 100)))
  safeHandle(ipcMain, 'zsense:device-link:disconnect', (payload) => deviceLinkService.disconnect(text(payload, '设备 ID', 100)))
  safeHandle(ipcMain, 'zsense:device-link:unpair', (payload) => deviceLinkService.unpair(text(payload, '设备 ID', 100)))
  safeHandle(ipcMain, 'zsense:device-link:set-peer-access', (payload) => {
    const value = object(payload, '设备权限设置')
    const access = object(value.access, '设备权限')
    return deviceLinkService.setPeerAccess(text(value.deviceId, '设备 ID', 100), { allowStatus: Boolean(access.allowStatus), allowFiles: Boolean(access.allowFiles), allowTasks: Boolean(access.allowTasks) })
  })
  safeHandle(ipcMain, 'zsense:device-link:remote-status', (payload) => deviceLinkService.remoteStatus(text(payload, '设备 ID', 100)))
  safeHandle(ipcMain, 'zsense:device-link:remote-run', (payload) => {
    const value = object(payload, '远程任务请求')
    const prompt = text(value.prompt, '远程任务内容', 8_000)
    const timeoutMs = value.timeoutMs === undefined ? undefined : integer(value.timeoutMs, '远程任务超时', 10_000, 600_000)
    return deviceLinkService.runRemoteTask(text(value.deviceId, '设备 ID', 100), prompt, timeoutMs)
  })

  publicHandle(ipcMain, 'zsense:update:status', () => (updateService ? updateService.inspect() : { currentVersion: appVersion, platform: process.platform }))
  safeHandle(ipcMain, 'zsense:update:check', async (payload) => {
    if (!updateService) throw new Error('当前运行环境不支持检查更新。')
    const requested = optionalText(payload, '更新检查地址', 2_000)
    const feedUrl = requested || String(database.loadSettings().updateFeedUrl || '') || defaultUpdateFeedUrl()
    return updateService.check(feedUrl)
  })
  safeHandle(ipcMain, 'zsense:update:download', () => {
    if (!updateService) throw new Error('当前运行环境不支持应用内更新。')
    return updateService.download()
  })
  safeHandle(ipcMain, 'zsense:update:pause-download', () => updateService?.pauseDownload())
  safeHandle(ipcMain, 'zsense:update:cancel-download', () => updateService?.cancelDownload())
  safeHandle(ipcMain, 'zsense:update:install', () => {
    if (!updateService) throw new Error('当前运行环境不支持应用内更新。')
    return updateService.install()
  })
  safeHandle(ipcMain, 'zsense:update:open-download', async (payload) => {
    const target = text(payload, '下载地址', 2_000)
    let url
    try { url = new URL(target) } catch { throw new Error('下载地址不是有效网址。') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('下载地址仅支持 HTTP 或 HTTPS。')
    await shell.openExternal(url.toString())
    return { opened: true, url: url.toString() }
  })

  safeHandle(ipcMain, 'zsense:browser:register', (payload, event) => {
    const value = object(payload, '会话浏览器注册请求')
    const sessionId = text(value.sessionId, '浏览器会话 ID', 180)
    const webContentsId = integer(value.webContentsId, '浏览器页面 ID', 1)
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) throw new Error('浏览器页面不存在或已经关闭。')
    if (guest.hostWebContents?.id !== event.sender.id) throw new Error('浏览器页面不属于当前 ZSense 窗口。')
    return browserService.attachVisible(sessionId, guest)
  })
  safeHandle(ipcMain, 'zsense:browser:unregister', (payload, event) => {
    const value = object(payload, '会话浏览器解绑请求')
    const sessionId = text(value.sessionId, '浏览器会话 ID', 180)
    const webContentsId = integer(value.webContentsId, '浏览器页面 ID', 1)
    const guest = webContents.fromId(webContentsId)
    if (guest && guest.hostWebContents?.id !== event.sender.id) throw new Error('浏览器页面不属于当前 ZSense 窗口。')
    return browserService.detachVisible(sessionId, webContentsId)
  })
  safeHandle(ipcMain, 'zsense:browser:activate', (payload) => browserService.activate(text(payload, '浏览器会话 ID', 180)))
  safeHandle(ipcMain, 'zsense:browser:close', (payload) => browserService.close(text(payload, '浏览器会话 ID', 180)))
  safeHandle(ipcMain, 'zsense:browser:capture', (payload) => browserService.capture(text(payload, '浏览器会话 ID', 180)))
  safeHandle(ipcMain, 'zsense:browser:state', () => browserService.profileState())
  safeHandle(ipcMain, 'zsense:browser:clear-data', () => browserService.clearBrowsingData())
  safeHandle(ipcMain, 'zsense:browser:clear-history', (payload) => browserService.clearHistory(oneOf(payload || 'history', new Set(['history', 'downloads', 'all']), '清理类型')))
  safeHandle(ipcMain, 'zsense:browser:pick-download-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择浏览器下载文件夹',
      buttonLabel: '选择文件夹',
      defaultPath: database.loadSettings().browserDownloadPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? '' : result.filePaths[0] || ''
  })
  safeHandle(ipcMain, 'zsense:browser:set-site-permission', (payload) => {
    const value = object(payload, '网站权限')
    return browserService.setSitePermission({
      origin: text(value.origin, '网站来源', 2_000),
      camera: oneOf(value.camera || 'ask', new Set(['ask', 'allow', 'block']), '摄像头权限'),
      microphone: oneOf(value.microphone || 'ask', new Set(['ask', 'allow', 'block']), '麦克风权限'),
    })
  })
  safeHandle(ipcMain, 'zsense:browser:remove-site-permission', (payload) => browserService.removeSitePermission(text(payload, '网站来源', 2_000)))
  safeHandle(ipcMain, 'zsense:browser:open-external', async (payload) => {
    const target = new URL(text(payload, '网页地址', 4_000))
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('只能在系统浏览器中打开 HTTP 或 HTTPS 地址。')
    await shell.openExternal(target.href)
    return true
  })
  safeHandle(ipcMain, 'zsense:screenshot:capture-region', async (payload, event) => {
    const value = object(payload, '截图区域')
    const rectangle = {
      x: integer(value.x, '截图横坐标', 0, 100_000),
      y: integer(value.y, '截图纵坐标', 0, 100_000),
      width: integer(value.width, '截图宽度', 1, 16_384),
      height: integer(value.height, '截图高度', 1, 16_384),
    }
    if (rectangle.width * rectangle.height > 40_000_000) throw new Error('截图区域过大，请缩小应用窗口后重试。')
    const image = await event.sender.capturePage(rectangle)
    if (image.isEmpty()) throw new Error('当前界面没有返回可用的截图内容。')
    const size = image.getSize()
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height, name: 'ZSense-画布截图.png' }
  })
  safeHandle(ipcMain, 'zsense:pdf:open-external', async (payload) => {
    const requestedPath = path.resolve(text(payload, 'PDF 文件路径', 4_000))
    let filePath
    let stats
    try {
      filePath = fs.realpathSync.native(requestedPath)
      stats = fs.statSync(filePath)
    } catch {
      throw new Error('PDF 文件不存在、已移动或无法读取。')
    }
    if (!stats.isFile() || stats.size <= 0) throw new Error('PDF 文件为空或不是有效文件。')
    if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('只能使用该入口打开 .pdf 文件。')
    const handle = await fs.promises.open(filePath, 'r')
    try {
      const signature = Buffer.alloc(5)
      await handle.read(signature, 0, signature.length, 0)
      if (signature.toString('ascii') !== '%PDF-') throw new Error('文件内容不是有效的 PDF。')
    } finally {
      await handle.close()
    }
    const error = await shell.openPath(filePath)
    if (error) throw new Error(`无法使用系统默认应用打开 PDF：${error}`)
    return true
  })
  safeHandle(ipcMain, 'zsense:pdf:read', async (payload) => readPdfDocument(text(payload, 'PDF 文件路径', 4_000)))
  safeHandle(ipcMain, 'zsense:pdf:read-chunk', async (payload) => {
    const value = object(payload, 'PDF 分块读取请求')
    return readPdfDocumentChunk({
      filePath: text(value.filePath, 'PDF 文件路径', 4_000),
      expectedModifiedAt: number(value.expectedModifiedAt, 'PDF 文件版本'),
      offset: integer(value.offset, '读取位置'),
      length: integer(value.length, '读取长度', 1, 2 * 1024 * 1024),
    })
  })
  safeHandle(ipcMain, 'zsense:pdf:save', async (payload) => {
    const value = object(payload, 'PDF 保存请求')
    return savePdfDocument({
      filePath: text(value.filePath, 'PDF 文件路径', 4_000),
      expectedModifiedAt: number(value.expectedModifiedAt, 'PDF 文件版本'),
      operations: value.operations,
      backupDirectory: path.join(app.getPath('userData'), 'pdf-backups'),
    })
  })
  safeHandle(ipcMain, 'zsense:pdf:save-as', async (payload, event) => {
    const value = object(payload, 'PDF 另存为请求')
    const filePath = text(value.filePath, 'PDF 文件路径', 4_000)
    const suggested = path.join(path.dirname(path.resolve(filePath)), `${path.basename(filePath, path.extname(filePath))}-副本.pdf`)
    const picked = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) ?? undefined, { title: 'PDF 另存为', defaultPath: suggested, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (picked.canceled || !picked.filePath) return { canceled: true }
    const target = picked.filePath.toLowerCase().endsWith('.pdf') ? picked.filePath : `${picked.filePath}.pdf`
    const saved = await savePdfDocument({
      filePath,
      expectedModifiedAt: number(value.expectedModifiedAt, 'PDF 文件版本'),
      operations: value.operations,
      targetFilePath: target,
    })
    return { canceled: false, saved }
  })
  safeHandle(ipcMain, 'zsense:pdf:page-action', async (payload, event) => {
    const value = object(payload, 'PDF 页面操作请求')
    const filePath = text(value.filePath, 'PDF 文件路径', 4_000)
    const action = text(value.action, 'PDF 页面操作', 40)
    const expectedModifiedAt = number(value.expectedModifiedAt, 'PDF 文件版本')
    const page = integer(value.page, 'PDF 页码', 1, 100_000)
    let insertFilePath = ''
    let targetFilePath = ''
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    if (action === 'merge') {
      const picked = await dialog.showOpenDialog(owner, { title: '选择要合并的 PDF', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      insertFilePath = picked.filePaths[0]
    }
    if (action === 'extract') {
      const suggested = path.join(path.dirname(path.resolve(filePath)), `${path.basename(filePath, path.extname(filePath))}-第${page}页.pdf`)
      const picked = await dialog.showSaveDialog(owner, { title: '提取当前页为 PDF', defaultPath: suggested, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      if (picked.canceled || !picked.filePath) return { canceled: true }
      targetFilePath = picked.filePath.toLowerCase().endsWith('.pdf') ? picked.filePath : `${picked.filePath}.pdf`
    }
    const saved = await transformPdfPages({ filePath, expectedModifiedAt, action, page, insertFilePath, targetFilePath, backupDirectory: path.join(app.getPath('userData'), 'pdf-backups') })
    return { canceled: false, saved }
  })
  const modelConfigurationForBot = (workspace, bot) => {
    if (!bot?.model) return workspace.modelConfiguration
    const configuration = workspace.availableModelConfigurations.find((item) => item.provider === bot.modelProvider && item.model === bot.model)
    if (!configuration) throw new Error(`${bot.name} 选择的模型已不在“AI 模型”可用列表中。`)
    return configuration
  }
  const modelSecretFor = (configuration, workspace) => {
    const scoped = secrets.get(`model:${configuration.provider}`)
    if (scoped.apiKey) return scoped
    if (workspace.modelConfiguration.provider === configuration.provider) return secrets.get('model:default')
    return scoped
  }
  const scheduledTaskWithReferences = (payload) => {
    const task = validateScheduledTaskInput(payload)
    const workspace = database.loadWorkspace()
    const defaultWorkspacePath = workspace.settings.defaultWorkspacePath
      ? validateWorkspaceDirectory(workspace.settings.defaultWorkspacePath, '默认全局工作区')
      : ''
    const hasModel = workspace.availableModelConfigurations.some((item) => item.provider === task.modelProvider && item.model === task.model)
      || (workspace.modelConfiguration.provider === task.modelProvider && workspace.modelConfiguration.model === task.model)
    if (!hasModel) throw new Error('请选择“设置 → AI 模型”中已保存或从官网同步的模型。')
    const knownSkillIds = new Set(workspace.skills.map((skill) => skill.id))
    const skillIds = task.skillIds.filter((skillId) => knownSkillIds.has(skillId))
    return { ...task, skillIds, workspacePath: task.workspacePath || defaultWorkspacePath }
  }

  const syncSkillAssignments = async (workspace) => {
    return workspace
  }

  safeHandle(ipcMain, 'zsense:data:load', () => database.loadWorkspace())
  safeHandle(ipcMain, 'zsense:data:load-summary', () => database.loadWorkspace({ includeMessages: false }))
  safeHandle(ipcMain, 'zsense:data:conversation', (payload) => {
    const conversation = database.getConversation(text(payload, '会话 ID', 180))
    if (!conversation) throw new Error('会话不存在或已被删除。')
    return conversation
  })
  safeHandle(ipcMain, 'zsense:office-tasks:list', (payload) => officeTaskService?.list({ botId: optionalText(payload?.botId, 'Bot ID', 180), conversationId: optionalText(payload?.conversationId, '会话 ID', 180) }) || [])
  safeHandle(ipcMain, 'zsense:office-tasks:search', (payload) => {
    const value = object(payload, '知识检索请求')
    return officeTaskService?.search({ botId: text(value.botId, 'Bot ID', 180), query: text(value.query, '搜索内容', 500) }) || []
  })
  safeHandle(ipcMain, 'zsense:office-tasks:deliver', async (payload) => {
    const taskId = text(payload, '任务 ID', 180)
    if (!officeTaskService) throw new Error('任务工作台不可用。')
    return gatewayService.deliverOfficeTask(taskId)
  })
  // 会话自愈轮询专用：只回 id + 更新时间，避免每 3 秒构建并传一份完整快照
  safeHandle(ipcMain, 'zsense:data:conversation-timestamps', () => database.conversationTimestamps())
  safeHandle(ipcMain, 'zsense:data:sync-messages', async () => ({ importedMessages: 0, workspace: database.loadWorkspace() }))
  safeHandle(ipcMain, 'zsense:dws:auth-status', () => gatewayService.inspectDwsAuth({ force: true }))
  safeHandle(ipcMain, 'zsense:dws:auth-login', () => gatewayService.startDwsAuthLogin())
  safeHandle(ipcMain, 'zsense:office:status', () => officeWorkspace.status())
  safeHandle(ipcMain, 'zsense:office:recent', () => officeWorkspace.listRecent())
  safeHandle(ipcMain, 'zsense:office:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '在 ZSense 中打开文件',
      buttonLabel: '打开文件',
      properties: ['openFile'],
      filters: [{ name: 'PDF、图片、HTML、Word、Excel、CSV、PowerPoint', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'ico', 'html', 'htm', 'xhtml', 'docx', 'xlsx', 'csv', 'tsv', 'pptx', 'doc', 'xls', 'ppt'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return officeWorkspace.open(result.filePaths[0])
  })
  safeHandle(ipcMain, 'zsense:office:open', (payload) => officeWorkspace.open(text(payload, 'Office 文件路径', 4_000)))
  safeHandle(ipcMain, 'zsense:office:inline-image', (payload) => {
    const value = object(payload, '会话图片预览请求')
    return officeWorkspace.inlineImage({
      workspacePath: validateWorkspaceDirectory(value.workspacePath),
      filePath: text(value.filePath, '图片路径', 4_000),
    })
  })
  safeHandle(ipcMain, 'zsense:office:refresh', (payload) => officeWorkspace.refresh(text(payload, 'Office 文件路径', 4_000)))
  safeHandle(ipcMain, 'zsense:office:image-thumbnail', async (payload) => {
    const filePath = officeWorkspace.resolveImagePath(text(payload, '图片路径', 4_000))
    const thumbnail = await nativeImage.createThumbnailFromPath(filePath, { width: 160, height: 120 })
    if (thumbnail.isEmpty()) throw new Error('无法生成图片缩略图，请点击附件在右侧查看。')
    const size = thumbnail.getSize()
    return { dataUrl: thumbnail.toDataURL(), width: size.width, height: size.height }
  })
  safeHandle(ipcMain, 'zsense:office:get-sheet', (payload) => {
    const value = object(payload, 'Excel 工作表读取请求')
    return officeWorkspace.getSheet({
      filePath: text(value.filePath, 'Excel 文件路径', 4_000),
      sheet: text(value.sheet, '工作表名称', 128),
    })
  })
  safeHandle(ipcMain, 'zsense:office:get-workbook', (payload) => {
    const value = object(payload, 'Excel 工作簿读取请求')
    return officeWorkspace.getWorkbook({
      filePath: text(value.filePath, 'Excel 文件路径', 4_000),
    })
  })
  safeHandle(ipcMain, 'zsense:office:stage-cells', (payload) => {
    const value = object(payload, 'Excel 实时修改请求')
    return officeWorkspace.stageCells({
      filePath: text(value.filePath, 'Excel 文件路径', 4_000),
      changes: value.changes,
      source: 'editor',
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:stage-operations', (payload) => {
    const value = object(payload, 'Excel 功能修改请求')
    return officeWorkspace.stageOperations({
      filePath: text(value.filePath, 'Excel 文件路径', 4_000),
      operations: value.operations,
      source: 'editor',
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:get-word', (payload) => {
    const value = object(payload, 'Word 编辑会话读取请求')
    return officeWorkspace.getWord({ filePath: text(value.filePath, 'Word 文件路径', 4_000) })
  })
  safeHandle(ipcMain, 'zsense:office:stage-word-operations', (payload) => {
    const value = object(payload, 'Word 修改请求')
    return officeWorkspace.stageWordOperations({
      filePath: text(value.filePath, 'Word 文件路径', 4_000),
      operations: value.operations,
      source: 'editor',
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:save-word', (payload) => {
    const value = object(payload, 'Word 手动保存请求')
    return officeWorkspace.saveWord({
      filePath: text(value.filePath, 'Word 文件路径', 4_000),
      source: 'editor',
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:discard-word', (payload) => {
    const value = object(payload, 'Word 放弃修改请求')
    return officeWorkspace.discardWord({
      filePath: text(value.filePath, 'Word 文件路径', 4_000),
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:get-html', (payload) => {
    const value = object(payload, 'HTML 编辑会话读取请求')
    return officeWorkspace.getHtml({ filePath: text(value.filePath, 'HTML 文件路径', 4_000) })
  })
  safeHandle(ipcMain, 'zsense:office:stage-html', (payload) => {
    const value = object(payload, 'HTML 实时修改请求')
    return officeWorkspace.stageHtml({
      filePath: text(value.filePath, 'HTML 文件路径', 4_000),
      source: htmlSource(value.source),
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:save-html', (payload) => {
    const value = object(payload, 'HTML 手动保存请求')
    return officeWorkspace.saveHtml({
      filePath: text(value.filePath, 'HTML 文件路径', 4_000),
      source: htmlSource(value.source),
      expectedRevision: integer(value.expectedRevision, 'HTML 编辑版本', 1),
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:discard-html', (payload) => {
    const value = object(payload, 'HTML 放弃修改请求')
    return officeWorkspace.discardHtml({
      filePath: text(value.filePath, 'HTML 文件路径', 4_000),
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:pick-spreadsheet-image', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要插入 Excel 的图片',
      buttonLabel: '插入图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'] }],
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
  safeHandle(ipcMain, 'zsense:office:pick-html-image', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择用于 HTML 的图片',
      buttonLabel: '替换图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }],
    })
    const filePath = result.canceled ? '' : result.filePaths[0] || ''
    if (!filePath) return null
    const stats = fs.statSync(filePath)
    if (!stats.isFile()) throw new Error('请选择图片文件。')
    if (stats.size > htmlEmbeddedImageSizeLimit) throw new Error('图片超过 4 MB。请先压缩图片，再替换到 HTML 中。')
    const mimeType = attachmentMimeType(filePath, 'image')
    return {
      name: path.basename(filePath),
      dataUrl: `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`,
    }
  })
  safeHandle(ipcMain, 'zsense:office:pick-word-image', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要插入 Word 的图片',
      buttonLabel: '插入图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'] }],
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
  safeHandle(ipcMain, 'zsense:office:save-workbook', (payload) => {
    const value = object(payload, 'Excel 手动保存请求')
    return officeWorkspace.saveWorkbook({
      filePath: text(value.filePath, 'Excel 文件路径', 4_000),
      source: 'editor',
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:discard-workbook', (payload) => {
    const value = object(payload, 'Excel 放弃修改请求')
    return officeWorkspace.discardWorkbook({
      filePath: text(value.filePath, 'Excel 文件路径', 4_000),
      sourceClientId: optionalText(value.clientId, '编辑器实例 ID', 180),
    })
  })
  safeHandle(ipcMain, 'zsense:office:replace-text', (payload) => {
    const value = object(payload, 'Office 文字替换请求')
    return officeWorkspace.replaceText({
      filePath: text(value.filePath, 'Office 文件路径', 4_000),
      find: value.find,
      replace: value.replace,
    })
  })
  safeHandle(ipcMain, 'zsense:office:set-cell', (payload) => {
    const value = object(payload, 'Excel 单元格编辑请求')
    return officeWorkspace.setCell({
      filePath: text(value.filePath, 'Excel 文件路径', 4_000),
      sheet: value.sheet,
      cell: value.cell,
      value: value.value,
    })
  })
  safeHandle(ipcMain, 'zsense:office:set-cells', (payload) => {
    const value = object(payload, 'Excel 单元格批量保存请求')
    return officeWorkspace.setCells({
      filePath: text(value.filePath, 'Excel 文件路径', 4_000),
      changes: value.changes,
    })
  })
  safeHandle(ipcMain, 'zsense:office:open-external', async (payload) => {
    const filePath = officeWorkspace.resolveExternalPath(text(payload, 'Office 文件路径', 4_000))
    const error = await shell.openPath(filePath)
    if (error) throw new Error(`无法使用系统默认应用打开：${error}`)
  })
  safeHandle(ipcMain, 'zsense:office:reveal', (payload) => {
    const filePath = officeWorkspace.resolveExternalPath(text(payload, 'Office 文件路径', 4_000))
    shell.showItemInFolder(filePath)
  })
  safeHandle(ipcMain, 'zsense:bots:create', async (payload) => {
    const workspace = database.createBot(validateBot(payload))
    await syncSkillAssignments(workspace)
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:bots:duplicate', async (payload) => {
    const value = object(payload, '复制 Bot 请求')
    const workspace = database.duplicateBot(text(value.sourceBotId, '源 Bot ID', 180), text(value.duplicateBotId, '新 Bot ID', 180))
    await syncSkillAssignments(workspace)
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:bots:update', async (payload) => {
    const nextBot = validateBot(payload)
    const currentWorkspace = database.loadWorkspace()
    const previousBot = currentWorkspace.bots.find((bot) => bot.id === nextBot.id)
    if (!previousBot) throw new Error('Bot 不存在')
    database.updateBot(nextBot)
    await gatewayService.reconcile()
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:bots:delete', async (payload) => {
    const botId = text(payload, 'Bot ID', 180)
    const previousWorkspace = database.loadWorkspace()
    const removedConnections = previousWorkspace.gatewayConnections.filter((connection) => connection.botId === botId)
    for (const connection of removedConnections) {
      const stored = database.getGatewayConnection(connection.id)
      if (!stored?.secretScope) continue
      const storedSecrets = secrets.get(stored.secretScope)
      secrets.set(stored.secretScope, {}, Object.keys(storedSecrets))
    }
    const workspace = database.deleteBot(botId)
    await Promise.allSettled(removedConnections.map((connection) => gatewayService.stopConnection(connection.id)))
    await syncSkillAssignments(workspace)
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:memories:create', async (payload) => {
    const value = object(payload, '记忆请求')
    const botId = text(value.botId, 'Bot ID', 180)
    const memory = validateMemory(value.memory)
    const bot = database.getBot(botId)
    if (!bot) throw new Error('Bot 不存在')
    return database.memoryService.createMemory(botId, memory)
  })
  safeHandle(ipcMain, 'zsense:memories:status', () => database.memoryService.inspect())
  safeHandle(ipcMain, 'zsense:memories:update', async (payload) => {
    const value = object(payload, '修改记忆请求')
    const botId = text(value.botId, 'Bot ID', 180)
    const memory = validateMemory(value.memory)
    const bot = database.getBot(botId)
    if (!bot) throw new Error('记忆空间不存在')
    if (!database.getMemory(botId, memory.id)) throw new Error('记忆不存在或不属于当前空间')
    return database.memoryService.updateMemory(botId, memory)
  })
  safeHandle(ipcMain, 'zsense:memories:delete', async (payload) => {
    const value = object(payload, '删除记忆请求')
    const botId = text(value.botId, 'Bot ID', 180)
    const memoryId = text(value.memoryId, '记忆 ID', 180)
    const memory = database.getMemory(botId, memoryId)
    if (!memory) throw new Error('记忆不存在或不属于该 Bot')
    return database.memoryService.deleteMemory(botId, memoryId)
  })
  safeHandle(ipcMain, 'zsense:gateway-connections:save', async (payload) => {
    const value = validateGatewayConnectionConfiguration(payload)
    const workspace = database.loadWorkspace()
    const bot = workspace.bots.find((item) => item.id === value.botId)
    if (!bot) throw new Error('目标 Bot 不存在')
    const existing = value.id ? database.getGatewayConnection(value.id) : null
    if (value.id && !existing) throw new Error('机器人账号不存在或已被删除')
    if (existing && (existing.botId !== value.botId || existing.provider !== value.provider)) {
      throw new Error('已保存的机器人账号不能更换渠道类型或目标 Bot；请删除后重新添加。')
    }
    const duplicate = database.findGatewayConnection(value.botId, value.provider)
    if (duplicate && duplicate.id !== existing?.id) throw new Error(`这个 Bot 已经有一个${channelFields[value.provider] ? '同类型' : ''}机器人账号。`)
    const connectionId = existing?.id || randomUUID()
    const secretScope = existing?.secretScope || `gateway:${connectionId}`
    const storedSecrets = secrets.get(secretScope)
    for (const key of value.clearSecrets) delete storedSecrets[key]
    for (const [key, secret] of Object.entries(value.secrets)) {
      if (secret) storedSecrets[key] = secret
    }
    const definition = channelFields[value.provider]
    const combined = { ...value.config, ...storedSecrets }
    const configured = definition.required.every((key) => Boolean(combined[key]))
    if (value.enabled && !configured) throw new Error('请先填写这个机器人账号的全部必填配置和凭证。')
    const profileName = existing?.profileName || `zsense-${value.botId}`
    const effectiveEnabled = value.enabled && configured
    secrets.set(secretScope, value.secrets, value.clearSecrets)
    database.upsertGatewayConnection({
      id: connectionId,
      provider: value.provider,
      name: value.name,
      botId: value.botId,
      profileName,
      configured,
      config: value.config,
      secretKeys: Object.keys(storedSecrets),
      status: effectiveEnabled ? 'connected' : configured ? 'paused' : 'setup',
      latency: effectiveEnabled ? 'ZSense 连接' : '—',
      messages: existing?.messages || 0,
      secretScope,
      updatedAt: new Date().toISOString(),
    })
    await gatewayService.stopConnection(connectionId)
    const result = await gatewayService.reconcile()
    if (effectiveEnabled && !result.ok) throw new Error(result.errors.join('\n'))
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:gateway-connections:weixin-login-start', async (payload) => {
    const value = object(payload, '微信扫码授权请求')
    const botId = text(value.botId, 'Bot ID', 180)
    const bot = database.getBot(botId)
    if (!bot) throw new Error('目标 Bot 不存在')
    return gatewayService.startWeixinQrLogin({ botId, bot })
  })
  safeHandle(ipcMain, 'zsense:gateway-connections:weixin-login-status', (payload) => (
    gatewayService.getWeixinQrLoginStatus(text(payload, '微信扫码授权 ID', 180))
  ))
  safeHandle(ipcMain, 'zsense:gateway-connections:weixin-login-cancel', (payload) => (
    gatewayService.cancelWeixinQrLogin(text(payload, '微信扫码授权 ID', 180))
  ))
  safeHandle(ipcMain, 'zsense:gateway-connections:delete', async (payload) => {
    const connectionId = text(payload, '机器人账号 ID', 180)
    const connection = database.getGatewayConnection(connectionId)
    if (!connection) throw new Error('机器人账号不存在或已被删除')
    const storedSecrets = secrets.get(connection.secretScope)
    await gatewayService.stopConnection(connectionId)
    secrets.set(connection.secretScope, {}, Object.keys(storedSecrets))
    const result = database.deleteGatewayConnection(connectionId)
    await gatewayService.reconcile()
    return result
  })
  safeHandle(ipcMain, 'zsense:gateway-connections:pairings', (payload) => {
    const connectionId = text(payload, '机器人账号 ID', 180)
    const connection = database.getGatewayConnection(connectionId)
    if (!connection) throw new Error('机器人账号不存在或已被删除')
    return gatewayService.listPendingPairings(connectionId)
  })
  safeHandle(ipcMain, 'zsense:gateway-connections:authorized-users', (payload) => {
    const connectionId = text(payload, '机器人账号 ID', 180)
    const connection = database.getGatewayConnection(connectionId)
    if (!connection) throw new Error('机器人账号不存在或已被删除')
    return gatewayService.listApprovedPairings(connectionId)
  })
  safeHandle(ipcMain, 'zsense:gateway-connections:rename-authorized-user', (payload) => {
    const value = object(payload, '重命名已授权用户请求')
    const connectionId = text(value.connectionId, '机器人账号 ID', 180)
    const userId = text(value.userId, '已授权用户 ID', 500)
    const userName = text(value.userName, '已授权用户名称', 80)
    const connection = database.getGatewayConnection(connectionId)
    if (!connection) throw new Error('机器人账号不存在或已被删除')
    return gatewayService.renameApprovedPairing(connectionId, userId, userName).users
  })
  safeHandle(ipcMain, 'zsense:gateway-connections:approve-pairing', async (payload) => {
    const value = object(payload, '授权请求')
    const connectionId = text(value.connectionId, '机器人账号 ID', 180)
    const requestId = text(value.requestId, '待授权请求 ID', 64)
    const connection = database.getGatewayConnection(connectionId)
    if (!connection) throw new Error('机器人账号不存在或已被删除')
    const result = gatewayService.approvePairing(connectionId, requestId)
    return { pairings: result.pairings, workspace: database.loadWorkspace() }
  })
  safeHandle(ipcMain, 'zsense:conversations:rename', (payload) => {
    const value = object(payload, '重命名会话请求')
    return database.renameConversation(text(value.conversationId, '会话 ID', 180), text(value.title, '会话名称', 80))
  })
  safeHandle(ipcMain, 'zsense:conversations:archive', (payload) => {
    const value = object(payload, '归档会话请求')
    return database.archiveConversation(text(value.conversationId, '会话 ID', 180), Boolean(value.archived))
  })
  safeHandle(ipcMain, 'zsense:conversations:set-workspace', (payload) => {
    const value = object(payload, '设置会话工作区请求')
    return database.setConversationWorkspace(text(value.conversationId, '会话 ID', 180), validateWorkspaceDirectory(value.workspacePath))
  })
  safeHandle(ipcMain, 'zsense:conversations:delete-message', (payload) => {
    const value = object(payload, '删除消息请求')
    return database.deleteConversationMessage(text(value.conversationId, '会话 ID', 180), text(value.messageId, '消息 ID', 180))
  })
  safeHandle(ipcMain, 'zsense:conversations:delete', (payload) => database.deleteConversation(text(payload, '会话 ID', 180)))
  safeHandle(ipcMain, 'zsense:tasks:set-overview-visibility', (payload) => {
    const value = object(payload, '总览展示设置')
    return database.setScheduledTaskOverviewVisibility(text(value.id, '定时任务 ID', 180), Boolean(value.visible))
  })
  safeHandle(ipcMain, 'zsense:conversations:move-group', (payload) => {
    const value = object(payload, '分组请求')
    return database.moveConversationToGroup(text(value.conversationId, '会话 ID', 180), optionalText(value.groupId, '分组 ID', 180))
  })
  safeHandle(ipcMain, 'zsense:conversations:reorder', (payload) => {
    const value = object(payload, '排序请求')
    return database.reorderConversations(text(value.botId, '对话空间 ID', 180), Array.isArray(value.orderedIds) ? value.orderedIds.slice(0, 500) : [])
  })
  safeHandle(ipcMain, 'zsense:conversation-groups:create', (payload) => {
    const value = object(payload, '分组请求')
    return database.createConversationGroup(text(value.botId, '对话空间 ID', 180), text(value.name, '分组名称', 40))
  })
  safeHandle(ipcMain, 'zsense:conversation-groups:rename', (payload) => {
    const value = object(payload, '分组请求')
    return database.renameConversationGroup(text(value.groupId, '分组 ID', 180), text(value.name, '分组名称', 40))
  })
  safeHandle(ipcMain, 'zsense:conversation-groups:delete', (payload) => database.deleteConversationGroup(text(payload, '分组 ID', 180)))
  safeHandle(ipcMain, 'zsense:conversation-groups:set-collapsed', (payload) => {
    const value = object(payload, '分组请求')
    return database.setConversationGroupCollapsed(text(value.groupId, '分组 ID', 180), Boolean(value.collapsed))
  })
  safeHandle(ipcMain, 'zsense:skills:create', async (payload) => {
    const workspace = database.createSkill(validateSkillEditorInput(payload))
    await syncSkillAssignments(workspace)
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:skills:update', async (payload) => {
    const value = validateSkillEditorInput(payload, true)
    const workspace = database.updateSkill(value.id, value)
    await syncSkillAssignments(workspace)
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:skills:toggle', async (payload) => {
    const value = object(payload, '技能启停请求')
    const workspace = database.setSkillEnabled(text(value.id, '技能 ID', 180), Boolean(value.enabled))
    await syncSkillAssignments(workspace)
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:skills:assign', async (payload) => {
    const value = validateSkillAssignmentInput(payload)
    const workspace = database.setSkillAssignments(value.skillId, value.botIds)
    await syncSkillAssignments(workspace)
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:skills:delete', async (payload) => {
    const skillId = text(payload, '技能 ID', 180)
    const skill = skillManager.getSkill(skillId)
    if (!skill) throw new Error('技能不存在或已经被删除。')
    database.deleteSkill(skillId)
    const workspace = database.loadWorkspace()
    await syncSkillAssignments(workspace)
    return database.loadWorkspace()
  })
  safeHandle(ipcMain, 'zsense:skills:import', async (payload) => {
    const mode = oneOf(payload, new Set(['file', 'folder']), '导入方式')
    const result = await dialog.showOpenDialog({
      title: mode === 'file' ? '选择 SKILL.md' : '选择技能文件夹',
      buttonLabel: '导入技能',
      properties: mode === 'file' ? ['openFile'] : ['openDirectory'],
      filters: mode === 'file' ? [{ name: 'ZSense Skill', extensions: ['md'] }] : undefined,
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true, workspace: database.loadWorkspace() }
    const imported = database.importSkill(result.filePaths[0])
    await syncSkillAssignments(imported.workspace)
    return { canceled: false, importedSkillName: imported.skill.name, workspace: database.loadWorkspace() }
  })
  safeHandle(ipcMain, 'zsense:skills:open-folder', async (payload) => {
    const target = skillManager.getOpenTarget(optionalText(payload, '技能 ID', 180))
    if (target.reveal) {
      shell.showItemInFolder(target.targetPath)
      return
    }
    const error = await shell.openPath(target.targetPath)
    if (error) throw new Error(`无法打开技能目录：${error}`)
  })
  safeHandle(ipcMain, 'zsense:skills:check-updates', async () => {
    const result = await skillManager.checkUpdates()
    const { results = [], summary, ...command } = result
    return { command, results, summary, workspace: database.loadWorkspace() }
  })
  safeHandle(ipcMain, 'zsense:skills:update-registry', async (payload) => {
    const skillId = optionalText(payload, '技能 ID', 180)
    const startedAt = Date.now()
    const check = await skillManager.checkUpdates(skillId)
    const targets = check.results.filter((item) => item.updateAvailable)
    const results = check.results.filter((item) => item.error).map((item) => ({ ...item }))
    for (const target of targets) {
      try {
        const updated = await skillManager.updateFromRepository(target.id)
        const installedVersion = target.latestVersion || updated.version
        results.push({ ...target, currentVersion: installedVersion, latestVersion: installedVersion, updateAvailable: false, updated: true })
      } catch (error) {
        results.push({ ...target, error: error instanceof Error ? error.message : '更新失败' })
      }
    }
    const failures = results.filter((item) => item.error)
    const updated = results.filter((item) => item.updated)
    const output = targets.length
      ? `已更新 ${updated.length} 个技能${failures.length ? `，${failures.length} 个失败` : ''}。`
      : skillId ? '这个技能已经是最新版本。' : '所有可在线检查的技能都已经是最新版本。'
    const command = { ok: failures.length === 0, output, exitCode: failures.length ? 1 : 0, durationMs: Date.now() - startedAt }
    return {
      command,
      results,
      summary: {
        ...check.summary,
        availableCount: Math.max(0, check.summary.availableCount - updated.length),
        failureCount: failures.length,
        completedAt: new Date().toISOString(),
      },
      workspace: database.loadWorkspace(),
    }
  })
  safeHandle(ipcMain, 'zsense:skills:restore-version', async (payload) => {
    const value = object(payload, '恢复技能版本请求')
    return database.restoreSkillVersion(text(value.skillId, '技能 ID', 180), text(value.versionId, '历史版本 ID', 200))
  })
  safeHandle(ipcMain, 'zsense:settings:update', async (payload) => {
    const nextSettings = validateSettings(payload)
    const wasLocked = Boolean(database.getSetting('appLockEnabled'))
    const workspace = database.updateSettings(nextSettings)
    // 关闭安全锁不再关闭远程通道，但旧安全锁密码登录的网页会话必须失效。
    if (wasLocked && !workspace.settings.appLockEnabled) webBridgeService?.revokeRemoteSessions()
    onRunWhileLockedChanged(workspace.settings.runWhileLocked)
    await gatewayService.reconcile()
    return workspace
  })
  safeHandle(ipcMain, 'zsense:configuration:export', async (_payload, event) => {
    auth.requireAdmin(event.sender.id)
    const workspace = database.loadWorkspace()
    const configuration = portableConfigurationFromWorkspace(workspace, appVersion)
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog({
      title: '导出 ZSense 跨平台配置',
      buttonLabel: '导出配置',
      defaultPath: `ZSense-配置-${stamp}.json`,
      filters: [{ name: 'ZSense 跨平台配置', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true, message: '已取消导出。' }
    fs.writeFileSync(result.filePath, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return {
      canceled: false,
      filePath: result.filePath,
      message: '配置已导出。密码、API Key、网关密钥、对话、记忆和本机路径均未写入文件。',
      counts: {
        bots: configuration.data.bots.length,
        models: configuration.data.savedModelConfigurations.length,
        skills: configuration.data.skills.length,
        scheduledTasks: configuration.data.scheduledTasks.length,
        gatewayProfiles: configuration.data.gatewayProfiles.length,
      },
    }
  })
  safeHandle(ipcMain, 'zsense:configuration:import', async (_payload, event) => {
    auth.requireAdmin(event.sender.id)
    const selected = await dialog.showOpenDialog({
      title: '导入 ZSense 跨平台配置',
      buttonLabel: '选择配置',
      properties: ['openFile'],
      filters: [{ name: 'ZSense 跨平台配置', extensions: ['json'] }],
    })
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true, message: '已取消导入。' }
    const filePath = selected.filePaths[0]
    const stats = fs.statSync(filePath)
    if (!stats.isFile() || stats.size <= 0 || stats.size > portableConfigurationMaxBytes) throw new Error('配置文件为空或超过 12 MB 限制。')
    let payload
    try { payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) }
    catch { throw new Error('配置文件不是有效的 JSON。') }
    if (payload?.format !== portableConfigurationFormat || Number(payload?.schemaVersion) !== portableConfigurationSchemaVersion) throw new Error('这不是受支持的 ZSense 跨平台配置文件。')
    const confirmation = await dialog.showMessageBox({
      type: 'question',
      title: '导入 ZSense 配置',
      message: '将配置合并到当前工作台？',
      detail: '同 ID 项目会更新，新项目会新增。不会删除现有内容；任务和消息网关会保持暂停，密码与密钥不会导入。',
      buttons: ['取消', '合并导入'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    })
    if (confirmation.response !== 1) return { canceled: true, message: '已取消导入。' }
    const imported = await importPortableConfiguration({ payload, database, skillManager })
    onRunWhileLockedChanged(imported.workspace.settings.runWhileLocked)
    await gatewayService.reconcile()
    onWorkspaceChanged(imported.workspace)
    return {
      canceled: false,
      filePath,
      message: '配置已安全合并；请在此设备重新填写模型与消息网关密钥，再手动启用任务和网关。',
      counts: imported.counts,
      workspace: imported.workspace,
    }
  })
  safeHandle(ipcMain, 'zsense:capabilities:status', () => capabilityService.inspect({ computerUseEnabled: database.loadSettings().computerUseEnabled === true }))
  safeHandle(ipcMain, 'zsense:computer-use:status', () => computerUseService.inspect(database.loadSettings().computerUseEnabled === true))
  safeHandle(ipcMain, 'zsense:computer-use:request-permissions', () => computerUseService.requestPermissions(database.loadSettings().computerUseEnabled === true))
  safeHandle(ipcMain, 'zsense:capabilities:autonomy', () => capabilityService.autonomySnapshot())
  safeHandle(ipcMain, 'zsense:capabilities:approval-revoke', (payload) => capabilityService.revokeApproval(text(payload, '授权 ID', 180)))
  safeHandle(ipcMain, 'zsense:capabilities:autonomy-manage', (payload) => {
    const value = object(payload, '自治任务操作')
    return capabilityService.manageAutonomy(
      oneOf(value.kind, new Set(['goal', 'loop', 'heartbeat']), '自治任务类型'),
      text(value.id, '自治任务 ID', 180),
      oneOf(value.action, new Set(['pause', 'resume', 'run', 'remove']), '自治任务操作'),
    )
  })
  safeHandle(ipcMain, 'zsense:mcp:list', () => mcpService.list())
  safeHandle(ipcMain, 'zsense:mcp:configure', (payload) => {
    const value = object(payload, 'MCP 服务器配置')
    return mcpService.configure({
      id: text(value.id || value.name, 'MCP 服务器 ID', 80),
      name: text(value.name || value.id, 'MCP 服务器名称', 120),
      transport: oneOf(value.transport || 'http', new Set(['stdio', 'http']), 'MCP 传输方式'),
      command: optionalText(value.command, 'MCP 启动命令', 2_000),
      args: Array.isArray(value.args) ? value.args.slice(0, 40).map((item) => text(item, 'MCP 命令参数', 1_000)) : [],
      url: optionalText(value.url, 'MCP HTTP 地址', 2_000),
      enabled: value.enabled !== false,
      oauthToken: optionalText(value.oauthToken, 'MCP OAuth Token', 16_000),
      clearOAuthToken: Boolean(value.clearOAuthToken),
    })
  })
  safeHandle(ipcMain, 'zsense:mcp:delete', (payload) => mcpService.remove(text(payload, 'MCP 服务器 ID', 80)))
  safeHandle(ipcMain, 'zsense:mcp:test', async (payload) => {
    const id = text(payload, 'MCP 服务器 ID', 80)
    const tools = await mcpService.listTools(id, true)
    return { id, connected: true, toolCount: tools.length, tools: tools.slice(0, 30) }
  })
  safeHandle(ipcMain, 'zsense:canvas:load', (payload) => canvasService.load(validateWorkspaceDirectory(payload, '画布工作区')))
  safeHandle(ipcMain, 'zsense:canvas:save', (payload) => {
    const value = object(payload, '画布保存请求')
    return canvasService.save(validateWorkspaceDirectory(value.workspacePath, '画布工作区'), object(value.document, '画布文档'), { sourceClientId: optionalText(value.clientId, '画布客户端 ID', 180) })
  })
  safeHandle(ipcMain, 'zsense:canvas:import-file', (payload) => {
    const value = object(payload, '画布文件导入请求')
    return canvasService.importFile(validateWorkspaceDirectory(value.workspacePath, '画布工作区'), text(value.filePath, '画布文件路径', 4_000), {
      sourceClientId: optionalText(value.clientId, '画布客户端 ID', 180),
      document: value.document && typeof value.document === 'object' ? value.document : null,
      conversationId: optionalText(value.conversationId, '画布会话 ID', 240),
    })
  })
function withScheduledTaskOwner(task, payload) {
  const owner = String((payload && typeof payload === 'object' && payload.ownerBotId) || task.ownerBotId || '').trim().slice(0, 180)
  return { ...task, ownerBotId: owner }
}

  safeHandle(ipcMain, 'zsense:tasks:create', (payload) => scheduledTaskRunner.create(withScheduledTaskOwner(scheduledTaskWithReferences(payload), payload)))
  safeHandle(ipcMain, 'zsense:tasks:update', (payload) => {
    const value = object(payload, '修改定时任务请求')
    return scheduledTaskRunner.update(text(value.id, '任务 ID', 180), withScheduledTaskOwner(scheduledTaskWithReferences(value.task), value.task))
  })
  safeHandle(ipcMain, 'zsense:tasks:toggle', (payload) => {
    const value = object(payload, '定时任务启停请求')
    return scheduledTaskRunner.toggle(text(value.id, '任务 ID', 180), Boolean(value.enabled))
  })
  safeHandle(ipcMain, 'zsense:tasks:delete', (payload) => scheduledTaskRunner.delete(text(payload, '任务 ID', 180)))
  safeHandle(ipcMain, 'zsense:tasks:delete-run', (payload) => scheduledTaskRunner.deleteRun(text(payload, '运行记录 ID', 180)))
  safeHandle(ipcMain, 'zsense:tasks:run-now', (payload) => scheduledTaskRunner.runNow(text(payload, '任务 ID', 180)))
  safeHandle(ipcMain, 'zsense:tasks:pick-workspace', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择定时任务工作区',
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return ''
    return validateWorkspaceDirectory(result.filePaths[0], '任务工作区')
  })
  safeHandle(ipcMain, 'zsense:tasks:open-workspace', async (payload) => {
    const workspacePath = scheduledTaskRunner.openWorkspace(text(payload, '任务 ID', 180))
    const error = await shell.openPath(workspacePath)
    if (error) throw new Error(`无法打开任务工作区：${error}`)
  })
  safeHandle(ipcMain, 'zsense:notifications:test', (payload) => {
    const kind = oneOf(payload, new Set(['approval', 'completion']), '通知类型')
    return notify(kind, kind === 'approval' ? 'ZSense 审批通知测试' : 'ZSense 完成通知测试', kind === 'approval' ? '这里会显示新的待处理审批或澄清。' : 'AI 回复或定时任务完成时会这样通知你。', { forceDesktop: true, forceSound: true })
  })
  safeHandle(ipcMain, 'zsense:voice-wake:status', () => ({
    ...voiceService.getWakeStatus(),
    permission: microphoneAccessStatus(),
  }))
  safeHandle(ipcMain, 'zsense:voice-wake:request-permission', async () => ({
    permission: await requestMicrophoneAccess(),
  }))
  safeHandle(ipcMain, 'zsense:voice-wake:detected-client', (payload) => onVoiceWakeDetected(object(payload || {}, '语音唤醒事件')))
  safeHandle(ipcMain, 'zsense:voice-wake:start', async (payload) => {
    const value = object(payload || {}, '语音唤醒配置')
    const status = voiceService.startWake({
      phrase: text(value.phrase || database.loadSettings().voiceWakePhrase || '你好 ZSense', '语音唤醒词', 32),
      sensitivity: number(value.sensitivity, '语音唤醒灵敏度', 0.2, 0.9),
      confirmationFrames: integer(value.confirmationFrames, '语音唤醒确认帧数', 1, 8),
    })
    return { ...status, permission: microphoneAccessStatus() }
  })
  safeHandle(ipcMain, 'zsense:voice-wake:feed', (payload) => {
    const value = object(payload, '语音唤醒音频帧')
    const pcm = text(value.pcm, '语音唤醒音频帧', 180_000)
    return voiceService.feedWake(pcm)
  })
  safeHandle(ipcMain, 'zsense:voice-wake:stop', async () => ({
    ...voiceService.stopWake(),
    permission: microphoneAccessStatus(),
  }))
  safeHandle(ipcMain, 'zsense:voice:transcribe-local', async (payload) => {
    const value = object(payload, '本地语音转写请求')
    return voiceService.transcribe({
      pcmBase64: text(value.pcmBase64, '本地 PCM 音频', 2_000_000),
      sampleRate: integer(value.sampleRate || 16_000, '本地录音采样率', 8_000, 48_000),
      language: oneOf(value.language || 'zh-CN', new Set(['zh-CN']), '本地转写语言'),
      mode: oneOf(value.mode || 'conversation', new Set(['conversation', 'wake', 'enrollment']), '本地转写模式'),
    })
  })
  safeHandle(ipcMain, 'zsense:voice:list-voices', () => voiceService.listVoices())
  safeHandle(ipcMain, 'zsense:voice:tts-config', () => {
    const status = voiceService.inspectBundledTts()
    if (!status.ready) throw new Error(`MOSS-TTS-Nano 模型不完整：${status.missing.slice(0, 4).join('、')}${status.missing.length > 4 ? `等 ${status.missing.length} 个文件` : ''}。`)
    return {
      engine: 'moss-tts-nano',
      modelUrl: 'zsense-tts://models/',
      threadCount: Math.max(1, Math.min(4, Number(process.env.ZSENSE_TTS_THREADS) || 4)),
      streaming: true,
      offline: true,
    }
  })
  safeHandle(ipcMain, 'zsense:voice:stop-speaking', () => voiceService.stopSpeaking())
  safeHandle(ipcMain, 'zsense:models:list', async (payload) => {
    const value = validateModelCatalogRequest(payload)
    const workspace = database.loadWorkspace()
    const providerConfiguration = workspace.savedModelConfigurations.find((item) => item.provider === value.provider)
    const scopedSecret = secrets.get(`model:${value.provider}`)
    const legacySecret = workspace.modelConfiguration.provider === value.provider ? secrets.get('model:default') : {}
    const currentSecret = scopedSecret.apiKey ? scopedSecret : legacySecret
    const currentKeyName = currentSecret.apiKeyName || providerConfiguration?.apiKeyName || value.apiKeyName
    const savedApiKey = currentKeyName === value.apiKeyName ? currentSecret.apiKey || '' : ''
    if (value.provider !== 'custom' && !value.apiKey && !savedApiKey) throw new Error('请先填写或保存 API Key，再同步该供应商的官网模型列表。')
    const catalog = await fetchOfficialModelCatalog({ ...value, apiKey: value.apiKey || savedApiKey })
    database.syncModelCatalog(catalog, {
      baseUrl: value.baseUrl || providerConfiguration?.baseUrl || '',
      apiKeyName: value.apiKeyName,
      apiKeyConfigured: Boolean(savedApiKey),
    })
    return catalog
  })
  safeHandle(ipcMain, 'zsense:models:update', async (payload) => {
    const value = validateModelConfiguration(payload)
    const workspace = database.loadWorkspace()
    const scope = `model:${value.provider}`
    const scopedSecret = secrets.get(scope)
    const legacySecret = workspace.modelConfiguration.provider === value.provider ? secrets.get('model:default') : {}
    const currentSecret = scopedSecret.apiKey ? scopedSecret : legacySecret
    const currentKeyName = currentSecret.apiKeyName || value.apiKeyName
    const effectiveApiKey = value.clearApiKey ? '' : value.apiKey || (currentKeyName === value.apiKeyName ? currentSecret.apiKey : '') || ''
    const clearApiKeyNames = currentKeyName && currentKeyName !== value.apiKeyName ? [currentKeyName] : []
    if (!value.clearApiKey && !['nous', 'custom'].includes(value.provider) && !effectiveApiKey) throw new Error('请填写所选模型供应商的 API Key。')
    const clearStoredModelKey = value.clearApiKey || (currentKeyName !== value.apiKeyName && !value.apiKey)
    const stored = secrets.set(scope, { apiKey: value.apiKey, apiKeyName: value.apiKeyName }, clearStoredModelKey ? ['apiKey'] : [])
    secrets.set('model:default', { apiKey: stored.apiKey || '', apiKeyName: value.apiKeyName }, ['apiKey'])
    return database.updateModelConfiguration({
      provider: value.provider,
      model: value.model,
      baseUrl: value.baseUrl,
      apiKeyName: value.apiKeyName,
      apiKeyConfigured: Boolean(stored.apiKey && stored.apiKeyName === value.apiKeyName),
      updatedAt: new Date().toISOString(),
    })
  })
  safeHandle(ipcMain, 'zsense:runtime:inspect', () => inspectApplicationRuntime())
  const coreCommand = async (output) => ({ ok: true, output, exitCode: 0, durationMs: 0, status: await inspectApplicationRuntime() })
  safeHandle(ipcMain, 'zsense:runtime:doctor', async () => {
    const gateway = await gatewayService.healthCheck()
    return coreCommand(gateway.ok ? 'ZSense Agent Core、消息网关和本地数据目录检查通过。' : `消息网关存在异常：\n${gateway.errors.join('\n')}`)
  })
  safeHandle(ipcMain, 'zsense:chat:pick-attachments', async () => {
    const result = await dialog.showOpenDialog({
      title: '添加到对话',
      buttonLabel: '添加附件',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []
    if (result.filePaths.length > attachmentLimit) throw new Error(`每次最多添加 ${attachmentLimit} 个附件。`)
    const attachments = result.filePaths.map((filePath) => attachmentFromPath(filePath))
    return attachments
  })
  safeHandle(ipcMain, 'zsense:chat:resolve-dropped-attachments', (payload) => {
    if (!Array.isArray(payload) || !payload.length) return []
    if (payload.length > attachmentLimit) throw new Error(`每次最多添加 ${attachmentLimit} 个附件。`)
    const attachments = payload.map((filePath) => attachmentFromPath(text(filePath, '拖入文件路径', 4_000)))
    return attachments
  })
  safeHandle(ipcMain, 'zsense:chat:resolve-pasted-attachments', (payload) => {
    const value = object(payload, '粘贴图片请求')
    const workspacePath = validateWorkspaceDirectory(value.workspacePath)
    if (!Array.isArray(value.files) || !value.files.length) return []
    if (value.files.length > attachmentLimit) throw new Error(`每次最多添加 ${attachmentLimit} 个附件。`)
    const images = value.files.map((item) => {
      const image = object(item, '剪贴板图片')
      const bytes = binary(image.bytes, '剪贴板图片内容')
      if (!bytes.length) throw new Error('剪贴板图片内容为空。')
      return {
        name: optionalText(image.name, '剪贴板图片名称', 240),
        mimeType: text(image.mimeType, '剪贴板图片格式', 100),
        bytes,
      }
    })
    return stagePastedImageAttachments(images, workspacePath).map((filePath) => attachmentFromPath(filePath))
  })
  safeHandle(ipcMain, 'zsense:chat:pick-workspace', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择会话工作区',
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return ''
    return validateWorkspaceDirectory(result.filePaths[0])
  })
  safeHandle(ipcMain, 'zsense:chat:list-workspace-directories', (payload) => {
    const requestedPath = optionalText(payload, '文件夹路径', 4_000)
    const defaultPath = database.loadSettings().defaultWorkspacePath || ''
    return listWorkspaceDirectories(requestedPath, defaultPath)
  })
  safeHandle(ipcMain, 'zsense:chat:send', async (payload, event) => {
    const value = object(payload, '对话请求')
    const requestId = text(value.requestId, '流式请求 ID', 180)
    const browserSessionId = optionalText(value.browserSessionId, '浏览器会话 ID', 180)
    const native = Boolean(value.native)
    // 会话归属的 Bot（native 表示 AI 对话空间）
    const botId = native ? NATIVE_BOT_ID : text(value.botId, 'Bot ID', 180)
    // 「/bot <名字> <指令>」：执行者是另一个 Bot，但会话与回复都留在当前对话里
    const delegateBotId = optionalText(value.delegateBotId, '被委派的 Bot ID', 180)
    const message = text(value.message, '消息', 8_000)
    const selectedAttachments = validateChatAttachments(value.attachments)
    const requestedModel = optionalText(value.model, '模型 ID', 300)
    const requestedModelProvider = optionalText(value.modelProvider, '模型供应商', 80)
    if (Boolean(requestedModel) !== Boolean(requestedModelProvider)) throw new Error('快速切换模型时必须同时提供模型供应商和模型 ID。')
    const reasoningEffort = oneOf(value.reasoningEffort || 'high', reasoningEfforts, '推理强度')
    const interactionMode = oneOf(value.interactionMode || 'text', interactionModes, '交互模式')
    const workspace = database.loadWorkspace()
    const bot = delegateBotId
      ? database.getBot(delegateBotId)
      : native ? nativeWorkspaceIdentity(workspace) : database.getBot(botId)
    if (!bot) throw new Error(delegateBotId ? '被委派的 Bot 不存在。' : 'Bot 不存在')
    const agentStatus = await agentCore.inspect()
    if (!agentStatus.runnable) throw new Error(agentStatus.message)
    const requestedConversationId = optionalText(value.conversationId, '会话 ID', 180)
    // 委派执行时不去按执行者过滤会话：指令就是要在当前对话里发出
    let conversation = requestedConversationId ? database.getConversation(requestedConversationId, delegateBotId ? '' : botId) : null
    if (requestedConversationId && !conversation) throw new Error(native ? 'AI 会话不存在。' : '会话不存在，或不属于当前 Bot。')
    if (delegateBotId && conversation && conversation.botId !== botId) throw new Error('会话不存在，或不属于当前对话。')
    const workspacePath = value.workspacePath
      ? validateWorkspaceDirectory(value.workspacePath)
      : conversation?.workspacePath
        ? validateWorkspaceDirectory(conversation.workspacePath)
        : workspace.settings.defaultWorkspacePath
          ? validateWorkspaceDirectory(workspace.settings.defaultWorkspacePath, '默认全局工作区')
          : ''
    if (!workspacePath) throw new Error('请先为这个对话选择工作区文件夹。')

    let modelConfiguration
    if (requestedModel && requestedModelProvider) {
      const provider = oneOf(requestedModelProvider, modelProviders, '模型供应商')
      modelConfiguration = workspace.availableModelConfigurations.find((item) => item.provider === provider && item.model === requestedModel)
      if (!modelConfiguration && workspace.modelConfiguration.provider === provider && workspace.modelConfiguration.model === requestedModel) modelConfiguration = workspace.modelConfiguration
      if (!modelConfiguration) throw new Error('这个模型不在“设置 → AI 模型”的已保存或官网同步列表中，请先刷新模型列表。')
    } else if (delegateBotId && (bot.model || bot.modelProvider)) {
      // 委派执行用被委派 Bot 自己的模型：它才是这次任务的执行者
      modelConfiguration = modelConfigurationForBot(workspace, bot)
    } else if (conversation?.model && conversation.modelProvider) {
      modelConfiguration = workspace.availableModelConfigurations.find((item) => item.provider === conversation.modelProvider && item.model === conversation.model)
      if (!modelConfiguration && workspace.modelConfiguration.provider === conversation.modelProvider && workspace.modelConfiguration.model === conversation.model) modelConfiguration = workspace.modelConfiguration
      if (!modelConfiguration) throw new Error('当前会话使用的模型已不在可用列表中，请重新选择模型。')
    } else {
      modelConfiguration = modelConfigurationForBot(workspace, bot)
    }

    const selectedModel = modelConfiguration?.model || ''
    const selectedModelProvider = selectedModel ? modelConfiguration.provider : ''
    if (!selectedModel || !selectedModelProvider) throw new Error('请先在“设置 → AI 模型”中配置默认模型。')
    const modelSecret = modelSecretFor(modelConfiguration, workspace)
    if (!agentCore.supportsProvider(selectedModelProvider)) throw new Error(`ZSense Agent Core 暂不支持 ${selectedModelProvider}。`)
    const runtimeEngine = 'zsense-core'
    if (agentCore.requiresApiKey(selectedModelProvider) && !modelSecret.apiKey) throw new Error('当前模型的 API Key 尚未配置，请前往“设置 → AI 模型”保存。')

    const attachments = stageChatAttachments(selectedAttachments, workspacePath)
    const conversationId = requestedConversationId || (native
      ? database.createNativeConversation(message, { runtimeEngine, modelProvider: selectedModelProvider, model: selectedModel, reasoningEffort, workspacePath })
      : database.createConversation(botId, message, { runtimeEngine, modelProvider: selectedModelProvider, model: selectedModel, reasoningEffort, workspacePath }))
    if (browserSessionId) browserService.linkSession(conversationId, browserSessionId)
    // 委派执行不改当前会话的模型设置（模型只属于这次执行）
    if (!delegateBotId) database.updateConversationOptions(conversationId, botId, { modelProvider: selectedModelProvider, model: selectedModel, reasoningEffort, workspacePath })
    conversation = database.getConversation(conversationId, botId)
    if (!conversation) throw new Error(native ? 'AI 会话创建失败。' : '会话创建失败。')
    const redactEnabled = workspace.settings.sensitiveDataRedaction
    const safeText = (content) => redactEnabled ? redactSensitiveText(content) : content
    const safeAgentSteps = (steps) => Array.isArray(steps) ? steps.map((step) => ({
      ...step,
      reasoning: safeText(String(step?.reasoning || '')),
      content: safeText(String(step?.content || '')),
      error: safeText(String(step?.error || '')),
      tools: Array.isArray(step?.tools) ? step.tools.map((tool) => ({
        ...tool,
        detail: safeText(String(tool?.detail || '')),
        input: safeText(String(tool?.input || '')),
        output: safeText(String(tool?.output || '')),
      })) : [],
    })) : []
    const legacyMessages = conversation.messages
    database.addMessage(conversationId, 'user', safeText(message), { attachments })
    const workItem = officeTaskService?.create({
      botId, conversationId, sourceChannel: 'web', sourceMessageId: requestId,
      title: message, request: safeText(message),
      evidence: attachments.map((item) => ({ type: 'file', label: item.name, path: item.path, sourceId: requestId })),
    })
    if (workItem) officeTaskService.addSearchDocument({ botId, taskId: workItem.id, sourceType: 'message', sourceId: requestId, title: message, body: safeText(message) })
    if (workItem) void Promise.allSettled(attachments.map((item) => officeTaskService.indexFile({
      botId, taskId: workItem.id, filePath: item.path, workspacePath, title: item.name,
    }))).then(() => officeTaskService.notify())
    onWorkspaceChanged(database.loadWorkspace())
    const recalledMemories = (await database.memoryService.recallMemories(bot.id, safeText(message), {
      limit: workspace.settings.memoryRecallLimit,
      characterBudget: Math.max(2_000, Math.min(5_000, Number(workspace.settings.memoryRecallLimit || 24) * 200)),
    })).memories
    const responseStartedAt = Date.now()
    const toolEvents = []
    const steeringMessages = []
    const persistedSteeringIds = new Set()
    let approvalNotified = false
    const sendEvent = (streamEvent) => {
      const cleaned = { ...streamEvent, conversationId }
      for (const key of ['delta', 'message', 'detail', 'input', 'output', 'content', 'reasoning', 'error']) {
        if (typeof cleaned[key] === 'string') cleaned[key] = safeText(cleaned[key])
      }
      if (Array.isArray(cleaned.agentSteps)) cleaned.agentSteps = safeAgentSteps(cleaned.agentSteps)
      if (Array.isArray(cleaned.tools)) cleaned.tools = safeAgentSteps([{ tools: cleaned.tools }])[0].tools
      const feedbackText = [cleaned.message, cleaned.detail, cleaned.error].filter(Boolean).join(' ')
      if (!approvalNotified && /(?:等待|需要|请求|pending).{0,40}(?:审批|批准|授权|许可|确认|澄清|approval|approve|permission|confirmation)/i.test(feedbackText)) {
        approvalNotified = true
        notify('approval', 'ZSense 有待处理操作', '有一项操作正在等待你的确认，请返回 ZSense 处理。')
      }
      if (!event.sender.isDestroyed()) event.sender.send('zsense:chat:event', cloneForRenderer(cleaned))
      return cleaned
    }
    const onStreamEvent = (streamEvent) => {
      const cleaned = sendEvent(streamEvent)
      if (cleaned.type === 'started' && cleaned.sessionId) database.setConversationRuntimeSession(conversationId, runtimeEngine, cleaned.sessionId)
      if (cleaned.type === 'steering' && cleaned.phase === 'queued' && cleaned.source !== 'agent' && !persistedSteeringIds.has(cleaned.steeringId)) {
        persistedSteeringIds.add(cleaned.steeringId)
        steeringMessages.push(cleaned.content)
        database.addMessage(conversationId, 'user', safeText(cleaned.content), { createdAt: cleaned.receivedAt, attachments: cleaned.attachments || [] })
        // 运行中的对话由 steering 事件和 chat-run-store 即时更新；完整工作区会在本轮结束时发布。
        // 这里重载所有历史消息会阻塞主进程，并让追加输入出现明显卡顿。
      }
      if (cleaned.type === 'tool') {
        if (workItem) officeTaskService.recordTool(workItem.id, cleaned)
        const current = toolEvents.find((item) => item.toolId === cleaned.toolId)
        if (current) Object.assign(current, cleaned)
        else toolEvents.push({ ...cleaned })
      }
    }
    onStreamEvent({ type: 'conversation-ready' })
    try {
      let result
      const assignedSkills = workspace.skills.filter((skill) => native && !delegateBotId ? skill.assignedBotIds.length > 0 : skill.assignedBotIds.includes(bot.id))
      result = await agentCore.chatStream({
          requestId,
          bot,
          message,
          model: selectedModel,
          modelProvider: selectedModelProvider,
          contextWindow: modelConfiguration.contextWindow || 0,
          apiKey: modelSecret.apiKey || '',
          baseUrl: modelConfiguration.baseUrl || '',
          reasoningEffort,
          interactionMode,
          workspacePath,
          attachments,
          runtimeSessionId: conversation.runtimeEngine === 'zsense-core' ? conversation.runtimeSessionId : '',
          legacyMessages,
          skills: assignedSkills,
          memories: recalledMemories,
          settings: workspace.settings,
          appContext: {
            currentBot: { id: bot.id, name: bot.name, status: bot.status, modelProvider: selectedModelProvider, model: selectedModel },
            gatewayConnections: native ? [] : workspace.gatewayConnections
              .filter((item) => item.botId === bot.id)
              .map((item) => ({ id: item.id, name: item.name, provider: item.provider, status: item.status, configured: item.configured })),
            currentConversation: { id: conversationId, botId, kind: native ? 'native' : 'bot', workspacePath, modelProvider: selectedModelProvider, model: selectedModel },
            deviceLink: currentDeviceLinkSnapshot(deviceLinkService),
            isolation: native
              ? 'AI 对话不注入任何业务 Bot 的私有内容或状态（记忆、会话正文），但拥有管理 Bot 本身的权限：可以列示、创建、改名、改角色、改提示词、改模型（bot_manage）。单个 Bot 空间仍然隔离。'
              : '当前上下文只属于本 Bot；不得查询、推断、转换或披露其他 Bot 的内容、状态、记忆、会话或网关。',
          },
          onEvent: onStreamEvent,
        })
      database.setConversationRuntimeSession(conversationId, runtimeEngine, result.sessionId)
      if (result.usage) database.updateConversationOptions(conversationId, botId, { usage: result.usage })
      const response = safeText(result.output)
      const responseReasoning = safeText(result.reasoning || '')
      const responseAgentSteps = safeAgentSteps(result.agentSteps)
      const durationMs = Number.isFinite(result.durationMs) ? Math.max(0, Math.round(result.durationMs)) : Date.now() - responseStartedAt
      const officeArtifacts = officeWorkspace.discoverArtifacts({
        workspacePath,
        content: response,
        toolEvents,
        since: responseStartedAt,
      })
      if (workItem) {
        const verifiedArtifacts = officeArtifacts.map((artifact) => {
          try {
            const contents = fs.readFileSync(artifact.path)
            return { name: artifact.name, path: artifact.path, verified: true, size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') }
          } catch (error) {
            return { name: artifact.name, path: artifact.path, verified: false, error: error instanceof Error ? error.message : String(error) }
          }
        })
        officeTaskService.advance(workItem.id, 'verify', verifiedArtifacts.some((item) => !item.verified) ? 'failed' : 'completed')
        officeTaskService.patch(workItem.id, {
          status: verifiedArtifacts.some((item) => !item.verified) ? 'failed' : 'completed',
          output: response, artifacts: verifiedArtifacts,
          errorCode: verifiedArtifacts.some((item) => !item.verified) ? 'artifact_verification' : '',
          error: verifiedArtifacts.some((item) => !item.verified) ? '生成文件无法重新读取，请核查磁盘文件。' : '',
          steps: officeTaskService.get(workItem.id).steps.map((step) => step.id === 'deliver' ? { ...step, status: verifiedArtifacts.some((item) => !item.verified) ? 'pending' : 'completed' } : step),
        })
        for (const artifact of verifiedArtifacts.filter((item) => item.verified)) void officeTaskService.indexFile({ botId, taskId: workItem.id, filePath: artifact.path, workspacePath, title: artifact.name }).catch(() => undefined)
        officeTaskService.addSearchDocument({ botId, taskId: workItem.id, sourceType: 'answer', sourceId: requestId, title: message, body: response })
      }
      let memoryConversationId = delegateBotId ? '' : conversationId
      if (delegateBotId && bot.id !== botId) {
        // 「/bot 名字 指令」：在目标 Bot 自己的会话列表里也留一份记录
        try {
          memoryConversationId = database.mirrorDelegatedExchange({
            targetBotId: bot.id,
            instruction: message,
            reply: response,
            modelProvider: selectedModelProvider,
            model: selectedModel,
            sourceTitle: conversation.title || '',
          }) || ''
        } catch (mirrorError) {
          console.error('同步委派指令到目标 Bot 会话失败：', mirrorError instanceof Error ? mirrorError.message : mirrorError)
        }
      }
      database.addMessage(conversationId, 'assistant', response, {
        reasoning: responseReasoning,
        agentSteps: responseAgentSteps,
        toolEvents,
        attachments: officeArtifacts,
        modelProvider: selectedModelProvider,
        model: selectedModel,
        durationMs,
        outputTokens: result.usage?.outputTokens,
      })
      if (native) database.completeNativeConversation(conversationId)
      else database.completeConversation(botId, conversationId, toolEvents)
      database.recordSkillUsage({ botId: bot.id, conversationId, toolEvents, durationMs })
      // ③ 技能沉淀闭环：本轮真跑过工具、且流程看起来可复用时，沉淀成一个新技能（不覆盖已有技能）
      if (workspace.settings.autoExtractMemory && Array.isArray(toolEvents) && toolEvents.length >= 4) {
        try {
          const existingSkillNames = new Set((workspace.skills || []).map((skill) => skill.name))
          const proposal = await agentCore.distillSkill({
            message: safeText(message),
            toolSummary: toolEvents.slice(-24).map((event) => `${event?.name || event?.type || '工具'} ${String(JSON.stringify(event?.args ?? {})).slice(0, 160)}`),
            existingSkills: (workspace.skills || []).map((skill) => ({ name: skill.name, description: skill.description })),
            model: selectedModel,
            modelProvider: selectedModelProvider,
            apiKey: (secrets.get(`model:${selectedModelProvider}`)?.apiKey || secrets.get('model:default')?.apiKey || ''),
            baseUrl: modelConfiguration.baseUrl || '',
          })
          if (proposal && !existingSkillNames.has(proposal.name)) {
            skillManager.createSkill({ name: proposal.name, description: proposal.description, content: proposal.content })
            console.log('[ZSense] 已自动沉淀技能：', proposal.name)
          }
        } catch (distillError) {
          console.warn('ZSense Core 技能沉淀失败：', distillError instanceof Error ? distillError.message : distillError)
        }
      }
      if (workspace.settings.autoExtractMemory) {
        // 应用内置的轻量记忆流程在本机后台整理明确的长期事实，不阻塞回复。
        const memorySourceMessage = [safeText(message), ...steeringMessages.map((item) => safeText(item))].filter(Boolean).join('\n\n')
        setImmediate(() => {
          void enqueueMemoryMaintenance(bot.id, async () => {
            if (database.getSetting('autoExtractMemory') === false) return
            if (shouldExtractMemory(memorySourceMessage)) {
              try {
                const result = await database.memoryService.retainUserMessage(bot.id, memorySourceMessage, {
                  conversationId: memoryConversationId, messageId: requestId,
                })
                if (result.stored) onWorkspaceChanged(database.loadWorkspace())
              } catch (memoryError) {
                console.warn('本地自动记忆失败：', memoryError instanceof Error ? memoryError.message : memoryError)
              }
            }
          }).catch((memoryError) => {
            console.warn('ZSense Core 后台记忆维护失败：', memoryError instanceof Error ? memoryError.message : memoryError)
          })
        })
      }
      const nextWorkspace = database.loadWorkspace()
      // A Web Bridge invocation updates the same database as the desktop renderer,
      // but its chat events are delivered only to the remote sender. Publish the
      // completed snapshot so an already-open desktop conversation sees the reply.
      onWorkspaceChanged(nextWorkspace)
      notify('completion', native ? 'ZSense AI 已完成回复' : `${bot.name} 已完成回复`, '回复已生成，可返回 ZSense 查看。')
      return { conversationId, message: response, attachments: officeArtifacts, modelProvider: selectedModelProvider, model: selectedModel, durationMs, agentSteps: responseAgentSteps, usage: result.usage, workspace: nextWorkspace }
    } catch (error) {
      if (workItem) officeTaskService.fail(workItem.id, error)
      const errorText = safeText(error instanceof Error ? error.message : 'ZSense 对话失败')
      database.addMessage(conversationId, 'system', errorText)
      onWorkspaceChanged(database.loadWorkspace())
      sendEvent({ requestId, type: 'error', message: errorText })
      throw new Error(errorText)
    }
  })
  safeHandle(ipcMain, 'zsense:chat:cancel', (payload) => {
    const requestId = text(payload, '流式请求 ID', 180)
    return agentCore.cancelChat(requestId)
  })
  safeHandle(ipcMain, 'zsense:chat:steer', (payload) => {
    const value = object(payload, '追加指令')
    const selectedAttachments = validateChatAttachments(value.attachments)
    const attachments = selectedAttachments.length
      ? stageChatAttachments(selectedAttachments, validateWorkspaceDirectory(value.workspacePath))
      : []
    return agentCore.steerChat(
      text(value.requestId, '流式请求 ID', 180),
      text(value.message, '追加指令内容', 8_000),
      { attachments, intent: 'adjust' },
    )
  })
  safeHandle(ipcMain, 'zsense:chat:clarify', (payload) => {
    const value = object(payload, '澄清回答')
    const requestId = text(value.requestId, '流式请求 ID', 180)
    const clarificationRequestId = text(value.clarificationRequestId, '澄清请求 ID', 180)
    if (!Array.isArray(value.answers) || value.answers.length > 20) throw new Error('澄清回答格式无效。')
    const answers = value.answers.map((item) => {
      const answer = object(item, '澄清回答项')
      return {
        ...(answer.questionId ? { questionId: text(answer.questionId, '问题 ID', 180) } : {}),
        answer: text(answer.answer, '澄清回答内容', 8_000),
      }
    })
    return agentCore.respondToClarification(requestId, clarificationRequestId, answers)
  })
  safeHandle(ipcMain, 'zsense:chat:delete-native', (payload) => database.deleteConversation(text(payload, '会话 ID', 180), { nativeOnly: true }))
}
