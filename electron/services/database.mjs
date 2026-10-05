import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { findSimilarMemory, isAutomaticMemory, scoreMemoryForQuery, selectRelevantMemories, unsafeAutomaticMemory } from './memory-intelligence.mjs'
import { inferredContextWindow, resolvedContextWindow } from './model-metadata.mjs'

const defaultBots = [
  {
    id: 'atlas', name: 'Atlas', initials: 'AT', role: '个人知识管家',
    description: '整理你的知识、偏好与日常决策，在需要时给出有上下文的建议。',
    status: 'online', color: '#8b5cf6', modelProvider: '', model: '', memoryCount: 3,
    memorySize: '1.4 KB', channels: ['web', 'telegram'], lastActive: '刚刚',
    conversations: 0, successRate: 100,
    prompt: '你是 Atlas，一位冷静、可靠的个人知识管家。优先引用用户已经确认的事实，并清楚区分事实、推断与建议。',
    memories: [
      { id: 'm-1', title: '内容表达偏好', excerpt: '偏好清晰、简洁的中文表达，结论先行，避免过度铺垫。', type: 'preference', updatedAt: '今天 18:42', source: 'Web 对话' },
      { id: 'm-2', title: 'ZSense 产品方向', excerpt: '内置 ZSense Agent Core，并为每个 Bot 提供隔离记忆与独立消息网关。', type: 'fact', updatedAt: '今天 16:18', source: 'Telegram' },
      { id: 'm-3', title: '周五产品复盘', excerpt: '每周五整理本周关键决策、遗留风险与下周优先级。', type: 'episode', updatedAt: '昨天 21:10', source: '定时任务' },
    ],
  },
]

export const NATIVE_BOT_ID = '__zsense_native__'

const defaultChannels = [
  { id: 'web', name: 'Web Chat', description: 'ZSense 内置对话入口', status: 'connected', latency: '本地', messages: 0, configured: true, config: {}, secretKeys: [] },
  { id: 'telegram', name: 'Telegram', description: 'ZSense Telegram Bot 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'discord', name: 'Discord', description: 'ZSense Discord Gateway 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'slack', name: 'Slack', description: 'ZSense Slack Socket Mode 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'wecom', name: '企业微信', description: 'ZSense 企业微信 WebSocket 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'weixin', name: '微信', description: 'ZSense 微信 iLink 长轮询适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'dingtalk', name: '钉钉', description: 'ZSense 钉钉 Stream 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'feishu', name: '飞书', description: 'ZSense 飞书长连接适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'device-link', name: '设备互联', description: '已配对 ZSense 设备之间的状态读取与远程任务', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'webhook', name: 'Webhook', description: 'ZSense 通用 Webhook 入口', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
]

const defaultSkills = [
  { id: 'web-search', name: 'Web Search', description: '搜索公开网络并整理带来源的结果，供研究与问答任务使用。', category: 'research', version: '1.4.2', latestVersion: '1.4.2', enabled: true, source: 'ZSense Core', updatedAt: '今天', toolCount: 3 },
  { id: 'browser-automation', name: 'Browser Automation', description: '打开网页、读取内容并执行受控的浏览器交互。', category: 'automation', version: '2.1.0', latestVersion: '2.2.0', enabled: true, source: 'ZSense Core', updatedAt: '昨天', toolCount: 8 },
  { id: 'code-execution', name: 'Code Execution', description: '在隔离环境中运行代码、脚本和开发工具。', category: 'automation', version: '1.8.3', latestVersion: '1.8.3', enabled: true, source: 'ZSense Core', updatedAt: '3 天前', toolCount: 6 },
  { id: 'file-workspace', name: 'File Workspace', description: '读取、创建与整理工作区中的文件和目录。', category: 'workspace', version: '1.3.1', latestVersion: '1.3.1', enabled: true, source: 'ZSense Core', updatedAt: '5 天前', toolCount: 5 },
  { id: 'memory-curator', name: 'Memory Curator', description: '从会话中提取、合并和维护稳定的长期记忆。', category: 'memory', version: '0.9.6', latestVersion: '0.9.6', enabled: true, source: 'ZSense', updatedAt: '今天', toolCount: 4 },
  { id: 'deep-research', name: 'Deep Research', description: '规划多阶段检索并生成可核验的深度研究报告。', category: 'research', version: '1.1.0', latestVersion: '1.2.0', enabled: false, source: 'Community', updatedAt: '1 周前', toolCount: 7 },
  { id: 'cron-scheduler', name: 'Cron Scheduler', description: '创建周期任务和定时唤醒，让 Bot 按计划持续工作。', category: 'automation', version: '1.0.4', latestVersion: '1.0.4', enabled: true, source: 'ZSense Core', updatedAt: '2 天前', toolCount: 4 },
  { id: 'message-delivery', name: 'Message Delivery', description: '通过已配置的消息网关向外部渠道发送结果与通知。', category: 'communication', version: '1.6.0', latestVersion: '1.6.0', enabled: true, source: 'ZSense', updatedAt: '今天', toolCount: 8 },
]

const defaultActivities = [
  { id: 'a-1', botId: 'atlas', type: 'system', title: '示例 Bot 已准备', detail: 'Atlas 的独立记忆命名空间已建立', time: '初始化' },
]

const defaultSettings = {
  firstRunSetupCompleted: false,
  defaultWorkspacePath: '',
  hiddenSidebarBotIds: [],
  gatewayUrl: 'http://127.0.0.1:9119',
  updateFeedUrl: '',
  strictMemory: true,
  // 默认开启：模型只负责“直接放行”，判断为拒绝/超时/失败时仍然弹窗问用户，所以默认开启只会减少打断。
  autoApprovalEnabled: true,
  // 局域网 Web 访问默认关闭：开启后同一局域网内可用浏览器打开完整界面（需要 6 位访问口令）。
  webAccessEnabled: false,
  autoExtractMemory: true,
  memoryPeriodicReview: true,
  memoryReviewInterval: 10,
  memoryRecallLimit: 24,
  memoryMaxItems: 500,
  bindChannelIdentity: true,
  runWhileLocked: false,
  appLockEnabled: false,
  appLockPasswordConfigured: false,
  computerUseEnabled: false,
  browserEnabled: true,
  browserWebLinkTarget: 'system',
  browserLocalUrlTarget: 'zsense',
  browserShowFullUrl: false,
  browserScreenshotPolicy: 'always',
  browserDownloadPath: '',
  browserAskDownloadLocation: false,
  browserHistoryAccess: 'ask',
  browserWebMcpEnabled: true,
  browserAgentBrowsePermission: 'ask',
  browserAgentDownloadPermission: 'ask',
  browserAgentUploadPermission: 'ask',
  browserFullCdpAccess: false,
  contextAutoCompression: true,
  contextCompressionThreshold: 0.5,
  contextCompressionTargetRatio: 0.2,
  contextCompressionProtectLastN: 20,
  contextCompressionProtectFirstN: 3,
  sensitiveDataRedaction: true,
  streamingResponse: true,
  compactMode: true,
  showReasoning: true,
  showUsage: true,
  inlineDiff: false,
  completionSound: true,
  approvalSound: false,
  approvalDesktopNotification: false,
  completionDesktopNotification: false,
  chatInputHeight: 88,
  voiceWakeEnabled: false,
  voiceWakePhrase: '你好 ZSense',
  voiceWakeSound: true,
  voiceWakeStartNewConversation: true,
  voiceWakeSensitivity: 0.3,
  voiceWakeConfirmationFrames: 1,
  voiceConversationEnabled: true,
  voiceAutoSpeak: true,
  voiceContinuousConversation: true,
  voiceTtsVoice: 'Xiaoyu',
  voiceTtsSpeed: 1,
  responseLanguage: 'zh-CN',
}

const defaultModelConfiguration = {
  provider: 'openrouter',
  model: '',
  baseUrl: '',
  apiKeyName: 'OPENROUTER_API_KEY',
  apiKeyConfigured: false,
  updatedAt: '',
}

function asBoolean(value) {
  return Boolean(Number(value))
}

function plain(row) {
  return row ? { ...row } : row
}

export function profileNameForBot(botId) {
  const readable = String(botId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
  const checksum = createHash('sha256').update(String(botId || '')).digest('hex').slice(0, 8)
  return `zsense${readable || 'bot'}${checksum}`
}

export const NATIVE_PROFILE_NAME = profileNameForBot(NATIVE_BOT_ID)

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function removeLegacyDsmlMarkup(value) {
  const source = String(value || '')
  if (!/(?:DSML|ＤＳＭＬ)/i.test(source)) return source
  const normalized = source.replace(/<\s*(\/?)\s*[｜|]{2}\s*(?:DSML|ＤＳＭＬ)\s*[｜|]{2}\s*(calls|invoke|parameter)([^>]*)>/gi, (_match, closing, tag, attributes) => `<${closing ? '/' : ''}zsense-dsml-${String(tag).toLowerCase()}${attributes || ''}>`)
  return normalized
    .replace(/<zsense-dsml-calls\b[^>]*>[\s\S]*?<\/zsense-dsml-calls>/gi, '')
    .replace(/<zsense-dsml-invoke\b[^>]*>[\s\S]*?<\/zsense-dsml-invoke>/gi, '')
    .replace(/<\/?zsense-dsml-(?:calls|invoke|parameter)\b[^>]*>/gi, '')
    .trim()
}

function attachmentMetadata(items) {
  if (!Array.isArray(items)) return []
  return items.slice(0, 8).map((item) => ({
    id: String(item?.id || ''),
    name: String(item?.name || ''),
    path: typeof item?.path === 'string' ? item.path : '',
    size: Number(item?.size || 0),
    mimeType: String(item?.mimeType || 'application/octet-stream'),
    kind: item?.kind === 'image' ? 'image' : 'file',
  })).filter((item) => item.id && item.name)
}

function isLocalModelEndpoint(value) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(value || '').trim())
}

function conversationUsage(value) {
  const usage = parseJson(value || '{}', {})
  if (!usage || typeof usage !== 'object' || !Object.keys(usage).length) return undefined
  return {
    contextUsed: Number(usage.contextUsed || 0),
    contextMax: Number(usage.contextMax || 0),
    contextPercent: Number(usage.contextPercent || 0),
    inputTokens: Number(usage.inputTokens || 0),
    outputTokens: Number(usage.outputTokens || 0),
    totalTokens: Number(usage.totalTokens || 0),
  }
}

function memoryContentSize(memory) {
  return Buffer.byteLength(JSON.stringify({
    id: memory.id || '',
    title: memory.title || '',
    excerpt: memory.excerpt || '',
    type: memory.type || '',
    updatedAt: memory.updatedAt || memory.updated_at || '',
    source: memory.source || '',
  }), 'utf8')
}

