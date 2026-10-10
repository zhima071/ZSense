import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import { parseMemoryProposals, ZSenseAgentCore } from '../electron/services/zsense-agent-core.mjs'

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }
const treeNodes = (node) => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(treeNodes)]
const treeText = (node) => typeof node === 'string' || typeof node === 'number' ? String(node) : !node ? '' : [node.props?.children].flat(Infinity).map(treeText).join(' ')

// Execute the real component with isolated hooks to inspect emitted save data and user-visible metadata.
function renderComponent(props, file = 'src/components/MemoryDialog.tsx', name = 'MemoryDialog') {
  const values = []
  let cursor = 0
  const exported = {}
  const jsx = (type, properties) => ({ type, props: properties || {} })
  const context = {
    exports: exported,
    document: { addEventListener() {}, removeEventListener() {} },
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
      if (name === 'react') return {
        useId: () => 'memory-dialog-test', useEffect() {}, useMemo: (factory) => factory(), useCallback: (callback) => callback, useRef: (initial) => ({ current: initial }),
        useState(initial) {
          const index = cursor++
          if (!(index in values)) values[index] = initial
          return [values[index], (next) => { values[index] = typeof next === 'function' ? next(values[index]) : next }]
        },
      }
      if (name === 'lucide-react') return new Proxy({}, { get: (_, icon) => String(icon) })
      if (name === '../services/date-time') return { formatLocalDateTime: (value, fallback) => value || fallback || '' }
      if (name.endsWith('.css')) return {}
      if (file.endsWith('SystemPages.tsx')) return {}
      throw new Error(`unexpected import: ${name}`)
    },
  }
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, context)
  return () => { cursor = 0; return exported[name](props) }
}

const memory = {
  id: 'auto-memory', title: '回复语言', excerpt: '以后默认用中文', type: 'preference',
  updatedAt: '2026-10-09T00:00:00.000Z', source: 'ZSense 自动记忆（本地）', evidence: '以后默认用中文',
  ownerKey: 'local:test', projectKey: '/isolated/project', locked: false, revision: 3,
  messageId: 'test-message', conversationId: 'test-conversation', factKey: 'answer.language',
  history: [{ title: '回复语言', excerpt: '之前默认用英文', updatedAt: '2026-10-08T00:00:00.000Z', revision: 2 }],
}
const saved = []
let closed = 0
const renderEdit = renderComponent({ memory, spaceName: '测试空间', initialMode: 'edit', onClose: () => closed++, onSave: async (item) => saved.push(item) })
let tree = renderEdit()
let checkbox = treeNodes(tree).find((node) => node.type === 'input' && node.props.type === 'checkbox')
assert.equal(checkbox.props.checked, true, '手动修改自动记忆必须默认保护')
treeNodes(tree).find((node) => node.type === 'button' && treeText(node).includes('保存记忆')).props.onClick()
await flush()
assert.equal(saved.length, 1)
assert.equal(saved[0].locked, true)
for (const field of ['id', 'ownerKey', 'projectKey', 'evidence', 'messageId', 'conversationId', 'factKey', 'revision']) assert.equal(saved[0][field], memory[field], `保存丢失 ${field}`)
assert.equal(saved[0].source, '手动修改', '修订来源必须标记人工修改')
assert.equal(saved[0].history, memory.history)
assert.equal(closed, 1)
checkbox.props.onChange({ target: { checked: false } })
tree = renderEdit()
treeNodes(tree).find((node) => node.type === 'button' && treeText(node).includes('保存记忆')).props.onClick()
await flush()
assert.equal(saved[1].locked, false, '手动明确取消保护必须有效')
const view = renderComponent({ memory: { ...memory, locked: true }, spaceName: '测试空间', initialMode: 'view', onClose() {}, async onSave() {} })()
for (const label of ['local:test', '/isolated/project', '已保护', '修订历史', '之前默认用英文']) assert(treeText(view).includes(label), `记忆详情缺少 ${label}`)

