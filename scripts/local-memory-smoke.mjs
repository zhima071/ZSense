import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZSenseDatabase } from '../electron/services/database.mjs'
import { LocalMemoryService } from '../electron/services/local-memory-service.mjs'

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
  const memory = database.listMemories('atlas').find((item) => item.source === 'ZSense 自动记忆（本地）')
  await service.deleteMemory('atlas', memory.id)
  assert.equal(database.getMemory('atlas', memory.id), null)
  await service.stop()
  console.log(JSON.stringify({ ok: true, noDownload: true, localRetention: true, deduplication: true, isolatedBots: true, sensitiveFilter: true, delete: true }))
} finally {
  database.close()
  fs.rmSync(directory, { recursive: true, force: true })
}
