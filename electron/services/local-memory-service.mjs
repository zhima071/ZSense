import { shouldExtractMemory, unsafeAutomaticMemory } from './memory-intelligence.mjs'

const DURABLE_SIGNAL = /(?:记住|记下来|以后|今后|从现在起|始终|默认|长期|每次|我叫|我是|我的(?:名字|职业|公司|项目)|我更喜欢|我偏好|不要再|不再|固定用|请一直|一直用)/u
const PREFERENCE_SIGNAL = /(?:更喜欢|偏好|默认|不要再|不再|每次|始终|一直用|固定用|请一直)/u
const FACT_SIGNAL = /(?:我叫|我是|我的(?:名字|职业|公司|项目))/u

function durableStatements(content) {
  return String(content || '').normalize('NFKC').split(/[。！？!?\n]+/u)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 6 && part.length <= 1_000 && DURABLE_SIGNAL.test(part) && !unsafeAutomaticMemory(part))
    .slice(0, 5)
}

/** Hindsight 的 retain / recall / forget 工作流，由应用现有 SQLite 实现，不依赖外部进程或模型下载。 */
export class LocalMemoryService {
  constructor({ database } = {}) {
    if (!database) throw new Error('本地记忆服务缺少数据库。')
    this.database = database
  }

  inspect() { return { engine: 'hindsight-inspired-local', localOnly: true, ready: true, error: '' } }
  async start() { return this }
  async stop() { /* 与应用数据库共生命周期，无子进程。 */ }

  async recallMemories(botId, query, options = {}) {
    return this.database.recallMemories(botId, query, options)
  }

  async searchMemories(botId, query, limit = 8) {
    return this.database.searchMemories(botId, query, limit)
  }

  async retainUserMessage(botId, content, { conversationId = '' } = {}) {
    const text = String(content || '').trim()
    if (!shouldExtractMemory(text) || unsafeAutomaticMemory(text)) return { stored: false, reason: 'not-durable-or-sensitive' }
    const statements = durableStatements(text)
    if (!statements.length) return { stored: false, reason: 'no-explicit-durable-fact' }
    const proposals = statements.map((statement) => ({
      title: statement.slice(0, 72), excerpt: statement, evidence: statement,
      type: PREFERENCE_SIGNAL.test(statement) ? 'preference' : FACT_SIGNAL.test(statement) ? 'fact' : 'episode',
      confidence: 0.88,
    }))
    const result = this.database.upsertAutoMemories(botId, proposals, {
      conversationId, source: 'ZSense 自动记忆（本地）', maxItems: 500,
    })
    return { stored: result.created + result.updated > 0, created: result.created, updated: result.updated,
      reason: result.created + result.updated > 0 ? '' : 'duplicate-or-low-confidence', extraction: 'local-rules' }
  }

  async refreshProjection(_botId) { return 0 }
  async createMemory(botId, memory) { return this.database.createMemory(botId, memory) }
  async updateMemory(botId, memory) { return this.database.updateMemory(botId, memory) }
  async deleteMemory(botId, memoryId) { return this.database.deleteMemory(botId, memoryId) }
}
