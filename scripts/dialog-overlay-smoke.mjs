import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')
const styles = read('../src/styles.css')
const source = {
  conversation: read('../src/components/ConversationActions.tsx'),
  message: read('../src/components/ChatMessageMeta.tsx'),
  bot: read('../src/components/BotActionsMenu.tsx'),
}

// 会话右键菜单与确认弹窗均挂到 body，避免被侧栏滚动区裁剪或受行内层叠上下文限制。
for (const [name, text] of Object.entries(source)) {
  assert(text.includes("import { createPortal } from 'react-dom'"), `${name} 没有引入 createPortal`)
  assert(/createPortal\(/.test(text), `${name} 没有使用 Portal 渲染弹窗`)
  assert(text.includes('document.body)}'), `${name} 的 Portal 没有挂到 document.body`)
  assert(text.includes('className="modal-layer"'), `${name} 的弹窗缺少 modal-layer`)
}
assert(source.conversation.includes('role="alertdialog"'), '删除会话的弹窗缺少 aria 语义')
assert(source.message.includes('role="alertdialog"'), '删除消息的弹窗缺少 aria 语义')
assert(source.bot.includes('role="alertdialog"'), '删除 Bot 的弹窗缺少 aria 语义')

// 会话不再显示三点按钮，也不能用全局隐藏菜单掩盖层叠问题。
assert(styles.includes('.conversation-context-menu {') && source.conversation.includes('role="menu"'), '会话右键菜单的样式或语义缺失')
assert(!source.conversation.includes('conversation-action-toggle'), '会话列表不应继续显示三点按钮')
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
