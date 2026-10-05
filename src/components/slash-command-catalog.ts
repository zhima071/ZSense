import type { Skill } from '../types'
import type { SlashCommandItem } from './SlashCommandMenu'

interface PromptCommand {
  command: string
  title: string
  description: string
  keywords: string
  group: string
  prompt: string
}

const PROMPT_COMMANDS: PromptCommand[] = [
  { command: 'summarize', title: '总结内容', description: '提炼结论、要点和后续行动', keywords: '总结 摘要 summary', group: '常用', prompt: '请总结上下文，给出关键结论、重要细节和下一步行动。' },
  { command: 'brief', title: '简洁回答', description: '只保留必要结论', keywords: '简短 精简 concise', group: '常用', prompt: '请用尽可能简洁的方式回答，结论先行：' },
  { command: 'detailed', title: '详细分析', description: '给出完整推理、步骤和边界', keywords: '详细 deep', group: '常用', prompt: '请详细分析下面的问题，说明关键假设、可选方案、风险和建议：\n' },
  { command: 'explain', title: '解释概念', description: '用通俗语言和例子说明', keywords: '解释 原理 explain', group: '常用', prompt: '请用通俗语言解释下面的内容，并给出一个具体例子：\n' },
  { command: 'examples', title: '生成示例', description: '为当前主题生成可直接使用的例子', keywords: '例子 example demo', group: '常用', prompt: '请针对下面的主题生成几个有代表性、可直接使用的示例：\n' },
  { command: 'brainstorm', title: '头脑风暴', description: '生成多角度思路并排序', keywords: '创意 ideas', group: '常用', prompt: '请对下面的目标进行头脑风暴，提供多种思路，并按可行性排序：\n' },
  { command: 'plan', title: '制定计划', description: '拆分阶段、依赖、验收标准', keywords: '计划 roadmap', group: '常用', prompt: '请将下面的目标拆分为可执行计划，包含优先级、依赖、风险和验收标准：\n' },
  { command: 'todo', title: '生成待办', description: '把内容转成可勾选任务列表', keywords: '待办 checklist task', group: '常用', prompt: '请将下面的内容整理成有优先级和完成标准的待办清单：\n' },
  { command: 'continue', title: '继续执行', description: '从当前进度继续做到完成', keywords: '继续 resume', group: '常用', prompt: '请根据当前会话的已有进度继续执行，直到完成并验证结果。' },
  { command: 'verify', title: '验证结果', description: '检查刚才的结果和遗留问题', keywords: '检查 verify validate', group: '常用', prompt: '请验证刚才的结果，检查是否真正完成、是否有遗留错误，并修正可以直接修正的问题。' },
  { command: 'decide', title: '帮我决策', description: '比较方案并给出明确建议', keywords: '决策 选择 decision', group: '常用', prompt: '请比较下面的选项，列出关键权衡，然后给出明确建议：\n' },

  { command: 'translate', title: '翻译', description: '翻译并保留原意与格式', keywords: '翻译 translate', group: '写作', prompt: '请将下面的内容翻译为目标语言，保留原意、语气和格式：\n' },
  { command: 'rewrite', title: '改写', description: '优化表达但不改变事实', keywords: '改写 rewrite', group: '写作', prompt: '请改写下面的内容，使表达更清晰自然，但不改变事实和原意：\n' },
  { command: 'polish', title: '润色文字', description: '改善节奏、语气和专业度', keywords: '润色 polish', group: '写作', prompt: '请润色下面的文字，改善语气、逻辑和可读性：\n' },
  { command: 'expand', title: '扩写', description: '在原意基础上补充细节', keywords: '扩写 expand', group: '写作', prompt: '请在不偏离原意的前提下扩写下面的内容，补充必要背景和细节：\n' },
  { command: 'shorten', title: '精简文字', description: '删除重复和无关表达', keywords: '缩写 shorten', group: '写作', prompt: '请精简下面的内容，保留所有重要信息：\n' },
  { command: 'outline', title: '创建大纲', description: '生成分层结构和写作顺序', keywords: '大纲 outline', group: '写作', prompt: '请为下面的主题创建逻辑清晰的分层大纲：\n' },
  { command: 'email', title: '撰写邮件', description: '根据目标生成可发送邮件', keywords: '邮件 email', group: '写作', prompt: '请根据下面的信息撰写一封可直接发送的邮件，包含主题：\n' },
  { command: 'report', title: '生成报告', description: '整理为结论先行的专业报告', keywords: '报告 report', group: '写作', prompt: '请将下面的材料整理成专业报告，包含摘要、分析、结论和建议：\n' },
  { command: 'meeting', title: '整理会议', description: '提取决策、待办和负责人', keywords: '会议 纪要 minutes', group: '写作', prompt: '请将下面的会议内容整理为纪要，提取决策、待办、负责人和时限：\n' },

  { command: 'search', title: '网络搜索', description: '搜索当前信息并附上来源', keywords: '搜索 search web', group: '研究', prompt: '请搜索网络上的最新信息，整理结论并附上可核验来源：\n' },
  { command: 'research', title: '深度研究', description: '多来源检索、交叉验证并综合', keywords: '研究 research', group: '研究', prompt: '请对下面的主题进行深度研究，使用多个可靠来源交叉验证，并区分事实、推断与不确定信息：\n' },
  { command: 'sources', title: '查找来源', description: '为当前结论补充一手来源', keywords: '来源 citation source', group: '研究', prompt: '请为当前结论查找可核验的一手来源，给出链接和各来源支持的具体观点。' },
  { command: 'factcheck', title: '事实核查', description: '核对说法、日期、数据与来源', keywords: '核查 fact check', group: '研究', prompt: '请对下面的说法进行事实核查，列出证据、可靠来源和最终判定：\n' },
  { command: 'compare', title: '对比分析', description: '按统一维度比较多个选项', keywords: '对比 compare', group: '研究', prompt: '请对比下面的选项，用统一维度列表比较，并给出适用场景：\n' },
  { command: 'news', title: '查看最新消息', description: '检索近期新闻并标注日期', keywords: '新闻 news latest', group: '研究', prompt: '请查找下面主题的最新消息，注明事件日期、来源和可能的信息差异：\n' },
  { command: 'weather', title: '查询天气', description: '按地点和日期查询天气', keywords: '天气 weather', group: '研究', prompt: '请查询下面地点和日期的天气，并说明数据来源：\n' },
  { command: 'timeline', title: '生成时间线', description: '按时间顺序整理事件', keywords: '时间线 timeline', group: '研究', prompt: '请将下面的事件按时间顺序整理成时间线，标出关键转折点：\n' },
  { command: 'extract', title: '提取信息', description: '从材料中提取指定字段', keywords: '提取 extract', group: '研究', prompt: '请从下面的内容中提取关键信息，按结构化字段输出：\n' },

  { command: 'files', title: '查看工作区', description: '列出文件并说明用途', keywords: '文件 file workspace', group: '文件', prompt: '请检查当前工作区，列出关键文件和目录，并简要说明用途。' },
  { command: 'read', title: '读取文件', description: '打开并解释指定文件', keywords: '读取 read file', group: '文件', prompt: '请读取并解释下面指定的文件：\n' },
  { command: 'analyze-file', title: '分析文件', description: '检查内容、结构和异常', keywords: '文件分析 analyze', group: '文件', prompt: '请分析下面的文件，总结内容、结构、关键数据和异常：\n' },
  { command: 'organize', title: '整理文件', description: '按用途归类并生成整理方案', keywords: '整理 organize files', group: '文件', prompt: '请分析当前工作区文件，先给出安全的整理方案，再根据我的要求执行。' },
  { command: 'compare-files', title: '比较文件', description: '找出两份或多份文件差异', keywords: '文件对比 diff', group: '文件', prompt: '请比较下面指定的文件，列出关键差异和可能影响：\n' },
  { command: 'convert', title: '转换格式', description: '在常用文件格式之间转换', keywords: '转换 convert format', group: '文件', prompt: '请将下面的文件转换为指定格式，尽量保留原有内容和排版：\n' },
  { command: 'word', title: '处理 Word', description: '创建、编辑或检查 Word 文档', keywords: 'word docx 文档', group: '文件', prompt: '请处理下面的 Word 文档任务，完成后检查内容和排版：\n' },
  { command: 'excel', title: '处理 Excel', description: '分析、编辑或创建表格', keywords: 'excel xlsx 表格', group: '文件', prompt: '请处理下面的 Excel 任务，保留现有公式和格式，并验证结果：\n' },
  { command: 'csv', title: '处理 CSV', description: '清洗、分析或转换 CSV 数据', keywords: 'csv data 数据', group: '文件', prompt: '请处理下面的 CSV 数据任务，检查编码、表头、缺失值和类型：\n' },
  { command: 'ppt', title: '制作演示文稿', description: '创建或优化 PowerPoint', keywords: 'ppt pptx slides 幻灯片', group: '文件', prompt: '请根据下面的要求创建或优化演示文稿，确保结构、视觉和信息层级清晰：\n' },
  { command: 'pdf', title: '处理 PDF', description: '读取、提取、分析或生成 PDF', keywords: 'pdf', group: '文件', prompt: '请处理下面的 PDF 任务，必要时按页提取并核对版式：\n' },
  { command: 'image', title: '分析图片', description: '识别图片内容、布局和细节', keywords: '图片 image vision', group: '文件', prompt: '请分析下面的图片，说明画面内容、文字、布局和需要注意的细节：\n' },
  { command: 'ocr', title: '提取图片文字', description: '从图片或扫描件中识别文字', keywords: 'ocr 文字识别', group: '文件', prompt: '请提取下面图片或扫描文档中的文字，尽量保留段落和表格结构：\n' },
  { command: 'chart', title: '创建图表', description: '选择合适图表展示数据', keywords: '图表 chart', group: '文件', prompt: '请根据下面的数据和目标选择合适图表，生成并说明设计理由：\n' },
  { command: 'table', title: '转为表格', description: '把非结构化内容整理成表格', keywords: '表格 table', group: '文件', prompt: '请将下面的内容整理成字段清晰的表格：\n' },

  { command: 'code', title: '编写代码', description: '按当前项目规范实现需求', keywords: '代码 code implement', group: '开发', prompt: '请在当前项目中实现下面的需求，遵循现有架构和风格，完成后运行验证：\n' },
  { command: 'debug', title: '调试问题', description: '复现、定位根因并修复', keywords: '调试 debug bug', group: '开发', prompt: '请复现并调试下面的问题，先定位根因，再实施最小、可验证的修复：\n' },
  { command: 'test', title: '编写测试', description: '补充自动化测试和边界用例', keywords: '测试 test', group: '开发', prompt: '请为下面的功能补充自动化测试，覆盖正常流程、边界条件和失败场景：\n' },
  { command: 'code-review', title: '代码审查', description: '查找错误、回归风险和缺失测试', keywords: '审查 review code', group: '开发', prompt: '请审查当前代码变更，重点查找功能错误、回归风险、安全问题和缺失测试。' },
  { command: 'refactor', title: '重构代码', description: '在不改变行为的前提下改善结构', keywords: '重构 refactor', group: '开发', prompt: '请重构下面的代码，保持对外行为不变，减少重复并提高可维护性：\n' },
  { command: 'optimize', title: '性能优化', description: '先测量再优化瓶颈', keywords: '优化 performance', group: '开发', prompt: '请分析下面的性能问题，找到可测量瓶颈后进行优化，并比较优化前后结果：\n' },
  { command: 'docs', title: '补充文档', description: '编写 README、注释或使用说明', keywords: '文档 docs readme', group: '开发', prompt: '请为下面的功能补充准确、可操作的文档，包含用法、限制和示例：\n' },
  { command: 'security', title: '安全检查', description: '检查输入、权限、秘密和依赖风险', keywords: '安全 security audit', group: '开发', prompt: '请对下面的代码或流程进行安全检查，重点检查输入验证、权限边界、秘密泄露和依赖风险：\n' },
  { command: 'git', title: '检查 Git 变更', description: '总结工作树、差异和风险', keywords: 'git diff status', group: '开发', prompt: '请检查当前 Git 工作树和变更，总结改动、潜在风险和建议的验证项。' },
  { command: 'terminal', title: '执行终端任务', description: '在当前工作区执行并解释结果', keywords: '终端 shell command', group: '开发', prompt: '请在当前工作区执行下面的终端任务，遵守安全边界并说明结果：\n' },

  { command: 'browser-task', title: '执行浏览器任务', description: '打开网页、读取或完成操作', keywords: '浏览器 browser web', group: '自动化', prompt: '请在浏览器中完成下面的任务，每一步都根据最新页面状态操作：\n' },
  { command: 'computer', title: '操作桌面应用', description: '使用 Computer Use 完成可见界面操作', keywords: '桌面 computer use gui', group: '自动化', prompt: '请使用 Computer Use 在桌面界面中完成下面的任务，操作后验证界面结果：\n' },
  { command: 'schedule', title: '创建定时任务', description: '设计任务频率、条件和输出', keywords: '定时 计划 schedule cron', group: '自动化', prompt: '请根据下面的需求帮我设计一个定时任务，明确频率、输入、成功标准和通知规则：\n' },
  { command: 'memory', title: '整理记忆', description: '提取值得长期保留的信息', keywords: '记忆 memory', group: '自动化', prompt: '请从当前会话中识别值得长期保留的稳定事实、偏好和决策，合并重复项并说明依据。' },
  { command: 'find-skill', title: '查找技能', description: '搜索可安装的 Agent Skill', keywords: '技能 skill find', group: '自动化', prompt: '请为下面的需求查找合适的 Agent Skill，比较来源、能力、依赖和风险，先向我推荐候选项：\n' },
  { command: 'workflow', title: '设计工作流', description: '将多步任务设计成可重复流程', keywords: '工作流 workflow', group: '自动化', prompt: '请将下面的需求设计成可重复执行的工作流，包含触发条件、步骤、异常处理和验收标准：\n' },
  { command: 'mcp', title: '配置 MCP', description: '检查或连接 MCP 服务', keywords: 'mcp server', group: '自动化', prompt: '请检查并帮我完成下面的 MCP 配置任务，先验证服务与权限再修改：\n' },
  { command: 'gateway', title: '处理消息网关', description: '检查 Bot 渠道、授权和消息投递', keywords: '消息网关 gateway bot', group: '自动化', prompt: '请检查并处理下面的消息网关任务，区分连接、授权、路由和投递状态：\n' },
  { command: 'dingtalk', title: '处理钉钉任务', description: '读取消息、文件或管理钉钉能力', keywords: '钉钉 dingtalk dws', group: '自动化', prompt: '请使用已配置的钉钉能力完成下面的任务，需要登录时先引导验证：\n' },
  { command: 'feishu', title: '处理飞书任务', description: '读写飞书消息、文档、日历等', keywords: '飞书 feishu lark', group: '自动化', prompt: '请使用已配置的飞书能力完成下面的任务，先读取对应技能说明并验证授权：\n' },
]

