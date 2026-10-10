// 「/bot 名字 指令」与分类斜杠指令的回归：
// - 一级菜单只列分类（/bot、/skill、/prompt）+ 内置操作，不再把上百条指令平铺一屏；
// - 「/bot Atlas 指令」在当前对话里交给 Atlas 执行（不跳转），回复也显示在这个对话里；
// - 「/skill dws 任务」「/prompt 翻译 文本」把提示词插进输入框，旧写法 /翻译 仍可用。
// 纯逻辑直接跑真实模块；两个输入框与主进程的接线用源码断言钉住，避免只改了一处。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSlashCommandCatalog, delegatedBotNameFor, matchingSlashCommands, resolveSlashSubmission } from '../src/components/slash-command-catalog.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(projectRoot, relative), 'utf8')

const dialogSource = read('src/components/ChatDialog.tsx')
const nativeSource = read('src/components/NativeChatPage.tsx')
const appSource = read('src/App.tsx')
const menuSource = read('src/components/SlashCommandMenu.tsx')
const ipcSource = read('electron/ipc.mjs')
const typesSource = read('src/types.ts')
const runStoreSource = read('src/services/chat-run-store.ts')

const bots = [
  { id: 'atlas', name: 'Atlas', role: '知识管家' },
  { id: 'scout', name: 'Scout', role: '研究助手' },
  { id: 'miaomiao', name: '月薪喵' },
]
const skills = [
  { id: 'dws', name: 'dws', enabled: true, description: '钉钉命令行', category: '办公', source: 'local' },
  { id: 'disabled-one', name: '停用技能', enabled: false, description: '', category: '', source: '' },
]
const applicationCommands = [
  { id: 'new', command: 'new', title: '新对话', description: '新建一个对话', run: () => undefined },
  { id: 'settings', command: 'settings', title: '打开设置', description: '进入设置', run: () => undefined },
  { id: 'help', command: 'help', title: '查看快捷指令', description: '重新显示全部斜杠命令', run: () => undefined },
]

// 当前对话属于「月薪喵」，所以二级 Bot 列表里是另外两个
const catalog = createSlashCommandCatalog({ applicationCommands, bots, skills, currentBotId: 'miaomiao', setDraft: () => undefined })

// 1) 一级菜单必须是「短列表」：内置操作 + 分类
assert(catalog.length <= 12, `一级斜杠指令应保持精简，当前有 ${catalog.length} 项`)
assert.deepEqual(catalog.map((item) => item.command), ['new', 'settings', 'help', 'bot', 'skill', 'prompt'], `一级指令不符合预期：${catalog.map((item) => item.command).join(', ')}`)

// 2) 分类都带二级名字，用法写在说明里
const botGroup = catalog.find((item) => item.command === 'bot')
assert(botGroup?.argument, '/bot 缺少二级 Bot 名字列表')
assert(botGroup.description.includes('/bot <Bot 名> <指令>'), '/bot 说明里没有写用法')
assert.deepEqual(botGroup.argument.items.map((item) => item.command), ['atlas', 'scout'], '二级 Bot 列表应排除当前 Bot，命令名用 Bot 名字')
assert(botGroup.argument.items.every((item) => !item.insertText && item.botId), 'Bot 子项应该是「选名字」而不是「插提示词」')
assert.deepEqual(catalog.find((item) => item.command === 'skill').argument.items.map((item) => item.command), ['dws'], '停用的技能不该出现在 /skill 列表里')
assert(!catalog.some((item) => item.command === 'plugin'), '技能模式不应再暴露插件命令')
assert(catalog.find((item) => item.command === 'prompt').argument.items.length > 40, '提示词模板应全部收进 /prompt 二级')

