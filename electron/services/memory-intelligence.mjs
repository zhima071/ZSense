const CJK_SEQUENCE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu

function normalized(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim()
}

function grams(value, size) {
  const output = []
  for (let index = 0; index <= value.length - size; index += 1) output.push(value.slice(index, index + size))
  return output
}

export function memoryTerms(value) {
  const source = normalized(value)
  const terms = new Set()
  for (const word of source.match(WORD) || []) {
    if (!CJK_CHARACTER.test(word)) {
      if (word.length >= 2) terms.add(word)
      continue
    }
    for (const sequence of word.match(CJK_SEQUENCE) || []) {
      if (sequence.length === 1) terms.add(sequence)
      else {
        for (const gram of grams(sequence, 2)) terms.add(gram)
        if (sequence.length >= 3) for (const gram of grams(sequence, 3)) terms.add(gram)
      }
    }
  }
  return terms
}

function overlap(left, right) {
  if (!left.size || !right.size) return { hits: 0, coverage: 0, dice: 0 }
  let hits = 0
  for (const term of left) if (right.has(term)) hits += 1
  return {
    hits,
    coverage: hits / Math.max(1, Math.min(left.size, right.size)),
    dice: (2 * hits) / (left.size + right.size),
  }
}

function isManualMemory(memory) {
  return !/^(?:ZSense 自动记忆|ZSense 周期复盘|Hindsight 自动记忆|Hermes ·)/i.test(String(memory?.source || '').trim())
}

function recencyScore(value, now) {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp)) return 0
  const days = Math.max(0, (now - timestamp) / 86_400_000)
  return Math.max(0, 1 - days / 365) * 0.22
}

export function scoreMemoryForQuery(memory, query, now = Date.now()) {
  const queryText = normalized(query)
  const title = normalized(memory?.title)
  const excerpt = normalized(memory?.excerpt)
  const queryTerms = memoryTerms(queryText)
  const titleOverlap = overlap(queryTerms, memoryTerms(title))
  const excerptOverlap = overlap(queryTerms, memoryTerms(excerpt))
  let score = titleOverlap.coverage * 3.4 + titleOverlap.dice * 2.2 + excerptOverlap.coverage * 2.4 + excerptOverlap.dice * 1.5
  if (queryText.length >= 2 && title.includes(queryText)) score += 4
  if (queryText.length >= 4 && excerpt.includes(queryText)) score += 2.5
  if (memory?.type === 'preference') score += 0.5
  if (isManualMemory(memory)) score += 0.45
  score += Math.min(1, Math.max(0, Number(memory?.confidence ?? 1))) * 0.3
  score += recencyScore(memory?.updatedAt || memory?.updated_at || memory?.createdAt || memory?.created_at, now)
  score += Math.min(0.18, Math.log2(1 + Math.max(0, Number(memory?.recallCount || memory?.recall_count || 0))) * 0.04)
  return { score, lexicalHits: titleOverlap.hits + excerptOverlap.hits }
}

export function selectRelevantMemories(memories, query, { limit = 24, characterBudget = 12_000, now = Date.now() } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 24))
  const safeBudget = Math.max(512, Math.min(24_000, Number(characterBudget) || 4_800))
  const ranked = (Array.isArray(memories) ? memories : []).map((memory, index) => ({
    memory,
    index,
    ...scoreMemoryForQuery(memory, query, now),
  })).sort((left, right) => right.score - left.score || right.lexicalHits - left.lexicalHits || left.index - right.index)

  const selected = []
  const selectedIds = new Set()
  let usedCharacters = 0
  const append = (entry, budget = safeBudget) => {
    if (!entry || selectedIds.has(entry.memory.id) || selected.length >= safeLimit) return
    const title = String(entry.memory.title || '').trim().slice(0, 160)
    const excerpt = String(entry.memory.excerpt || '').trim()
    const remaining = Math.min(900, Math.min(safeBudget, budget) - usedCharacters - title.length - 24)
    if (remaining < 40 && excerpt) return
    if (remaining < 0) return
    const compactExcerpt = excerpt.length > remaining ? `${excerpt.slice(0, Math.max(0, remaining - 1))}…` : excerpt
    const size = title.length + compactExcerpt.length + 24
    if (usedCharacters + size > Math.min(safeBudget, budget)) return
    selected.push(title === entry.memory.title && compactExcerpt === entry.memory.excerpt
      ? entry.memory
      : { ...entry.memory, title, excerpt: compactExcerpt })
    selectedIds.add(entry.memory.id)
    usedCharacters += size
  }

  // 类似 Hermes 的精简 USER/MEMORY 层：只为明确偏好与人工策展事实预留少量固定空间。
  // 其余长期记忆按本轮问题检索，不把整个记忆库塞入每次模型请求。
  const profileBudget = Math.min(1_400, Math.floor(safeBudget * 0.35))
  for (const entry of ranked) {
    if (entry.lexicalHits > 0) append(entry, safeBudget - profileBudget)
  }
  let profileCount = 0
  let profileUsed = 0
  for (const entry of ranked) {
    if (profileCount >= Math.min(3, safeLimit)) break
    if (entry.memory.type !== 'preference' && !(isManualMemory(entry.memory) && entry.memory.type === 'fact')) continue
    const before = selected.length
    const previousUsage = usedCharacters
    append(entry, usedCharacters + profileBudget - profileUsed)
    if (selected.length > before) {
      profileCount += 1
      profileUsed += usedCharacters - previousUsage
    }
  }

  for (const entry of ranked) {
    if (entry.lexicalHits > 0) append(entry)
  }
  // “继续”等短指令缺少检索词时回退一条；明确而无命中的问题不注入无关自动记忆。
  if (!selected.length && ranked.length && normalized(query).length <= 4) append(ranked[0])
  return { memories: selected, usedCharacters, totalCandidates: ranked.length }
}

