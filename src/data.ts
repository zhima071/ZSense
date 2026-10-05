import type { Activity, Bot, Channel, GatewayConnection, ModelConfiguration, Skill } from './types'

export const initialBots: Bot[] = [
  {
    id: 'atlas',
    name: 'Atlas',
    initials: 'AT',
    role: '个人知识管家',
    description: '整理你的知识、偏好与日常决策，在需要时给出有上下文的建议。',
    status: 'online',
    color: '#8b5cf6',
    modelProvider: '',
    model: '',
    memoryCount: 3,
    memorySize: '1.4 KB',
    channels: ['web', 'telegram'],
    lastActive: '刚刚',
    conversations: 0,
    successRate: 100,
    prompt: '你是 Atlas，一位冷静、可靠的个人知识管家。优先引用用户已经确认的事实，并清楚区分事实、推断与建议。',
    memories: [
      { id: 'm-1', title: '内容表达偏好', excerpt: '偏好清晰、简洁的中文表达，结论先行，避免过度铺垫。', type: 'preference', updatedAt: '今天 18:42', source: 'Web 对话' },
      { id: 'm-2', title: 'ZSense 产品方向', excerpt: '内置 ZSense Agent Core，并为每个 Bot 提供隔离记忆与独立消息网关。', type: 'fact', updatedAt: '今天 16:18', source: 'Telegram' },
      { id: 'm-3', title: '周五产品复盘', excerpt: '每周五整理本周关键决策、遗留风险与下周优先级。', type: 'episode', updatedAt: '昨天 21:10', source: '定时任务' },
    ],
  },
]

export const initialChannels: Channel[] = [
  { id: 'web', name: 'Web Chat', description: 'ZSense 内置对话入口', status: 'connected', latency: '本地', messages: 0, configured: true, config: {}, secretKeys: [] },
  { id: 'telegram', name: 'Telegram', description: 'ZSense Telegram Bot 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'discord', name: 'Discord', description: 'ZSense Discord Gateway 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'slack', name: 'Slack', description: 'ZSense Slack Socket Mode 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'wecom', name: '企业微信', description: 'ZSense 企业微信 WebSocket 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'weixin', name: '微信', description: 'ZSense 微信 iLink 长轮询适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'dingtalk', name: '钉钉', description: 'ZSense 钉钉 Stream 适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'feishu', name: '飞书', description: 'ZSense 飞书长连接适配器', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
  { id: 'webhook', name: 'Webhook', description: 'ZSense 通用 Webhook 入口', status: 'setup', latency: '—', messages: 0, configured: false, config: {}, secretKeys: [] },
]

export const initialGatewayConnections: GatewayConnection[] = []

export const initialModelConfiguration: ModelConfiguration = {
  provider: 'openrouter',
  model: '',
  baseUrl: '',
  apiKeyName: 'OPENROUTER_API_KEY',
  apiKeyConfigured: false,
  updatedAt: '',
}

export const initialSavedModelConfigurations: ModelConfiguration[] = []

function previewSkill(skill: Pick<Skill, 'id' | 'name' | 'description' | 'category' | 'version' | 'source'> & Partial<Skill>): Skill {
  const content = skill.content || `---\nname: ${skill.name}\ndescription: ${skill.description}\nversion: ${skill.version}\n---\n\n# ${skill.name}\n\n${skill.description}\n`
  return {
    enabled: true,
    assignedBotIds: initialBots.map((bot) => bot.id),
    updatedAt: new Date().toISOString(),
    fileCount: 1,
    content,
    installPath: `ZSense Preview/skills/${skill.category}/${skill.id}`,
    editable: true,
    builtIn: skill.source === 'ZSense Core',
    essential: false,
    updateMode: skill.source === 'ZSense Core' ? 'runtime' : 'manual',
    repositoryUrl: '',
    ...skill,
  }
}

export const initialSkills: Skill[] = [
  previewSkill({ id: 'dws', name: 'dws', description: '管理钉钉文档、表格、群聊、日历、待办与开放平台能力。', category: 'zsense-builtin', version: '1.0.0', source: 'ZSense Core' }),
  previewSkill({ id: 'officecli', name: 'officecli', description: '读取和编辑 Excel、Word、PowerPoint 与 PDF 文件。', category: 'zsense-builtin', version: '1.0.0', source: 'ZSense Core' }),
  previewSkill({ id: 'ui-ux-pro-max', name: 'ui-ux-pro-max', description: '提供应用界面、交互、可访问性与设计系统建议。', category: 'zsense-builtin', version: '1.0.0', source: 'ZSense Core' }),
  previewSkill({ id: 'skill-creator', name: 'skill-creator', description: '创建、编辑、校验和打包可由 ZSense Agent Core 加载的技能。', category: 'zsense-builtin', version: '1.0.0', source: 'ZSense Core' }),
  previewSkill({ id: 'kdocs', name: 'kdocs', description: '读取和管理金山文档、WPS 云文档、表格、演示与知识库。', category: 'zsense-builtin', version: '2.5.7', source: 'ZSense Core' }),
  previewSkill({ id: 'find-skills', name: 'find-skills', description: '从公开技能生态搜索适合 ZSense 的可安装技能。', category: 'zsense-builtin', version: '1.0.0', source: 'ZSense Core' }),
  previewSkill({ id: 'weekly-review', name: 'weekly-review', description: '整理每周进展、风险与下一步计划。', category: '我的技能', version: '1.0.0', source: 'ZSense', editable: true, builtIn: false }),
]

export const activities: Activity[] = [
  { id: 'a-1', botId: 'atlas', type: 'system', title: '示例 Bot 已准备', detail: 'Atlas 的独立记忆命名空间已建立', time: '初始化', createdAt: '2026-09-06T08:00:00.000Z', metadata: { operation: 'bot.initialize' } },
]
