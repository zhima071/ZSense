// 效率回归：这些是「任务处理得更快」的底层保障，改动它们时的退化很难被功能测试发现。
// 覆盖三块：热点查询必须走索引、只有读设置时不许把整库消息读进内存、渲染进程必须合并流式增量。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { createStreamDeltaBuffer } from '../src/utils/stream-delta-buffer.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = mkdtempSync(path.join(tmpdir(), 'zsense-efficiency-'))
const database = new ZSenseDatabase(directory)

// 造一份「用得比较久」的数据：会话和消息都带 reasoning/tool_events/agent_steps 这类大 JSON 字段
const insertConversation = database.db.prepare("INSERT INTO conversations (id, bot_id, title, channel_id, created_at, updated_at) VALUES (?, 'atlas', ?, 'desktop', ?, ?)")
const insertMessage = database.db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, reasoning, tool_events_json, agent_steps_json) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)")
const heavyReasoning = '推理内容。'.repeat(300)
const heavyJson = JSON.stringify(Array.from({ length: 8 }, (_, index) => ({ name: 'terminal', output: 'o'.repeat(400), index })))
const conversationCount = 120
for (let conversation = 0; conversation < conversationCount; conversation += 1) {
  const conversationId = `conversation-efficiency-${conversation}`
  const stamp = new Date(Date.now() - conversation * 60_000).toISOString()
  insertConversation.run(conversationId, `效率会话 ${conversation}`, stamp, stamp)
  for (let message = 0; message < 6; message += 1) {
    insertMessage.run(`message-efficiency-${conversation}-${message}`, conversationId, '回答正文。'.repeat(30), new Date(Date.now() - conversation * 60_000 + message * 1_000).toISOString(), heavyReasoning, heavyJson, heavyJson)
  }
}

const planFor = (sql) => database.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail)).join(' | ')

// 1) 按会话读取消息：必须走索引，且不再需要临时排序（这是打开会话和每轮 Agent 读历史的必经之路）
const conversationMessagesPlan = planFor("SELECT * FROM messages WHERE conversation_id='conversation-efficiency-1' ORDER BY datetime(created_at), rowid")
assert(conversationMessagesPlan.includes('messages_conversation_datetime'), `按会话读取消息没有使用索引：${conversationMessagesPlan}`)
assert(!conversationMessagesPlan.includes('SCAN messages'), `按会话读取消息仍在全表扫描：${conversationMessagesPlan}`)
assert(!conversationMessagesPlan.includes('TEMP B-TREE FOR ORDER BY'), `按会话读取消息仍在做临时排序：${conversationMessagesPlan}`)

for (const [label, sql] of [
  ['会话列表', 'SELECT * FROM conversations ORDER BY datetime(updated_at) DESC, rowid DESC'],
  ['活动流', 'SELECT * FROM activities ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 100'],
]) {
  const plan = planFor(sql)
  assert(!plan.includes('SCAN ') || plan.includes('USING INDEX'), `${label}仍在全表扫描：${plan}`)
  assert(!plan.includes('TEMP B-TREE FOR ORDER BY') || plan.includes('LAST TERM'), `${label}仍在整体临时排序：${plan}`)
}

// 2) 只读设置时不能把全部消息读进内存
const settings = database.loadSettings()
assert.equal(typeof settings, 'object')
assert.equal(settings.responseLanguage, database.loadWorkspace().settings.responseLanguage, 'loadSettings 与完整快照的读取结果必须一致')
const settingsStarted = Date.now()
for (let round = 0; round < 20; round += 1) database.loadSettings()
const settingsMs = (Date.now() - settingsStarted) / 20
const workspaceStarted = Date.now()
for (let round = 0; round < 5; round += 1) database.loadWorkspace()
const workspaceMs = (Date.now() - workspaceStarted) / 5
assert(settingsMs * 4 < workspaceMs, `只读设置应显著快于完整快照（设置 ${settingsMs.toFixed(1)}ms / 完整 ${workspaceMs.toFixed(1)}ms）`)
const gatewayStarted = Date.now()
for (let round = 0; round < 20; round += 1) database.loadGatewayRuntime()
const gatewayMs = (Date.now() - gatewayStarted) / 20
assert(gatewayMs * 4 < workspaceMs, `网关健康检查应使用轻量快照（网关 ${gatewayMs.toFixed(1)}ms / 完整 ${workspaceMs.toFixed(1)}ms）`)

