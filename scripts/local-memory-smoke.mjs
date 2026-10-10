import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { extractLocalMemoryProposals, LocalMemoryService } from '../electron/services/local-memory-service.mjs'
import { createMemoryScope } from '../electron/services/memory-scope.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-local-memory-'))
const database = new ZSenseDatabase(directory)
const service = new LocalMemoryService({ database })
database.memoryService = service

try {
  assert.deepEqual(service.inspect(), { engine: 'hindsight-inspired-local', localOnly: true, ready: true, error: '' })
  const first = await service.retainUserMessage('atlas', '以后请一直使用简体中文回答我，这是我的长期偏好。', { conversationId: 'conversation-one' })
  assert.equal(first.stored, true)
  assert.equal(first.created, 1)
  assert.equal((await service.retainUserMessage('atlas', '以后请一直使用简体中文回答我，这是我的长期偏好。')).stored, false, '相同事实不得重复堆积')
  assert.equal(database.listMemories('atlas').filter((item) => item.source === 'ZSense 自动记忆（本地）').length, 1)
  assert((await service.recallMemories('atlas', '简体中文回复')).memories.some((item) => item.excerpt.includes('简体中文')))
  assert.equal((await service.recallMemories('scout', '简体中文回复')).memories.some((item) => item.excerpt.includes('以后请一直使用简体中文回答我')), false, '不能跨 Bot 召回')
  assert.equal((await service.retainUserMessage('atlas', 'API Key: sk-test-secret-value')).stored, false)
  assert.equal((await service.retainUserMessage('atlas', '今天天气怎么样？')).stored, false)
  for (const content of ['以后默认用英文吗？', '请翻译：我叫小王', '他说“我叫小王”', '这次默认用英文回答', '请记住我的密码是hunter2']) {
    assert.equal((await service.retainUserMessage('atlas', content)).stored, false, `${content}不应被自动入库`)
  }
  const changed = await service.retainUserMessage('atlas', '以后默认用英文回答。', { messageId: 'message-language-correction' })
  assert.equal(changed.updated, 1, '显式语言纠正必须替换同一稳定事实')
  assert.equal(changed.created, 0, '纠正不应制造第二条相互矛盾的语言偏好')
  const language = database.listMemories('atlas').find((item) => item.factKey === 'answer.language')
  assert(language.excerpt.includes('英文'))
  assert((await service.recallMemories('atlas', '回答语言')).memories.find((item) => item.factKey === 'answer.language')?.excerpt.includes('英文'), '已建立召回缓存后纠正必须刷新索引')
  assert((await service.searchMemories('atlas', '英文')).some((item) => item.id === language.id), '搜索与召回应使用同一当前索引')
  assert(database.getMemory('atlas', language.id).history.some((item) => item.excerpt.includes('简体中文')), '纠正须保留旧版本证据')
  assert.equal(language.messageId, 'message-language-correction')
  assert.equal((await service.retainUserMessage('atlas', '我叫小王')).created, 1, '短身份不得漏记')
  assert.equal((await service.retainUserMessage('atlas', '我叫小李')).updated, 1, '身份纠正按稳定键修订')
  assert.equal(database.listMemories('atlas').filter((item) => item.factKey === 'identity.name').length, 1)
  assert.equal((await service.retainUserMessage('atlas', '不要忘记我的名字')).stored, false, '否定遗忘不能误删记忆')
  assert.equal((await service.retainUserMessage('atlas', '我忘记了我的名字')).stored, false, '用户自述遗忘不是删除命令')
  assert(database.listMemories('atlas').some((item) => item.factKey === 'identity.name'), '否定与自述不能改变既有身份')
  assert.equal((await service.retainUserMessage('atlas', '忘记我的名字')).forgotten, 1, '显式遗忘应删除对应身份事实')
  assert.equal(database.listMemories('atlas').some((item) => item.factKey === 'identity.name'), false)
  assert.equal((await service.retainUserMessage('atlas', '忘记我的名字')).reason, 'memory-not-found', '不存在的遗忘目标不得保存为新事实')
  assert.equal((await service.retainUserMessage('atlas', '我叫小王')).reason, 'previously-forgotten', '已遗忘身份不能被后台再次创建')
  const alice = createMemoryScope({ channel: 'gateway', connectionId: 'test-connection', userId: 'alice' })
  const bob = createMemoryScope({ channel: 'gateway', connectionId: 'test-connection', userId: 'bob' })
  assert.equal((await service.retainUserMessage('atlas', '我叫甲', alice)).created, 1)
  assert.equal((await service.retainUserMessage('atlas', '我叫乙', bob)).created, 1)
  assert(database.listMemories('atlas', alice).some((item) => item.excerpt.includes('甲')))
  assert(database.listMemories('atlas', bob).every((item) => !item.excerpt.includes('甲')), '同Bot不同用户必须隔离')
  const zsense = createMemoryScope({ workspacePath: path.join(directory, 'project-zsense') })
  const hub = createMemoryScope({ workspacePath: path.join(directory, 'project-hub') })
  await service.retainUserMessage('atlas', '我的项目叫ZSense', zsense)
  await service.retainUserMessage('atlas', '我的项目叫Hub', hub)
  assert(database.listMemories('atlas', zsense).some((item) => item.factKey === 'project.name' && item.excerpt.includes('ZSense')))
  assert(database.listMemories('atlas', hub).every((item) => !item.excerpt.includes('项目是ZSense')), '项目不能跨作用域被纠正或召回')
  assert.equal(extractLocalMemoryProposals('我叫Ｈａｎｋ')[0].evidence, '我叫Ｈａｎｋ', '兼容字符归一化不能改变用户原始证据')
  assert.equal(extractLocalMemoryProposals('改用中文')[0].factKey, 'answer.language', '简短显式语言纠正需要稳定槽位')
  assert.equal(extractLocalMemoryProposals('记住，我叫小王').length, 1, '单独记住命令不得成为无内容的事实')
  for (const nonIdentity of ['我叫小王去拿钥匙', '我是医生的家属', 'I am not a doctor']) assert.equal(extractLocalMemoryProposals(nonIdentity).length, 0, '提及姓名或职业不是身份陈述')
  const memory = database.listMemories('atlas').find((item) => item.source === 'ZSense 自动记忆（本地）')
  await service.deleteMemory('atlas', memory.id)
  assert.equal(database.getMemory('atlas', memory.id), null)
  assert((await service.recallMemories('atlas', '英文')).memories.every((item) => item.id !== memory.id), '删除后不能从旧召回索引取回记录')
  await service.stop()
  console.log(JSON.stringify({ ok: true, noDownload: true, localRetention: true, deduplication: true, isolatedBots: true, isolatedOwnersAndProjects: true, correctionHistory: true, explicitForget: true, conservativeExtraction: true, sensitiveFilter: true, delete: true }))
} finally {
  database.close()
  fs.rmSync(directory, { recursive: true, force: true })
}