const pauseReasonCases = [
  ['question', '内容是问句'], ['quoted', '引用或转述'], ['transient', '临时要求或状态'],
  ['tool-transcript', '工具或助手执行记录'], ['sensitive', '凭据或敏感信息'], ['future-rule', '需要人工核对'],
]
for (const [recallReason, label] of pauseReasonCases) {
  const paused = { ...memory, locked: true, recallEligible: false, recallReason }
  const detail = renderComponent({ memory: paused, spaceName: '测试空间', initialMode: 'view', onClose() {}, async onSave() {} })()
  for (const text of ['自动召回已暂停', label, '原内容已保留', '手动检索', '手动编辑、保存', '保护设置用于阻止自动修改', memory.excerpt, '已保护']) assert(treeText(detail).includes(text), `暂停召回详情缺少 ${text}`)
  assert.equal(paused.excerpt, memory.excerpt)
  assert.equal(paused.recallEligible, false, '查看详情不能恢复自动召回')
  if (recallReason === 'future-rule') assert(!treeText(detail).includes(recallReason), '未知原因不能显示内部代码')
}
const pausedSaves = []
const pausedEditor = renderComponent({ memory: { ...memory, locked: true, recallEligible: false, recallReason: 'question' }, spaceName: '测试空间', initialMode: 'edit', onClose() {}, async onSave(item) { pausedSaves.push(item) } })
const pausedTree = pausedEditor()
assert(treeText(pausedTree).includes('自动召回已暂停'))
assert.equal(pausedSaves.length, 0)
treeNodes(pausedTree).find((node) => node.type === 'button' && treeText(node).includes('保存记忆')).props.onClick()
await flush()
assert.equal(pausedSaves.length, 1, '手动保存无需新增确认弹窗')
assert.equal(pausedSaves[0].recallEligible, true)
assert.equal(pausedSaves[0].recallReason, '')
assert.equal(pausedSaves[0].locked, true, '恢复召回不能解除内容保护')
assert.equal(pausedSaves[0].excerpt, memory.excerpt, '手动保存不能隐式改写原内容')
assert.equal(pausedSaves[0].history, memory.history)
assert(!treeText(view).includes('自动召回已暂停'), '未暂停记录不应显示暂停提示')

const registry = renderComponent({ bots: [{ id: 'test-bot', name: '测试空间', memories: [memory, { ...memory, id: 'manual', source: '手动添加' }], memoryCount: 2 }], memoryMaxItems: 50 }, 'src/components/SystemPages.tsx', 'GlobalMemoryPage')()
assert(treeText(registry).includes('自动记忆容量'))
const capacityStat = treeNodes(registry).find((node) => node.type === 'div' && treeText(node).includes('自动记忆容量') && treeNodes(node).filter((child) => child.type === 'div').length === 1)
assert(capacityStat && /1\s*\/\s*50/.test(treeText(capacityStat)), '人工记忆不应占自动记忆额度')
const pausedRegistry = renderComponent({ bots: [{ id: 'test-bot', name: '测试空间', memories: [{ ...memory, recallEligible: false, recallReason: 'question' }], memoryCount: 1 }], memoryMaxItems: 50 }, 'src/components/SystemPages.tsx', 'GlobalMemoryPage')()
assert(treeText(pausedRegistry).includes('自动召回暂停'))
assert(treeText(pausedRegistry).includes(memory.excerpt), '待核对记录必须继续在管理列表可见')
const policiesRender = renderComponent({ settings: { autoExtractMemory: true, memoryModelRefinement: false, autoDistillSkills: false, memoryPeriodicReview: true, memoryReviewInterval: 10, memoryRecallLimit: 24, memoryMaxItems: 500, voiceWakePhrase: '你好 ZSense' }, runtime: {}, section: 'policies', currentUser: { role: 'admin' } }, 'src/components/SystemPages.tsx', 'SettingsPage')
const policies = policiesRender()
const refinementSwitch = treeNodes(policies).find((node) => node.props?.title === '模型精炼记忆')
const distillationSwitch = treeNodes(policies).find((node) => node.props?.title === '自动沉淀技能')
for (const control of [refinementSwitch, distillationSwitch]) {
  assert.equal(control?.props.checked, false)
  assert(control.props.description.includes('云端服务会接收这些内容'), '模型设置缺少原话发送说明')
}
refinementSwitch.props.onChange(true)
assert.equal(treeNodes(policiesRender()).find((node) => node.props?.title === '模型精炼记忆')?.props.checked, true)
const limits = treeNodes(policies).find((node) => node.props?.title === '每空间自动记忆上限')
assert.equal(limits?.props.min, 50)
assert.equal(limits?.props.max, 5000)

const ipc = new EventEmitter()
ipc.invoke = async () => ({ ok: true })
let desktop
vm.runInNewContext(read('electron/preload.cjs'), {
  require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_, api) => { desktop = api } }, webUtils: {} }),
  process: { platform: 'darwin', versions: {} },
})
const events = []
const unsubscribe = desktop.data.onMemoryChanged((event) => events.push(event))
const event = { botId: 'test-bot', memories: [memory], memoryCount: 1, memorySize: '1 KB' }
ipc.emit('zsense:workspace:memory-changed', {}, event)
assert.equal(events[0], event)
unsubscribe()
ipc.emit('zsense:workspace:memory-changed', {}, event)
assert.equal(events.length, 1, '订阅清理后不能重复分发记忆事件')

