import { NATIVE_BOT_ID } from './database.mjs'

function snapshotText(value, maximum = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

export function nativeWorkspaceIdentity(workspace) {
  const bots = Array.isArray(workspace?.bots) ? workspace.bots : []
  const connections = Array.isArray(workspace?.gatewayConnections) ? workspace.gatewayConnections : []
  const skills = Array.isArray(workspace?.skills) ? workspace.skills : []
  const botLines = bots.length
    ? bots.map((bot, index) => `${index + 1}. ${snapshotText(bot.name)} | ID=${snapshotText(bot.id)} | 状态=${snapshotText(bot.status)} | 角色=${snapshotText(bot.role)}`)
    : ['（当前没有 Bot）']
  const gatewayLines = connections.length
    ? connections.map((connection, index) => {
        const target = bots.find((bot) => bot.id === connection.botId)
        return `${index + 1}. ${snapshotText(connection.name)} | 渠道=${snapshotText(connection.provider)} | 目标 Bot=${snapshotText(target?.name || connection.botId)} | 状态=${snapshotText(connection.status)}`
      })
    : ['（当前没有已保存的消息网关）']
  const enabledSkills = skills.filter((skill) => Array.isArray(skill.assignedBotIds) && skill.assignedBotIds.length > 0)
  const prompt = [
    '你是 ZSense 工作台的 AI 助手。你可以正常帮助用户完成通用 AI 任务，也能回答当前 ZSense 工作区的问题。',
    '下面的快照由 ZSense 数据库在本次请求开始前实时生成，优先级高于旧会话中的数量、名称或状态。',
    '',
    `快照时间：${new Date().toISOString()}`,
    `当前 Bot 总数（精确值）：${bots.length}`,
    '当前 Bot 列表：',
    ...botLines,
    '',
    `当前已保存消息网关数：${connections.length}`,
    '当前消息网关路由：',
    ...gatewayLines,
    '',
    `当前已启用共享技能数：${enabledSkills.length}`,
    `当前已启用共享技能：${enabledSkills.map((skill) => snapshotText(skill.name)).join('、') || '无'}`,
    '',
    '若用户询问已删除对象或旧数量，请明确说明当前快照已经更新，不要沿用旧会话中的结果。',
  ].join('\n').slice(0, 48_000)
  return {
    ...(workspace?.nativeBot || {}),
    id: NATIVE_BOT_ID,
    name: 'ZSense AI',
    initials: 'AI',
    role: 'ZSense 工作台 AI 助手',
    description: '使用 ZSense Agent Core、独立长期记忆与实时工作区快照。',
    modelProvider: workspace?.modelConfiguration?.provider || '',
    model: workspace?.modelConfiguration?.model || '',
    prompt,
    workspaceAssistant: true,
  }
}
