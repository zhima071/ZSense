#!/usr/bin/env node
// 任务执行效率基准：把「一次任务到底慢在哪」变成可重复运行的数字。
// 用法：
//   npm run bench:efficiency                    # 全量（含规模数据与真实库副本）
//   npm run bench:efficiency -- --quick         # 跳过规模数据与请求体量
//   npm run bench:efficiency -- --conversations 500 --messages 10
// 详细方法论见 docs/efficiency.md。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ZSenseDatabase } = await import(path.join(projectRoot, 'electron/services/database.mjs'))
const { AgentCapabilityService } = await import(path.join(projectRoot, 'electron/services/agent-capability-service.mjs'))
const { ZSenseAgentCore } = await import(path.join(projectRoot, 'electron/services/zsense-agent-core.mjs'))

const argumentsList = process.argv.slice(2)
const readFlag = (name, fallback) => {
  const index = argumentsList.indexOf(`--${name}`)
  return index >= 0 && argumentsList[index + 1] ? argumentsList[index + 1] : fallback
}
const quick = argumentsList.includes('--quick')
const scaleConversations = Number(readFlag('conversations', 300))
const scaleMessages = Number(readFlag('messages', 8))
const rows = []
const record = (area, metric, value) => { rows.push({ area, metric, value }); console.log(`  ${metric}: ${value}`) }
const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`

// ---------- 1. 一轮模型请求的体量 ----------
async function measureModelPayload() {
  console.log('\n[1/4] 一轮模型请求的体量（系统提示词 / 工具模式 / 消息）')
  const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'zsense-bench-payload-'))
  for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(workspacePath, `note-${index}.txt`), `文件 ${index} 的内容\n`.repeat(50), 'utf8')
  const capabilityRoot = mkdtempSync(path.join(os.tmpdir(), 'zsense-bench-capability-'))
  const database = new ZSenseDatabase(capabilityRoot)
  const capabilityService = new AgentCapabilityService({ rootPath: capabilityRoot, database, browserService: { shutdown: () => undefined } })

  const rounds = []
  let roundIndex = 0
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body)
    roundIndex += 1
    const systemMessage = parsed.messages.find((message) => message.role === 'system')
    rounds.push({
      round: roundIndex,
      totalBytes: Buffer.byteLength(body, 'utf8'),
      systemChars: (systemMessage?.content || '').length,
      toolsChars: JSON.stringify(parsed.tools || []).length,
      toolCount: (parsed.tools || []).length,
      messagesChars: parsed.messages.reduce((total, message) => total + String(message.content || '').length, 0),
      messageCount: parsed.messages.length,
    })
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    if (roundIndex === 1) {
      const calls = ['note-0.txt', 'note-1.txt', 'note-2.txt'].map((name, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: 'read_text_file', arguments: JSON.stringify({ path: name }) } }))
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\n`)
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '基准测量完成。' } }] })}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const core = new ZSenseAgentCore({ capabilityService })
  await core.chatStream({
    requestId: 'bench-payload',
    bot: { id: 'atlas', name: 'Atlas', role: '研究助手', prompt: '回答必须基于事实。' },
    message: '读一下工作区里的三个 note 文件。',
    model: 'bench-model',
    modelProvider: 'custom',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    workspacePath,
    settings: { responseLanguage: 'zh-CN' },
    onEvent: () => {},
  })
  server.close()
  const first = rounds[0]
  const definitions = capabilityService.definitions({ workspacePath, conversationId: 'bench' })
  record('模型请求', '第 1 轮请求总量', kb(first.totalBytes))
  record('模型请求', '系统提示词字数', `${first.systemChars} 字`)
  record('模型请求', `工具模式（${first.toolCount} 个）`, kb(first.toolsChars))
  record('模型请求', '工具模式清单（能力层）', `${definitions.length} 个 / ${kb(JSON.stringify(definitions).length)}`)
  for (const round of rounds) record('模型请求', `第 ${round.round} 轮消息体量`, `${round.messagesChars} 字 / ${round.messageCount} 条`)
  const heaviest = definitions.map((tool) => ({ name: tool.name, bytes: JSON.stringify(tool).length })).sort((left, right) => right.bytes - left.bytes).slice(0, 5)
  for (const item of heaviest) record('模型请求', `最重的工具模式 ${item.name}`, kb(item.bytes))
}

