import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')
const styles = read('../src/styles.css')
const source = {
  conversation: read('../src/components/ConversationActions.tsx'),
  message: read('../src/components/ChatMessageMeta.tsx'),
  bot: read('../src/components/BotActionsMenu.tsx'),
}

// 会话操作按钮位于 `.conversation-actions`（z-index:6 + isolation:isolate）这个层叠上下文里。
// 确认弹窗如果渲染在这个上下文内部，它的遮罩就盖不住后面几行的按钮，会出现“按钮浮在遮罩之上”的穿透。
// 正确做法是把弹窗用 Portal 挂到 body 上，而不是靠整体隐藏按钮把问题盖过去。
for (const [name, text] of Object.entries(source)) {
  assert(text.includes("import { createPortal } from 'react-dom'"), `${name} 没有引入 createPortal`)
  assert(/createPortal\(/.test(text), `${name} 没有使用 Portal 渲染弹窗`)
  assert(text.includes('document.body)}'), `${name} 的 Portal 没有挂到 document.body`)
  assert(text.includes('className="modal-layer"'), `${name} 的弹窗缺少 modal-layer`)
}
assert(source.conversation.includes('role="alertdialog"'), '删除会话的弹窗缺少 aria 语义')
assert(source.message.includes('role="alertdialog"'), '删除消息的弹窗缺少 aria 语义')
assert(source.bot.includes('role="alertdialog"'), '删除 Bot 的弹窗缺少 aria 语义')

// 侧栏按钮保留基础可见性：不能再出现“弹窗一开所有按钮消失”的规则。
assert(styles.includes('.native-chat-sidebar-row .conversation-actions {'), '侧栏会话操作按钮的基础样式缺失')
assert(!/:has\(\.modal-layer/.test(styles), '不应再用 :has(.modal-layer) 整体隐藏按钮来规避层叠问题')

// 弹窗仍然要压在所有面板之上（侧栏 z-index:30、聊天浮层 z-index:70）。
const modalRule = styles.match(/\.modal-layer \{([^}]*)\}/)
assert(modalRule, '缺少 .modal-layer 样式')
const modalZ = Number((modalRule[1].match(/z-index:\s*(\d+)/) || [])[1])
assert(modalZ >= 50, `modal-layer 的 z-index 太小：${modalZ}`)
assert(/position:\s*fixed/.test(modalRule[1]), 'modal-layer 必须是 fixed 定位')
const sidebarRule = styles.match(/\.sidebar \{([^}]*)\}/)
const sidebarZ = Number((sidebarRule?.[1].match(/z-index:\s*(\d+)/) || [])[1])
assert(sidebarZ && modalZ > sidebarZ, `modal-layer(${modalZ}) 必须高于 sidebar(${sidebarZ})`)

console.log(JSON.stringify({
  ok: true,
  engine: 'dialog-portal-stacking',
  portaledDialogs: Object.keys(source),
  noGlobalHidingRule: true,
  modalAboveSidebar: true,
}))