// 3) 菜单匹配：一级列分类，二级列名字
assert.equal(matchingSlashCommands('/', catalog).length, catalog.length, '输入「/」应列出全部一级指令')
assert.deepEqual(matchingSlashCommands('/bo', catalog).map((item) => item.command), ['bot'], '/bo 应过滤出一级 /bot')
assert.deepEqual(matchingSlashCommands('/bot ', catalog).map((item) => item.command), ['atlas', 'scout'], '/bot 后应列出 Bot 名字')
assert.deepEqual(matchingSlashCommands('/bot sc', catalog).map((item) => item.command), ['scout'], '/bot sc 应过滤出 Scout')
assert.equal(matchingSlashCommands('/bot Atlas 指令', catalog).length, 0, '写完整条指令后菜单应收起')
assert(matchingSlashCommands('/prompt translate', catalog).some((item) => item.command === 'translate'), '/prompt translate 应能过滤出翻译模板')

// 4) 「/bot 名字 指令」解析成「在当前对话里交给它执行」
assert.deepEqual(resolveSlashSubmission('/bot Atlas 帮我统计昨天的会话数', catalog), { kind: 'delegate', botId: 'atlas', botName: 'Atlas', instruction: '帮我统计昨天的会话数' })
assert.deepEqual(resolveSlashSubmission('/bot Scout', catalog), { kind: 'delegate', botId: 'scout', botName: 'Scout', instruction: '' }, '只写名字时应提示补指令，而不是换对话')
assert.deepEqual(resolveSlashSubmission('/bot Scout\n把服务重启一下', catalog), { kind: 'delegate', botId: 'scout', botName: 'Scout', instruction: '把服务重启一下' }, '换行后的内容应作为指令正文')
assert.equal(resolveSlashSubmission('/bot moon 指令', catalog), null, '不存在的 Bot 不该被命中')

// 5) /skill、/prompt 插入提示词，后面可以接任务
const skillSubmission = resolveSlashSubmission('/skill dws 查一下待办', catalog)
assert(skillSubmission?.kind === 'insert' && skillSubmission.text.includes('「dws」技能') && skillSubmission.text.endsWith('查一下待办'), `技能指令应插入提示词并带上任务：${JSON.stringify(skillSubmission)}`)
const promptSubmission = resolveSlashSubmission('/prompt translate 你好世界', catalog)
assert(promptSubmission?.kind === 'insert' && promptSubmission.text.endsWith('你好世界'), '提示词模板应带上后面的正文')
assert.equal(resolveSlashSubmission('/prompt 不存在的模板', catalog), null)

// 6) 旧的直接写法仍然可用（/Atlas 指令、/翻译 文本）
assert.deepEqual(resolveSlashSubmission('/Atlas 帮我查一下', catalog), { kind: 'delegate', botId: 'atlas', botName: 'Atlas', instruction: '帮我查一下' }, '旧写法 /Atlas 指令 应继续可用')
assert.equal(resolveSlashSubmission('/translate 你好', catalog)?.kind, 'insert', '旧写法 /translate 应继续插入提示词')
assert.equal(resolveSlashSubmission('普通消息', catalog), null, '普通消息不该被拦截')
assert.equal(resolveSlashSubmission('/', catalog), null)

// 7) 前端：两个输入框都用同一套目录与解析，并且不再跳转
for (const [label, source] of [['ChatDialog', dialogSource], ['NativeChatPage', nativeSource]]) {
  assert(source.includes('createSlashCommandCatalog('), `${label} 没有使用分类目录`)
  assert(source.includes('resolveSlashSubmission(draft, slashCommands)'), `${label} 没有解析「/bot 名字 指令」`)
  assert(source.includes('findSlashParent(slashCommands, command)'), `${label} 选中二级项时没有区分 Bot / 提示词`)
  assert(source.includes('delegateBotId: delegation?.botId'), `${label} 发送时没有带上被委派的 Bot`)
  assert(source.includes('delegateBotName: delegation?.botName'), `${label} 没有标记这条回复来自哪个 Bot`)
  assert(source.includes('delegatedAuthorByMessageId.get(message.id)'), `${label} 回复作者行没有显示被委派 Bot（刷新后也要能显示）`)
  assert(!source.includes('onOpenBotChat'), `${label} 还留着「切到对方对话」的旧逻辑`)
  assert(!source.includes('matchBotInstruction'), `${label} 还留着旧的单级 Bot 指令解析`)
}
assert(dialogSource.includes('后面接着写要交给它的指令'), '只写 /bot 名字时缺少补指令提示')