const proposed = { action: 'create', title: '回复语言', excerpt: '以后默认用英文', type: 'preference', confidence: 0.99, evidence: '以后默认用英文', factKey: 'answer.language' }
const parse = (item = proposed, options = {}) => parseMemoryProposals(JSON.stringify([item]), { evidenceText: proposed.evidence, ...options })
assert.equal(parse().length, 1)
assert.equal(parse()[0].factKey, '', '模型不能自行设置可信事实槽位')
assert.equal(parse({ ...proposed, action: 'delete' }).length, 0)
assert.equal(parse({ ...proposed, evidence: '以后默认用英语' }).length, 0, '改写证据必须拒绝')
assert.equal(parse(proposed, { evidenceText: '以后默认用英文吗？' }).length, 0, '问题不能通过证据截取变成事实')
assert.equal(parse(proposed, { evidenceText: '他说：“以后默认用英文”' }).length, 0, '引用不能通过证据截取变成事实')
assert.equal(parse({ ...proposed, confidence: 0.4 }).length, 0)
const target = { ...memory, locked: false, state: 'active' }
const options = { trustedProposals: [proposed], existingMemories: [target] }
assert.equal(parse({ ...proposed, action: 'update', matchId: memory.id }, options)[0]?.factKey, 'answer.language')
assert.equal(parse({ ...proposed, action: 'update', matchId: memory.id }, { ...options, existingMemories: [{ ...target, locked: true }] }).length, 0, '保护字段必须阻止模型改写')
assert.equal(parse({ ...proposed, action: 'update', matchId: memory.id }, { ...options, existingMemories: [{ ...target, factKey: 'identity.name' }] }).length, 0, '不能修改不同事实槽位')
assert.equal(parse({ ...proposed, excerpt: '编造了新偏好', ownerKey: 'attacker' }, options)[0]?.excerpt, proposed.excerpt, '模型不能扩大本地已确认证据内容')
assert.equal(parse({ ...proposed, ownerKey: 'attacker' }, options)[0]?.ownerKey, undefined)
assert.equal(parse({ ...proposed, evidence: '以后默认用英文\n我叫小王' }, { evidenceTexts: ['以后默认用英文', '我叫小王'] }).length, 0, '复盘证据不能跨消息拼接')

// The network is fully mocked; abort after a provider reply must still prevent stale proposals.
const core = new ZSenseAgentCore()
const originalFetch = globalThis.fetch
let requests = 0
try {
  const response = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify([proposed]) } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  let lastBody = ''
  globalThis.fetch = async (_, request) => { requests++; lastBody = request.body; return response() }
  const credentials = { model: 'isolated-test', modelProvider: 'deepseek', apiKey: 'test-only', baseUrl: 'https://unit.invalid' }
  assert.equal((await core.extractMemories({ ...credentials, message: `${proposed.evidence}。项目附注PRIVATE_SENTINEL。`, recentUserMessages: ['我叫历史昵称'], trustedProposals: [proposed] }))[0]?.factKey, 'answer.language')
  assert(!lastBody.includes('PRIVATE_SENTINEL'), '精炼只能发送筛选后的本轮原句')
  assert(!lastBody.includes('历史昵称'), '精炼不能发送此前对话原话')
  const stopped = new AbortController()
  stopped.abort(new Error('后台已取消'))
  const before = requests
  await assert.rejects(core.extractMemories({ ...credentials, message: proposed.evidence, signal: stopped.signal }), /后台已取消/)
  assert.equal(requests, before, '已取消的请求不能访问模型')
  const late = new AbortController()
  globalThis.fetch = async (_, request) => { requests++; late.abort(new Error('旧后台任务失效')); assert.equal(request.signal.aborted, true); return response() }
  await assert.rejects(core.extractMemories({ ...credentials, message: proposed.evidence, signal: late.signal }), /旧后台任务失效/)
} finally {
  globalThis.fetch = originalFetch
}

console.log(JSON.stringify({ ok: true, manualProtection: true, metadataPreserved: true, detailProvenance: true, pausedRecallReasons: true, pausedRecordsVisible: true, manualRecallRestoration: true, noExtraConfirmation: true, incrementalSubscription: true, exactEvidence: true, trustedFactKey: true, cancellation: true, externalNetwork: false }))