// ---------- 2. 数据库读取路径与查询计划 ----------
function measureDatabase() {
  console.log(`\n[2/4] 数据库读取路径（规模数据：${scaleConversations} 会话 / ${scaleConversations * scaleMessages} 消息）`)
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zsense-bench-scale-'))
  const database = new ZSenseDatabase(directory)
  const raw = database.db
  const heavyReasoning = '这是一段推理文本。'.repeat(120)
  const heavyJson = JSON.stringify(Array.from({ length: 6 }, (_, index) => ({ id: `tool-${index}`, name: 'terminal', status: 'complete', output: 'o'.repeat(600), index })))
  const insertConversation = raw.prepare("INSERT INTO conversations (id, bot_id, title, channel_id, created_at, updated_at) VALUES (?, 'atlas', ?, 'desktop', ?, ?)")
  const insertMessage = raw.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, reasoning, tool_events_json, agent_steps_json, model_provider, model, duration_ms, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deepseek', 'deepseek-chat', 4000, 300)")
  const insertStarted = Date.now()
  raw.exec('BEGIN')
  for (let conversation = 0; conversation < scaleConversations; conversation += 1) {
    const conversationId = `conversation-bench-${conversation}`
    const stamp = new Date(Date.now() - conversation * 60_000).toISOString()
    insertConversation.run(conversationId, `基准会话 ${conversation}`, stamp, stamp)
    for (let message = 0; message < scaleMessages; message += 1) {
      insertMessage.run(
        `message-bench-${conversation}-${message}`,
        conversationId,
        message % 2 === 0 ? 'user' : 'assistant',
        '这是一条消息正文。'.repeat(40),
        new Date(Date.now() - conversation * 60_000 + message * 1_000).toISOString(),
        heavyReasoning, heavyJson, heavyJson,
      )
    }
  }
  raw.exec('COMMIT')
  record('数据库', '写入规模数据耗时', `${Date.now() - insertStarted}ms`)
  record('数据库', '库文件大小', `${(fs.statSync(path.join(directory, 'zsense.sqlite3')).size / 1024 / 1024).toFixed(1)}MB`)

  const timeIt = (label, run, rounds = 5) => {
    run()
    const started = Date.now()
    for (let round = 0; round < rounds; round += 1) run()
    const average = (Date.now() - started) / rounds
    record('数据库', label, `${average.toFixed(2)}ms`)
    return average
  }
  const conversation = `conversation-bench-0`
  const conversationMessages = raw.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY datetime(created_at), rowid')
  const settingsMs = timeIt('loadSettings()（只读设置）', () => database.loadSettings(), 20)
  const gatewayRuntimeMs = timeIt('loadGatewayRuntime()（网关健康检查）', () => database.loadGatewayRuntime(), 20)
  const workspaceMs = timeIt('loadWorkspace()（完整快照）', () => database.loadWorkspace(), 5)
  timeIt('按会话读取全部消息', () => conversationMessages.all(conversation), 20)
  record('数据库', '轻量读取相对完整快照', `${(workspaceMs / Math.max(settingsMs, 0.01)).toFixed(0)} 倍更快`)
  record('数据库', '网关健康读取相对完整快照', `${(workspaceMs / Math.max(gatewayRuntimeMs, 0.01)).toFixed(0)} 倍更快`)

  const planFor = (sql) => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail)).join(' | ')
  for (const [label, sql] of [
    ['按会话读取消息', `SELECT * FROM messages WHERE conversation_id='${conversation}' ORDER BY datetime(created_at), rowid`],
    ['会话列表', 'SELECT * FROM conversations ORDER BY datetime(updated_at) DESC, rowid DESC'],
    ['活动流', 'SELECT * FROM activities ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 100'],
  ]) {
    record('查询计划', label, planFor(sql))
  }
}

// ---------- 3. 启动与首次快照 ----------
function measureStartup() {
  console.log('\n[3/4] 启动成本')
  const real = path.join(os.homedir(), 'Library/Application Support/ZSense/zsense.sqlite3')
  let directory = ''
  if (fs.existsSync(real)) {
    directory = mkdtempSync(path.join(os.tmpdir(), 'zsense-bench-boot-'))
    fs.copyFileSync(real, path.join(directory, 'zsense.sqlite3'))
    record('启动', '数据来源', '真实库副本')
  } else {
    directory = mkdtempSync(path.join(os.tmpdir(), 'zsense-bench-boot-'))
    record('启动', '数据来源', '空库（未找到真实库）')
  }
  const started = Date.now()
  const database = new ZSenseDatabase(directory)
  record('启动', '打开数据库（含迁移与统计同步）', `${Date.now() - started}ms`)
  const snapshotStarted = Date.now()
  database.loadWorkspace()
  record('启动', '首次完整快照', `${Date.now() - snapshotStarted}ms`)
  const capabilityStarted = Date.now()
  const capabilityService = new AgentCapabilityService({ rootPath: path.join(directory, 'agent-core'), database, browserService: { shutdown: () => undefined } })
  record('启动', '能力服务构造', `${Date.now() - capabilityStarted}ms`)
  const toolsStarted = Date.now()
  const definitions = capabilityService.definitions({ workspacePath: directory, conversationId: 'bench' })
  record('启动', '工具模式生成', `${Date.now() - toolsStarted}ms / ${definitions.length} 个`)
}

// ---------- 4. 汇总 ----------
console.log('ZSense 执行效率基准')
console.log(`项目: ${projectRoot}`)
if (!quick) await measureModelPayload()
else console.log('\n[1/4] 已跳过（--quick）')
if (!quick) measureDatabase()
else console.log('\n[2/4] 已跳过（--quick）')
measureStartup()
console.log('\n=== 汇总 ===')
for (const row of rows) console.log(`${row.area.padEnd(6)} | ${row.metric} | ${row.value}`)
console.log('\n提示：优化前后各跑一次对比数字；改代码后 npm test 会检查关键路径是否退化。')
process.exit(0)
