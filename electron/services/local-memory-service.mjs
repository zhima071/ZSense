import { createMemoryMaintenanceQueue, isExplicitMemoryStatement, selectCurationMemories, shouldExtractMemory, unsafeAutomaticMemory } from './memory-intelligence.mjs'

const DURABLE_SIGNAL = /(?:记住|记下来|以后|今后|从现在起|始终|默认|长期|每次|我叫|我是|我在.{1,60}(?:工作|上班|任职)|我的(?:名字|职业|公司|项目)|我更喜欢|我偏好|不要再|不再|固定用|请一直|一直用|改用|改成|改为|更正|\b(?:remember|my name is|call me|i am|i'm|i prefer|always|by default|from now on|my profession|my company|my project)\b)/iu
const PREFERENCE_SIGNAL = /(?:更喜欢|偏好|默认|不要再|不再|每次|始终|一直用|固定用|请一直|以后|今后|\b(?:prefer|always|by default|from now on)\b)/iu
const LANGUAGE = /简体中文|繁体中文|英文|英语|中文|日文|日语|韩文|韩语|法文|法语|\b(?:english|chinese|japanese|korean|french)\b/iu
const PROFESSIONS = /(?:工程师|开发者?|设计师|医生|教师|老师|律师|会计|学生|研究员|产品经理|项目经理|创业者|创始人|程序员|作家|编辑|记者|护士|engineer|developer|designer|doctor|teacher|lawyer|accountant|student|researcher|manager|founder|writer|editor|nurse)(?:\s*[（(][^）)]{0,24}[）)])?$/iu
export const LOCAL_MEMORY_FACT_KEYS = Object.freeze(['answer.language', 'identity.name', 'identity.profession', 'identity.company', 'project.name', 'output.format'])

function canonicalLanguage(value) {
  return ({ 英语: '英文', english: '英文', chinese: '中文', 日语: '日文', japanese: '日文', 韩语: '韩文', korean: '韩文', 法语: '法文', french: '法文' })[value.toLowerCase()] || value
}

function statements(content) {
  // 移除标点之前判断问句，不能把“以后默认用英文吗？”切成偏好。
  return (String(content || '').match(/[^。.!！？?\n]+[。.!！？?\n]?/gu) || [])
    .map((part) => part.trim())
    .filter((part) => part.length <= 1_000 && isExplicitMemoryStatement(part))
    .flatMap((part) => part.replace(/[。.!！\n]+$/u, '').split(/[，,；;]/u).map((clause) => clause.trim()).filter(Boolean))
    .filter(isExplicitMemoryStatement).slice(0, 12)
    .map((evidence) => ({ evidence, statement: evidence.normalize('NFKC').replace(/\s+/g, ' ').trim() }))
}

function forgottenFactKey(statement) {
  // “不要忘记我的名字”不是删除授权；关于遗忘的自述也不触发操作。
  if (/(?:不要|别|不能|不想|不希望|不需要|没有|避免|\b(?:don't|do not|not|never)\b).{0,20}(?:忘记|忘掉|删除|移除|清除|forget)/iu.test(statement)) return ''
  if (!/^(?:(?:请|帮我|麻烦你?|现在)\s*)?(?:忘记|忘掉|删除|移除|清除)|^(?:请)?(?:把|将).{1,40}(?:忘记|忘掉|删除|移除|清除)|^(?:please\s+)?forget\b/iu.test(statement)) return ''
  const matches = [
    [/(?:名字|姓名|\bname\b)/iu, 'identity.name'],
    [/(?:职业|工作身份|\bprofession\b)/iu, 'identity.profession'],
    [/(?:公司|\bcompany\b)/iu, 'identity.company'],
    [/(?:项目名称|我的项目|\bproject name\b)/iu, 'project.name'],
    [/(?:回答语言|回复语言|语言偏好|(?:英文|中文|英语|日文).{0,6}(?:偏好|回答|回复)|\b(?:answer language|language preference)\b)/iu, 'answer.language'],
    [/(?:输出格式|回答格式|格式偏好|\boutput format\b)/iu, 'output.format'],
  ].filter(([expression]) => expression.test(statement))
  return matches.length === 1 ? matches[0][1] : ''
}

/** 仅用户明确陈述的原话能产生纠正键；未知事实只精确去重。 */
export function extractLocalMemoryProposals(content, { projectKey = '' } = {}) {
  const raw = String(content || '').trim()
  if (!shouldExtractMemory(raw) || unsafeAutomaticMemory(raw)) return []
  const proposals = []
  const append = (evidence, factKey, title, excerpt, type = 'fact', action = 'create') => {
    const scope = factKey === 'project.name' && projectKey ? 'project' : 'user'
    proposals.push({ title, excerpt, evidence, type, confidence: 0.94, factKey, action, scope })
  }
  for (const { statement, evidence } of statements(raw)) {
    const forgotten = forgottenFactKey(statement)
    if (forgotten) { append(evidence, forgotten, '用户明确要求遗忘', statement, 'fact', 'forget'); continue }
    if (!DURABLE_SIGNAL.test(statement) || /(?:忘记|忘掉|删除|移除|清除|\bforget\b)/iu.test(statement)) continue
    const name = statement.match(/^(?:请?记住[ :：]*)?(?:我叫|我的名字(?:是|叫)|my name is\s+|call me\s+)([\p{L}\p{N}][\p{L}\p{N} ._-]{0,39})$/iu)?.[1]?.trim()
    if (name && !/(?:去|帮|替|给|负责|需要|来做).{1,}/u.test(name)) { append(evidence, 'identity.name', '用户姓名', `用户的名字是${name}。`); continue }
    const profession = statement.match(/^(?:请?记住[ :：]*)?(?:我是(?:一名|一位)?|我的职业(?:是|为)|my profession is\s+|i am (?:an? )?|i'm (?:an? )?)(.{1,60})$/iu)?.[1]?.trim()
    if (profession && !/^(?:不|非|not\b|no\b)/iu.test(profession) && PROFESSIONS.test(profession)) { append(evidence, 'identity.profession', '用户职业', `用户的职业是${profession}。`); continue }
    const company = statement.match(/^(?:请?记住[ :：]*)?(?:我的公司(?:是|叫|名为)|my company is\s+)(.{1,60})$/iu)?.[1]?.trim()
      || statement.match(/^我在(.{1,60})(?:工作|上班|任职)$/u)?.[1]?.trim()
    if (company) { append(evidence, 'identity.company', '用户公司', `用户的公司是${company}。`); continue }
    const project = statement.match(/^(?:请?记住[ :：]*)?(?:我的项目(?:是|叫|名为)|my project is\s+)(.{1,60})$/iu)?.[1]?.trim()
    if (project) { append(evidence, 'project.name', '项目名称', `用户的项目是${project}。`); continue }
    const language = statement.match(LANGUAGE)?.[0]
    if (language && /(?:回答|回复|沟通|交流|(?:默认|以后|今后).{0,16}(?:用|使用)|改用|改成|改为|固定用|一直用|\b(?:answer|respond|reply)\b)/iu.test(statement)
      && !/(?:不要|不再|别|停止|勿|\b(?:don't|do not|never|stop)\b)/iu.test(statement)
      && !/(?:编程|开发|代码|界面|翻译)/u.test(statement)) {
      append(evidence, 'answer.language', '回答语言', `默认使用${canonicalLanguage(language)}回答。`, 'preference'); continue
    }
    const format = statement.match(/\b(?:json|markdown)\b|表格|纯文本|代码块/iu)?.[0]
    if (format && /(?:输出|回答|回复|格式|\b(?:output|answer|reply|format)\b)/iu.test(statement)
      && !/(?:不要|不再|别|停止|勿|\b(?:don't|do not|never|stop)\b)/iu.test(statement)) {
      const canonical = ({ json: 'JSON', markdown: 'Markdown' })[format.toLowerCase()] || format
      append(evidence, 'output.format', '输出格式', `默认使用${canonical}输出。`, 'preference'); continue
    }
    if (PREFERENCE_SIGNAL.test(statement) && !/^(?:这|那|它|(?:this|that)\b)/iu.test(statement)) append(evidence, '', statement.slice(0, 72), statement, 'preference')
    else if (/^(?:请?记住|remember\b)/iu.test(statement) && statement.replace(/^(?:请?记住|remember\b)\s*/iu, '').length >= 4) append(evidence, '', statement.slice(0, 72), statement)
    if (proposals.length >= 5) break
  }
  return proposals.slice(0, 5)
}

/** 应用现有 SQLite 提供 retain / recall / forget，默认完全在本机执行。 */
export class LocalMemoryService {
  constructor({ database, extractMemories = null, onChanged = null } = {}) {
    if (!database) throw new Error('本地记忆服务缺少数据库。')
    this.database = database
    this.extractMemories = extractMemories
    this.onChanged = onChanged
    this.enqueue = createMemoryMaintenanceQueue()
    this.pending = new Set()
    this.pendingByKey = new Map()
    this.controllers = new Map()
    this.activeRefinements = 0
    this.refinementWaiters = []
    this.generations = new Map()
    this.recentCandidates = new Map()
    this.retainCounts = new Map()
    this.retentionGeneration = 0
    this.stopped = false
  }

  inspect() { return { engine: 'hindsight-inspired-local', localOnly: !this.settings().memoryModelRefinement, ready: true, error: '' } }
  settings() { return this.database.loadSettings?.() || {} }
  setModelRefiner(refiner) {
    for (const key of this.generations.keys()) this.generations.set(key, (this.generations.get(key) || 0) + 1)
    for (const controller of this.controllers.values()) controller.abort()
    this.extractMemories = typeof refiner === 'function' ? refiner : null
  }
  captureRetentionGeneration() { return this.retentionGeneration }
  async start() {
    if (this.stopped) this.retentionGeneration += 1
    this.stopped = false
    return this
  }
  async stop() {
    this.stopped = true
    this.cancelAllMaintenance()
  }

  cancelAllMaintenance() {
    this.retentionGeneration += 1
    for (const key of this.generations.keys()) this.generations.set(key, (this.generations.get(key) || 0) + 1)
    for (const controller of this.controllers.values()) controller.abort()
    this.recentCandidates.clear()
    this.retainCounts.clear()
  }

  cancelMaintenance(botId, ownerKey = null) {
    const prefix = `${String(botId)}\u0000`
    const keys = new Set([...this.generations.keys(), ...this.controllers.keys(), ...this.recentCandidates.keys()])
    for (const key of keys) {
      if (!key.startsWith(prefix) || (ownerKey !== null && key !== `${prefix}${ownerKey}`)) continue
      if (this.pendingByKey.has(key)) this.generations.set(key, (this.generations.get(key) || 0) + 1)
      else this.generations.delete(key)
      this.controllers.get(key)?.abort()
      this.recentCandidates.delete(key)
      this.retainCounts.delete(key)
    }
  }

  async waitForMaintenance() { await Promise.allSettled([...this.pending]) }
  async recallMemories(botId, query, options = {}) { return this.database.recallMemories(botId, query, options) }
  async searchMemories(botId, query, limit = 8, options = {}) { return this.database.searchMemories(botId, query, limit, options) }

  result(result, extraction = 'local-rules') {
    const changed = Number(result?.created || 0) + Number(result?.updated || 0) + Number(result?.forgotten || 0) > 0
    return { ...result, stored: changed, created: Number(result?.created || 0), updated: Number(result?.updated || 0),
      reason: result?.reason || (changed ? '' : result?.capacityReached ? 'capacity-reached' : 'duplicate-or-low-confidence'), extraction }
  }

  async retainUserMessage(botId, content, { conversationId = '', messageId = '', ownerKey = 'local', projectKey = '', modelContext = null, expectedVersion, expectedGeneration } = {}) {
    const text = String(content || '').trim()
    if (expectedGeneration !== undefined && Number(expectedGeneration) !== this.retentionGeneration) return { stored: false, blocked: 1, reason: 'stale-generation' }
    if (expectedVersion !== undefined && Number(expectedVersion) !== this.database.getMemoryVersion?.(botId)) return { stored: false, blocked: 1, reason: 'stale-version' }
    const settings = this.settings()
    if (this.stopped || settings.autoExtractMemory === false) return { stored: false, reason: 'disabled' }
    if (!shouldExtractMemory(text) || unsafeAutomaticMemory(text)) return { stored: false, reason: 'not-durable-or-sensitive' }
    const existing = this.database.listMemories(botId, { ownerKey, projectKey })
    let unmatchedForget = false
    const proposals = extractLocalMemoryProposals(text, { projectKey }).flatMap((proposal) => {
      const exactProject = proposal.scope === 'project' ? projectKey : ''
      const prior = proposal.factKey ? existing.find((memory) => memory.factKey === proposal.factKey && (memory.projectKey || '') === exactProject) : null
      if (proposal.action === 'forget') {
        if (!prior) { unmatchedForget = true; return [] }
        return [{ ...proposal, matchId: prior.id }]
      }
      if (prior && prior.locked === false && prior.excerpt !== proposal.excerpt) return [{ ...proposal, action: 'update', matchId: prior.id }]
      return [proposal]
    })
    const options = { conversationId, messageId, ownerKey, projectKey, expectedVersion, evidenceText: text, source: 'ZSense 自动记忆（本地）', maxItems: settings.memoryMaxItems || 500 }
    const local = proposals.length ? this.result(this.database.upsertAutoMemories(botId, proposals, options)) : { stored: false, reason: unmatchedForget ? 'memory-not-found' : 'no-explicit-durable-fact', extraction: 'local-rules' }
    // 首次写入用完整原话核验证据；维护缓存只保留有限候选证据，避免驻留长消息。
    options.evidenceText = proposals.map((proposal) => proposal.evidence).join('\n')
    const key = `${String(botId)}\u0000${ownerKey}`
    // 候选缓存仅用于本地周期增量维护；不读取或发送过去的聊天记录。
    if (proposals.length && local.capacityReached) {
      const recent = this.recentCandidates.get(key) || []
      recent.push({ proposals, options, version: this.database.getMemoryVersion?.(botId) })
      if (recent.length > 24) recent.shift()
      this.recentCandidates.set(key, recent)
      if (this.recentCandidates.size > 64) this.recentCandidates.delete(this.recentCandidates.keys().next().value)
    }
    const count = (this.retainCounts.get(key) || 0) + 1
    this.retainCounts.set(key, count)
    if (this.retainCounts.size > 64) this.retainCounts.delete(this.retainCounts.keys().next().value)
    const interval = Math.max(2, Math.min(100, Number(settings.memoryReviewInterval) || 10))
    if (settings.memoryPeriodicReview && count % interval === 0) this.scheduleLocalReview(botId, key)
    if (settings.memoryModelRefinement === true && modelContext && this.extractMemories && proposals.length && !local.blocked && !local.capacityReached && proposals.every((proposal) => proposal.action !== 'forget')) {
      local.modelRefinement = this.scheduleRefinement(botId, key, proposals, options, modelContext)
    }
    return local
  }

  schedule(botId, key, task) {
    if (this.pending.size >= 16) return 'queue-full'
    const generation = this.generations.get(key) || 0
    this.generations.set(key, generation)
    const version = this.database.getMemoryVersion?.(botId)
    const valid = () => !this.stopped && (this.generations.get(key) || 0) === generation
      && (version === undefined || this.database.getMemoryVersion?.(botId) === version)
      && this.settings().autoExtractMemory !== false
    const promise = this.enqueue(key, async () => { if (valid()) await task({ valid, version }) }).catch(() => {
      if (!valid()) return
      // 对外只报告固定原因，模型响应、原话和服务凭据不进入错误通知。
      try { this.onChanged?.(botId, { stored: false, reason: 'maintenance-failed', extraction: 'background' }) } catch { /* 通知失败不影响后续队列。 */ }
    })
    this.pending.add(promise)
    this.pendingByKey.set(key, (this.pendingByKey.get(key) || 0) + 1)
    void promise.finally(() => {
      this.pending.delete(promise)
      const remaining = (this.pendingByKey.get(key) || 1) - 1
      if (remaining > 0) this.pendingByKey.set(key, remaining)
      else { this.pendingByKey.delete(key); this.generations.delete(key) }
    })
    return 'queued'
  }

  async acquireRefinementSlot(signal) {
    if (signal.aborted) return null
    const release = () => {
      this.activeRefinements -= 1
      while (this.refinementWaiters.length && this.activeRefinements < 2) {
        const waiter = this.refinementWaiters.shift()
        waiter.signal.removeEventListener('abort', waiter.abort)
        if (waiter.signal.aborted) { waiter.resolve(null); continue }
        this.activeRefinements += 1
        waiter.resolve(release)
      }
    }
    if (this.activeRefinements < 2) { this.activeRefinements += 1; return release }
    return new Promise((resolve) => {
      const waiter = { signal, resolve, abort: null }
      waiter.abort = () => {
        const position = this.refinementWaiters.indexOf(waiter)
        if (position >= 0) this.refinementWaiters.splice(position, 1)
        resolve(null)
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.refinementWaiters.push(waiter)
    })
  }

  scheduleLocalReview(botId, key) {
    return this.schedule(botId, key, async ({ valid, version }) => {
      if (!this.settings().memoryPeriodicReview) return
      const recent = this.recentCandidates.get(key) || []
      this.recentCandidates.delete(key)
      for (const candidate of recent) {
        if (!valid() || (candidate.version !== undefined && candidate.version !== version)) break
        const result = this.result(this.database.upsertAutoMemories(botId, candidate.proposals, {
          ...candidate.options, source: 'ZSense 周期复盘（本地）', maxItems: this.settings().memoryMaxItems || 500, expectedVersion: version,
        }), 'local-review')
        if (result.stored || result.capacityReached) this.onChanged?.(botId, result)
      }
    })
  }

  scheduleRefinement(botId, key, localProposals, options, modelContext) {
    const candidateText = localProposals.map((proposal) => proposal.evidence).join('\n')
    return this.schedule(botId, key, async ({ valid, version }) => {
      if (!this.settings().memoryModelRefinement || !this.extractMemories || !valid()) return
      const controller = new AbortController()
      this.controllers.set(key, controller)
      let release = null
      try {
        release = await this.acquireRefinementSlot(controller.signal)
        if (!release || !valid() || !this.settings().memoryModelRefinement) return
        const existing = this.database.listMemories(botId, { ownerKey: options.ownerKey, projectKey: options.projectKey })
        const refined = await this.extractMemories({ ...modelContext, message: candidateText, recentUserMessages: [],
          existingMemories: selectCurationMemories(existing, candidateText), trustedProposals: localProposals, signal: controller.signal, strict: true })
        if (controller.signal.aborted || !valid() || !this.settings().memoryModelRefinement) return
        const allowed = (Array.isArray(refined) ? refined : []).flatMap((proposal) => {
          const evidence = String(proposal?.evidence || '').trim()
          if (!evidence || !candidateText.includes(evidence) || !shouldExtractMemory(evidence) || !isExplicitMemoryStatement(evidence)
            || unsafeAutomaticMemory(`${proposal.title || ''}\n${proposal.excerpt || ''}\n${evidence}`)) return []
          const action = proposal.action || 'create'
          const confidence = Number(proposal.confidence)
          if (!['create', 'update'].includes(action) || !Number.isFinite(confidence) || confidence < 0.9 || confidence > 1) return []
          const local = localProposals.find((item) => item.evidence.includes(evidence) && (!proposal.factKey || item.factKey === proposal.factKey))
          if (!local || (action === 'create' && proposal.matchId)) return []
          if (action === 'update') {
            const match = existing.find((item) => item.id === proposal.matchId)
            const exactProject = local.scope === 'project' ? options.projectKey : ''
            if (!local.factKey || !match || match.locked !== false || match.factKey !== local.factKey || (match.projectKey || '') !== exactProject) return []
          }
          // 注入边界也固定已确认事实与归属，模型只能选择候选和改善标题。
          return [{ ...proposal, action, excerpt: local.excerpt, type: local.type, factKey: local.factKey, scope: local.scope }]
        }).slice(0, 3)
        if (!allowed.length) return
        const result = this.result(this.database.upsertAutoMemories(botId, allowed, {
          ...options, source: 'ZSense 自动记忆（模型精炼）', maxItems: this.settings().memoryMaxItems || 500, expectedVersion: version,
        }), 'model-refinement')
        if (result.stored || result.capacityReached) this.onChanged?.(botId, result)
      } finally {
        release?.()
        if (this.controllers.get(key) === controller) this.controllers.delete(key)
      }
    })
  }

  async refreshProjection(_botId) { return 0 }
  async createMemory(botId, memory) { this.cancelMaintenance(botId); return this.database.createMemory(botId, memory) }
  async updateMemory(botId, memory) { this.cancelMaintenance(botId); return this.database.updateMemory(botId, memory) }
  async deleteMemory(botId, memoryId) { this.cancelMaintenance(botId); return this.database.deleteMemory(botId, memoryId) }
}
