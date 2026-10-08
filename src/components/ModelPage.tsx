import { AlertTriangle, CheckCircle2, ChevronDown, Cpu, ExternalLink, KeyRound, LoaderCircle, RefreshCw, Save, Search, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelCatalog, ModelCatalogRequest, ModelConfiguration, ModelConfigurationInput, ModelProvider, RuntimeStatus } from '../types'

export const modelProviderDefinitions: Array<{ id: ModelProvider; name: string; description: string; keyName: string; model: string; baseUrl: string }> = [
  { id: 'openrouter', name: 'OpenRouter', description: '一个 API 使用多家模型', keyName: 'OPENROUTER_API_KEY', model: 'anthropic/claude-sonnet-4', baseUrl: '' },
  { id: 'openai', name: 'OpenAI', description: 'GPT 与兼容模型', keyName: 'OPENAI_API_KEY', model: 'gpt-5.4', baseUrl: '' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude 系列模型', keyName: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-6', baseUrl: '' },
  { id: 'google', name: 'Google Gemini', description: 'Gemini 系列模型', keyName: 'GEMINI_API_KEY', model: 'gemini-3.1-pro-preview', baseUrl: '' },
  { id: 'deepseek', name: 'DeepSeek', description: '深度求索官方 API', keyName: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-flash', baseUrl: '' },
  { id: 'zai', name: '智谱 GLM', description: 'Z.AI / 智谱 GLM 系列', keyName: 'GLM_API_KEY', model: 'glm-5', baseUrl: '' },
  { id: 'kimi-coding-cn', name: 'Kimi / Moonshot', description: '月之暗面中国区 API', keyName: 'KIMI_CN_API_KEY', model: 'kimi-k2.5', baseUrl: '' },
  { id: 'nous', name: 'Nous Portal', description: '连接 Nous Research 官方推理 API', keyName: 'NOUS_API_KEY', model: 'nous/hermes-4-405b', baseUrl: '' },
  { id: 'custom', name: '自定义 API', description: 'OpenAI 兼容接口或本地模型', keyName: 'OPENAI_API_KEY', model: 'provider/model-id', baseUrl: 'http://127.0.0.1:11434/v1' },
]

interface ModelPageProps {
  configuration: ModelConfiguration
  savedConfigurations: ModelConfiguration[]
  availableConfigurations: ModelConfiguration[]
  runtime: RuntimeStatus
  onSave: (configuration: ModelConfigurationInput) => Promise<void>
  onLoadModels: (request: ModelCatalogRequest) => Promise<ModelCatalog>
  onRefreshRuntime: () => Promise<void>
  onOpenRuntime: () => void
  embedded?: boolean
}

function compactContextWindow(value?: number) {
  if (!value) return ''
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions.toFixed(Number.isInteger(millions) ? 0 : 1)}M`
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function modelCredentialReady(configuration: ModelConfiguration) {
  if (configuration.apiKeyConfigured) return true
  if (configuration.provider !== 'custom') return false
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(configuration.baseUrl)
}

function localCustomEndpoint(provider: ModelProvider, baseUrl: string) {
  return provider === 'custom' && /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(baseUrl.trim())
}

export function ModelPage({ configuration, savedConfigurations, availableConfigurations, runtime, onSave, onLoadModels, onRefreshRuntime, onOpenRuntime, embedded = false }: ModelPageProps) {
  const [provider, setProvider] = useState<ModelProvider>(configuration.provider)
  const [model, setModel] = useState(configuration.model)
  const [baseUrl, setBaseUrl] = useState(configuration.baseUrl)
  const [apiKeyName, setApiKeyName] = useState(configuration.apiKeyName)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelCatalogError, setModelCatalogError] = useState('')
  const [modelCatalogFetchedAt, setModelCatalogFetchedAt] = useState('')
  const [modelCatalogEndpoint, setModelCatalogEndpoint] = useState('')
  const [manualModel, setManualModel] = useState(false)
  const [activatingModelKey, setActivatingModelKey] = useState('')
  const [globalSwitchMessage, setGlobalSwitchMessage] = useState('')
  const [globalSwitchError, setGlobalSwitchError] = useState('')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogProvider, setCatalogProvider] = useState<ModelProvider | 'all'>('all')
  const [catalogCredential, setCatalogCredential] = useState<'all' | 'ready' | 'needs-key'>('all')
  const [visibleModelCount, setVisibleModelCount] = useState(40)
  const deferredCatalogQuery = useDeferredValue(catalogQuery)
  const catalogRequestId = useRef(0)
  const selected = useMemo(() => modelProviderDefinitions.find((item) => item.id === provider) || modelProviderDefinitions[0], [provider])
  const savedForProvider = useMemo(() => savedConfigurations.filter((item) => item.provider === provider), [provider, savedConfigurations])
  const availableForProvider = useMemo(() => availableConfigurations.filter((item) => item.provider === provider), [availableConfigurations, provider])
  const hasSavedKey = savedForProvider.some((item) => item.apiKeyConfigured && item.apiKeyName === apiKeyName) && !clearApiKey
  const modelOptions = useMemo(() => [...new Set(availableModels.filter(Boolean))], [availableModels])
  const sortedAvailableConfigurations = useMemo(() => [...availableConfigurations].sort((left, right) => {
    const leftCurrent = left.provider === configuration.provider && left.model === configuration.model
    const rightCurrent = right.provider === configuration.provider && right.model === configuration.model
    if (leftCurrent !== rightCurrent) return Number(rightCurrent) - Number(leftCurrent)
    const providerOrder = modelProviderDefinitions.findIndex((item) => item.id === left.provider) - modelProviderDefinitions.findIndex((item) => item.id === right.provider)
    return providerOrder || left.model.localeCompare(right.model, 'en', { numeric: true, sensitivity: 'base' })
  }), [availableConfigurations, configuration.model, configuration.provider])
  const providerModelCounts = useMemo(() => new Map(modelProviderDefinitions.map((item) => [item.id, availableConfigurations.filter((modelItem) => modelItem.provider === item.id).length])), [availableConfigurations])
  const filteredAvailableConfigurations = useMemo(() => {
    const normalizedQuery = deferredCatalogQuery.trim().toLocaleLowerCase('zh-CN')
    return sortedAvailableConfigurations.filter((item) => {
      const providerDefinition = modelProviderDefinitions.find((providerItem) => providerItem.id === item.provider)
      const matchesProvider = catalogProvider === 'all' || item.provider === catalogProvider
      const credentialReady = modelCredentialReady(item)
      const matchesCredential = catalogCredential === 'all' || (catalogCredential === 'ready' ? credentialReady : !credentialReady)
      const haystack = `${item.model} ${item.provider} ${providerDefinition?.name || ''} ${item.apiKeyName}`.toLocaleLowerCase('zh-CN')
      return matchesProvider && matchesCredential && (!normalizedQuery || haystack.includes(normalizedQuery))
    })
  }, [catalogCredential, catalogProvider, deferredCatalogQuery, sortedAvailableConfigurations])
  const visibleAvailableConfigurations = filteredAvailableConfigurations.slice(0, visibleModelCount)

  useEffect(() => {
    setProvider(configuration.provider)
    setModel(configuration.model)
    setBaseUrl(configuration.baseUrl)
    setApiKeyName(configuration.apiKeyName)
    setApiKey('')
    setClearApiKey(false)
    setManualModel(false)
    // 刷新官网列表会重新载入工作区，产生新的 configuration 对象；
    // 仅在默认模型配置实际变更时重置表单，避免丢失当前供应商和未保存的密钥。
  }, [configuration.provider, configuration.model, configuration.baseUrl, configuration.apiKeyName, configuration.updatedAt])

  useEffect(() => { setVisibleModelCount(40) }, [catalogCredential, catalogProvider, deferredCatalogQuery])

  useEffect(() => {
    const requestId = ++catalogRequestId.current
    const definition = modelProviderDefinitions.find((item) => item.id === provider) || modelProviderDefinitions[0]
    setAvailableModels(availableForProvider.map((item) => item.model))
    setModelCatalogError('')
    setModelCatalogFetchedAt('')
    setModelCatalogEndpoint('')
    if (!hasSavedKey && !localCustomEndpoint(provider, baseUrl)) {
      setLoadingModels(false)
      setModelCatalogError('请先填写并保存 API Key，再同步该供应商的官网模型列表。')
      return
    }
    setLoadingModels(true)
    void onLoadModels({ provider, baseUrl: provider === 'custom' ? baseUrl : '', apiKeyName: apiKeyName || definition.keyName, apiKey: '', forceRefresh: false })
      .then((catalog) => {
        if (catalogRequestId.current !== requestId) return
        setAvailableModels(catalog.models)
        setModelCatalogFetchedAt(catalog.fetchedAt)
        setModelCatalogEndpoint(catalog.endpoint)
        setModel((current) => current || catalog.models[0] || '')
      })
      .catch((reason) => {
        if (catalogRequestId.current !== requestId) return
        setModelCatalogError(reason instanceof Error ? reason.message : '获取模型列表失败。')
      })
      .finally(() => {
        if (catalogRequestId.current === requestId) setLoadingModels(false)
      })
  }, [onLoadModels, provider])

  const chooseProvider = (next: ModelProvider) => {
    if (next === provider) return
    const definition = modelProviderDefinitions.find((item) => item.id === next) || modelProviderDefinitions[0]
    const saved = savedConfigurations.find((item) => item.provider === next)
    setProvider(next)
    setApiKeyName(saved?.apiKeyName || definition.keyName)
    setApiKey('')
    setModel(saved?.model || '')
    setManualModel(false)
    if (next === 'custom') setBaseUrl(saved?.baseUrl || baseUrl || definition.baseUrl)
    if (next !== 'custom') setBaseUrl('')
    setClearApiKey(false)
    setError('')
  }

  const refreshModels = async () => {
    if (!apiKey.trim() && !hasSavedKey && !localCustomEndpoint(provider, baseUrl)) {
      setModelCatalogError('请先填写或保存 API Key，再刷新官网模型列表。')
      return
    }
    const requestId = ++catalogRequestId.current
    setLoadingModels(true)
    setAvailableModels([])
    setModelCatalogError('')
    setModelCatalogFetchedAt('')
    setModelCatalogEndpoint('')
    try {
      const catalog = await onLoadModels({ provider, baseUrl: baseUrl.trim(), apiKeyName: apiKeyName.trim(), apiKey: apiKey.trim(), forceRefresh: true })
      if (catalogRequestId.current !== requestId) return
      setAvailableModels(catalog.models)
      setModelCatalogFetchedAt(catalog.fetchedAt)
      setModelCatalogEndpoint(catalog.endpoint)
      setModel((current) => current || catalog.models[0] || '')
    } catch (reason) {
      if (catalogRequestId.current === requestId) setModelCatalogError(reason instanceof Error ? reason.message : '获取模型列表失败。')
    } finally {
      if (catalogRequestId.current === requestId) setLoadingModels(false)
    }
  }

  const save = async () => {
    if (!model.trim()) return setError('请填写完整的模型 ID。')
    if (!apiKeyName.trim()) return setError('请填写 API 密钥变量名。')
    setSaving(true)
    setError('')
    try {
      await onSave({ provider, model: model.trim(), baseUrl: baseUrl.trim(), apiKeyName: apiKeyName.trim(), apiKey: apiKey.trim(), clearApiKey })
      setApiKey('')
      setClearApiKey(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模型配置保存失败。')
    } finally {
      setSaving(false)
    }
  }

  const setAsGlobalModel = async (item: ModelConfiguration) => {
    const modelKey = `${item.provider}:${item.model}`
    setActivatingModelKey(modelKey)
    setGlobalSwitchMessage('')
    setGlobalSwitchError('')
    try {
      await onSave({ provider: item.provider, model: item.model, baseUrl: item.baseUrl, apiKeyName: item.apiKeyName, apiKey: '', clearApiKey: false })
      const providerName = modelProviderDefinitions.find((providerItem) => providerItem.id === item.provider)?.name || item.provider
      setGlobalSwitchMessage(`全局模型已替换为 ${providerName} · ${item.model}`)
    } catch (reason) {
      setGlobalSwitchError(reason instanceof Error ? reason.message : '替换全局模型失败。')
    } finally {
      setActivatingModelKey('')
    }
  }

  return (
    <div className="page model-page">
      <section className="page-heading">
        <div><span className="eyebrow">AI MODEL & API</span>{embedded ? <h2>AI 模型</h2> : <h1>AI 模型</h1>}<p>单独管理 ZSense 的默认模型、供应商和 API 凭证。</p></div>
        <span className="private-badge"><ShieldCheck size={14} />密钥由系统安全存储加密</span>
      </section>

      <section className={`model-runtime-banner ${runtime.runnable ? 'ready' : 'warning'}`}>
        <span>{runtime.runnable ? <CheckCircle2 size={21} /> : <AlertTriangle size={21} />}</span>
        <div><strong>{runtime.runnable ? 'ZSense Agent Core 已就绪' : 'ZSense Agent Core 尚未就绪'}</strong><p>{runtime.message}</p></div>
        <button className="button secondary" onClick={runtime.runnable ? () => void onRefreshRuntime() : onOpenRuntime}>{runtime.runnable ? <><RefreshCw size={16} />重新检测</> : <><ExternalLink size={16} />查看核心服务</>}</button>
      </section>

      <div className="model-layout">
        <section className="panel provider-panel">
          <div className="panel-header"><div><h2>模型供应商</h2><p>选择 API 来源</p></div></div>
          <div className="provider-list">
            {modelProviderDefinitions.map((item) => <button key={item.id} className={provider === item.id ? 'active' : ''} onClick={() => chooseProvider(item.id)}><span><Cpu size={17} /></span><span><strong>{item.name}</strong><small>{item.description}</small></span>{provider === item.id && <CheckCircle2 size={16} />}</button>)}
          </div>
        </section>

        <section className="panel model-config-panel">
          <div className="panel-header"><div><h2>{selected.name} 配置</h2><p>保存后加入 Bot 可选模型，并作为新的全局默认值</p></div><span className={`credential-state ${hasSavedKey ? 'saved' : ''}`}>{hasSavedKey ? `${availableForProvider.length} 个可用模型` : '尚未保存此供应商密钥'}</span></div>
          <div className="settings-form model-form">
            <label className="full-field"><span>模型 ID *</span><span className="model-select-control"><select value={manualModel ? '__manual__' : model} onChange={(event) => {
              if (event.target.value === '__manual__') return setManualModel(true)
              setManualModel(false)
              setModel(event.target.value)
            }} aria-label={`${selected.name} 官网可用模型`}>
              {!model && <option value="">请选择模型</option>}
              {model && !modelOptions.includes(model) && <option value={model}>{model}（当前配置）</option>}
              {modelOptions.map((item) => {
                const contextWindow = availableForProvider.find((configurationItem) => configurationItem.model === item)?.contextWindow
                return <option key={item} value={item}>{item}{contextWindow ? ` · 上下文 ${compactContextWindow(contextWindow)}` : ''}</option>
              })}
              <option value="__manual__">手动输入其他模型 ID…</option>
            </select><button type="button" className="model-refresh-button" onClick={() => void refreshModels()} disabled={loadingModels} aria-label="刷新官网可用模型" title={`直接从 ${selected.name} 官方 API 获取模型`}>{loadingModels ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}<span>{loadingModels ? '获取中' : '刷新官网列表'}</span></button></span>
              {manualModel && <input className="manual-model-input" autoFocus value={model} onChange={(event) => setModel(event.target.value)} placeholder={selected.model} aria-label="手动输入模型 ID" />}
              <small className={modelCatalogError ? 'catalog-error' : ''} aria-live="polite">{loadingModels ? `正在连接 ${selected.name} 官方模型 API…` : modelCatalogError ? `${modelCatalogError} 你仍可选择“手动输入”。` : modelCatalogFetchedAt ? `官方 API 已返回 ${modelOptions.length} 个模型，并同步到对话、Bot 与定时任务选择器 · ${new Date(modelCatalogFetchedAt).toLocaleTimeString('zh-CN')}` : '选择供应商后会直接读取其官方模型 API。'}</small>
              {modelCatalogEndpoint && <small title={modelCatalogEndpoint}>数据来源：{modelCatalogEndpoint}</small>}
            </label>
            <label><span>API 密钥变量名 *</span><input value={apiKeyName} onChange={(event) => setApiKeyName(event.target.value.toUpperCase())} readOnly={provider !== 'custom'} /><small>ZSense 用此名称标识系统钥匙串中的加密凭证，不会写入工作区文件。</small></label>
            <label className="full-field"><span>API Key {hasSavedKey ? '（留空保持不变）' : ''}</span><span className="secret-input"><KeyRound size={16} /><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false) }} placeholder={hasSavedKey ? '•••••••• 已安全保存' : '粘贴 API Key'} /></span><small>ZSense 不会把密钥返回给界面，也不会写进 SQLite。</small></label>
            {(provider === 'custom' || baseUrl) && <label className="full-field"><span>API Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selected.baseUrl} /><small>仅自定义或 OpenAI 兼容接口需要填写。</small></label>}
            {hasSavedKey && <label className="clear-secret"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey('') }} /><span>删除当前已保存的 API Key</span></label>}
            {provider === 'nous' && <div className="form-note"><Sparkles size={17} /><span><strong>Nous Portal</strong><small>当前由 ZSense 直接使用 Nous API Key 调用模型，无需额外 Agent 组件。</small></span></div>}
            {error && <div className="inline-error" role="alert"><AlertTriangle size={15} />{error}</div>}
          </div>
          <div className="model-actions"><span><small>最近保存</small><strong>{configuration.updatedAt ? new Date(configuration.updatedAt).toLocaleString('zh-CN') : '尚未保存'}</strong></span><button className="button primary" disabled={saving || !model.trim()} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? '正在保存…' : '保存模型配置'}</button></div>
        </section>
      </div>

      <section className="panel saved-global-models-panel">
        <div className="panel-header"><div><h2>可用模型</h2><p>搜索模型 ID 或供应商；官网同步结果会自动进入对话、Bot 和定时任务选择器</p></div><span className="saved-model-count">{availableConfigurations.length} 个模型</span></div>
        <div className="model-catalog-toolbar">
          <label className="model-catalog-search"><Search size={16} /><input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="搜索模型 ID、供应商或密钥变量名" aria-label="搜索可用模型" />{catalogQuery && <button type="button" onClick={() => setCatalogQuery('')} aria-label="清空模型搜索"><X size={14} /></button>}</label>
          <label className="model-catalog-filter"><span>供应商</span><select value={catalogProvider} onChange={(event) => setCatalogProvider(event.target.value as ModelProvider | 'all')} aria-label="按供应商筛选模型"><option value="all">全部供应商 · {availableConfigurations.length}</option>{modelProviderDefinitions.map((item) => <option key={item.id} value={item.id}>{item.name} · {providerModelCounts.get(item.id) || 0}</option>)}</select><ChevronDown size={14} /></label>
          <label className="model-catalog-filter"><span>可用状态</span><select value={catalogCredential} onChange={(event) => setCatalogCredential(event.target.value as 'all' | 'ready' | 'needs-key')} aria-label="按 API 凭证状态筛选模型"><option value="all">全部状态</option><option value="ready">可以直接使用</option><option value="needs-key">需要配置密钥</option></select><ChevronDown size={14} /></label>
          <span className="model-filter-result" aria-live="polite">显示 {Math.min(visibleAvailableConfigurations.length, filteredAvailableConfigurations.length)} / {filteredAvailableConfigurations.length}</span>
        </div>
        {filteredAvailableConfigurations.length ? <div className="saved-global-model-list compact">{visibleAvailableConfigurations.map((item) => {
          const modelKey = `${item.provider}:${item.model}`
          const isCurrent = item.provider === configuration.provider && item.model === configuration.model
          const isActivating = activatingModelKey === modelKey
          const providerName = modelProviderDefinitions.find((providerItem) => providerItem.id === item.provider)?.name || item.provider
          const credentialReady = modelCredentialReady(item)
          return <div className={`saved-global-model-row ${isCurrent ? 'current' : ''}`} key={modelKey}><span className="saved-global-model-icon"><Cpu size={16} /></span><span className="saved-global-model-copy"><span className="saved-global-model-title"><code title={item.model}>{item.model}</code>{isCurrent && <em>当前</em>}</span><span className="saved-global-model-metadata"><small>{providerName}</small><small>{item.contextWindow ? `上下文 ${compactContextWindow(item.contextWindow)}` : '上下文待官网提供'}</small><small className={credentialReady ? 'ready' : 'needs-key'}>{credentialReady ? '凭证已就绪' : '缺少 API Key'}</small></span></span>{isCurrent ? <span className="current-global-model"><CheckCircle2 size={14} />当前全局模型</span> : <button type="button" className="button secondary set-global-model-button" onClick={() => void setAsGlobalModel(item)} disabled={Boolean(activatingModelKey) || !credentialReady} aria-label={`将 ${providerName} ${item.model} 设为全局模型`} title={credentialReady ? `将 ${item.model} 设为全局模型` : `请先配置 ${item.apiKeyName}`}>{isActivating ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{isActivating ? '替换中…' : '设为全局'}</button>}</div>
        })}</div> : <div className="saved-global-model-empty"><Search size={20} /><span><strong>{availableConfigurations.length ? '没有匹配的模型' : '还没有可用模型'}</strong><small>{availableConfigurations.length ? '请更换搜索词或筛选条件。' : '先在上方刷新官网模型列表或手动保存模型。'}</small></span></div>}
        {visibleAvailableConfigurations.length < filteredAvailableConfigurations.length && <div className="model-catalog-more"><button type="button" className="button secondary" onClick={() => setVisibleModelCount((current) => current + 60)}>再显示 {Math.min(60, filteredAvailableConfigurations.length - visibleAvailableConfigurations.length)} 个模型</button></div>}
        {globalSwitchMessage && <div className="global-model-feedback success" role="status"><CheckCircle2 size={15} />{globalSwitchMessage}</div>}
        {globalSwitchError && <div className="global-model-feedback error" role="alert"><AlertTriangle size={15} />{globalSwitchError}</div>}
      </section>
    </div>
  )
}
