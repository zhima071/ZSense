import { contextWindowFromModelEntry } from './model-metadata.mjs'

const MODEL_ENDPOINTS = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1/models',
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  deepseek: 'https://api.deepseek.com/v1/models',
  zai: 'https://api.z.ai/api/paas/v4/models',
  'kimi-coding-cn': 'https://api.moonshot.cn/v1/models',
  nous: 'https://inference-api.nousresearch.com/v1/models',
})
const MODEL_PROVIDER_NAMES = Object.freeze({
  openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini',
  deepseek: 'DeepSeek', zai: '智谱 GLM', 'kimi-coding-cn': 'Kimi / Moonshot', nous: 'Nous Portal', custom: '自定义 API',
})
const MODEL_KEY_REQUIRED = new Set(['openai', 'anthropic', 'google', 'deepseek', 'zai', 'kimi-coding-cn', 'nous'])
const MODEL_FETCH_TIMEOUT = 30_000

function customModelsEndpoint(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) throw new Error('请先填写自定义 API Base URL，再获取官网模型列表。')
  return normalized.endsWith('/models') ? normalized : `${normalized}/models`
}

function modelEntriesFromPayload(payload, provider) {
  const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  const models = new Map()
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (id) models.set(id, { id, contextWindow: contextWindowFromModelEntry(null, provider, id) })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    if (provider === 'google' && !(entry.supportedGenerationMethods || []).includes('generateContent')) continue
    const value = entry.id || entry.name || entry.model
    if (typeof value !== 'string') continue
    const id = provider === 'google' ? value.replace(/^models\//, '').trim() : value.trim()
    if (id) models.set(id, { id, contextWindow: contextWindowFromModelEntry(entry, provider, id) })
  }
  return [...models.values()]
}

function requestHeaders(provider, apiKey) {
  const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache', 'User-Agent': 'ZSense-Agent-Core/0.2' }
  if (!apiKey) return headers
  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (provider === 'google') headers['x-goog-api-key'] = apiKey
  else headers.Authorization = `Bearer ${apiKey}`
  return headers
}

async function requestPage(provider, url, apiKey) {
  const providerName = MODEL_PROVIDER_NAMES[provider] || provider
  let response
  try {
    response = await fetch(url, { method: 'GET', headers: requestHeaders(provider, apiKey), redirect: 'follow', signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT) })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error(`${providerName} 官方模型接口请求超时，请检查网络后重试。`)
    throw new Error(`无法连接 ${providerName} 官方模型接口，请检查网络或 Base URL 后重试。`)
  }
  let payload = null
  try { payload = await response.json() } catch { /* status error below is clearer */ }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || payload?.detail
    if ([401, 403].includes(response.status)) throw new Error(`${providerName} API Key 无效、已过期，或当前账号无权访问模型列表。`)
    if (response.status === 404) throw new Error(`${providerName} 没有在当前地址提供 /models 接口，请检查 API Base URL。`)
    if (response.status === 429) throw new Error(`${providerName} 官方接口请求过于频繁，请稍后再刷新。`)
    throw new Error(`${providerName} 官方模型接口返回 HTTP ${response.status}${detail ? `：${String(detail).replace(/\s+/g, ' ').slice(0, 400)}` : '。'}`)
  }
  if (!payload || typeof payload !== 'object') throw new Error(`${providerName} 官方模型接口返回了无法识别的数据。`)
  return payload
}

export async function fetchOfficialModelCatalog({ provider, apiKey = '', baseUrl = '' }) {
  const providerName = MODEL_PROVIDER_NAMES[provider] || provider
  if (MODEL_KEY_REQUIRED.has(provider) && !apiKey) throw new Error(`请填写或保存 ${providerName} API Key 后，再刷新官网模型列表。`)
  const endpoint = provider === 'custom' ? customModelsEndpoint(baseUrl) : MODEL_ENDPOINTS[provider]
  if (!endpoint) throw new Error('当前供应商没有配置官方模型接口。')
  const modelEntries = new Map()
  let pageToken = ''
  let pageCount = 0
  do {
    const url = new URL(endpoint)
    if (provider === 'google') {
      url.searchParams.set('pageSize', '1000')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
    } else if (provider === 'anthropic') {
      url.searchParams.set('limit', '1000')
      if (pageToken) url.searchParams.set('after_id', pageToken)
    }
    const payload = await requestPage(provider, url, apiKey)
    for (const entry of modelEntriesFromPayload(payload, provider)) modelEntries.set(entry.id, entry)
    pageCount += 1
    pageToken = provider === 'google'
      ? typeof payload.nextPageToken === 'string' ? payload.nextPageToken : ''
      : provider === 'anthropic' && payload.has_more && typeof payload.last_id === 'string' ? payload.last_id : ''
  } while (pageToken && pageCount < 20)
  const entries = [...modelEntries.values()]
  if (!entries.length) throw new Error(`${providerName} 官方 API 已响应，但没有返回可用模型。`)
  return { provider, models: entries.map((entry) => entry.id), entries, source: 'official-api', endpoint, fetchedAt: new Date().toISOString() }
}