export function unsafeAutomaticMemory(value) {
  const content = String(value || '').normalize('NFKC')
  return /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u.test(content)
    || /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,})/i.test(content)
    || /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|密码|口令|密钥|secret|私钥|验证码)[\s:=：]+\S+/i.test(content)
    || /(?:忽略|绕过|跳过|禁用|取消|不再)(?:.{0,12})(?:系统指令|安全规则|审批|权限检查|developer instructions|previous instructions)/i.test(content)
}

export function memorySimilarity(left, right) {
  const title = overlap(memoryTerms(left?.title), memoryTerms(right?.title)).dice
  const excerpt = overlap(memoryTerms(left?.excerpt), memoryTerms(right?.excerpt)).dice
  const exactTitle = normalized(left?.title) && normalized(left?.title) === normalized(right?.title)
  const exactExcerpt = normalized(left?.excerpt) && normalized(left?.excerpt) === normalized(right?.excerpt)
  if (exactExcerpt) return 1
  if (exactTitle) return Math.max(0.9, excerpt)
  return title * 0.58 + excerpt * 0.42
}

export function findSimilarMemory(memories, candidate, { threshold = 0.78, automaticOnly = false } = {}) {
  let best = null
  for (const memory of Array.isArray(memories) ? memories : []) {
    if (automaticOnly && isManualMemory(memory)) continue
    const similarity = memorySimilarity(memory, candidate)
    if (similarity >= threshold && (!best || similarity > best.similarity)) best = { memory, similarity }
  }
  return best
}

export function isAutomaticMemory(memory) {
  return !isManualMemory(memory)
}

// 只排除能够确定没有长期价值的消息；不确定的陈述仍交给模型判断，避免漏记短句。
export function shouldExtractMemory(message) {
  const content = String(message || '').normalize('NFKC').trim()
  if (!content) return false
  if (/(?:记住|记下来|以后|今后|从现在起|始终|默认|长期|每次|我叫|我是|我更喜欢|我偏好|不要再|不再|固定用)/u.test(content)) return true
  if (/^(?:继续|好的?|行|嗯|收到|谢谢|是的|不是|ok|yes|no|再试一次|重试)[。.!！?？\s]*$/iu.test(content)) return false
  if (/^\/[\w-]+(?:\s+\S+)?$/u.test(content)) return false
  if (/^(?:今天|明天|现在|当前)(?:的)?(?:天气|时间|日期|几点|星期).{0,32}[?？]?$/u.test(content)) return false
  if (/^[^\n]{0,80}[?？]$/u.test(content) && /^(?:什么|谁|哪里|哪|几|多少|怎么|如何|为什么|是否|能否|可不可以|能不能|你能不能|有没有|你知道|请问)/u.test(content)) return false
  return true
}

export function selectCurationMemories(memories, message, { limit = 24, characterBudget = 7_000 } = {}) {
  const source = String(message || '')
  const query = source.length > 8_000 ? `${source.slice(0, 4_000)}\n${source.slice(-4_000)}` : source
  return selectRelevantMemories(memories, query, { limit, characterBudget }).memories
}

export function createMemoryMaintenanceQueue() {
  const tails = new Map()
  return (botId, task) => {
    const key = String(botId)
    const result = (tails.get(key) || Promise.resolve()).then(task)
    const tail = result.catch(() => undefined).finally(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    tails.set(key, tail)
    return result
  }
}