const settingsSource = fs.readFileSync(path.join(projectRoot, 'electron/services/database.mjs'), 'utf8')
assert(settingsSource.includes('loadSettings() {'), '数据库缺少只读设置的轻量访问器')
const fullSnapshotReads = fs.readdirSync(path.join(projectRoot, 'electron'), { recursive: true })
  .filter((name) => String(name).endsWith('.mjs'))
  .filter((name) => fs.readFileSync(path.join(projectRoot, 'electron', String(name)), 'utf8').includes('loadWorkspace().settings'))
assert.equal(fullSnapshotReads.length, 0, `仍有地方为了读一个设置字段而加载完整快照：${fullSnapshotReads.join('、')}`)
const gatewaySource = fs.readFileSync(path.join(projectRoot, 'electron/services/zsense-gateway-service.mjs'), 'utf8')
assert((gatewaySource.match(/this\.database\.loadGatewayRuntime\(\)/g) || []).length >= 2, '网关 reconcile/inspect 又退化成了完整工作区快照')

// 3) 渲染进程必须合并流式增量，否则一次长回答会触发上千次整树重渲染
const bufferSource = fs.readFileSync(path.join(projectRoot, 'src/utils/stream-delta-buffer.ts'), 'utf8')
assert(bufferSource.includes('createStreamDeltaBuffer'), '缺少流式增量合并工具')
const appliedChunks = []
const streamBuffer = createStreamDeltaBuffer(20)
for (let index = 0; index < 100; index += 1) {
  // 每次故意传一个新闭包，模拟真实 SSE token 事件；同一会话仍必须合并。
  streamBuffer.push(String(index % 10), (chunk) => appliedChunks.push(chunk), 'conversation-1')
}
await new Promise((resolve) => setTimeout(resolve, 45))
assert.equal(appliedChunks.length, 1, '同一会话的新闭包导致流式缓冲提前 flush，token 合并已退化')
assert.equal(appliedChunks[0].length, 100, '流式缓冲合并后丢失了 token')
streamBuffer.dispose()
for (const component of ['src/components/ChatDialog.tsx', 'src/components/NativeChatPage.tsx']) {
  const source = fs.readFileSync(path.join(projectRoot, component), 'utf8')
  assert(source.includes('createStreamDeltaBuffer'), `${component} 没有合并流式回答增量`)
  assert(source.includes('answerDeltas.push'), `${component} 没有把回答增量交给合并缓冲`)
  assert(source.includes('flushStreamDeltas()'), `${component} 缺少事件间的增量落地`)
}
const appSource = fs.readFileSync(path.join(projectRoot, 'src/App.tsx'), 'utf8')
assert(appSource.includes('if (index >= 0 && !Object.keys(update).some'), '会话进度更新没有跳过无变化的重复写入')

// 4) 聚合测试入口不能被当成单个测试（否则 npm test 会无限递归地再启动自己）
const runnerList = fs.readFileSync(path.join(projectRoot, 'scripts/run-all-tests.mjs'), 'utf8')
assert(runnerList.includes("!String(scripts[name]).includes('run-all-tests.mjs')"), '聚合测试入口缺少递归保护')

console.log(JSON.stringify({
  ok: true,
  indexedMessageReads: true,
  settingsReadWithoutMessages: true,
  gatewayHealthReadWithoutMessages: true,
  noFullSnapshotSettingReads: true,
  streamingDeltasCoalesced: true,
  streamingBehaviorVerified: true,
  testRunnerRecursionGuard: true,
  measuredMs: { settingsRead: Number(settingsMs.toFixed(2)), gatewayRuntime: Number(gatewayMs.toFixed(2)), fullSnapshot: Number(workspaceMs.toFixed(2)) },
}, null, 0))
process.exit(0)
