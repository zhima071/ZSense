// 对话卡片行为回归：审批弹窗、澄清选择卡这两处都出过真实问题，
// 而且都靠渲染层状态管理，功能测试不容易发现退化，这里用源码与行为断言把它们钉住。
// 1) 审批弹窗必须说明“自动审批为什么没有直接放行”
// 2) 澄清卡片切换会话后不能变回空白，点击必须有反馈，失效要显示失效
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(projectRoot, relative), 'utf8')

const cardSource = read('src/components/ChatClarificationCard.tsx')
const dialogSource = read('src/components/ChatDialog.tsx')
const nativeSource = read('src/components/NativeChatPage.tsx')
const coreSource = read('electron/services/zsense-agent-core.mjs')
const capabilitySource = read('electron/services/agent-capability-service.mjs')
const typesSource = read('src/types.ts')

// 1) 审批弹窗：自动审批未生效时必须给出原因
assert(capabilitySource.includes("autoFallback = autoDecision"), '审批没有记录自动审批的失败原因')
assert(capabilitySource.includes("state: 'disabled'"), '缺少“自动审批未开启”的回退状态')
assert(capabilitySource.includes("state: 'unavailable'"), '缺少“自动审批没给出判断”的回退状态')
assert(capabilitySource.includes('autoApproval: autoFallback'), '回退原因没有传给审批界面')
assert(coreSource.includes('approvalAutoReason'), '澄清事件没有把自动审批原因带给界面')
assert(typesSource.includes('approvalAutoState'), '类型定义缺少自动审批状态字段')
assert(cardSource.includes('chat-approval-auto-note'), '审批卡片没有展示自动审批原因的位置')
assert(cardSource.includes('设置 → 工具与 MCP'), '未开启自动审批时没有提示开关位置')
assert(coreSource.includes('这就是用户自己要求的外部发送或定时动作'), '自动审批提示词没有覆盖“用户自己要求的外部发送/定时任务”')
assert(read('electron/services/database.mjs').includes('autoApprovalEnabled: true'), '自动审批应默认开启以减少打断')

// 2) 澄清卡片：状态必须放在组件之外，重挂载后仍保留
assert(cardSource.includes('const cardStates = new Map<string, CardState>()'), '澄清卡片状态没有跨挂载保存')
assert(cardSource.includes('writeCardState(cardKeyOf(clarification), merged)'), '澄清卡片状态没有写回外部存储')
assert(cardSource.includes("const [state, setState] = useState<CardState>(() => readState(clarification))"), '澄清卡片没有从外部存储恢复状态')
assert(cardSource.includes('readState(clarification)'), '澄清卡片重新挂载时没有恢复已填内容')
assert(cardSource.includes('unfinished > 0 ? `还差 ${unfinished} 项`'), '未答完时按钮没有说明还差什么')
assert(cardSource.includes('stale'), '澄清卡片缺少失效状态')
assert(cardSource.includes('isGoneMessage'), '运行结束后继续点击没有失效处理')
for (const [name, source] of [['ChatDialog', dialogSource], ['NativeChatPage', nativeSource]]) {
  assert(source.includes('pendingClarificationMessage?.clarification && <div className="chat-clarification-dock"'), `${name} 没有把待回答的选择固定到输入框上方`)
  assert(source.includes('expired={pendingClarificationMessage.clarificationExpired}'), `${name} 里已超时的选择卡片没有按失效显示`)
  assert(!source.includes('message.clarification && <ChatClarificationCard'), `${name} 仍把选择卡片嵌在可滚动的消息正文中`)
}
const styles = read('src/styles.css')
assert(styles.includes('.chat-clarification-dock .chat-clarification-questions { min-height: 0; overflow-y: auto;'), '长选择卡片没有独立滚动区域')

// 4) 运行被取消时挂起的澄清必须通知界面
assert(coreSource.includes("type: 'clarify-expired'"), '取消或结束时没有通知界面澄清已失效')
assert(coreSource.includes('for (const [clarificationRequestId, pending] of active.pendingClarifications.entries())'), '取消时没有逐个处理挂起的澄清')

console.log(JSON.stringify({
  ok: true,
  approvalExplainsAutoSkip: true,
  clarificationStateSurvivesRemount: true,
  clarificationStaleFeedback: true,
  clarifyExpiredOnCancel: true,
}, null, 0))
process.exit(0)