// 8) App：斜杠委派不能跳转；普通会话入口可复用受保护的导航函数。
assert.doesNotMatch(appSource, /onOpenBotChat=/, 'App 不能把跳转回调接回斜杠委派入口')
if (appSource.includes('const openBotChat =')) {
  assert.match(appSource, /const openBotChat = [^\n]*guardedNavigation\(/, '普通 Bot 会话跳转必须尊重未保存文件确认')
}
assert(!appSource.includes('botInstructionRequest'), 'App 还留着跳转用的指令请求状态')
assert(appSource.includes('delegateBotId?: string'), 'App 的发送选项缺少 delegateBotId')

// 9) 主进程：执行者用被委派 Bot，会话仍是当前会话
assert(ipcSource.includes("const delegateBotId = optionalText(value.delegateBotId, '被委派的 Bot ID', 180)"), '主进程没有接收 delegateBotId')
assert(ipcSource.includes("database.getConversation(requestedConversationId, delegateBotId ? '' : botId)"), '主进程委派时仍按执行者过滤会话')
assert(ipcSource.includes('database.memoryService.recallMemories(bot.id, safeText(message)'), '委派时应召回被委派 Bot 的记忆')
assert(ipcSource.includes('workspace.skills.filter((skill) => native && !delegateBotId ?'), '委派时应按被委派 Bot 过滤技能')
assert(ipcSource.includes('if (!delegateBotId) database.updateConversationOptions(conversationId, botId, { modelProvider'), '委派不该改当前会话的模型设置')
assert(ipcSource.includes('database.memoryService.retainUserMessage(bot.id, memorySourceMessage'), '委派产生的记忆应记在被委派 Bot 的独立记忆空间')
assert(ipcSource.includes('memoryConversationId = database.mirrorDelegatedExchange(') && ipcSource.includes('conversationId: memoryConversationId'), '委派记忆不能引用源空间的会话 ID')
assert(ipcSource.includes('if (delegateBotId && conversation && conversation.botId !== botId)'), '委派时缺少会话归属校验')

// 10) 刷新后仍能认出「这条回复是哪个 Bot 答的」：靠前一条用户消息的「@名字 」标记
const transcript = [
  { role: 'user', content: '你能看到表格里的公式吗' },
  { role: 'assistant', content: '能看到' },
  { role: 'user', content: '@Atlas 只回复“已收到指令”四个字' },
  { role: 'assistant', content: '已收到指令' },
]
assert.equal(delegatedBotNameFor(transcript, 3, ['Atlas', 'Scout']), 'Atlas', '应能由 @Atlas 标记认出回复来自 Atlas')
assert.equal(delegatedBotNameFor(transcript, 1, ['Atlas', 'Scout']), '', '普通回复不该被当成委派')
assert.equal(delegatedBotNameFor(transcript, 3, ['Scout']), '', '名字对不上已知 Bot 时不该硬认')
assert.equal(delegatedBotNameFor([{ role: 'user', content: '@不存在的Bot 指令' }, { role: 'assistant', content: 'x' }], 1, ['Atlas']), '', '未知名字应返回空')
assert.equal(delegatedBotNameFor([{ role: 'user', content: '@atlas 大小写不敏感' }, { role: 'assistant', content: 'x' }], 1, ['Atlas']), 'Atlas', '名字匹配应忽略大小写')

// 11) 类型与消息标记
assert(typesSource.includes('delegateBotId?: string'), 'ChatRequest 缺少 delegateBotId')
assert(runStoreSource.includes('delegateBotName?: string'), '会话消息类型缺少 delegateBotName')
assert(menuSource.includes('argument?: { label: string; hint: string; items: SlashCommandItem[] }'), 'SlashCommandItem 缺少二级参数定义')

const promptTemplates = catalog.find((item) => item.command === 'prompt').argument.items.length
console.log(JSON.stringify({ ok: true, topLevelCommands: catalog.length, secondLevelBots: botGroup.argument.items.length, promptTemplates, checkedFiles: 7 }))