export function createPromptCommandItems(): SlashCommandItem[] {
  return PROMPT_COMMANDS.map((item) => ({
    id: `prompt-${item.command}`,
    command: item.command,
    title: item.title,
    description: item.description,
    keywords: item.keywords,
    group: item.group,
    insertText: item.prompt,
  }))
}

interface BotCommandTarget {
  id: string
  name: string
  role?: string
}

/** /bot 的二级子项：每个 Bot 一条，选中后只补全名字，指令正文由使用者接着写 */
export function createBotCommandItems(bots: BotCommandTarget[], currentBotId = ''): SlashCommandItem[] {
  return bots
    .filter((bot) => bot.id !== currentBotId && bot.name.trim())
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    .map((bot) => ({
      id: `bot-${bot.id}`,
      command: commandSlug(bot.name) || bot.id,
      title: bot.name,
      description: bot.role ? `${bot.role} · 指令交给它执行` : '把指令交给它执行',
      keywords: `bot 机器人 指令 交给 委派 ${bot.name} ${bot.role || ''}`,
      group: 'Bot',
      botId: bot.id,
    }))
}

export type SlashSubmission =
  | { kind: 'delegate'; botId: string; botName: string; instruction: string }
  | { kind: 'insert'; text: string }

/** 找到某个二级项所属的分类（用于把「选中 Bot」变成「补全 /bot 名字 」） */
export function findSlashParent(commands: SlashCommandItem[], item: SlashCommandItem) {
  return commands.find((parent) => parent.argument?.items.some((child) => child.id === item.id)) || null
}