function formatMemorySize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${units[unitIndex]}`
}

function normalizedMemoryValue(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN')
}

function memoryFromRow(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    type: row.type,
    updatedAt: row.updated_at,
    source: row.source,
    confidence: Number(row.confidence ?? 1),
    evidence: row.evidence || '',
    conversationId: row.conversation_id || '',
    createdAt: row.created_at || row.updated_at,
    lastRecalledAt: row.last_recalled_at || null,
    recallCount: Number(row.recall_count || 0),
  }
}

function gatewayConnectionFromRow(row, includeSecretScope = false) {
  if (!row) return null
  const connection = {
    id: row.id,
    provider: row.provider,
    name: row.name,
    botId: row.bot_id,
    profileName: row.profile_name,
    status: row.status,
    latency: row.latency,
    messages: Number(row.messages),
    configured: asBoolean(row.configured),
    config: parseJson(row.config_json || '{}', {}),
    secretKeys: parseJson(row.secret_keys_json || '[]', []),
    updatedAt: row.updated_at,
  }
  if (includeSecretScope) connection.secretScope = row.secret_scope
  return connection
}

function scheduledTaskFromRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    frequency: row.frequency,
    timeOfDay: row.time_of_day,
    weekday: Number(row.weekday),
    dayOfMonth: Number(row.day_of_month || 1),
    cronExpression: row.cron_expression || '',
    modelProvider: row.model_provider,
    model: row.model,
    prompt: row.prompt,
    memoryEnabled: asBoolean(row.memory_enabled ?? 1),
    memorySummary: row.memory_summary || '',
    memorySummaryUpdatedAt: row.memory_summary_updated_at || null,
    memorySummaryRunCount: Number(row.memory_summary_run_count || 0),
    skillIds: parseJson(row.skill_ids_json || '[]', []),
    deliveryTarget: 'local',
    repeatCount: Number(row.repeat_count),
    runCount: Number(row.run_count),
    enabled: asBoolean(row.enabled),
    showOnOverview: asBoolean(row.show_on_overview ?? 1),
    ownerBotId: row.owner_bot_id || '',
    status: row.status,
    workspacePath: row.workspace_path,
    nextRunAt: row.next_run_at || null,
    lastRunAt: row.last_run_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function scheduledTaskRunFromRow(row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    conversationId: row.conversation_id || null,
    modelProvider: row.model_provider || '',
    model: row.model || '',
    output: row.output || '',
    error: row.error || '',
  }
}

function userFromRow(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email || '',
    accountPasswordConfigured: Boolean(row.account_password_hash),
    role: row.role,
    enabled: asBoolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || null,
  }
}

export class ZSenseDatabase {
  constructor(userDataDirectory, skillManager = null) {
    this.filePath = path.join(userDataDirectory, 'zsense.sqlite3')
    this.skillManager = skillManager
    this.memoryReviewClaims = new Map()
    this.db = new DatabaseSync(this.filePath)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.#migrate()
    this.#seedIfNeeded()
    this.#synchronizeMemoryStats()
    this.#synchronizeChannelMessageStats()
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        initials TEXT NOT NULL,
        role TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('online', 'paused', 'offline')),
        color TEXT NOT NULL,
        model_provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        memory_count INTEGER NOT NULL DEFAULT 0,
        memory_size TEXT NOT NULL DEFAULT '0 KB',
        last_active TEXT NOT NULL DEFAULT '刚刚',
        conversations INTEGER NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 100,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'episode')),
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        evidence TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_recalled_at TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS memories_bot_id ON memories(bot_id);
      CREATE TABLE IF NOT EXISTS memory_review_state (
        bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
        last_reviewed_turn INTEGER NOT NULL DEFAULT 0,
        reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('connected', 'setup', 'paused')),
        latency TEXT NOT NULL,
        messages INTEGER NOT NULL DEFAULT 0,
        configured INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}',
        secret_keys_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS bot_channels (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        PRIMARY KEY (bot_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS gateway_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        profile_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('connected', 'setup', 'paused')),
        latency TEXT NOT NULL DEFAULT '—',
        messages INTEGER NOT NULL DEFAULT 0,
        configured INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}',
        secret_keys_json TEXT NOT NULL DEFAULT '[]',
        secret_scope TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (bot_id, provider)
      );
      CREATE INDEX IF NOT EXISTS gateway_connections_bot_id ON gateway_connections(bot_id);
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        version TEXT NOT NULL,
        latest_version TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tool_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bot_skills (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (bot_id, skill_id)
      );
      CREATE INDEX IF NOT EXISTS bot_skills_skill_id ON bot_skills(skill_id);
      CREATE TABLE IF NOT EXISTS skill_usage_events (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error')),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        tool_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS skill_usage_events_skill ON skill_usage_events(skill_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        time_label TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        channel_id TEXT NOT NULL DEFAULT 'web',
        external_thread_id TEXT NOT NULL DEFAULT '',
        -- Retained only so databases created by older ZSense versions remain readable.
        hermes_session_id TEXT NOT NULL DEFAULT '',
        runtime_engine TEXT NOT NULL DEFAULT '',
        runtime_session_id TEXT NOT NULL DEFAULT '',
        model_provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT NOT NULL DEFAULT 'high',
        workspace_path TEXT NOT NULL DEFAULT '',
        usage_json TEXT NOT NULL DEFAULT '{}',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS conversation_groups (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS conversation_groups_bot ON conversation_groups(bot_id, sort_order);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        reasoning TEXT NOT NULL DEFAULT '',
        agent_steps_json TEXT NOT NULL DEFAULT '[]',
        tool_events_json TEXT NOT NULL DEFAULT '[]',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        external_message_id TEXT NOT NULL DEFAULT '',
        -- Retained only so databases created by older ZSense versions remain readable.
        hermes_message_id TEXT NOT NULL DEFAULT '',
        model_provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        output_tokens INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS deleted_external_messages (
        conversation_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        external_message_id TEXT NOT NULL DEFAULT '',
        -- Retained only so databases created by older ZSense versions remain readable.
        hermes_message_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (conversation_id, external_message_id)
      );
      CREATE INDEX IF NOT EXISTS deleted_external_messages_bot_id ON deleted_external_messages(bot_id);
      CREATE TABLE IF NOT EXISTS model_settings (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        provider TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        base_url TEXT NOT NULL DEFAULT '',
        api_key_name TEXT NOT NULL,
        api_key_configured INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS saved_model_configurations (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        api_key_name TEXT NOT NULL,
        api_key_configured INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (provider, model)
      );
      CREATE TABLE IF NOT EXISTS model_catalog_entries (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        api_key_name TEXT NOT NULL,
        api_key_configured INTEGER NOT NULL DEFAULT 0,
        endpoint TEXT NOT NULL DEFAULT '',
        context_window INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (provider, model)
      );
      CREATE INDEX IF NOT EXISTS model_catalog_entries_provider ON model_catalog_entries(provider, fetched_at DESC);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at TEXT
      );
      CREATE INDEX IF NOT EXISTS users_enabled_role ON users(enabled, role);
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        frequency TEXT NOT NULL,
        time_of_day TEXT NOT NULL DEFAULT '09:00',
        weekday INTEGER NOT NULL DEFAULT 1,
        day_of_month INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT NOT NULL DEFAULT '',
        model_provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        memory_enabled INTEGER NOT NULL DEFAULT 1,
        memory_summary TEXT NOT NULL DEFAULT '',
        memory_summary_updated_at TEXT,
        memory_summary_run_count INTEGER NOT NULL DEFAULT 0,
        skill_ids_json TEXT NOT NULL DEFAULT '[]',
        delivery_target TEXT NOT NULL DEFAULT 'local',
        repeat_count INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        workspace_path TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        task_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        conversation_id TEXT,
        model_provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        output TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS scheduled_task_runs_task ON scheduled_task_runs(task_id, started_at DESC);
    `)
    const schemaVersion = Number(this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0)
    this.#ensureColumn('channels', 'configured', 'INTEGER NOT NULL DEFAULT 0')
    this.#ensureColumn('channels', 'config_json', "TEXT NOT NULL DEFAULT '{}'")
    this.#ensureColumn('channels', 'secret_keys_json', "TEXT NOT NULL DEFAULT '[]'")
    this.#ensureColumn('bots', 'model_provider', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('conversations', 'hermes_session_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('conversations', 'external_thread_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('users', 'email', "TEXT NOT NULL DEFAULT ''")
    // 账号密码：专用于「其它验证」（浏览器访问 / 远程登录），与安全锁密码分开存
    this.#ensureColumn('users', 'account_password_hash', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('users', 'account_password_salt', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('conversations', 'runtime_engine', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('conversations', 'runtime_session_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('conversations', 'model_provider', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('conversations', 'model', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('conversations', 'reasoning_effort', "TEXT NOT NULL DEFAULT 'high'")
    this.#ensureColumn('conversations', 'workspace_path', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('conversations', 'usage_json', "TEXT NOT NULL DEFAULT '{}'")
    this.#ensureColumn('conversations', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
    this.#ensureColumn('conversations', 'group_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('scheduled_tasks', 'day_of_month', 'INTEGER NOT NULL DEFAULT 1')
    this.#ensureColumn('scheduled_tasks', 'cron_expression', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('scheduled_tasks', 'show_on_overview', 'INTEGER NOT NULL DEFAULT 1')
    // 归属 Bot：'' 表示属于 AI 对话空间；Bot 页面的定时任务板块按它筛选
    this.#ensureColumn('scheduled_tasks', 'owner_bot_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('scheduled_tasks', 'memory_enabled', 'INTEGER NOT NULL DEFAULT 1')
    this.#ensureColumn('scheduled_tasks', 'memory_summary', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('scheduled_tasks', 'memory_summary_updated_at', 'TEXT')
    this.#ensureColumn('scheduled_tasks', 'memory_summary_run_count', 'INTEGER NOT NULL DEFAULT 0')
    this.#ensureColumn('conversations', 'archived', 'INTEGER NOT NULL DEFAULT 0')
    this.#ensureColumn('messages', 'reasoning', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('messages', 'agent_steps_json', "TEXT NOT NULL DEFAULT '[]'")
    this.#ensureColumn('messages', 'tool_events_json', "TEXT NOT NULL DEFAULT '[]'")
    this.#ensureColumn('messages', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'")
    this.#ensureColumn('messages', 'hermes_message_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('messages', 'external_message_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('messages', 'model_provider', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('messages', 'model', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('messages', 'duration_ms', 'INTEGER')
    this.#ensureColumn('messages', 'output_tokens', 'INTEGER')
    this.#ensureColumn('deleted_external_messages', 'external_message_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('activities', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'")
    this.#ensureColumn('scheduled_task_runs', 'model_provider', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('scheduled_task_runs', 'model', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('model_catalog_entries', 'context_window', 'INTEGER NOT NULL DEFAULT 0')
    this.#ensureColumn('memories', 'confidence', 'REAL NOT NULL DEFAULT 1')
    this.#ensureColumn('memories', 'evidence', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('memories', 'conversation_id', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('memories', 'created_at', "TEXT NOT NULL DEFAULT ''")
    this.#ensureColumn('memories', 'last_recalled_at', 'TEXT')
    this.#ensureColumn('memories', 'recall_count', 'INTEGER NOT NULL DEFAULT 0')
    this.db.prepare("UPDATE memories SET created_at=COALESCE(NULLIF(created_at, ''), updated_at, CURRENT_TIMESTAMP) WHERE created_at='' OR created_at IS NULL").run()
    if (schemaVersion < 19) {
      this.db.prepare(`
        UPDATE scheduled_task_runs
        SET
          model_provider=CASE WHEN model_provider='' THEN COALESCE((SELECT c.model_provider FROM conversations c WHERE c.id=scheduled_task_runs.conversation_id), '') ELSE model_provider END,
          model=CASE WHEN model='' THEN COALESCE((SELECT c.model FROM conversations c WHERE c.id=scheduled_task_runs.conversation_id), '') ELSE model END
        WHERE (model_provider='' OR model='') AND conversation_id IS NOT NULL AND conversation_id<>''
      `).run()
      this.db.prepare(`
        UPDATE messages
        SET
          model_provider=CASE WHEN model_provider='' THEN COALESCE((SELECT c.model_provider FROM conversations c WHERE c.id=messages.conversation_id), '') ELSE model_provider END,
          model=CASE WHEN model='' THEN COALESCE((SELECT c.model FROM conversations c WHERE c.id=messages.conversation_id), '') ELSE model END
        WHERE role='assistant' AND (model_provider='' OR model='')
      `).run()
      this.db.prepare(`
        UPDATE messages
        SET duration_ms=CAST((unixepoch(messages.created_at) - unixepoch((
          SELECT previous.created_at
          FROM messages previous
          WHERE previous.conversation_id=messages.conversation_id
            AND previous.role='user'
            AND (
              datetime(previous.created_at)<datetime(messages.created_at)
              OR (datetime(previous.created_at)=datetime(messages.created_at) AND previous.rowid<messages.rowid)
            )
          ORDER BY datetime(previous.created_at) DESC, previous.rowid DESC
          LIMIT 1
        ))) * 1000 AS INTEGER)
        WHERE role='assistant' AND duration_ms IS NULL AND EXISTS (
          SELECT 1
          FROM messages previous
          WHERE previous.conversation_id=messages.conversation_id
            AND previous.role='user'
            AND julianday(messages.created_at) - julianday(previous.created_at) BETWEEN 0 AND 1
        )
      `).run()
    }
    if (schemaVersion < 20) {
      this.db.prepare(`
        UPDATE conversations
        SET
          model_provider=CASE WHEN model_provider='' THEN COALESCE(
            NULLIF((SELECT b.model_provider FROM bots b WHERE b.id=conversations.bot_id), ''),
            NULLIF((SELECT provider FROM model_settings WHERE id='default'), ''),
            ''
          ) ELSE model_provider END,
          model=CASE WHEN model='' THEN COALESCE(
            NULLIF((SELECT b.model FROM bots b WHERE b.id=conversations.bot_id), ''),
            NULLIF((SELECT model FROM model_settings WHERE id='default'), ''),
            ''
          ) ELSE model END
        WHERE model_provider='' OR model=''
      `).run()
      this.db.prepare(`
        UPDATE messages
        SET
          model_provider=CASE WHEN model_provider='' THEN COALESCE(
            NULLIF((SELECT c.model_provider FROM conversations c WHERE c.id=messages.conversation_id), ''),
            NULLIF((SELECT provider FROM model_settings WHERE id='default'), ''),
            ''
          ) ELSE model_provider END,
          model=CASE WHEN model='' THEN COALESCE(
            NULLIF((SELECT c.model FROM conversations c WHERE c.id=messages.conversation_id), ''),
            NULLIF((SELECT model FROM model_settings WHERE id='default'), ''),
            ''
          ) ELSE model END
        WHERE role='assistant' AND (model_provider='' OR model='')
      `).run()
      this.db.prepare(`
        UPDATE scheduled_task_runs
        SET
          model_provider=CASE WHEN model_provider='' THEN COALESCE(
            NULLIF((SELECT c.model_provider FROM conversations c WHERE c.id=scheduled_task_runs.conversation_id), ''),
            NULLIF((SELECT t.model_provider FROM scheduled_tasks t WHERE t.id=scheduled_task_runs.task_id), ''),
            NULLIF((SELECT provider FROM model_settings WHERE id='default'), ''),
            ''
          ) ELSE model_provider END,
          model=CASE WHEN model='' THEN COALESCE(
            NULLIF((SELECT c.model FROM conversations c WHERE c.id=scheduled_task_runs.conversation_id), ''),
            NULLIF((SELECT t.model FROM scheduled_tasks t WHERE t.id=scheduled_task_runs.task_id), ''),
            NULLIF((SELECT model FROM model_settings WHERE id='default'), ''),
            ''
          ) ELSE model END
        WHERE model_provider='' OR model=''
      `).run()
    }
    if (schemaVersion < 26) {
      this.db.prepare(`
        UPDATE conversations
        SET runtime_engine=CASE WHEN hermes_session_id<>'' THEN 'hermes' ELSE runtime_engine END,
            runtime_session_id=CASE WHEN hermes_session_id<>'' THEN hermes_session_id ELSE runtime_session_id END
        WHERE runtime_engine='' OR runtime_session_id=''
      `).run()
    }
    if (schemaVersion < 31) {
      // The old columns are intentionally left in place for rollback compatibility.
      // All current code reads and writes the provider-neutral identifiers below.
      this.db.prepare("UPDATE conversations SET external_thread_id=hermes_session_id WHERE external_thread_id='' AND hermes_session_id<>''").run()
      this.db.prepare("UPDATE messages SET external_message_id=hermes_message_id WHERE external_message_id='' AND hermes_message_id<>''").run()
      this.db.prepare("UPDATE deleted_external_messages SET external_message_id=hermes_message_id WHERE external_message_id='' AND hermes_message_id<>''").run()
      this.db.prepare("UPDATE conversations SET runtime_engine='legacy' WHERE runtime_engine='hermes'").run()
    }
    if (schemaVersion < 21) {
      const sensitivity = Number(parseJson(this.db.prepare("SELECT value FROM settings WHERE key='voiceWakeSensitivity'").get()?.value || 'null', NaN))
      const confirmationFrames = Number(parseJson(this.db.prepare("SELECT value FROM settings WHERE key='voiceWakeConfirmationFrames'").get()?.value || 'null', NaN))
      if (sensitivity === 0.45 && confirmationFrames === 2) {
        this.db.prepare("UPDATE settings SET value='0.3' WHERE key='voiceWakeSensitivity'").run()
        this.db.prepare("UPDATE settings SET value='1' WHERE key='voiceWakeConfirmationFrames'").run()
      } else if (sensitivity === 0.6 && confirmationFrames === 3) {
        this.db.prepare("UPDATE settings SET value='0.35' WHERE key='voiceWakeSensitivity'").run()
        this.db.prepare("UPDATE settings SET value='2' WHERE key='voiceWakeConfirmationFrames'").run()
      }
    }
    if (schemaVersion < 23) {
      const chatInputHeight = Number(parseJson(this.db.prepare("SELECT value FROM settings WHERE key='chatInputHeight'").get()?.value || 'null', NaN))
      if (chatInputHeight === 112) this.db.prepare("UPDATE settings SET value='88' WHERE key='chatInputHeight'").run()
    }
    if (schemaVersion < 24) {
      this.db.prepare("UPDATE bots SET color='#2563eb' WHERE id=? AND color='#b4532a'").run(NATIVE_BOT_ID)
    }
    if (schemaVersion > 0 && schemaVersion < 25) {
      this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('firstRunSetupCompleted', 'true')").run()
      this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('defaultWorkspacePath', '\"\"')").run()
    }
    this.db.prepare(`
      UPDATE conversations
      SET channel_id='scheduled'
      WHERE channel_id<>'scheduled'
        AND id IN (
          SELECT conversation_id
          FROM scheduled_task_runs
          WHERE conversation_id IS NOT NULL AND conversation_id<>''
        )
    `).run()
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_external_id ON messages(conversation_id, external_message_id) WHERE external_message_id<>'';")
    this.db.exec("CREATE INDEX IF NOT EXISTS conversations_external_thread ON conversations(bot_id, channel_id, external_thread_id);")
    // 会话消息、会话列表和活动流是最高频的读取路径，而它们都按 datetime(created_at/updated_at) 排序：
    // 没有索引时每次打开会话、每轮 Agent 读历史都要全表扫描再临时排序，数据量一大就拖慢整个任务。
    // 索引的表达式必须与查询里的 datetime(...) 完全一致，否则 SQLite 用不上。
    this.db.exec("CREATE INDEX IF NOT EXISTS messages_conversation_datetime ON messages(conversation_id, datetime(created_at));")
    this.db.exec("CREATE INDEX IF NOT EXISTS conversations_datetime_updated ON conversations(datetime(updated_at) DESC);")
    this.db.exec("CREATE INDEX IF NOT EXISTS activities_datetime_created ON activities(datetime(created_at) DESC);")
    for (const legacy of ['messages_conversation_created', 'messages_conversation_role_created', 'conversations_updated_at', 'conversations_bot_updated_at', 'activities_created_at']) {
      this.db.exec(`DROP INDEX IF EXISTS ${legacy};`)
    }
    const insertChannel = this.db.prepare(`
      INSERT OR IGNORE INTO channels (id, name, description, status, latency, messages, configured, config_json, secret_keys_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const channel of defaultChannels) {
      insertChannel.run(channel.id, channel.name, channel.description, channel.status, channel.latency, channel.messages, channel.configured ? 1 : 0, JSON.stringify(channel.config), JSON.stringify(channel.secretKeys))
      this.db.prepare('UPDATE channels SET name=?, description=? WHERE id=?').run(channel.name, channel.description, channel.id)
    }
    this.db.prepare("UPDATE channels SET configured=1, latency='本地' WHERE id='web'").run()
    this.db.prepare("UPDATE channels SET status='setup', latency='—' WHERE id<>'web' AND configured=0").run()
    if (schemaVersion < 3) {
      const migrateLegacy = this.db.prepare(`
        INSERT OR IGNORE INTO gateway_connections
          (id, provider, name, bot_id, profile_name, status, latency, messages, configured, config_json, secret_keys_json, secret_scope, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `)
      for (const channel of this.db.prepare("SELECT * FROM channels WHERE id<>'web' AND configured=1").all()) {
        const linkedBots = this.db.prepare('SELECT bot_id FROM bot_channels WHERE channel_id=? ORDER BY rowid').all(channel.id)
        if (linkedBots.length !== 1) continue
        const botId = linkedBots[0].bot_id
        migrateLegacy.run(
          `legacy-${channel.id}`,
          channel.id,
          `${channel.name}（旧配置）`,
          botId,
          profileNameForBot(botId),
          channel.status,
          channel.latency,
          channel.messages,
          1,
          channel.config_json || '{}',
          channel.secret_keys_json || '[]',
          `channel:${channel.id}`,
        )
      }
      this.db.prepare("DELETE FROM bot_channels WHERE channel_id<>'web'").run()
    }
    if (schemaVersion < 4) {
      const bots = this.db.prepare('SELECT id FROM bots ORDER BY rowid').all()
      const storedSkillState = new Map(this.db.prepare('SELECT id, enabled FROM skills').all().map((row) => [row.id, asBoolean(row.enabled)]))
      const availableSkills = this.skillManager?.listSkills() || this.db.prepare('SELECT id, name FROM skills ORDER BY rowid').all().map((row) => ({ id: row.id, name: row.name, essential: false }))
      const insertAssignment = this.db.prepare('INSERT OR REPLACE INTO bot_skills (bot_id, skill_id, enabled) VALUES (?, ?, ?)')
      for (const bot of bots) {
        for (const skill of availableSkills) {
          const enabled = skill.essential || (storedSkillState.get(skill.id) ?? true)
          insertAssignment.run(bot.id, skill.id, enabled ? 1 : 0)
        }
      }
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO model_settings (id, provider, model, base_url, api_key_name, api_key_configured, updated_at)
      VALUES ('default', ?, ?, ?, ?, ?, ?)
    `).run(defaultModelConfiguration.provider, defaultModelConfiguration.model, defaultModelConfiguration.baseUrl, defaultModelConfiguration.apiKeyName, 0, defaultModelConfiguration.updatedAt)
    this.db.prepare(`
      INSERT OR IGNORE INTO saved_model_configurations (provider, model, base_url, api_key_name, api_key_configured, updated_at)
      SELECT provider, model, base_url, api_key_name, api_key_configured, updated_at
      FROM model_settings WHERE id='default' AND model<>''
    `).run()
    this.db.prepare(`
      UPDATE bots SET model_provider=COALESCE((SELECT provider FROM model_settings WHERE id='default'), '')
      WHERE model<>'' AND model_provider=''
    `).run()
    if (schemaVersion < 33) {
      this.db.prepare(`
        UPDATE bots
        SET name='AI 对话', role='ZSense AI 助手', description='不依附任何 Bot 的 ZSense Agent Core 对话空间。', updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(NATIVE_BOT_ID)
      this.db.prepare("UPDATE memories SET source='AI 对话' WHERE bot_id=? AND source=char(21407,29983) || '对话'").run(NATIVE_BOT_ID)
      this.db.prepare("UPDATE channels SET description=REPLACE(description, 'ZSense ' || char(21407,29983) || ' ', 'ZSense ') WHERE description LIKE 'ZSense %'").run()
      this.db.prepare("UPDATE gateway_connections SET latency='ZSense 连接' WHERE latency LIKE 'ZSense %连接'").run()
    }
    if (schemaVersion < 34) {
      const selectLatestAssistantSteps = this.db.prepare(`
        SELECT agent_steps_json
        FROM messages
        WHERE conversation_id=? AND role='assistant'
        ORDER BY datetime(created_at) DESC, rowid DESC
        LIMIT 1
      `)
      const updateUsage = this.db.prepare('UPDATE conversations SET usage_json=? WHERE id=?')
      for (const row of this.db.prepare("SELECT id, usage_json FROM conversations WHERE usage_json<>'' AND usage_json<>'{}'").all()) {
        const usage = parseJson(row.usage_json || '{}', {})
        const steps = parseJson(selectLatestAssistantSteps.get(row.id)?.agent_steps_json || '[]', [])
        const contextUsed = Number(usage?.contextUsed || 0)
        const totalTokens = Number(usage?.totalTokens || 0)
        const contextMax = Number(usage?.contextMax || 0)
        if (!Array.isArray(steps) || steps.length < 2 || totalTokens <= 0 || contextMax <= 0 || Math.abs(contextUsed - totalTokens) > 1) continue
        const correctedContextUsed = Math.max(1, Math.ceil(totalTokens / steps.length))
        updateUsage.run(JSON.stringify({
          ...usage,
          contextUsed: correctedContextUsed,
          contextPercent: Math.min(100, Math.round((correctedContextUsed / contextMax) * 100)),
        }), row.id)
      }
    }
    if (schemaVersion < 35) {
      if (schemaVersion > 0 && fs.existsSync(this.filePath)) {
        const backupPath = `${this.filePath}.pre-schema-35.bak`
        if (!fs.existsSync(backupPath)) {
          try {
            this.db.exec('PRAGMA wal_checkpoint(FULL)')
            fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL)
          } catch (error) {
            if (!fs.existsSync(backupPath)) throw error
          }
        }
      }
      const replacement = 'ZSense 已移除旧版本误存的工具调用标签；这些历史工具调用没有实际执行，请重新提交当时的问题。'
      const updateMessage = this.db.prepare('UPDATE messages SET content=? WHERE id=?')
      for (const row of this.db.prepare("SELECT id, content FROM messages WHERE role='assistant' AND (content LIKE '%DSML%' OR content LIKE '%ＤＳＭＬ%')").all()) {
        const cleaned = removeLegacyDsmlMarkup(row.content)
        if (cleaned !== row.content) updateMessage.run(cleaned || replacement, row.id)
      }
    }
    if (schemaVersion < 37) this.db.prepare("DELETE FROM settings WHERE key='agentMaxToolSteps'").run()
    if (schemaVersion < 38) {
      const removeUnusedLegacySample = this.db.prepare(`
        DELETE FROM bots
        WHERE id=? AND name=? AND role=? AND prompt=?
          AND NOT EXISTS (SELECT 1 FROM conversations WHERE bot_id=bots.id)
          AND NOT EXISTS (SELECT 1 FROM gateway_connections WHERE bot_id=bots.id)
          AND NOT EXISTS (
            SELECT 1 FROM activities
            WHERE bot_id=bots.id AND title<>'示例 Bot 已准备'
          )
      `)
      removeUnusedLegacySample.run('scout', 'Scout', '研究情报助手', '你是 Scout，一位证据优先的研究助手。必须标记来源与时间，对不确定结论给出置信度。')
      removeUnusedLegacySample.run('momo', 'Momo', '团队运营助理', '你是 Momo，负责团队运营与协作。行动前先确认负责人、截止时间和通知范围。')
    }
    if (schemaVersion < 39) {
      const currentOwner = this.db.prepare("SELECT id, username, display_name FROM users WHERE username='local.owner' AND display_name='本机用户' LIMIT 1").get()
      const backupPath = `${this.filePath}.pre-schema-35.bak`
      if (currentOwner && fs.existsSync(backupPath)) {
        let backupDatabase
        try {
          backupDatabase = new DatabaseSync(backupPath, { readOnly: true })
          const previousOwner = backupDatabase.prepare('SELECT id, username, display_name FROM users WHERE id=? LIMIT 1').get(currentOwner.id)
          const previousUsername = String(previousOwner?.username || '').trim()
          const previousDisplayName = String(previousOwner?.display_name || '').trim()
          if (/^[A-Za-z0-9._-]{3,40}$/.test(previousUsername) && previousDisplayName && previousDisplayName.length <= 80 && (previousUsername !== 'local.owner' || previousDisplayName !== '本机用户')) {
            this.db.prepare('UPDATE users SET username=?, display_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(previousUsername, previousDisplayName, currentOwner.id)
          }
        } catch (error) {
          console.warn('恢复升级前本机身份名称失败：', error instanceof Error ? error.message : error)
        } finally {
          try { backupDatabase?.close() } catch { /* Ignore a backup close failure. */ }
        }
      }
    }
    if (schemaVersion < 40) this.db.prepare("DELETE FROM settings WHERE key IN ('petFrameRate', 'petEnabled', 'petSelectedId')").run()
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '41')
  }

  #ensureColumn(table, column, definition) {
    const exists = this.db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
    if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  #transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  #synchronizeMemoryStats(botId = null) {
    const bots = botId
      ? this.db.prepare('SELECT id FROM bots WHERE id=?').all(botId)
      : this.db.prepare('SELECT id FROM bots').all()
    const selectMemories = this.db.prepare('SELECT id, title, excerpt, type, updated_at, source FROM memories WHERE bot_id=? ORDER BY rowid')
    const updateBot = this.db.prepare(`
      UPDATE bots
      SET memory_count=?, memory_size=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND (memory_count<>? OR memory_size<>?)
    `)
    for (const bot of bots) {
      const memories = selectMemories.all(bot.id)
      const memoryCount = memories.length
      const memorySize = formatMemorySize(memories.reduce((total, memory) => total + memoryContentSize(memory), 0))
      updateBot.run(memoryCount, memorySize, bot.id, memoryCount, memorySize)
    }
  }

  #synchronizeChannelMessageStats() {
    this.db.prepare(`
      UPDATE channels
      SET messages=(
        SELECT COUNT(*)
        FROM messages m
        JOIN conversations c ON c.id=m.conversation_id
        WHERE c.channel_id=channels.id
      )
    `).run()
  }

  #seedIfNeeded() {
    const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM bots WHERE id<>?').get(NATIVE_BOT_ID).count)
    if (count === 0) {
      this.#transaction(() => {
        for (const channel of defaultChannels) this.#upsertChannel(channel)
        for (const bot of defaultBots) this.#insertBot(bot)
        for (const skill of defaultSkills) this.#upsertSkill(skill)
        const availableSkills = this.skillManager?.listSkills() || defaultSkills
        const assignSkill = this.db.prepare('INSERT OR REPLACE INTO bot_skills (bot_id, skill_id, enabled) VALUES (?, ?, 1)')
        for (const bot of defaultBots) {
          for (const skill of availableSkills) assignSkill.run(bot.id, skill.id)
        }
        for (const [key, value] of Object.entries(defaultSettings)) {
          this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
        }
        const statement = this.db.prepare('INSERT INTO activities (id, bot_id, type, title, detail, time_label) VALUES (?, ?, ?, ?, ?, ?)')
        for (const activity of defaultActivities) statement.run(activity.id, activity.botId, activity.type, activity.title, activity.detail, activity.time)
      })
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO bots
        (id, name, initials, role, description, status, color, model_provider, model, memory_count, memory_size, last_active, conversations, success_rate, prompt)
      VALUES (?, 'AI 对话', 'AI', 'ZSense AI 助手', '不依附任何 Bot 的 ZSense Agent Core 对话空间。', 'online', '#2563eb', '', '', 0, '0 KB', '尚未运行', 0, 100, '使用 ZSense 全局模型、技能与安全策略直接回答用户。')
    `).run(NATIVE_BOT_ID)
  }

  #insertBot(bot) {
    const memories = Array.isArray(bot.memories) ? bot.memories : []
    const memoryCount = memories.length
    const memorySize = formatMemorySize(memories.reduce((total, memory) => total + memoryContentSize(memory), 0))
    this.db.prepare(`
      INSERT INTO bots (id, name, initials, role, description, status, color, model_provider, model, memory_count, memory_size, last_active, conversations, success_rate, prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(bot.id, bot.name, bot.initials, bot.role, bot.description, bot.status, bot.color, bot.modelProvider || '', bot.model || '', memoryCount, memorySize, bot.lastActive, bot.conversations, bot.successRate, bot.prompt)
    const channelStatement = this.db.prepare('INSERT OR IGNORE INTO bot_channels (bot_id, channel_id) VALUES (?, ?)')
    for (const channelId of bot.channels.filter((id) => id === 'web')) channelStatement.run(bot.id, channelId)
    const memoryStatement = this.db.prepare(`
      INSERT INTO memories (id, bot_id, title, excerpt, type, updated_at, source, confidence, evidence, conversation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const memory of memories) memoryStatement.run(memory.id, bot.id, memory.title, memory.excerpt, memory.type, memory.updatedAt, memory.source, Number(memory.confidence ?? 1), memory.evidence || '', memory.conversationId || '', memory.createdAt || new Date().toISOString())
  }

  #upsertChannel(channel) {
    this.db.prepare(`
      INSERT INTO channels (id, name, description, status, latency, messages, configured, config_json, secret_keys_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, status=excluded.status, latency=excluded.latency, messages=excluded.messages, configured=excluded.configured, config_json=excluded.config_json, secret_keys_json=excluded.secret_keys_json
    `).run(channel.id, channel.name, channel.description, channel.status, channel.latency, channel.messages, channel.configured ? 1 : 0, JSON.stringify(channel.config || {}), JSON.stringify(channel.secretKeys || []))
  }

  #upsertGatewayConnection(connection) {
    this.db.prepare(`
      INSERT INTO gateway_connections
        (id, provider, name, bot_id, profile_name, status, latency, messages, configured, config_json, secret_keys_json, secret_scope, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider=excluded.provider, name=excluded.name, bot_id=excluded.bot_id,
        profile_name=excluded.profile_name, status=excluded.status, latency=excluded.latency,
        messages=excluded.messages, configured=excluded.configured, config_json=excluded.config_json,
        secret_keys_json=excluded.secret_keys_json, secret_scope=excluded.secret_scope,
        updated_at=excluded.updated_at
    `).run(
      connection.id,
      connection.provider,
      connection.name,
      connection.botId,
      connection.profileName,
      connection.status,
      connection.latency,
      connection.messages,
      connection.configured ? 1 : 0,
      JSON.stringify(connection.config || {}),
      JSON.stringify(connection.secretKeys || []),
      connection.secretScope,
      connection.updatedAt,
    )
  }

  #upsertSkill(skill) {
    this.db.prepare(`
      INSERT INTO skills (id, name, description, category, version, latest_version, enabled, source, updated_at, tool_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, category=excluded.category, version=excluded.version, latest_version=excluded.latest_version, enabled=excluded.enabled, source=excluded.source, updated_at=excluded.updated_at, tool_count=excluded.tool_count
    `).run(skill.id, skill.name, skill.description, skill.category, skill.version, skill.latestVersion || skill.version, skill.enabled ? 1 : 0, skill.source, skill.updatedAt, skill.fileCount ?? skill.toolCount ?? 0)
  }

  #availableSkills() {
    return this.skillManager?.listSkills() || this.db.prepare('SELECT id, name FROM skills ORDER BY rowid').all().map((row) => ({ id: row.id, name: row.name, essential: false }))
  }

  #ensureSkillAssignmentRows() {
    const bots = this.db.prepare('SELECT id FROM bots WHERE id<>? ORDER BY rowid').all(NATIVE_BOT_ID)
    const skills = this.#availableSkills()
    const insertAssignment = this.db.prepare('INSERT OR IGNORE INTO bot_skills (bot_id, skill_id, enabled) VALUES (?, ?, ?)')
    const enableEssential = this.db.prepare('UPDATE bot_skills SET enabled=1 WHERE bot_id=? AND skill_id=?')
    for (const bot of bots) {
      for (const skill of skills) {
        insertAssignment.run(bot.id, skill.id, skill.essential || skill.defaultEnabled ? 1 : 0)
        if (skill.essential) enableEssential.run(bot.id, skill.id)
      }
    }
  }

  #replaceSkillAssignments(skill, requestedBotIds) {
    const botIds = this.db.prepare('SELECT id FROM bots WHERE id<>? ORDER BY rowid').all(NATIVE_BOT_ID).map((row) => row.id)
    const knownBotIds = new Set(botIds)
    const requested = new Set((requestedBotIds || []).filter((botId) => knownBotIds.has(botId)))
    const selected = skill.essential ? new Set(botIds) : requested
    const statement = this.db.prepare(`
      INSERT INTO bot_skills (bot_id, skill_id, enabled) VALUES (?, ?, ?)
      ON CONFLICT(bot_id, skill_id) DO UPDATE SET enabled=excluded.enabled
    `)
    for (const botId of botIds) statement.run(botId, skill.id, selected.has(botId) ? 1 : 0)
    return [...selected]
  }

  #loadGatewayConnectionsSlice() {
    return this.db.prepare('SELECT * FROM gateway_connections ORDER BY datetime(updated_at) DESC, rowid DESC').all().map((row) => gatewayConnectionFromRow(row))
  }

  loadGatewayConnections() {
    return this.#loadGatewayConnectionsSlice()
  }

  // 网关健康检查会按固定间隔调用。这里只返回连接生命周期真正需要的轻量数据，
  // 避免为了几十个状态字段反复解析全部会话消息、Agent 步骤和技能目录。
  loadGatewayRuntime() {
    return {
      bots: this.db.prepare('SELECT id, status FROM bots WHERE id<>? ORDER BY created_at, rowid').all(NATIVE_BOT_ID).map((row) => ({ id: row.id, status: row.status })),
      gatewayConnections: this.#loadGatewayConnectionsSlice(),
      settings: this.#loadSettingsSlice(),
    }
  }

  // 只取 Bot ID 列表：校验对端 Bot 时没必要把全部会话、消息和技能一起读出来。
  loadBotIds() {
    return this.db.prepare('SELECT id FROM bots WHERE id<>? ORDER BY created_at, rowid').all(NATIVE_BOT_ID).map((row) => row.id)
  }

  // 设置项的单字段读取（更新源、下载目录、Computer Use 开关等）非常多。走 loadWorkspace()
  // 会把全部会话和消息连同 reasoning/tool_events JSON 一起读出来，只为取一个值；
  // 数据量一大，每次这样的读取都会阻塞主进程几十到几百毫秒。
  #loadSettingsSlice() {
    const settings = { ...defaultSettings }
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
      try { settings[row.key] = JSON.parse(row.value) } catch { settings[row.key] = row.value }
    }
    return settings
  }

  loadSettings() {
    return this.#loadSettingsSlice()
  }

  /** 只取会话 id 与更新时间：轮询自愈用，避免每次构建整份工作区快照 */
  conversationTimestamps() {
    return this.db.prepare('SELECT id AS id, updated_at AS updatedAt FROM conversations').all().map((row) => ({ id: row.id, updatedAt: row.updatedAt || '' }))
  }

  loadWorkspace() {
    this.#ensureSkillAssignmentRows()
    const memoriesByBot = new Map()
    for (const row of this.db.prepare('SELECT * FROM memories ORDER BY rowid DESC').all()) {
      const memory = memoryFromRow(row)
      const list = memoriesByBot.get(row.bot_id) || []
      list.push(memory)
      memoriesByBot.set(row.bot_id, list)
    }
    const channelsByBot = new Map()
    for (const row of this.db.prepare('SELECT bot_id, channel_id FROM bot_channels ORDER BY rowid').all()) {
      const list = channelsByBot.get(row.bot_id) || []
      list.push(row.channel_id)
      channelsByBot.set(row.bot_id, list)
    }
    const gatewayConnections = this.#loadGatewayConnectionsSlice()
    for (const connection of gatewayConnections) {
      const list = channelsByBot.get(connection.botId) || []
      if (!list.includes(connection.provider)) list.push(connection.provider)
      channelsByBot.set(connection.botId, list)
    }
    const conversationCountsByBot = new Map(this.db.prepare(`
      SELECT bot_id, COUNT(*) AS conversation_count
      FROM conversations
      WHERE channel_id<>'scheduled'
      GROUP BY bot_id
    `).all().map((row) => [row.bot_id, Number(row.conversation_count)]))
    const bots = this.db.prepare('SELECT * FROM bots WHERE id<>? ORDER BY created_at, rowid').all(NATIVE_BOT_ID).map((row) => {
      const memories = memoriesByBot.get(row.id) || []
      return {
        id: row.id, name: row.name, initials: row.initials, role: row.role,
        description: row.description, status: row.status, color: row.color, modelProvider: row.model_provider || '', model: row.model,
        memoryCount: memories.length,
        memorySize: formatMemorySize(memories.reduce((total, memory) => total + memoryContentSize(memory), 0)),
        channels: channelsByBot.get(row.id) || [], lastActive: row.last_active,
        conversations: conversationCountsByBot.get(row.id) || 0, successRate: Number(row.success_rate),
        prompt: row.prompt, memories,
      }
    })
    const nativeRow = this.db.prepare('SELECT * FROM bots WHERE id=?').get(NATIVE_BOT_ID)
    const nativeMemories = memoriesByBot.get(NATIVE_BOT_ID) || []
    const nativeBot = nativeRow ? {
      id: nativeRow.id,
      name: nativeRow.name,
      initials: nativeRow.initials,
      role: nativeRow.role,
      description: nativeRow.description,
      status: nativeRow.status,
      color: nativeRow.color,
      modelProvider: nativeRow.model_provider || '',
      model: nativeRow.model,
      memoryCount: nativeMemories.length,
      memorySize: formatMemorySize(nativeMemories.reduce((total, memory) => total + memoryContentSize(memory), 0)),
      channels: ['web'],
      lastActive: nativeRow.last_active,
      conversations: conversationCountsByBot.get(nativeRow.id) || 0,
      successRate: Number(nativeRow.success_rate),
      prompt: nativeRow.prompt,
      memories: nativeMemories,
    } : null
    const messageCountsByChannel = new Map(this.db.prepare(`
      SELECT c.channel_id, COUNT(m.id) AS message_count
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id=c.id
      GROUP BY c.channel_id
    `).all().map((row) => [row.channel_id, Number(row.message_count)]))
    const channels = this.db.prepare('SELECT * FROM channels ORDER BY rowid').all().map((row) => {
      if (row.id === 'web') return {
        id: row.id, name: row.name, description: row.description, status: 'connected',
        latency: '本地', messages: messageCountsByChannel.get(row.id) || 0, configured: true, config: {}, secretKeys: [],
      }
      const instances = gatewayConnections.filter((connection) => connection.provider === row.id)
      const connected = instances.some((connection) => connection.status === 'connected')
      const configured = instances.some((connection) => connection.configured)
      return {
        id: row.id, name: row.name, description: row.description,
        status: connected ? 'connected' : configured ? 'paused' : 'setup',
        latency: connected ? '独立 Profile' : '—',
        messages: messageCountsByChannel.get(row.id) || 0,
        configured, config: {}, secretKeys: [],
      }
    })
    const storedSkillRows = this.db.prepare('SELECT * FROM skills ORDER BY rowid').all()
    const assignedBotsBySkill = new Map()
    for (const row of this.db.prepare('SELECT bot_id, skill_id FROM bot_skills WHERE enabled=1 ORDER BY rowid').all()) {
      const list = assignedBotsBySkill.get(row.skill_id) || []
      list.push(row.bot_id)
      assignedBotsBySkill.set(row.skill_id, list)
    }
    const usageBySkill = new Map(this.db.prepare(`
      SELECT skill_id, COUNT(*) AS usage_count,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success_count,
        MAX(created_at) AS last_used_at
      FROM skill_usage_events
      GROUP BY skill_id
    `).all().map((row) => [row.skill_id, {
      usageCount: Number(row.usage_count || 0),
      successRate: Number(row.usage_count || 0) ? Math.round((Number(row.success_count || 0) / Number(row.usage_count)) * 100) : 0,
      lastUsedAt: row.last_used_at || '',
    }]))
    const skills = this.skillManager ? this.skillManager.listSkills().map((skill) => ({
      ...skill,
      assignedBotIds: assignedBotsBySkill.get(skill.id) || [],
      enabled: Boolean((assignedBotsBySkill.get(skill.id) || []).length),
      ...(usageBySkill.get(skill.id) || { usageCount: 0, successRate: 0, lastUsedAt: '' }),
    })) : storedSkillRows.map((row) => ({
      id: row.id, name: row.name, description: row.description, category: row.category,
      version: row.version, assignedBotIds: assignedBotsBySkill.get(row.id) || [], enabled: Boolean((assignedBotsBySkill.get(row.id) || []).length), source: row.source,
      updatedAt: row.updated_at, fileCount: Number(row.tool_count), content: '', installPath: '',
      editable: true, builtIn: true, essential: false, updateMode: 'runtime', repositoryUrl: '',
      ...(usageBySkill.get(row.id) || { usageCount: 0, successRate: 0, lastUsedAt: '' }), versions: [],
    }))
    const activities = this.db.prepare('SELECT * FROM activities ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 100').all().map((row) => ({
      id: row.id, botId: row.bot_id, type: row.type, title: row.title, detail: row.detail, time: row.time_label,
      createdAt: row.created_at, metadata: parseJson(row.metadata_json || '{}', {}),
    }))
    const messagesByConversation = new Map()
    for (const row of this.db.prepare('SELECT * FROM messages ORDER BY datetime(created_at), rowid').all()) {
      const list = messagesByConversation.get(row.conversation_id) || []
      list.push({
        id: row.id,
        role: row.role,
        content: row.content,
        reasoning: row.reasoning || '',
        agentSteps: parseJson(row.agent_steps_json || '[]', []),
        toolEvents: parseJson(row.tool_events_json || '[]', []),
        attachments: attachmentMetadata(parseJson(row.attachments_json || '[]', [])),
        externalMessageId: row.external_message_id || row.hermes_message_id || '',
        modelProvider: row.model_provider || '',
        model: row.model || '',
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
        outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
        createdAt: row.created_at,
      })
      messagesByConversation.set(row.conversation_id, list)
    }
    // 手动拖拽过顺序的会话按 sort_order 排；没排过的（0）仍按最近更新排在最前
    const conversations = this.db.prepare('SELECT * FROM conversations ORDER BY sort_order ASC, datetime(updated_at) DESC, rowid DESC').all().map((row) => {
      const messages = messagesByConversation.get(row.id) || []
      return {
        id: row.id,
        botId: row.bot_id,
        kind: row.bot_id === NATIVE_BOT_ID ? 'native' : 'bot',
        title: row.title,
        channelId: row.channel_id,
        externalThreadId: row.external_thread_id || row.hermes_session_id || '',
        runtimeEngine: row.runtime_engine === 'hermes' ? 'legacy' : row.runtime_engine || (row.hermes_session_id ? 'legacy' : ''),
        runtimeSessionId: row.runtime_session_id || row.hermes_session_id || '',
        modelProvider: row.model_provider || '',
        model: row.model || '',
        reasoningEffort: ['none', 'low', 'high', 'max'].includes(row.reasoning_effort) ? row.reasoning_effort : 'high',
        workspacePath: row.workspace_path || '',
        usage: conversationUsage(row.usage_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: messages.length,
        archived: asBoolean(row.archived),
        sortOrder: Number(row.sort_order || 0),
        groupId: row.group_id || '',
        messages,
      }
    })
    const conversationGroups = this.db.prepare('SELECT * FROM conversation_groups ORDER BY sort_order ASC, datetime(created_at) ASC, rowid ASC').all().map((row) => ({
      id: row.id,
      botId: row.bot_id || '',
      name: row.name,
      sortOrder: Number(row.sort_order || 0),
      collapsed: asBoolean(row.collapsed),
      createdAt: row.created_at,
    }))
    const settings = this.#loadSettingsSlice()
    const catalogRows = this.db.prepare('SELECT * FROM model_catalog_entries WHERE model<>\'\' ORDER BY datetime(fetched_at) DESC, rowid DESC').all()
    const catalogContextWindows = new Map(catalogRows.map((row) => [`${row.provider}\0${row.model}`, resolvedContextWindow(row.provider, row.model, row.context_window)]))
    const contextWindowFor = (provider, model) => catalogContextWindows.get(`${provider}\0${model}`) || inferredContextWindow(provider, model)
    const modelRow = plain(this.db.prepare("SELECT * FROM model_settings WHERE id='default'").get())
    const modelConfiguration = modelRow ? {
      provider: modelRow.provider,
      model: modelRow.model,
      baseUrl: modelRow.base_url,
      apiKeyName: modelRow.api_key_name,
      apiKeyConfigured: asBoolean(modelRow.api_key_configured),
      updatedAt: modelRow.updated_at,
      contextWindow: contextWindowFor(modelRow.provider, modelRow.model),
    } : { ...defaultModelConfiguration, contextWindow: contextWindowFor(defaultModelConfiguration.provider, defaultModelConfiguration.model) }
    const savedModelConfigurations = this.db.prepare('SELECT * FROM saved_model_configurations WHERE model<>\'\' ORDER BY datetime(updated_at) DESC, rowid DESC').all().map((row) => ({
      provider: row.provider,
      model: row.model,
      baseUrl: row.base_url,
      apiKeyName: row.api_key_name,
      apiKeyConfigured: asBoolean(row.api_key_configured),
      updatedAt: row.updated_at,
      contextWindow: contextWindowFor(row.provider, row.model),
    }))
    const credentialProviders = new Set(savedModelConfigurations.filter((item) => item.apiKeyConfigured).map((item) => item.provider))
    if (modelConfiguration.apiKeyConfigured) credentialProviders.add(modelConfiguration.provider)
    const canSelectModel = (item) => credentialProviders.has(item.provider)
      || (item.provider === 'custom' && isLocalModelEndpoint(item.baseUrl))
      || (item.provider === modelConfiguration.provider && item.model === modelConfiguration.model)
    const catalogProviders = new Set(catalogRows.map((row) => row.provider))
    const catalogModelKeys = new Set(catalogRows.map((row) => `${row.provider}\0${row.model}`))
    const currentModelKey = `${modelConfiguration.provider}\0${modelConfiguration.model}`
    const selectableSavedModelConfigurations = savedModelConfigurations.filter((item) => {
      const key = `${item.provider}\0${item.model}`
      return canSelectModel(item) && (!catalogProviders.has(item.provider) || catalogModelKeys.has(key) || key === currentModelKey)
    })
    const selectableSavedModelKeys = new Set(selectableSavedModelConfigurations.map((item) => `${item.provider}\0${item.model}`))
    const catalogModelConfigurations = catalogRows.filter((row) => !selectableSavedModelKeys.has(`${row.provider}\0${row.model}`) && canSelectModel({ provider: row.provider, model: row.model, baseUrl: row.base_url })).map((row) => ({
      provider: row.provider,
      model: row.model,
      baseUrl: row.base_url,
      apiKeyName: row.api_key_name,
      apiKeyConfigured: asBoolean(row.api_key_configured),
      updatedAt: row.fetched_at,
      contextWindow: contextWindowFor(row.provider, row.model),
    }))
    const availableModelConfigurations = [...selectableSavedModelConfigurations, ...catalogModelConfigurations]
    const scheduledTasks = this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY datetime(created_at) DESC, rowid DESC').all().map(scheduledTaskFromRow)
    const scheduledTaskRuns = this.db.prepare('SELECT * FROM scheduled_task_runs ORDER BY datetime(started_at) DESC, rowid DESC LIMIT 200').all().map(scheduledTaskRunFromRow)
    return { bots, nativeBot, channels, gatewayConnections, skills, activities, conversations, conversationGroups, scheduledTasks, scheduledTaskRuns, settings, modelConfiguration, savedModelConfigurations, availableModelConfigurations, storagePath: this.filePath, skillsPath: this.skillManager?.rootPath }
  }

  createBot(bot) {
    this.#transaction(() => {
      this.#insertBot(bot)
      const assignSkill = this.db.prepare('INSERT OR REPLACE INTO bot_skills (bot_id, skill_id, enabled) VALUES (?, ?, ?)')
      for (const skill of this.#availableSkills()) assignSkill.run(bot.id, skill.id, skill.essential || skill.defaultEnabled ? 1 : 0)
      this.#addActivity(bot.id, 'system', 'Bot 已创建', `${bot.name} 的独立记忆空间和消息路由已就绪`, {
        operation: 'bot.create',
        botId: bot.id,
        initialStatus: bot.status,
        model: bot.model || 'global-default',
      })
    })
    return this.loadWorkspace()
  }

  duplicateBot(sourceBotId, duplicateBotId) {
    this.#ensureSkillAssignmentRows()
    this.#transaction(() => {
      const source = this.db.prepare('SELECT * FROM bots WHERE id=?').get(sourceBotId)
      if (!source) throw new Error('要复制的 Bot 不存在')

      const existingNames = new Set(this.db.prepare('SELECT name FROM bots').all().map((row) => row.name))
      let copyNumber = 1
      let duplicateName = `${source.name} 副本`
      while (existingNames.has(duplicateName)) {
        copyNumber += 1
        duplicateName = `${source.name} 副本 ${copyNumber}`
      }

      this.db.prepare(`
        INSERT INTO bots (id, name, initials, role, description, status, color, model_provider, model, memory_count, memory_size, last_active, conversations, success_rate, prompt)
        VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?, 0, '0 KB', '尚未运行', 0, 100, ?)
      `).run(duplicateBotId, duplicateName, source.initials, source.role, source.description, source.color, source.model_provider || '', source.model, source.prompt)
      this.db.prepare("INSERT INTO bot_channels (bot_id, channel_id) VALUES (?, 'web')").run(duplicateBotId)
      this.db.prepare(`
        INSERT INTO bot_skills (bot_id, skill_id, enabled)
        SELECT ?, skill_id, enabled FROM bot_skills WHERE bot_id=?
      `).run(duplicateBotId, sourceBotId)
      this.#addActivity(duplicateBotId, 'system', 'Bot 已复制', `已从 ${source.name} 复制身份、模型与技能分配；私有数据和网关凭证未复制`, {
        operation: 'bot.duplicate',
        sourceBotId,
        botId: duplicateBotId,
      })
    })
    return this.loadWorkspace()
  }

  updateBot(bot) {
    this.#transaction(() => {
      const previous = this.db.prepare('SELECT * FROM bots WHERE id=?').get(bot.id)
      if (!previous) throw new Error('Bot 不存在')
      const result = this.db.prepare(`
        UPDATE bots SET name=?, initials=?, role=?, description=?, status=?, color=?, model_provider=?, model=?, last_active=?, conversations=?, success_rate=?, prompt=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(bot.name, bot.initials, bot.role, bot.description, bot.status, bot.color, bot.modelProvider || '', bot.model || '', bot.lastActive, bot.conversations, bot.successRate, bot.prompt, bot.id)
      if (!result.changes) throw new Error('Bot 不存在')
      this.db.prepare('DELETE FROM bot_channels WHERE bot_id=?').run(bot.id)
      const channelStatement = this.db.prepare('INSERT INTO bot_channels (bot_id, channel_id) VALUES (?, ?)')
      for (const channelId of bot.channels.filter((id) => id === 'web')) channelStatement.run(bot.id, channelId)

      if (previous.status !== bot.status) {
        const previousStatus = previous.status === 'online' ? '运行中' : previous.status === 'paused' ? '已暂停' : '离线'
        const nextStatus = bot.status === 'online' ? '运行中' : bot.status === 'paused' ? '已暂停' : '离线'
        const gatewayEffect = bot.status === 'online' ? '恢复已启用消息网关' : '停止接收外部消息'
        this.#addActivity(bot.id, 'system', bot.status === 'online' ? 'Bot 已启动' : 'Bot 已暂停', `状态从“${previousStatus}”切换为“${nextStatus}”；${gatewayEffect}。`, {
          operation: 'bot.status.change',
          previousStatus,
          nextStatus,
          gatewayEffect,
        })
      }

      const changedFields = [
        { label: '名称', previous: previous.name, next: bot.name },
        { label: '角色', previous: previous.role, next: bot.role },
        { label: '描述', previous: previous.description, next: bot.description },
        { label: '标识颜色', previous: previous.color, next: bot.color },
        { label: '模型供应商', previous: previous.model_provider, next: bot.modelProvider || '' },
        { label: '模型 ID', previous: previous.model, next: bot.model || '' },
        { label: '系统提示词', previous: previous.prompt, next: bot.prompt },
      ].filter((field) => String(field.previous || '') !== String(field.next || '')).map((field) => field.label)
      if (changedFields.length) {
        this.#addActivity(bot.id, 'system', 'Bot 配置已更新', `已更新：${changedFields.join('、')}。`, {
          operation: 'bot.configuration.update',
          changedFields: changedFields.join(', '),
          modelProvider: bot.modelProvider || 'global-default',
          model: bot.model || 'global-default',
        })
      }
    })
    return this.loadWorkspace()
  }

  deleteBot(botId) {
    if (botId === NATIVE_BOT_ID) throw new Error('AI 对话空间不能作为 Bot 删除')
    this.#transaction(() => {
      this.db.prepare('DELETE FROM deleted_external_messages WHERE bot_id=?').run(botId)
      const result = this.db.prepare('DELETE FROM bots WHERE id=?').run(botId)
      if (!result.changes) throw new Error('Bot 不存在')
    })
    this.#synchronizeChannelMessageStats()
    return this.loadWorkspace()
  }

  createMemory(botId, memory) {
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO memories (id, bot_id, title, excerpt, type, updated_at, source, confidence, evidence, conversation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(memory.id, botId, memory.title, memory.excerpt, memory.type, memory.updatedAt, memory.source, Number(memory.confidence ?? 1), memory.evidence || '', memory.conversationId || '', memory.createdAt || new Date().toISOString())
      this.#synchronizeMemoryStats(botId)
      this.#addActivity(botId, 'memory', '新增长期记忆', `已新增“${memory.title}”，类型为 ${memory.type}，来源为 ${memory.source}。`, {
        operation: 'memory.create', memoryId: memory.id, memoryType: memory.type, source: memory.source,
      })
    })
    return this.loadWorkspace()
  }

  updateMemory(botId, memory) {
    this.#transaction(() => {
      const previous = this.db.prepare('SELECT confidence, evidence, conversation_id FROM memories WHERE id=? AND bot_id=?').get(memory.id, botId)
      if (!previous) throw new Error('记忆不存在或不属于当前空间')
      const result = this.db.prepare(`
        UPDATE memories
        SET title=?, excerpt=?, type=?, updated_at=?, source=?, confidence=?, evidence=?, conversation_id=?
        WHERE id=? AND bot_id=?
      `).run(memory.title, memory.excerpt, memory.type, memory.updatedAt, memory.source, Number(memory.confidence ?? previous.confidence ?? 1), memory.evidence ?? previous.evidence ?? '', memory.conversationId ?? previous.conversation_id ?? '', memory.id, botId)
      if (!result.changes) throw new Error('记忆不存在或不属于当前空间')
      this.#synchronizeMemoryStats(botId)
      this.#addActivity(botId, 'memory', '更新长期记忆', `已更新“${memory.title}”，类型为 ${memory.type}，来源为 ${memory.source}。`, {
        operation: 'memory.update', memoryId: memory.id, memoryType: memory.type, source: memory.source,
      })
    })
    return this.loadWorkspace()
  }

  upsertAutoMemories(botId, proposals, { conversationId = '', source = 'ZSense 自动记忆', maxItems = 500 } = {}) {
    const result = { created: 0, updated: 0, skipped: 0, memoryIds: [] }
    const allowedTypes = new Set(['fact', 'preference', 'episode'])
    this.#transaction(() => {
      if (!this.db.prepare('SELECT id FROM bots WHERE id=?').get(botId)) throw new Error('记忆空间不存在。')
      const rows = this.db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY rowid DESC').all(botId)
      const byId = new Map(rows.map((row) => [row.id, row]))
      const byTitle = new Map(rows.map((row) => [normalizedMemoryValue(row.title), row]))
      const byExcerpt = new Map(rows.map((row) => [normalizedMemoryValue(row.excerpt), row]))
      const insert = this.db.prepare(`
        INSERT INTO memories (id, bot_id, title, excerpt, type, updated_at, source, confidence, evidence, conversation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const update = this.db.prepare(`
        UPDATE memories
        SET title=?, excerpt=?, type=?, updated_at=?, source=?, confidence=?, evidence=?, conversation_id=?
        WHERE id=? AND bot_id=?
      `)
      const updatedAt = new Date().toISOString()
      const safeSource = String(source || 'ZSense 自动记忆').trim().slice(0, 200) || 'ZSense 自动记忆'
      const capacity = Math.max(50, Math.min(5_000, Number(maxItems) || 500))
      for (const proposal of Array.isArray(proposals) ? proposals.slice(0, 5) : []) {
        const title = String(proposal?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        const excerpt = String(proposal?.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 20_000)
        const type = allowedTypes.has(proposal?.type) ? proposal.type : ''
        if (!title || !excerpt || !type || unsafeAutomaticMemory(`${title}\n${excerpt}\n${proposal?.evidence || ''}`)) { result.skipped += 1; continue }
        const rawConfidence = Number(proposal?.confidence)
        const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0
        const evidence = String(proposal?.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 1_000)
        if (!evidence || confidence < 0.75) { result.skipped += 1; continue }
        const requestedTargetId = String(proposal?.matchId || '')
        const updateRequested = proposal?.action === 'update'
        // 模型只能明确修订已存在的自动记忆；不能以“新增”或模糊相似度覆盖旧结论。
        if (updateRequested && !byId.has(requestedTargetId)) { result.skipped += 1; continue }
        const exactTarget = byId.get(String(proposal?.matchId || '')) || byExcerpt.get(normalizedMemoryValue(excerpt)) || byTitle.get(normalizedMemoryValue(title))
        const similarTarget = exactTarget ? null : findSimilarMemory(rows, { title, excerpt }, { threshold: 0.84 })?.memory
        const target = exactTarget || similarTarget
        if (target) {
          // 自动整理绝不能覆盖用户或 Agent 手动策展的记忆；相似时也不再制造副本。
          if (!isAutomaticMemory(target)) { result.skipped += 1; continue }
          const unchanged = normalizedMemoryValue(target.title) === normalizedMemoryValue(title)
            && normalizedMemoryValue(target.excerpt) === normalizedMemoryValue(excerpt)
            && target.type === type
          if (unchanged) { result.skipped += 1; continue }
          if (!updateRequested || requestedTargetId !== target.id) { result.skipped += 1; continue }
          update.run(title, excerpt, type, updatedAt, safeSource, confidence, evidence, conversationId, target.id, botId)
          const next = { ...target, title, excerpt, type, updated_at: updatedAt, source: safeSource, confidence, evidence, conversation_id: conversationId }
          if (byTitle.get(normalizedMemoryValue(target.title))?.id === target.id) byTitle.delete(normalizedMemoryValue(target.title))
          if (byExcerpt.get(normalizedMemoryValue(target.excerpt))?.id === target.id) byExcerpt.delete(normalizedMemoryValue(target.excerpt))
          const rowIndex = rows.findIndex((row) => row.id === target.id)
          if (rowIndex >= 0) rows[rowIndex] = next
          byId.set(target.id, next)
          byTitle.set(normalizedMemoryValue(title), next)
          byExcerpt.set(normalizedMemoryValue(excerpt), next)
          result.updated += 1
          result.memoryIds.push(target.id)
          continue
        }
        if (rows.length >= capacity) { result.skipped += 1; continue }
        const memoryId = `auto-memory-${randomUUID()}`
        insert.run(memoryId, botId, title, excerpt, type, updatedAt, safeSource, confidence, evidence, conversationId, updatedAt)
        const next = { id: memoryId, title, excerpt, type, updated_at: updatedAt, source: safeSource, confidence, evidence, conversation_id: conversationId, created_at: updatedAt }
        rows.push(next)
        byId.set(memoryId, next)
        byTitle.set(normalizedMemoryValue(title), next)
        byExcerpt.set(normalizedMemoryValue(excerpt), next)
        result.created += 1
        result.memoryIds.push(memoryId)
      }
      if (result.created || result.updated) {
        this.#synchronizeMemoryStats(botId)
        const detail = [result.created ? `新增 ${result.created} 条` : '', result.updated ? `更新 ${result.updated} 条` : ''].filter(Boolean).join('，')
        this.#addActivity(botId, 'memory', '自动整理长期记忆', `${detail}长期记忆；所有内容均保存在当前独立记忆空间。`, {
          operation: 'memory.auto-upsert', conversationId, created: result.created, updated: result.updated,
        })
      }
    })
    return result
  }

  // Hindsight 是自动记忆的主数据源；SQLite 只保留供现有界面展示和编辑的投影。
  // 旧版/人工记忆不属于此投影，迁移期间始终保留原样。
  replaceHindsightMemoryProjection(botId, records) {
    this.#transaction(() => {
      if (!this.db.prepare('SELECT id FROM bots WHERE id=?').get(botId)) throw new Error('记忆空间不存在。')
      const existing = new Map(this.db.prepare("SELECT id, title, excerpt, type, updated_at, conversation_id FROM memories WHERE bot_id=? AND source='Hindsight 自动记忆'").all(botId).map((row) => [row.id, row]))
      const incoming = new Map((Array.isArray(records) ? records : [])
        .filter((memory) => String(memory.id || '').startsWith('hindsight-') && memory.excerpt)
        .map((memory) => [memory.id, memory]))
      const remove = this.db.prepare("DELETE FROM memories WHERE id=? AND bot_id=? AND source='Hindsight 自动记忆'")
      for (const id of existing.keys()) if (!incoming.has(id)) remove.run(id, botId)
      const insert = this.db.prepare(`
        INSERT INTO memories (id, bot_id, title, excerpt, type, updated_at, source, confidence, evidence, conversation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const update = this.db.prepare("UPDATE memories SET title=?, excerpt=?, type=?, updated_at=?, conversation_id=? WHERE id=? AND bot_id=? AND source='Hindsight 自动记忆'")
      for (const memory of incoming.values()) {
        const prior = existing.get(memory.id)
        if (!prior) {
          insert.run(memory.id, botId, memory.title, memory.excerpt, memory.type, memory.updatedAt,
            'Hindsight 自动记忆', Number(memory.confidence ?? 1), memory.evidence || '', memory.conversationId || '', memory.updatedAt)
        } else if (prior.title !== memory.title || prior.excerpt !== memory.excerpt || prior.type !== memory.type
          || prior.updated_at !== memory.updatedAt || prior.conversation_id !== (memory.conversationId || '')) {
          update.run(memory.title, memory.excerpt, memory.type, memory.updatedAt, memory.conversationId || '', memory.id, botId)
        }
      }
      this.#synchronizeMemoryStats(botId)
    })
    return this.loadWorkspace()
  }

  deleteMemory(botId, memoryId) {
    this.#transaction(() => {
      const memory = this.db.prepare('SELECT title, type, source FROM memories WHERE id=? AND bot_id=?').get(memoryId, botId)
      const result = this.db.prepare('DELETE FROM memories WHERE id=? AND bot_id=?').run(memoryId, botId)
      if (!result.changes) throw new Error('记忆不存在或不属于该 Bot')
      this.#synchronizeMemoryStats(botId)
      this.#addActivity(botId, 'memory', '删除长期记忆', `“${memory?.title || memoryId}”已从独立命名空间移除。`, {
        operation: 'memory.delete', memoryId, memoryType: memory?.type || 'unknown', source: memory?.source || 'unknown',
      })
    })
    return this.loadWorkspace()
  }

  getMemory(botId, memoryId) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=? AND bot_id=?').get(memoryId, botId)
    return memoryFromRow(row)
  }

  listMemories(botId) {
    return this.db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY datetime(updated_at) DESC, rowid DESC').all(botId).map(memoryFromRow)
  }

  recallMemories(botId, query, { limit = 24, characterBudget = 4_800 } = {}) {
    const selected = selectRelevantMemories(this.listMemories(botId), query, { limit, characterBudget })
    if (!selected.memories.length) return selected
    const recalledAt = new Date().toISOString()
    this.#transaction(() => {
      const update = this.db.prepare('UPDATE memories SET recall_count=recall_count+1, last_recalled_at=? WHERE id=? AND bot_id=?')
      for (const memory of selected.memories) update.run(recalledAt, memory.id, botId)
    })
    return {
      ...selected,
      memories: selected.memories.map((memory) => ({ ...memory, recallCount: memory.recallCount + 1, lastRecalledAt: recalledAt })),
    }
  }

  searchMemories(botId, query, limit = 8) {
    const term = String(query || '').trim().slice(0, 300)
    if (!term) return []
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 8))
    return this.listMemories(botId)
      .map((memory) => ({ memory, ...scoreMemoryForQuery(memory, term) }))
      .filter((entry) => entry.lexicalHits > 0)
      .sort((left, right) => right.score - left.score || right.lexicalHits - left.lexicalHits)
      .slice(0, safeLimit)
      .map(({ memory }) => ({ id: memory.id, title: memory.title, excerpt: memory.excerpt.slice(0, 1_200), type: memory.type, source: memory.source, updatedAt: memory.updatedAt }))
  }

  recentUserMessages(botId, limit = 24) {
    return this.db.prepare(`
      SELECT m.content, m.created_at, m.conversation_id
      FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      WHERE c.bot_id=? AND c.channel_id<>'scheduled' AND m.role='user'
      ORDER BY datetime(m.created_at) DESC, m.rowid DESC
      LIMIT ?
    `).all(botId, Math.max(1, Math.min(100, Number(limit) || 24))).reverse().map((row) => ({
      content: row.content,
      createdAt: row.created_at,
      conversationId: row.conversation_id,
    }))
  }

  userMessagesForMemoryReview(botId, claim, limit = 48) {
    const previousTurn = Math.max(0, Number(claim?.previous) || 0)
    const boundary = previousTurn > 0 ? this.db.prepare(`
      SELECT m.rowid AS row_id
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.bot_id=? AND c.channel_id<>'scheduled' AND m.role='assistant'
      ORDER BY m.rowid ASC LIMIT 1 OFFSET ?
    `).get(botId, previousTurn - 1)?.row_id : 0
    return this.db.prepare(`
      SELECT m.content, m.created_at, m.conversation_id
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.bot_id=? AND c.channel_id<>'scheduled' AND m.role='user' AND m.rowid>?
      ORDER BY m.rowid DESC LIMIT ?
    `).all(botId, boundary || 0, Math.max(1, Math.min(100, Number(limit) || 48))).reverse().map((row) => ({
      content: row.content,
      createdAt: row.created_at,
      conversationId: row.conversation_id,
    }))
  }

  claimPeriodicMemoryReview(botId, interval = 10) {
    const safeInterval = Math.max(2, Math.min(100, Number(interval) || 10))
    const successfulTurns = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      WHERE c.bot_id=? AND c.channel_id<>'scheduled' AND m.role='assistant'
    `).get(botId).count)
    const previous = Number(this.db.prepare('SELECT last_reviewed_turn FROM memory_review_state WHERE bot_id=?').get(botId)?.last_reviewed_turn || 0)
    if (this.memoryReviewClaims.has(botId) || successfulTurns - previous < safeInterval) return { claimed: false, successfulTurns, previous }
    const claim = { claimed: true, successfulTurns, previous, token: randomUUID() }
    this.memoryReviewClaims.set(botId, claim.token)
    return claim
  }

  completePeriodicMemoryReviewClaim(botId, claim) {
    if (!claim?.claimed || this.memoryReviewClaims.get(botId) !== claim.token) return false
    try {
      this.db.prepare(`
        INSERT INTO memory_review_state (bot_id, last_reviewed_turn, reviewed_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(bot_id) DO UPDATE SET last_reviewed_turn=excluded.last_reviewed_turn, reviewed_at=excluded.reviewed_at
      `).run(botId, claim.successfulTurns)
      return true
    } finally {
      this.memoryReviewClaims.delete(botId)
    }
  }

  releasePeriodicMemoryReviewClaim(botId, claim) {
    if (!claim?.claimed || this.memoryReviewClaims.get(botId) !== claim.token) return false
    this.memoryReviewClaims.delete(botId)
    return true
  }

  getGatewayConnection(connectionId) {
    return gatewayConnectionFromRow(this.db.prepare('SELECT * FROM gateway_connections WHERE id=?').get(connectionId), true)
  }

  findGatewayConnection(botId, provider) {
    return gatewayConnectionFromRow(this.db.prepare('SELECT * FROM gateway_connections WHERE bot_id=? AND provider=?').get(botId, provider), true)
  }

  upsertGatewayConnection(connection) {
    this.#upsertGatewayConnection(connection)
    return this.loadWorkspace()
  }

  deleteGatewayConnection(connectionId) {
    const result = this.db.prepare('DELETE FROM gateway_connections WHERE id=?').run(connectionId)
    if (!result.changes) throw new Error('消息网关实例不存在')
    return this.loadWorkspace()
  }

  updateModelConfiguration(configuration) {
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO model_settings (id, provider, model, base_url, api_key_name, api_key_configured, updated_at)
        VALUES ('default', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model, base_url=excluded.base_url, api_key_name=excluded.api_key_name, api_key_configured=excluded.api_key_configured, updated_at=excluded.updated_at
      `).run(configuration.provider, configuration.model, configuration.baseUrl, configuration.apiKeyName, configuration.apiKeyConfigured ? 1 : 0, configuration.updatedAt)
      this.db.prepare('UPDATE saved_model_configurations SET api_key_configured=?, api_key_name=?, base_url=? WHERE provider=?')
        .run(configuration.apiKeyConfigured ? 1 : 0, configuration.apiKeyName, configuration.baseUrl, configuration.provider)
      this.db.prepare('UPDATE model_catalog_entries SET api_key_configured=?, api_key_name=?, base_url=? WHERE provider=?')
        .run(configuration.apiKeyConfigured ? 1 : 0, configuration.apiKeyName, configuration.baseUrl, configuration.provider)
      this.db.prepare(`
        INSERT INTO saved_model_configurations (provider, model, base_url, api_key_name, api_key_configured, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, model) DO UPDATE SET base_url=excluded.base_url, api_key_name=excluded.api_key_name, api_key_configured=excluded.api_key_configured, updated_at=excluded.updated_at
      `).run(configuration.provider, configuration.model, configuration.baseUrl, configuration.apiKeyName, configuration.apiKeyConfigured ? 1 : 0, configuration.updatedAt)
    })
    return this.loadWorkspace()
  }

  upsertPortableModelConfiguration(configuration, setDefault = false) {
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO saved_model_configurations (provider, model, base_url, api_key_name, api_key_configured, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, model) DO UPDATE SET base_url=excluded.base_url, api_key_name=excluded.api_key_name,
          api_key_configured=MAX(saved_model_configurations.api_key_configured, excluded.api_key_configured), updated_at=excluded.updated_at
      `).run(configuration.provider, configuration.model, configuration.baseUrl, configuration.apiKeyName, configuration.apiKeyConfigured ? 1 : 0, configuration.updatedAt)
      if (setDefault) {
        this.db.prepare(`
          INSERT INTO model_settings (id, provider, model, base_url, api_key_name, api_key_configured, updated_at)
          VALUES ('default', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model, base_url=excluded.base_url,
            api_key_name=excluded.api_key_name, api_key_configured=excluded.api_key_configured, updated_at=excluded.updated_at
        `).run(configuration.provider, configuration.model, configuration.baseUrl, configuration.apiKeyName, configuration.apiKeyConfigured ? 1 : 0, configuration.updatedAt)
      }
    })
    return this.loadWorkspace()
  }

  syncModelCatalog(catalog, configuration) {
    const models = [...new Set((Array.isArray(catalog?.models) ? catalog.models : []).map((model) => String(model || '').trim().slice(0, 300)).filter(Boolean))]
    const synchronizedContextWindows = new Map((Array.isArray(catalog?.entries) ? catalog.entries : []).map((entry) => [
      String(entry?.id || '').trim(),
      resolvedContextWindow(catalog.provider, entry?.id, entry?.contextWindow),
    ]).filter(([model]) => model))
    const fetchedAt = String(catalog?.fetchedAt || new Date().toISOString())
    this.#transaction(() => {
      this.db.prepare('DELETE FROM model_catalog_entries WHERE provider=?').run(catalog.provider)
      const insert = this.db.prepare(`
        INSERT INTO model_catalog_entries (provider, model, base_url, api_key_name, api_key_configured, endpoint, context_window, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const model of models) {
        insert.run(catalog.provider, model, configuration.baseUrl || '', configuration.apiKeyName, configuration.apiKeyConfigured ? 1 : 0, catalog.endpoint || '', synchronizedContextWindows.get(model) || inferredContextWindow(catalog.provider, model), fetchedAt)
      }
    })
    return this.loadWorkspace()
  }

  findSavedModelConfiguration(provider, model) {
    const row = plain(this.db.prepare('SELECT * FROM saved_model_configurations WHERE provider=? AND model=?').get(provider, model))
    return row ? {
      provider: row.provider,
      model: row.model,
      baseUrl: row.base_url,
      apiKeyName: row.api_key_name,
      apiKeyConfigured: asBoolean(row.api_key_configured),
      updatedAt: row.updated_at,
    } : null
  }

  setSkillEnabled(skillId, enabled) {
    const skill = this.skillManager?.getSkill(skillId)
    if (!skill) throw new Error('技能不存在或文件已被移动。')
    const botIds = enabled ? this.db.prepare('SELECT id FROM bots WHERE id<>? ORDER BY rowid').all(NATIVE_BOT_ID).map((row) => row.id) : []
    const assignedBotIds = this.#replaceSkillAssignments(skill, botIds)
    this.#upsertSkill({ ...skill, enabled: Boolean(assignedBotIds.length) })
    return this.loadWorkspace()
  }

  setSkillAssignments(skillId, botIds) {
    const skill = this.skillManager?.getSkill(skillId)
    if (!skill) throw new Error('技能不存在或文件已被移动。')
    const knownBotIds = new Set(this.db.prepare('SELECT id FROM bots WHERE id<>?').all(NATIVE_BOT_ID).map((row) => row.id))
    const invalidBotId = botIds.find((botId) => !knownBotIds.has(botId))
    if (invalidBotId) throw new Error('所选 Bot 不存在或已经被删除。')
    const assignedBotIds = this.#replaceSkillAssignments(skill, botIds)
    this.#upsertSkill({ ...skill, enabled: Boolean(assignedBotIds.length) })
    return this.loadWorkspace()
  }

  createSkill(input) {
    if (!this.skillManager) throw new Error('技能文件管理器尚未就绪。')
    const skill = this.skillManager.createSkill(input)
    const assignedBotIds = this.#replaceSkillAssignments(skill, input.assignedBotIds || [])
    this.#upsertSkill({ ...skill, enabled: Boolean(assignedBotIds.length) })
    return this.loadWorkspace()
  }

  updateSkill(skillId, input) {
    if (!this.skillManager) throw new Error('技能文件管理器尚未就绪。')
    const skill = this.skillManager.updateSkill(skillId, input)
    const assignedBotIds = this.#replaceSkillAssignments(skill, input.assignedBotIds || [])
    this.#upsertSkill({ ...skill, enabled: Boolean(assignedBotIds.length) })
    return this.loadWorkspace()
  }

  restoreSkillVersion(skillId, snapshotId) {
    if (!this.skillManager) throw new Error('技能文件管理器尚未就绪。')
    const restored = this.skillManager.restoreVersion(skillId, snapshotId)
    this.#upsertSkill(restored)
    return this.loadWorkspace()
  }

  recordSkillUsage({ botId, conversationId, toolEvents = [], durationMs = 0 }) {
    const loadedNames = [...new Set(toolEvents.filter((event) => event?.name === 'load_skill' && event?.status === 'complete').flatMap((event) => {
      try {
        const input = typeof event.input === 'string' ? JSON.parse(event.input) : event.input
        return typeof input?.name === 'string' && input.name.trim() ? [input.name.trim()] : []
      } catch { return [] }
    }))]
    if (!loadedNames.length) return 0
    const skillsByName = new Map((this.skillManager?.listSkills() || []).map((skill) => [skill.name, skill]))
    const status = toolEvents.some((event) => event?.status === 'error') ? 'error' : 'success'
    const statement = this.db.prepare('INSERT INTO skill_usage_events (id, skill_id, bot_id, conversation_id, status, duration_ms, tool_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
    let inserted = 0
    this.#transaction(() => {
      for (const name of loadedNames) {
        const skill = skillsByName.get(name)
        if (!skill) continue
        statement.run(randomUUID(), skill.id, botId, conversationId, status, Math.max(0, Math.round(Number(durationMs) || 0)), toolEvents.length)
        inserted += 1
      }
    })
    return inserted
  }

  importSkill(sourcePath) {
    if (!this.skillManager) throw new Error('技能文件管理器尚未就绪。')
    const skill = this.skillManager.importSkill(sourcePath)
    const allBotIds = this.db.prepare('SELECT id FROM bots WHERE id<>? ORDER BY rowid').all(NATIVE_BOT_ID).map((row) => row.id)
    const assignedBotIds = this.#replaceSkillAssignments(skill, allBotIds)
    this.#upsertSkill({ ...skill, enabled: Boolean(assignedBotIds.length) })
    return { skill, workspace: this.loadWorkspace() }
  }

  deleteSkill(skillId) {
    if (!this.skillManager) throw new Error('技能文件管理器尚未就绪。')
    this.skillManager.deleteSkill(skillId)
    this.db.prepare('DELETE FROM bot_skills WHERE skill_id=?').run(skillId)
    this.db.prepare('DELETE FROM skills WHERE id=?').run(skillId)
    return this.loadWorkspace()
  }

  forgetSkill(skillId) {
    this.db.prepare('DELETE FROM bot_skills WHERE skill_id=?').run(skillId)
    this.db.prepare('DELETE FROM skills WHERE id=?').run(skillId)
    return this.loadWorkspace()
  }

  updateSettings(settings) {
    this.#transaction(() => {
      const statement = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      for (const [key, value] of Object.entries(settings)) statement.run(key, JSON.stringify(value))
    })
    return this.loadWorkspace()
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    if (!row) return undefined
    try { return JSON.parse(row.value) } catch { return row.value }
  }

  countUsers() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count)
  }

  countEnabledAdmins() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE enabled=1 AND role='admin'").get().count)
  }

  listUsers() {
    return this.db.prepare(`
      SELECT id, username, display_name, email, role, enabled, created_at, updated_at, last_login_at,
             (account_password_hash <> '') AS account_password_hash
      FROM users
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, lower(username)
    `).all().map(userFromRow)
  }

  getUserById(userId, includeCredentials = false) {
    const columns = includeCredentials ? '*' : "id, username, display_name, email, role, enabled, created_at, updated_at, last_login_at, (account_password_hash <> '') AS account_password_hash"
    return userFromRow(this.db.prepare(`SELECT ${columns} FROM users WHERE id=?`).get(userId))
  }

  getUserByUsername(username, includeCredentials = false) {
    const columns = includeCredentials ? '*' : 'id, username, display_name, role, enabled, created_at, updated_at, last_login_at'
    const row = this.db.prepare(`SELECT ${columns} FROM users WHERE username=? COLLATE NOCASE`).get(username)
    if (!row) return null
    const user = userFromRow(row)
    return includeCredentials
      ? { ...user, passwordHash: row.password_hash, passwordSalt: row.password_salt, accountPasswordHash: row.account_password_hash || '', accountPasswordSalt: row.account_password_salt || '' }
      : user
  }

  createUser(user) {
    try {
      this.db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, password_salt, role, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, user.username, user.displayName, user.passwordHash, user.passwordSalt, user.role, user.enabled ? 1 : 0, user.createdAt, user.createdAt)
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new Error('这个用户名已经存在。')
      throw error
    }
    return this.getUserById(user.id)
  }

  updateUser(userId, changes) {
    const current = this.getUserById(userId)
    if (!current) throw new Error('用户不存在或已经被删除。')
    const role = changes.role ?? current.role
    const enabled = changes.enabled ?? current.enabled
    if (current.role === 'admin' && current.enabled && (role !== 'admin' || !enabled) && this.countEnabledAdmins() <= 1) {
      throw new Error('至少需要保留一个已启用的管理员。')
    }
    try {
      this.db.prepare(`
        UPDATE users SET username=?, display_name=?, role=?, enabled=?, updated_at=? WHERE id=?
      `).run(changes.username ?? current.username, changes.displayName ?? current.displayName, role, enabled ? 1 : 0, changes.updatedAt, userId)
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new Error('这个用户名已经存在。')
      throw error
    }
    return this.getUserById(userId)
  }

  updateUserEmail(userId, email) {
    const result = this.db.prepare('UPDATE users SET email=?, updated_at=? WHERE id=?').run(String(email || ''), new Date().toISOString(), userId)
    if (!result.changes) throw new Error('用户不存在或已经被删除。')
    return this.getUserById(userId)
  }

  updateUserAccountPassword(userId, passwordHash, passwordSalt, updatedAt) {
    const result = this.db.prepare('UPDATE users SET account_password_hash=?, account_password_salt=?, updated_at=? WHERE id=?').run(passwordHash, passwordSalt, updatedAt, userId)
    if (!result.changes) throw new Error('用户不存在或已经被删除。')
    return this.getUserById(userId)
  }

  updateUserPassword(userId, passwordHash, passwordSalt, updatedAt) {
    const result = this.db.prepare('UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?').run(passwordHash, passwordSalt, updatedAt, userId)
    if (!result.changes) throw new Error('用户不存在或已经被删除。')
    return this.getUserById(userId)
  }

  deleteUser(userId) {
    const current = this.getUserById(userId)
    if (!current) throw new Error('用户不存在或已经被删除。')
    if (current.role === 'admin' && current.enabled && this.countEnabledAdmins() <= 1) {
      throw new Error('不能删除最后一个已启用的管理员。')
    }
    this.db.prepare('DELETE FROM users WHERE id=?').run(userId)
    return this.listUsers()
  }

  recordUserLogin(userId, loggedInAt) {
    this.db.prepare('UPDATE users SET last_login_at=?, updated_at=? WHERE id=?').run(loggedInAt, loggedInAt, userId)
    return this.getUserById(userId)
  }

  getBot(botId) {
    if (botId === NATIVE_BOT_ID) return this.loadWorkspace().nativeBot || null
    return this.loadWorkspace().bots.find((bot) => bot.id === botId) || null
  }

  getEnabledSkills(botId = '') {
    return this.loadWorkspace().skills.filter((skill) => botId ? skill.assignedBotIds.includes(botId) : skill.enabled)
  }

  getScheduledTask(taskId) {
    return scheduledTaskFromRow(this.db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(taskId))
  }

  getDueScheduledTasks(nowIso) {
    return this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE enabled=1 AND status='active' AND next_run_at IS NOT NULL AND datetime(next_run_at)<=datetime(?)
      ORDER BY datetime(next_run_at), rowid
    `).all(nowIso).map(scheduledTaskFromRow)
  }

  /** 跨会话检索：只在指定空间（bot_id）内搜索历史消息，返回带片段的结果 */
  searchConversationMessages(query, { botId = '', limit = 8, roles = [] } = {}) {
    const term = String(query || '').trim()
    if (!term) return []
    const like = `%${term.replace(/[%_\\]/g, (match) => `\\${match}`)}%`
    const spaceId = String(botId || '__zsense_native__')
    const capped = Math.max(1, Math.min(50, Number(limit) || 8))
    const roleFilter = roles.filter((role) => role === 'user' || role === 'assistant')
    const rows = this.db.prepare(`
      SELECT m.conversation_id AS conversationId, c.title, c.bot_id AS botId, c.channel_id AS channelId,
             m.role, m.content, m.created_at AS createdAt
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.bot_id = ? AND m.content LIKE ? ESCAPE '\\'
        ${roleFilter.length ? `AND m.role IN (${roleFilter.map(() => '?').join(',')})` : ''}
      ORDER BY datetime(m.created_at) DESC, m.rowid DESC
      LIMIT ?
    `).all(...[spaceId, like, ...roleFilter, capped])
    return rows.map((row) => {
      const content = String(row.content || '')
      const index = content.toLowerCase().indexOf(term.toLowerCase())
      const start = index > 60 ? index - 60 : 0
      return {
        conversationId: row.conversationId,
        title: row.title || '',
        botId: row.botId,
        channelId: row.channelId || 'web',
        role: row.role,
        at: row.createdAt,
        snippet: `${start > 0 ? '…' : ''}${content.slice(start, start + 240)}${content.length > start + 240 ? '…' : ''}`,
      }
    })
  }

  /** 把 source 技能并进 target（内容追加，来源技能删除），只允许非内置技能 */
  /** 打开一条会话的最近消息（限定同一空间内，用于检索命中后查看上下文） */
  loadConversationMessages(conversationId, { botId = '', limit = 20 } = {}) {
    const id = String(conversationId || '').trim()
    if (!id) throw new Error('会话 ID 不能为空。')
    const spaceId = String(botId || '__zsense_native__')
    const conversation = this.db.prepare('SELECT id, title, bot_id, channel_id FROM conversations WHERE id=?').get(id)
    if (!conversation || conversation.bot_id !== spaceId) throw new Error('这条会话不在当前空间里。')
    const safeLimit = Math.max(1, Math.min(80, Number(limit) || 20))
    const rows = this.db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?').all(id, safeLimit)
    return {
      conversationId: id,
      title: conversation.title || '',
      channelId: conversation.channel_id || 'web',
      messages: rows.reverse().map((row) => ({ role: row.role, at: row.created_at, content: String(row.content || '').slice(0, 4_000) })),
    }
  }

  mergeSkills(sourceId, targetId) {
    const manager = this.skillManager
    if (!manager) throw new Error('技能管理器不可用。')
    const source = manager.getSkill(String(sourceId || ''))
    const target = manager.getSkill(String(targetId || ''))
    if (!source || !target) throw new Error('要合并的技能不存在或已被移动。')
    if (source.id === target.id) throw new Error('不能把技能合并到它自己。')
    if (source.builtIn || target.builtIn || source.editable === false || target.editable === false) throw new Error('内置技能不参与合并。')
    const body = String(source.content || '').replace(/^---[\s\S]*?---\s*/m, '').trim()
    const merged = `${String(target.content || '').replace(/^---[\s\S]*?---\s*/m, '').trimEnd()}\n\n## 合并自「${source.name}」\n\n${body}\n`
    const updated = manager.updateSkill(target.id, { name: target.name, description: target.description, category: target.category, content: merged })
    manager.deleteSkill(source.id)
    return { mergedInto: updated?.id || target.id, absorbed: source.id, absorbedName: source.name }
  }

  /** 归档（删除）一个非内置技能 */
  archiveSkill(skillId) {
    const manager = this.skillManager
    if (!manager) throw new Error('技能管理器不可用。')
    const skill = manager.getSkill(String(skillId || ''))
    if (!skill) throw new Error('技能不存在或已被移动。')
    if (skill.builtIn || skill.editable === false) throw new Error('内置技能不能归档。')
    manager.deleteSkill(skill.id)
    return { archived: skill.id, name: skill.name }
  }

  createScheduledTask(task) {
    this.db.prepare(`
      INSERT INTO scheduled_tasks
        (id, name, frequency, time_of_day, weekday, day_of_month, cron_expression, model_provider, model, prompt, memory_enabled, skill_ids_json, delivery_target, repeat_count, run_count, enabled, status, workspace_path, next_run_at, last_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, 0, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      task.id, task.name, task.frequency, task.timeOfDay, task.weekday, task.dayOfMonth || 1, task.cronExpression || '', task.modelProvider, task.model,
      task.prompt, task.memoryEnabled === false ? 0 : 1, JSON.stringify(task.skillIds || []), task.repeatCount, task.enabled ? 1 : 0,
      task.enabled ? 'active' : 'paused', task.workspacePath, task.nextRunAt, task.createdAt, task.updatedAt,
    )
    this.db.prepare('UPDATE scheduled_tasks SET owner_bot_id=? WHERE id=?').run(task.ownerBotId || '', task.id)
    return this.loadWorkspace()
  }

  updateScheduledTask(taskId, task) {
    const current = this.getScheduledTask(taskId)
    if (!current) throw new Error('定时任务不存在或已经被删除。')
    const resetCount = task.repeatCount > 0 && current.runCount >= task.repeatCount ? 0 : current.runCount
    const status = task.enabled ? 'active' : 'paused'
    this.db.prepare(`
      UPDATE scheduled_tasks SET
        name=?, frequency=?, time_of_day=?, weekday=?, day_of_month=?, cron_expression=?, model_provider=?, model=?, prompt=?, memory_enabled=?, skill_ids_json=?,
        repeat_count=?, run_count=?, enabled=?, status=?, workspace_path=?, next_run_at=?, updated_at=?
      WHERE id=?
    `).run(
      task.name, task.frequency, task.timeOfDay, task.weekday, task.dayOfMonth || 1, task.cronExpression || '', task.modelProvider, task.model, task.prompt,
      task.memoryEnabled === false ? 0 : 1, JSON.stringify(task.skillIds || []), task.repeatCount, resetCount, task.enabled ? 1 : 0, status,
      task.workspacePath, task.nextRunAt, task.updatedAt, taskId,
    )
    if (String(task.prompt || '').trim() !== String(current.prompt || '').trim()) {
      this.db.prepare("UPDATE scheduled_tasks SET memory_summary='', memory_summary_updated_at=NULL, memory_summary_run_count=0 WHERE id=?").run(taskId)
    }
    return this.loadWorkspace()
    this.db.prepare('UPDATE scheduled_tasks SET owner_bot_id=? WHERE id=?').run(task.ownerBotId || '', taskId)
  }

  setScheduledTaskEnabled(taskId, enabled, nextRunAt) {
    const task = this.getScheduledTask(taskId)
    if (!task) throw new Error('定时任务不存在或已经被删除。')
    const resetCount = enabled && task.repeatCount > 0 && task.runCount >= task.repeatCount ? 0 : task.runCount
    this.db.prepare(`
      UPDATE scheduled_tasks SET enabled=?, status=?, run_count=?, next_run_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(enabled ? 1 : 0, enabled ? 'active' : 'paused', resetCount, enabled ? nextRunAt : null, taskId)
    return this.loadWorkspace()
  }

  /**
   * 「/bot 名字 指令」这种跨 Bot 委派：在当前对话里留一份的同时，
   * 在目标 Bot 自己的本地会话里也记一份，这样它的会话列表能看到这次指令与回复。
   */
  mirrorDelegatedExchange({ targetBotId, instruction, reply = '', modelProvider = '', model = '', sourceTitle = '' }) {
    const bot = String(targetBotId || '')
    const text = String(instruction || '').trim()
    if (!bot || !text) return null
    const existing = this.db.prepare("SELECT id FROM conversations WHERE bot_id=? AND channel_id='web' AND archived=0 ORDER BY datetime(updated_at) DESC, rowid DESC LIMIT 1").get(bot)
    const conversationId = existing?.id
      || this.createConversation(bot, sourceTitle ? `来自「${sourceTitle}」的指令` : '来自 AI 对话的指令', { channelId: 'web', modelProvider, model })
    this.addMessage(conversationId, 'user', text.slice(0, 8_000))
    const answer = String(reply || '').trim()
    if (answer) this.addMessage(conversationId, 'assistant', answer.slice(0, 40_000), { modelProvider, model })
    return conversationId
  }

  /** 是否在总览页展示这个任务（总览页只列打开开关的任务） */
  setScheduledTaskOverviewVisibility(taskId, visible) {
    const result = this.db.prepare('UPDATE scheduled_tasks SET show_on_overview=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(visible ? 1 : 0, taskId)
    if (!result.changes) throw new Error('定时任务不存在或已经被删除。')
    return this.loadWorkspace()
  }

  deleteScheduledTask(taskId) {
    if (!this.getScheduledTask(taskId)) throw new Error('定时任务不存在或已经被删除。')
    const conversationIds = this.db.prepare(`
      SELECT conversation_id
      FROM scheduled_task_runs
      WHERE task_id=? AND conversation_id IS NOT NULL AND conversation_id<>''
    `).all(taskId).map((row) => row.conversation_id)
    this.#transaction(() => {
      this.db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(taskId)
      const deleteConversation = this.db.prepare("DELETE FROM conversations WHERE id=? AND channel_id='scheduled'")
      for (const conversationId of conversationIds) deleteConversation.run(conversationId)
    })
    return this.loadWorkspace()
  }

  deleteScheduledTaskRun(runId) {
    const run = scheduledTaskRunFromRow(this.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId))
    if (!run) throw new Error('运行记录不存在或已经被删除。')
    if (run.status === 'running') throw new Error('任务仍在运行，完成后才能删除这条记录。')
    this.#transaction(() => {
      this.db.prepare('DELETE FROM scheduled_task_runs WHERE id=?').run(runId)
      if (run.status === 'success') this.db.prepare("UPDATE scheduled_tasks SET memory_summary='', memory_summary_updated_at=NULL, memory_summary_run_count=0 WHERE id=?").run(run.taskId)
      if (run.conversationId) this.db.prepare("DELETE FROM conversations WHERE id=? AND channel_id='scheduled'").run(run.conversationId)
    })
    return this.loadWorkspace()
  }

  recallScheduledTaskMemories(taskId, _query, { characterBudget = 8_000 } = {}) {
    const task = this.getScheduledTask(taskId)
    if (!task || !task.memoryEnabled) return { memories: [], usedCharacters: 0, totalCandidates: 0 }
    const recentRuns = this.db.prepare(`
      SELECT id, output, finished_at, conversation_id
      FROM scheduled_task_runs
      WHERE task_id=? AND status='success' AND output<>''
      ORDER BY datetime(finished_at) DESC, rowid DESC
      LIMIT 2
    `).all(taskId).map((row, index) => ({
      id: `scheduled-memory-${row.id}`,
      title: `${task.name} · 最近第 ${index + 1} 次成功运行`,
      excerpt: String(row.output || '').slice(0, 3_000),
      type: 'episode',
      updatedAt: row.finished_at,
      source: '定时任务近期结果',
      confidence: 1,
      evidence: '',
      conversationId: row.conversation_id || '',
      createdAt: row.finished_at,
      lastRecalledAt: null,
      recallCount: 0,
    }))
    const candidates = [
      ...(task.memorySummary ? [{
        id: `scheduled-summary-${task.id}`,
        title: `${task.name} · 滚动摘要`,
        excerpt: String(task.memorySummary).slice(0, 4_000),
        type: 'episode',
        updatedAt: task.memorySummaryUpdatedAt || task.updatedAt,
        source: '定时任务滚动摘要',
        confidence: 1,
        evidence: '',
        conversationId: '',
        createdAt: task.memorySummaryUpdatedAt || task.updatedAt,
        lastRecalledAt: null,
        recallCount: 0,
      }] : []),
      ...recentRuns,
    ]
    const safeBudget = Math.max(3_000, Math.min(12_000, Number(characterBudget) || 8_000))
    const memories = []
    let usedCharacters = 0
    for (const memory of candidates) {
      const size = memory.title.length + memory.excerpt.length + 24
      if (memories.length && usedCharacters + size > safeBudget) continue
      memories.push(memory)
      usedCharacters += size
    }
    return { memories, usedCharacters, totalCandidates: candidates.length }
  }

  updateScheduledTaskMemorySummary(taskId, summary, updatedAt = new Date().toISOString()) {
    const compactSummary = String(summary || '').trim().slice(0, 5_000)
    if (!compactSummary) return this.loadWorkspace()
    const successfulRunCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id=? AND status='success' AND output<>''").get(taskId)?.count || 0)
    const result = this.db.prepare(`
      UPDATE scheduled_tasks
      SET memory_summary=?, memory_summary_updated_at=?, memory_summary_run_count=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND memory_enabled=1
    `).run(compactSummary, updatedAt, successfulRunCount, taskId)
    if (!result.changes && this.getScheduledTask(taskId)) throw new Error('任务记忆已关闭，未更新滚动摘要。')
    if (!result.changes) throw new Error('定时任务不存在或已经被删除。')
    return this.loadWorkspace()
  }

  startScheduledTaskRun(taskId, runId, startedAt, nextRunAt) {
    const task = this.getScheduledTask(taskId)
    if (!task) throw new Error('定时任务不存在或已经被删除。')
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO scheduled_task_runs (id, task_id, task_name, status, started_at, model_provider, model)
        VALUES (?, ?, ?, 'running', ?, ?, ?)
      `).run(runId, taskId, task.name, startedAt, task.modelProvider, task.model)
      this.db.prepare(`UPDATE scheduled_tasks SET last_run_at=?, next_run_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(startedAt, nextRunAt, taskId)
    })
    return scheduledTaskRunFromRow(this.db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(runId))
  }

  finishScheduledTaskRun({ taskId, runId, status, finishedAt, durationMs, conversationId = '', output = '', error = '' }) {
    const task = this.getScheduledTask(taskId)
    if (!task) throw new Error('定时任务不存在或已经被删除。')
    const nextRunCount = task.runCount + 1
    const completed = task.repeatCount > 0 && nextRunCount >= task.repeatCount
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE scheduled_task_runs SET status=?, finished_at=?, duration_ms=?, conversation_id=?, output=?, error=? WHERE id=?
      `).run(status, finishedAt, durationMs, conversationId, String(output).slice(0, 100_000), String(error).slice(0, 20_000), runId)
      this.db.prepare(`
        UPDATE scheduled_tasks SET run_count=?, enabled=?, status=?, next_run_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(nextRunCount, completed ? 0 : task.enabled ? 1 : 0, completed ? 'completed' : task.enabled ? 'active' : 'paused', completed ? null : task.nextRunAt, taskId)
    })
    return this.loadWorkspace()
  }

  recoverInterruptedScheduledTaskRuns() {
    const finishedAt = new Date().toISOString()
    this.db.prepare(`
      UPDATE scheduled_task_runs
      SET status='failed', finished_at=?, duration_ms=0, error='ZSense 上次退出时任务仍在运行，本次已安全结束。'
      WHERE status='running'
    `).run(finishedAt)
  }

  searchSessions(botId, query, limit = 20) {
    const needle = String(query || '').normalize('NFKC').trim()
    if (!needle) throw new Error('会话搜索词不能为空。')
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20))
    const escaped = needle.replace(/[\\%_]/g, (value) => `\\${value}`)
    const pattern = `%${escaped}%`
    const rows = this.db.prepare(`
      SELECT
        c.id AS conversation_id,
        c.title,
        c.channel_id,
        c.updated_at,
        m.id AS message_id,
        m.role,
        m.content,
        m.created_at
      FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      WHERE c.bot_id=?
        AND (c.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
      ORDER BY datetime(m.created_at) DESC, m.rowid DESC
      LIMIT ?
    `).all(botId, pattern, pattern, safeLimit)
    return rows.map((row) => {
      const content = String(row.content || '').replace(/\s+/g, ' ').trim()
      const matchAt = content.toLocaleLowerCase('zh-CN').indexOf(needle.toLocaleLowerCase('zh-CN'))
      const start = Math.max(0, matchAt < 0 ? 0 : matchAt - 120)
      return {
        conversationId: row.conversation_id,
        title: row.title,
        channelId: row.channel_id,
        updatedAt: row.updated_at,
        messageId: row.message_id,
        role: row.role,
        createdAt: row.created_at,
        excerpt: `${start ? '…' : ''}${content.slice(start, start + 500)}${start + 500 < content.length ? '…' : ''}`,
      }
    })
  }

  createConversation(botId, title, { channelId = 'web', externalThreadId = '', runtimeEngine = '', runtimeSessionId = '', modelProvider = '', model = '', reasoningEffort = 'high', workspacePath = '' } = {}) {
    const id = `conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`
    this.db.prepare(`
      INSERT INTO conversations (id, bot_id, title, channel_id, external_thread_id, runtime_engine, runtime_session_id, model_provider, model, reasoning_effort, workspace_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, botId, title.slice(0, 80), channelId, externalThreadId, runtimeEngine, runtimeSessionId, modelProvider, model, reasoningEffort, workspacePath)
    return id
  }

  createNativeConversation(title, options = {}) {
    return this.createConversation(NATIVE_BOT_ID, title, options)
  }

  getConversation(conversationId, botId = '') {
    const row = botId
      ? this.db.prepare('SELECT * FROM conversations WHERE id=? AND bot_id=?').get(conversationId, botId)
      : this.db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId)
    if (!row) return null
    const messages = this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY datetime(created_at), rowid').all(conversationId).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      reasoning: message.reasoning || '',
      agentSteps: parseJson(message.agent_steps_json || '[]', []),
      toolEvents: parseJson(message.tool_events_json || '[]', []),
      attachments: attachmentMetadata(parseJson(message.attachments_json || '[]', [])),
      externalMessageId: message.external_message_id || message.hermes_message_id || '',
      modelProvider: message.model_provider || '',
      model: message.model || '',
      durationMs: message.duration_ms == null ? null : Number(message.duration_ms),
      outputTokens: message.output_tokens == null ? null : Number(message.output_tokens),
      createdAt: message.created_at,
    }))
    return {
      id: row.id,
      botId: row.bot_id,
      kind: row.bot_id === NATIVE_BOT_ID ? 'native' : 'bot',
      title: row.title,
      channelId: row.channel_id,
      externalThreadId: row.external_thread_id || row.hermes_session_id || '',
      runtimeEngine: row.runtime_engine === 'hermes' ? 'legacy' : row.runtime_engine || (row.hermes_session_id ? 'legacy' : ''),
      runtimeSessionId: row.runtime_session_id || row.hermes_session_id || '',
      modelProvider: row.model_provider || '',
      model: row.model || '',
      reasoningEffort: ['none', 'low', 'high', 'max'].includes(row.reasoning_effort) ? row.reasoning_effort : 'high',
      workspacePath: row.workspace_path || '',
      usage: conversationUsage(row.usage_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: messages.length,
      archived: asBoolean(row.archived),
      messages,
    }
  }

  setConversationRuntimeSession(conversationId, runtimeEngine, runtimeSessionId) {
    if (runtimeEngine !== 'zsense-core') throw new Error('会话运行内核无效。')
    const result = this.db.prepare(`
      UPDATE conversations
      SET runtime_engine=?, runtime_session_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(runtimeEngine, runtimeSessionId, conversationId)
    if (!result.changes) throw new Error('会话不存在或已经被删除。')
    return this.getConversation(conversationId)
  }

  updateConversationOptions(conversationId, botId, { modelProvider, model, reasoningEffort, workspacePath, usage } = {}) {
    const current = this.getConversation(conversationId, botId)
    if (!current) throw new Error('会话不存在，或不属于当前对话空间。')
    const nextUsage = usage === undefined ? current.usage : usage
    this.db.prepare(`
      UPDATE conversations
      SET model_provider=?, model=?, reasoning_effort=?, workspace_path=?, usage_json=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND bot_id=?
    `).run(
      modelProvider === undefined ? current.modelProvider : modelProvider,
      model === undefined ? current.model : model,
      reasoningEffort === undefined ? current.reasoningEffort : reasoningEffort,
      workspacePath === undefined ? current.workspacePath : workspacePath,
      JSON.stringify(nextUsage || {}),
      conversationId,
      botId,
    )
    return this.getConversation(conversationId, botId)
  }

  setConversationWorkspace(conversationId, workspacePath) {
    const result = this.db.prepare('UPDATE conversations SET workspace_path=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(workspacePath, conversationId)
    if (!result.changes) throw new Error('会话不存在或已经被删除。')
    return this.loadWorkspace()
  }

  addMessage(conversationId, role, content, { reasoning = '', agentSteps = [], toolEvents = [], attachments = [], externalMessageId = '', modelProvider = '', model = '', durationMs = null, outputTokens = null, createdAt = '' } = {}) {
    const id = `message-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const numericDurationMs = durationMs === null || durationMs === undefined ? NaN : Number(durationMs)
    const storedDurationMs = Number.isFinite(numericDurationMs) && numericDurationMs >= 0 ? Math.round(numericDurationMs) : null
    const numericOutputTokens = outputTokens === null || outputTokens === undefined ? NaN : Number(outputTokens)
    const storedOutputTokens = Number.isFinite(numericOutputTokens) && numericOutputTokens >= 0 ? Math.round(numericOutputTokens) : null
    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, reasoning, agent_steps_json, tool_events_json, attachments_json, external_message_id, model_provider, model, duration_ms, output_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), CURRENT_TIMESTAMP))
    `).run(id, conversationId, role, content, reasoning, JSON.stringify(agentSteps || []), JSON.stringify(toolEvents || []), JSON.stringify(attachmentMetadata(attachments)), externalMessageId, modelProvider, model, storedDurationMs, storedOutputTokens, createdAt)
    this.db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(conversationId)
    return id
  }

  deleteConversationMessage(conversationId, messageId) {
    this.#transaction(() => {
      const message = this.db.prepare(`
        SELECT m.id, m.external_message_id, c.bot_id
        FROM messages m
        JOIN conversations c ON c.id=m.conversation_id
        WHERE m.id=? AND m.conversation_id=?
      `).get(messageId, conversationId)
      if (!message) throw new Error('消息不存在、尚未保存，或已经被删除。')
      if (message.external_message_id) {
        this.db.prepare(`
          INSERT OR IGNORE INTO deleted_external_messages (conversation_id, bot_id, external_message_id, hermes_message_id)
          VALUES (?, ?, ?, ?)
        `).run(conversationId, message.bot_id, message.external_message_id, message.external_message_id)
      }
      this.db.prepare('DELETE FROM messages WHERE id=? AND conversation_id=?').run(messageId, conversationId)
      this.db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(conversationId)
    })
    this.#synchronizeChannelMessageStats()
    return this.loadWorkspace()
  }

  deleteConversation(conversationId, { nativeOnly = false } = {}) {
    this.#transaction(() => {
      const conversation = nativeOnly
        ? this.db.prepare('SELECT id, bot_id FROM conversations WHERE id=? AND bot_id=?').get(conversationId, NATIVE_BOT_ID)
        : this.db.prepare('SELECT id, bot_id FROM conversations WHERE id=?').get(conversationId)
      if (!conversation) throw new Error('会话不存在或已经被删除。')
      const rememberDeletedMessage = this.db.prepare(`
        INSERT OR IGNORE INTO deleted_external_messages (conversation_id, bot_id, external_message_id, hermes_message_id)
        VALUES (?, ?, ?, ?)
      `)
      for (const row of this.db.prepare("SELECT external_message_id FROM messages WHERE conversation_id=? AND external_message_id<>''").all(conversationId)) {
        rememberDeletedMessage.run(conversationId, conversation.bot_id, row.external_message_id, row.external_message_id)
      }
      this.db.prepare('DELETE FROM conversations WHERE id=?').run(conversationId)
      this.db.prepare(`
        UPDATE gateway_connections SET messages=(
          SELECT COUNT(*) FROM messages m
          JOIN conversations c ON c.id=m.conversation_id
          WHERE c.bot_id=gateway_connections.bot_id
            AND c.channel_id=gateway_connections.provider
            AND m.external_message_id<>''
        ), updated_at=CURRENT_TIMESTAMP
        WHERE bot_id=?
      `).run(conversation.bot_id)
    })
    this.#synchronizeChannelMessageStats()
    return this.loadWorkspace()
  }

  renameConversation(conversationId, title) {
    const result = this.db.prepare('UPDATE conversations SET title=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(title).slice(0, 80), conversationId)
    if (!result.changes) throw new Error('会话不存在或已经被删除。')
    return this.loadWorkspace()
  }

  archiveConversation(conversationId, archived) {
    const result = this.db.prepare('UPDATE conversations SET archived=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(archived ? 1 : 0, conversationId)
    if (!result.changes) throw new Error('会话不存在或已经被删除。')
    return this.loadWorkspace()
  }

  // ── 对话分组：把会话收进可折叠的组里；同一对话空间（Bot / AI 对话）内各自独立 ──

  createConversationGroup(botId, name) {
    const space = String(botId || '')
    const label = String(name || '').trim().slice(0, 40)
    if (!space) throw new Error('缺少对话空间。')
    if (!label) throw new Error('分组名称不能为空。')
    const nextOrder = Number(this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM conversation_groups WHERE bot_id=?').get(space)?.value || 0) + 1
    this.db.prepare('INSERT INTO conversation_groups (id, bot_id, name, sort_order) VALUES (?, ?, ?, ?)').run(`conversation-group-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, space, label, nextOrder)
    return this.loadWorkspace()
  }

  renameConversationGroup(groupId, name) {
    const label = String(name || '').trim().slice(0, 40)
    if (!label) throw new Error('分组名称不能为空。')
    const result = this.db.prepare('UPDATE conversation_groups SET name=? WHERE id=?').run(label, groupId)
    if (!result.changes) throw new Error('分组不存在或已经被删除。')
    return this.loadWorkspace()
  }

  deleteConversationGroup(groupId) {
    this.#transaction(() => {
      const group = this.db.prepare('SELECT id FROM conversation_groups WHERE id=?').get(groupId)
      if (!group) throw new Error('分组不存在或已经被删除。')
      // 组里的会话回到未分组，不跟着一起删
      this.db.prepare("UPDATE conversations SET group_id='', updated_at=CURRENT_TIMESTAMP WHERE group_id=?").run(groupId)
      this.db.prepare('DELETE FROM conversation_groups WHERE id=?').run(groupId)
    })
    return this.loadWorkspace()
  }

  setConversationGroupCollapsed(groupId, collapsed) {
    const result = this.db.prepare('UPDATE conversation_groups SET collapsed=? WHERE id=?').run(collapsed ? 1 : 0, groupId)
    if (!result.changes) throw new Error('分组不存在或已经被删除。')
    return this.loadWorkspace()
  }

  moveConversationToGroup(conversationId, groupId) {
    const conversation = this.db.prepare('SELECT id, bot_id FROM conversations WHERE id=?').get(conversationId)
    if (!conversation) throw new Error('会话不存在或已经被删除。')
    const target = String(groupId || '')
    if (target) {
      const group = this.db.prepare('SELECT id, bot_id FROM conversation_groups WHERE id=?').get(target)
      if (!group || group.bot_id !== conversation.bot_id) throw new Error('分组不存在或不属于这个对话空间。')
    }
    this.db.prepare('UPDATE conversations SET group_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(target, conversationId)
    return this.loadWorkspace()
  }

  /** 按给定顺序重排某个对话空间里的会话（列表里传完整顺序） */
  reorderConversations(botId, orderedIds = []) {
    const space = String(botId || '')
    if (!space) throw new Error('缺少对话空间。')
    const ids = Array.isArray(orderedIds) ? orderedIds.map((id) => String(id)).filter(Boolean) : []
    this.#transaction(() => {
      const update = this.db.prepare('UPDATE conversations SET sort_order=? WHERE id=? AND bot_id=?')
      ids.forEach((id, index) => update.run(index + 1, id, space))
    })
    return this.loadWorkspace()
  }

  importExternalMessages(records = []) {
    let importedMessages = 0
    const touchedConnections = new Map()
    this.#transaction(() => {
      for (const record of records) {
        if (!record?.botId || !record?.channelId || !record?.externalThreadId || !Array.isArray(record.messages)) continue
        const conversationHash = createHash('sha256').update(`${record.botId}\0${record.channelId}\0${record.externalThreadId}`).digest('hex').slice(0, 24)
        const conversationId = `external-${conversationHash}`
        const suppressedMessageIds = new Set(this.db.prepare('SELECT external_message_id FROM deleted_external_messages WHERE conversation_id=?').all(conversationId).map((row) => String(row.external_message_id)))
        const visibleMessages = record.messages.filter((message) => !suppressedMessageIds.has(String(message?.externalMessageId)))
        const existingConversation = this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(conversationId)
        if (!visibleMessages.length && !existingConversation) continue
        const createdAt = record.createdAt || new Date().toISOString()
        this.db.prepare(`
          INSERT OR IGNORE INTO conversations (id, bot_id, title, channel_id, external_thread_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(conversationId, record.botId, String(record.title || `${record.channelId} 对话`).slice(0, 80), record.channelId, record.externalThreadId, createdAt, record.updatedAt || createdAt)
        for (const message of visibleMessages) {
          if (!['user', 'assistant'].includes(message.role) || !message.content || message.externalMessageId === undefined) continue
          const messageHash = createHash('sha256').update(`${record.externalThreadId}\0${message.externalMessageId}`).digest('hex').slice(0, 28)
          const result = this.db.prepare(`
            INSERT OR IGNORE INTO messages
              (id, conversation_id, role, content, reasoning, tool_events_json, attachments_json, external_message_id, created_at)
            VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)
          `).run(`external-${messageHash}`, conversationId, message.role, message.content, message.reasoning || '', JSON.stringify(attachmentMetadata(message.attachments)), String(message.externalMessageId), message.createdAt || createdAt)
          if (result.changes) importedMessages += 1
        }
        if (record.connectionId) touchedConnections.set(record.connectionId, (touchedConnections.get(record.connectionId) || 0) + visibleMessages.length)
        this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(record.updatedAt || createdAt, conversationId)
      }
      if (importedMessages) {
        for (const [connectionId] of touchedConnections) {
          const count = Number(this.db.prepare(`
            SELECT COUNT(*) AS count FROM messages m
            JOIN conversations c ON c.id=m.conversation_id
            JOIN gateway_connections g ON g.bot_id=c.bot_id AND g.provider=c.channel_id
            WHERE g.id=? AND m.external_message_id<>''
          `).get(connectionId)?.count || 0)
          this.db.prepare('UPDATE gateway_connections SET messages=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(count, connectionId)
        }
      }
    })
    this.#synchronizeChannelMessageStats()
    return { importedMessages, workspace: this.loadWorkspace() }
  }

  completeConversation(botId, conversationId, toolEvents = []) {
    this.#transaction(() => {
      const conversation = this.db.prepare('SELECT channel_id FROM conversations WHERE id=? AND bot_id=?').get(conversationId, botId)
      const channelId = conversation?.channel_id || 'web'
      this.db.prepare(`
        UPDATE bots
        SET conversations=(SELECT COUNT(*) FROM conversations WHERE bot_id=?), last_active=?
        WHERE id=?
      `).run(botId, '刚刚', botId)
      this.#synchronizeChannelMessageStats()
      this.#addActivity(botId, 'message', '完成 Web Chat 对话', `会话 ${conversationId} 已完成，共调用 ${toolEvents.length} 个工具。`, {
        operation: 'conversation.complete',
        conversationId,
        channelId,
        toolCalls: String(toolEvents.length),
      })
      for (const toolEvent of toolEvents) {
        const toolName = String(toolEvent?.name || '未命名工具')
        const status = String(toolEvent?.status || 'complete')
        const statusLabel = status === 'error' ? '执行失败' : status === 'running' ? '执行中' : '执行完成'
        const durationLabel = Number.isFinite(toolEvent?.durationMs) ? `，耗时 ${Math.round(toolEvent.durationMs)} 毫秒` : ''
        this.#addActivity(botId, 'tool', `工具调用：${toolName}`, `${toolName} ${statusLabel}${durationLabel}；详细输入与输出可在对应会话中展开查看。`, {
          operation: 'tool.execute',
          conversationId,
          toolId: String(toolEvent?.toolId || ''),
          toolName,
          status,
          step: Number.isFinite(toolEvent?.step) ? String(Math.round(toolEvent.step)) : '',
          durationMs: Number.isFinite(toolEvent?.durationMs) ? String(Math.round(toolEvent.durationMs)) : '',
        })
      }
    })
  }

  completeNativeConversation(conversationId) {
    this.#transaction(() => {
      this.#synchronizeChannelMessageStats()
      this.db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=? AND bot_id=?').run(conversationId, NATIVE_BOT_ID)
    })
  }

  #addActivity(botId, type, title, detail, metadata = {}) {
    const id = `activity-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const safeMetadata = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, value == null ? '' : String(value)]))
    this.db.prepare('INSERT INTO activities (id, bot_id, type, title, detail, time_label, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, botId, type, title, detail, '刚刚', JSON.stringify(safeMetadata))
  }

  close() {
    this.db.close()
  }
}

export function cloneForRenderer(value) {
  if (value === undefined || value === null) return value
  // Binary IPC payloads must not pass through JSON.stringify: a large Uint8Array
  // becomes millions of numeric object keys and can throw "Invalid string length".
  if (value instanceof Uint8Array) return value
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item))
}
