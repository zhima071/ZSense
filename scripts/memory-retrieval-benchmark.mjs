import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createMemoryRetrievalIndex, scoreMemoryForQuery, selectRelevantMemories } from '../electron/services/memory-intelligence.mjs'

const results = []
for (const count of [100, 500, 5_000]) {
  const memories = Array.from({ length: count }, (_, index) => ({ id: `memory-${index}`, source: 'ZSense 自动记忆', type: 'fact',
    title: index === 0 ? '使用TypeScript开发ZSense' : `财务核算清单${index}`,
    excerpt: index === 0 ? 'TypeScript项目迁移先执行类型检查。' : `资产核对事项${index}；财务月度报告、预算和成本计算。`.repeat(8),
    confidence: 0.94, updatedAt: '2026-10-01T00:00:00.000Z' }))
  const buildStart = performance.now()
  const retrievalIndex = createMemoryRetrievalIndex(memories)
  const buildMs = performance.now() - buildStart
  const queries = [
    ['mixed', 'TypeScript项目迁移'],
    ['short', '继续'],
    ['long-8000', `${'版本检查发布流程'.repeat(1_000)}TypeScript`.slice(0, 8_000)],
  ]
  for (const [kind, query] of queries) {
    const fullScanStart = performance.now()
    const fullScan = memories.map((memory, index) => ({ memory, index, ...scoreMemoryForQuery(memory, query) }))
      .sort((left, right) => right.score - left.score || right.lexicalHits - left.lexicalHits || left.index - right.index)
    const fullScanMs = performance.now() - fullScanStart
    const indexedStart = performance.now()
    const indexed = selectRelevantMemories(retrievalIndex, query)
    const indexedMs = performance.now() - indexedStart
    if (kind === 'mixed') assert.equal(indexed.memories[0]?.id, fullScan[0].memory.id)
    results.push({ count, query: kind, buildMs: +buildMs.toFixed(2), fullScanMs: +fullScanMs.toFixed(2), indexedMs: +indexedMs.toFixed(2), scoredCandidates: indexed.scoredCandidates })
  }
}
console.log(JSON.stringify({ ok: true, environment: 'synthetic-in-memory-no-user-database', results }))