/**
 * 解析输入框里写完的斜杠指令：
 * - 「/bot Atlas 指令」→ 交给 Atlas 在当前对话里执行；
 * - 「/skill dws 任务」「/prompt 翻译 文本」→ 插入对应提示词（后面可接任务正文）；
 * - 兼容旧写法：直接写「/Atlas 指令」「/翻译 文本」也能命中；
 * - 解析不了返回 null，按普通消息发送。
 */
export function resolveSlashSubmission(draft: string, commands: SlashCommandItem[]): SlashSubmission | null {
  const value = draft.trim()
  if (!value.startsWith('/')) return null
  const match = value.slice(1).match(/^([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const token = match[1]
  const rest = (match[2] || '').trim()
  const group = commands.find((item) => item.argument && item.command.toLowerCase() === token.toLowerCase())
  if (group) {
    const childToken = rest.split(/\s+/)[0] || ''
    const child = group.argument!.items.find((item) => item.command.toLowerCase() === childToken.toLowerCase())
    if (!child) return null
    const tail = rest.slice(childToken.length).trim()
    if (child.botId) return { kind: 'delegate', botId: child.botId, botName: child.title, instruction: tail }
    if (child.insertText) return { kind: 'insert', text: `${child.insertText}${tail}` }
    return null
  }
  const alias = commands.flatMap((item) => item.argument?.items || []).find((item) => item.command.toLowerCase() === token.toLowerCase())
  if (!alias) return null
  if (alias.botId) return { kind: 'delegate', botId: alias.botId, botName: alias.title, instruction: rest }
  if (alias.insertText) return { kind: 'insert', text: `${alias.insertText}${rest}` }
  return null
}

const haystack = (item: SlashCommandItem) => `${item.command} ${item.title} ${item.description} ${item.group || ''} ${item.keywords || ''}`.toLowerCase()

/**
 * 两级菜单：写「/」只列分类（/bot、/skill、/prompt）+ 内置操作；
 * 写「/bot 」之后再列这一类的名字（各个 Bot）。上百条指令不再挤在一屏里。
 */
export function matchingSlashCommands(draft: string, commands: SlashCommandItem[]) {
  const first = draft.match(/^\/([^\s]*)$/)
  if (first) {
    const query = first[1].toLowerCase()
    return commands.filter((item) => haystack(item).includes(query))
  }
  const second = draft.match(/^\/([^\s]+)\s+([^\s]*)$/)
  if (second) {
    const group = commands.find((item) => item.argument && item.command.toLowerCase() === second[1].toLowerCase())
    if (!group) return []
    const query = second[2].toLowerCase()
    return group.argument!.items.filter((item) => haystack(item).includes(query))
  }
  return []
}

export interface SlashCommandCatalogOptions {
  /** 各页面自己的内置操作（新对话、设置、浏览器…） */
  applicationCommands: SlashCommandItem[]
  bots: BotCommandTarget[]
  skills: Skill[]
  currentBotId?: string
  setDraft: (value: string) => void
}

/**
 * 一级菜单只留「内置操作 + 3 个分类」，名字全部收进二级：
 * /bot <Bot 名> <指令>、/skill <技能名>、/prompt <模板名>。
 * 之前 80 多个指令平铺在一屏里，找起来很费劲。
 */
export function createSlashCommandCatalog({ applicationCommands, bots, skills, currentBotId = '', setDraft }: SlashCommandCatalogOptions): SlashCommandItem[] {
  const groups: SlashCommandItem[] = [
    {
      id: 'slash-group-bot',
      command: 'bot',
      title: '给 Bot 下指令',
      group: '交给 Bot',
      description: '/bot <Bot 名> <指令>：在当前对话里交给那个 Bot 执行，回复也显示在这里',
      keywords: 'bot 机器人 指令 下发 交给 委派 delegate',
      argument: { label: 'Bot 名', hint: '选中 Bot 后接着写要交给它的指令，回车即发送', items: createBotCommandItems(bots, currentBotId) },
      run: () => setDraft('/bot '),
    },
    {
      id: 'slash-group-skill',
      command: 'skill',
      title: '使用技能',
      group: '能力',
      description: '/skill <技能名>：插入技能加载指令，后面可以接着写任务',
      keywords: 'skill 技能 加载 目录',
      argument: { label: '技能名', hint: '选中后插入「请先加载并使用…」，也可以直接写 /skill dws 你的任务', items: createSkillCommandItems(skills) },
      run: () => setDraft('/skill '),
    },
    {
      id: 'slash-group-prompt',
      command: 'prompt',
      title: '提示词模板',
      group: '提示词',
      description: '/prompt <模板名>：插入现成提示词（总结、翻译、润色…）',
      keywords: 'prompt 提示词 模板 总结 翻译 润色',
      argument: { label: '模板名', hint: '选中后插入这段提示词；旧写法 /翻译 也还能用', items: createPromptCommandItems() },
      run: () => setDraft('/prompt '),
    },
  ]
  return [...applicationCommands, ...groups.filter((group) => (group.argument?.items.length || 0) > 0)]
}

/**
 * 「/bot 名字 指令」发出的用户消息会写成「@名字 指令」。
 * 这里据此判断某条回复是哪个 Bot 回答的——从数据库读回来（刷新、换窗口）也能显示，
 * 不依赖只存在于内存里的标记。名字必须能对上已知 Bot，避免把普通 @ 文本当成委派。
 */
export function delegatedBotNameFor(messages: { role: string; content: string }[], index: number, botNames: string[]) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const item = messages[cursor]
    if (item.role === 'assistant') continue
    if (item.role !== 'user') return ''
    const match = item.content.match(/^@([^\s@]{1,40})[\s\u3000]/)
    if (!match) return ''
    return botNames.find((candidate) => candidate.toLowerCase() === match[1].toLowerCase()) || ''
  }
  return ''
}

function commandSlug(value: string) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
}

/** /skill 的二级子项 */
export function createSkillCommandItems(skills: Skill[]): SlashCommandItem[] {
  return skills
    .filter((skill) => skill.enabled && skill.name.trim())
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    .map((skill) => ({
      id: `skill-${skill.id}`,
      command: commandSlug(skill.id || skill.name) || 'skill',
      title: skill.name,
      description: skill.description || '加载这个技能并执行任务',
      keywords: `skill 技能 ${skill.category} ${skill.source}`,
      group: '技能',
      insertText: `请先加载并使用「${skill.name}」技能处理下面的任务：\n`,
    }))
}
