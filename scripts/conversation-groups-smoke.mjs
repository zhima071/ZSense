// 对话列表的「拖拽排序 + 分组折叠」回归：
// - 会话可以按手动顺序排列（sort_order），没排过的仍按最近更新排在前面；
// - 分组可以把会话收进去、折叠收纳，折叠状态与分组名都持久化；
// - 删除分组只解散分组，不会删会话；跨对话空间移动会被拦住。
// 数据库行为直接跑真实实现；侧边栏与桌面桥的接线用源码断言钉住。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NATIVE_BOT_ID, ZSenseDatabase } from '../electron/services/database.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(projectRoot, relative), 'utf8')
const sidebar = read('src/components/Sidebar.tsx')
const app = read('src/App.tsx')
const preload = read('electron/preload.cjs')
const ipc = read('electron/ipc.mjs')
const types = read('src/types.ts')
const bridge = read('src/electron.d.ts')
const styles = read('src/styles.css')

const directory = mkdtempSync(path.join(tmpdir(), 'zsense-conversation-groups-'))
const database = new ZSenseDatabase(directory)
try {
  const ids = [
    database.createNativeConversation('会话一'),
    database.createNativeConversation('会话二'),
    database.createNativeConversation('会话三'),
  ]

  // 1) 默认顺序：未手动排序（sort_order=0）时按最近更新倒序
  const initial = database.loadWorkspace().conversations
  assert.deepEqual(initial.map((item) => item.title), ['会话三', '会话二', '会话一'], '新建会话默认应按最近更新排在前面')
  assert(initial.every((item) => item.sortOrder === 0 && item.groupId === ''), '新建会话不应带排序或分组')
  assert(Array.isArray(database.loadWorkspace().conversationGroups) && !database.loadWorkspace().conversationGroups.length, '初始不应有分组')

  // 2) 拖拽排序：按给定顺序写 sort_order，快照顺序跟着变
  database.reorderConversations(NATIVE_BOT_ID, [ids[2], ids[0], ids[1]])
  const reordered = database.loadWorkspace().conversations
  assert.deepEqual(reordered.map((item) => item.title), ['会话三', '会话一', '会话二'], '排序后快照顺序应等于手动顺序')
  assert.deepEqual(reordered.map((item) => item.sortOrder), [1, 2, 3], 'sort_order 应按顺序写成 1..N')

  // 3) 新建会话插到最前（sort_order 0 仍排在手排位置前面）
  const fresh = database.createNativeConversation('新会话')
  assert.equal(database.loadWorkspace().conversations[0].title, '新会话', '新建会话应排在最前面')

  // 4) 分组：创建 / 收纳 / 折叠 / 改名，全部持久化
  const afterCreate = database.createConversationGroup(NATIVE_BOT_ID, '工作')
  const group = afterCreate.conversationGroups.find((item) => item.name === '工作')
  assert(group, '分组应出现在快照里')
  assert.equal(group.botId, NATIVE_BOT_ID, '分组应记在对应的对话空间下')
  assert.equal(group.collapsed, false, '新建分组默认展开')

  database.moveConversationToGroup(ids[0], group.id)
  const moved = database.loadWorkspace().conversations.find((item) => item.id === ids[0])
  assert.equal(moved.groupId, group.id, '会话应被收进分组')

  database.setConversationGroupCollapsed(group.id, true)
  assert.equal(database.loadWorkspace().conversationGroups.find((item) => item.id === group.id)?.collapsed, true, '折叠状态应持久化')

  database.renameConversationGroup(group.id, '工作项目')
  assert.equal(database.loadWorkspace().conversationGroups.find((item) => item.id === group.id)?.name, '工作项目', '分组改名应持久化')

  // 重开数据库仍然保持（模拟重启应用）
  database.close()
  const reopened = new ZSenseDatabase(directory)
  try {
    const after = reopened.loadWorkspace()
    assert.equal(after.conversationGroups.find((item) => item.id === group.id)?.name, '工作项目', '重启后分组名应保留')
    assert.equal(after.conversationGroups.find((item) => item.id === group.id)?.collapsed, true, '重启后折叠状态应保留')
    assert.equal(after.conversations.find((item) => item.id === ids[0])?.groupId, group.id, '重启后会话归属应保留')
    assert.deepEqual(after.conversations.filter((item) => item.id !== fresh).map((item) => item.title).slice(0, 3), ['会话三', '会话一', '会话二'], '重启后手动顺序应保留')

    // 5) 移出分组 / 删除分组：只解散分组，不删会话
    reopened.moveConversationToGroup(ids[0], '')
    assert.equal(reopened.loadWorkspace().conversations.find((item) => item.id === ids[0])?.groupId, '', '会话应能移出分组')
    reopened.moveConversationToGroup(ids[0], group.id)
    const afterDelete = reopened.deleteConversationGroup(group.id)
    assert(!afterDelete.conversationGroups.some((item) => item.id === group.id), '分组应被删除')
    assert.equal(afterDelete.conversations.find((item) => item.id === ids[0])?.groupId, '', '删除分组后会话应回到未分组')
    assert(afterDelete.conversations.some((item) => item.id === ids[0]), '删除分组不应删掉会话')

    // 6) 校验
    assert.throws(() => reopened.createConversationGroup(NATIVE_BOT_ID, '   '), /分组名称不能为空/, '空分组名应被拒绝')
    assert.throws(() => reopened.moveConversationToGroup(ids[0], 'not-a-group'), /分组不存在/, '不存在的分组应被拒绝')
    const botId = 'test-bot-space'
    reopened.createBot({ id: botId, name: '另一个空间', initials: 'X', role: '测试', description: '跨空间校验用', status: 'online', color: '#111827', modelProvider: '', model: '', lastActive: '尚未运行', conversations: 0, successRate: 100, prompt: '测试', channels: ['web'], memories: [] })
    const foreignGroup = reopened.createConversationGroup(botId, '别的空间')
    const foreignGroupId = foreignGroup.conversationGroups.find((item) => item.botId === botId).id
    assert.throws(() => reopened.moveConversationToGroup(ids[0], foreignGroupId), /不属于这个对话空间/, '不能把会话移进别的对话空间的分组')
  } finally {
    reopened.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

// 7) 接线：桌面桥 / IPC / 类型
for (const handler of ['zsense:conversations:move-group', 'zsense:conversations:reorder', 'zsense:conversation-groups:create', 'zsense:conversation-groups:rename', 'zsense:conversation-groups:delete', 'zsense:conversation-groups:set-collapsed']) {
  assert(ipc.includes(`'${handler}'`), `IPC 缺少 ${handler}`)
}
assert(preload.includes('moveGroup: (conversationId, groupId)') && preload.includes('reorder: (botId, orderedIds)'), 'preload 缺少会话分组/排序接口')
assert(preload.includes('conversationGroups: Object.freeze({') && preload.includes('setCollapsed: (groupId, collapsed)'), 'preload 缺少分组管理接口')
assert(types.includes('export interface ConversationGroup'), 'types 缺少 ConversationGroup')
assert(types.includes('sortOrder: number') && types.includes('groupId: string'), 'Conversation 缺少排序/分组字段')
assert(types.includes('conversationGroups: ConversationGroup[]'), 'WorkspaceSnapshot 缺少 conversationGroups')
assert(bridge.includes('moveGroup: (conversationId: string, groupId: string)') && bridge.includes('conversationGroups: {'), 'electron.d.ts 缺少桌面桥类型')

// 8) 侧边栏：分组渲染、折叠、拖拽
assert(sidebar.includes('nativeConversationGroups.map('), '侧边栏没有渲染分组')
assert(sidebar.includes('aria-expanded={!group.collapsed}') && sidebar.includes('onToggleConversationGroup(group.id, !group.collapsed)'), '分组标题缺少折叠开关')
assert(sidebar.includes('draggable') && sidebar.includes('onDragStart=') && sidebar.includes('onDragOver=') && sidebar.includes('onDrop='), '会话行缺少拖拽处理')
assert(sidebar.includes('dropOnConversation(conversation.id)') && sidebar.includes('dropIntoGroup(group.id)') && sidebar.includes('dropOutOfGroup()'), '拖拽落点处理不完整（排序 / 收入分组 / 移出分组）')
assert(sidebar.includes('onReorderConversations(nativeSpaceId, [...next, ...hidden])'), '拖拽后没有按新顺序提交重排')
assert(sidebar.includes('setGroupDialog({ mode: \'create\', name: \'\' })'), '缺少新建分组的入口')
assert(sidebar.includes('重命名分组') && sidebar.includes('删除分组'), '缺少分组改名 / 删除入口')
assert(sidebar.includes('conversation-group-dialog') && styles.includes('.conversation-group-dialog'), '缺少分组弹窗或其样式')
for (const rule of ['.native-chat-sidebar-group-head', '.native-chat-sidebar-row.drop-before', '.native-chat-sidebar-row.drop-after', '.native-chat-sidebar-ungroup-drop']) {
  assert(styles.includes(rule), `缺少拖拽/分组样式：${rule}`)
}

// 9) App：处理函数与传参
for (const handler of ['createConversationGroup', 'renameConversationGroup', 'deleteConversationGroup', 'toggleConversationGroup', 'moveConversationToGroup', 'reorderConversations']) {
  assert(app.includes(`const ${handler} = async`), `App 缺少 ${handler}`)
}
assert(app.includes('setConversationGroups(snapshot.conversationGroups || [])'), 'App 没有把分组写进状态')
assert(app.includes('nativeConversationGroups={nativeConversationGroups}') && app.includes('onReorderConversations={reorderConversations}'), 'App 没有把分组/排序传给侧边栏')

console.log(JSON.stringify({ ok: true, reorderPersisted: true, groupCreateMoveCollapse: true, groupSurvivesRestart: true, deleteGroupKeepsConversations: true, crossSpaceGuard: true, wiringChecked: 5 }))
