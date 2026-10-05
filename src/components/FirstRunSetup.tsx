import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { type FormEvent, useMemo, useState } from 'react'
import brandLogo from '../assets/zsense-brand.png'
import type { ModelCatalog, ModelCatalogRequest, ModelConfiguration, ModelConfigurationInput, ModelProvider } from '../types'
import { modelProviderDefinitions } from './ModelPage'

interface FirstRunSetupProps {
  configuration: ModelConfiguration
  initialUserName: string
  onLoadModels: (request: ModelCatalogRequest) => Promise<ModelCatalog>
  onPickWorkspace: () => Promise<string>
  onComplete: (configuration: ModelConfigurationInput, defaultWorkspacePath: string, userName: string) => Promise<void>
}

function folderName(value: string) {
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value
}

export function FirstRunSetup({ configuration, initialUserName, onLoadModels, onPickWorkspace, onComplete }: FirstRunSetupProps) {
  const [step, setStep] = useState<1 | 2>(1)
  const [provider, setProvider] = useState<ModelProvider>(configuration.provider)
  const [model, setModel] = useState(configuration.model)
  const [baseUrl, setBaseUrl] = useState(configuration.baseUrl)
  const [apiKeyName, setApiKeyName] = useState(configuration.apiKeyName)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [userName, setUserName] = useState(initialUserName === '本机用户' ? '' : initialUserName)
  const [workspacePath, setWorkspacePath] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const selectedProvider = useMemo(() => modelProviderDefinitions.find((item) => item.id === provider) || modelProviderDefinitions[0], [provider])
  const keyRequired = !['nous', 'custom'].includes(provider)
  const hasStoredKey = configuration.provider === provider && configuration.apiKeyConfigured

  const chooseProvider = (nextProvider: ModelProvider) => {
    const definition = modelProviderDefinitions.find((item) => item.id === nextProvider) || modelProviderDefinitions[0]
    setProvider(nextProvider)
    setModel('')
    setAvailableModels([])
    setApiKey('')
    setShowApiKey(false)
    setApiKeyName(definition.keyName)
    setBaseUrl(nextProvider === 'custom' ? definition.baseUrl : '')
    setError('')
  }

  const loadModels = async () => {
    if (keyRequired && !apiKey.trim() && !hasStoredKey) return setError('请先填写 API Key，再获取官方可用模型。')
    if (provider === 'custom' && !baseUrl.trim()) return setError('自定义 API 需要填写 Base URL。')
    setLoadingModels(true)
    setError('')
    try {
      const catalog = await onLoadModels({ provider, baseUrl: baseUrl.trim(), apiKeyName: apiKeyName.trim(), apiKey: apiKey.trim(), forceRefresh: true })
      setAvailableModels(catalog.models)
      if (!catalog.models.includes(model)) setModel(catalog.models[0] || '')
      if (!catalog.models.length) setError('接口没有返回可用模型，你可以直接填写模型 ID。')
    } catch (reason) {
      setError(reason instanceof Error ? `${reason.message} 你仍可以手动填写模型 ID。` : '获取模型列表失败，你仍可以手动填写模型 ID。')
    } finally {
      setLoadingModels(false)
    }
  }

  const continueToWorkspace = (event: FormEvent) => {
    event.preventDefault()
    if (keyRequired && !apiKey.trim() && !hasStoredKey) return setError('请填写所选供应商的 API Key。')
    if (!apiKeyName.trim()) return setError('请填写 API 密钥变量名。')
    if (!model.trim()) return setError('请选择或填写要作为全局默认值的模型 ID。')
    if (provider === 'custom' && !baseUrl.trim()) return setError('自定义 API 需要填写 Base URL。')
    setError('')
    setStep(2)
  }

  const pickWorkspace = async () => {
    setPickingWorkspace(true)
    setError('')
    try {
      const selected = await onPickWorkspace()
      if (selected) setWorkspacePath(selected)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '选择工作区失败。')
    } finally {
      setPickingWorkspace(false)
    }
  }

  const finish = async (event: FormEvent) => {
    event.preventDefault()
    if (!userName.trim()) return setError('请填写用户名称。')
    if (userName.trim().length > 80) return setError('用户名称不能超过 80 个字符。')
    if (!workspacePath) return setError('请选择默认全局工作区文件夹。')
    setSaving(true)
    setError('')
    try {
      await onComplete({
        provider,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        apiKeyName: apiKeyName.trim(),
        apiKey: apiKey.trim(),
        clearApiKey: false,
      }, workspacePath, userName.trim())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '首次配置保存失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="first-run-page">
      <section className="first-run-shell" aria-labelledby="first-run-title">
        <aside className="first-run-intro">
          <img src={brandLogo} alt="ZSense" />
          <span className="first-run-kicker"><Sparkles size={14} />首次启动设置</span>
          <h1 id="first-run-title">让 ZSense 准备好第一次工作</h1>
          <p>只需要配置一次。之后新建的 Bot、AI 对话和定时任务会直接使用这里保存的模型与工作区。</p>
          <ol aria-label="首次启动设置进度">
            <li className={step === 1 ? 'active' : 'complete'}><span>{step === 2 ? <CheckCircle2 size={16} /> : '1'}</span><div><strong>连接 AI 模型</strong><small>供应商、API Key 与默认模型</small></div></li>
            <li className={step === 2 ? 'active' : ''}><span>2</span><div><strong>设置身份与工作区</strong><small>用户名称和默认文件位置</small></div></li>
          </ol>
          <div className="first-run-security"><ShieldCheck size={18} /><span><strong>凭证只保存在本机</strong><small>API Key 进入系统凭证保险库，不写入 SQLite，也不会显示回界面。</small></span></div>
        </aside>

        <section className="first-run-form-panel">
          {step === 1 ? <form onSubmit={continueToWorkspace}>
            <header><small>步骤 1 / 2</small><h2>配置 AI 模型 API</h2><p>选择供应商并设置 ZSense 的全局默认模型。</p></header>
            <div className="first-run-form-grid">
              <label className="full-field"><span>模型供应商</span><select autoFocus value={provider} onChange={(event) => chooseProvider(event.target.value as ModelProvider)}>{modelProviderDefinitions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.description}</option>)}</select></label>
              <label><span>API 密钥变量名</span><input value={apiKeyName} onChange={(event) => setApiKeyName(event.target.value.toUpperCase())} readOnly={provider !== 'custom'} /></label>
              <label><span>API Key {keyRequired ? '*' : '（可选）'}</span><span className="first-run-secret"><KeyRound size={16} /><input type={showApiKey ? 'text' : 'password'} autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasStoredKey ? '•••••••• 已安全保存' : '粘贴 API Key'} /><button type="button" onClick={() => setShowApiKey((current) => !current)} aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'} title={showApiKey ? '隐藏 API Key' : '显示 API Key'}>{showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
              {provider === 'custom' && <label className="full-field"><span>API Base URL *</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selectedProvider.baseUrl} /></label>}
              <label className="full-field"><span>全局默认模型 *</span><div className="first-run-model-control">{availableModels.length ? <select value={model} onChange={(event) => setModel(event.target.value)}>{availableModels.map((item) => <option key={item} value={item}>{item}</option>)}</select> : <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={selectedProvider.model} />}<button type="button" className="button secondary" onClick={() => void loadModels()} disabled={loadingModels}>{loadingModels ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{loadingModels ? '正在获取' : '获取可用模型'}</button></div><small>从供应商官方 API 获取；连接失败时也可以手动填写模型 ID。</small></label>
            </div>
            {error && <div className="first-run-error" role="alert">{error}</div>}
            <footer><span><Cpu size={15} />当前选择：{selectedProvider.name}</span><button className="button primary" type="submit">下一步<ArrowRight size={16} /></button></footer>
          </form> : <form onSubmit={finish}>
            <header><small>步骤 2 / 2</small><h2>设置用户与全局工作区</h2><p>用户名称用于本机界面显示和数据归属；新对话和新任务会默认在所选文件夹中读写文件。</p></header>
            <label className="first-run-user-name"><span><UserRound size={18} /></span><span><strong>用户名称</strong><small>只保存在本机，不会创建在线账号。</small></span><input autoFocus value={userName} maxLength={80} autoComplete="name" onChange={(event) => setUserName(event.target.value)} placeholder="例如：小林" aria-label="用户名称" required /></label>
            <button type="button" className={`first-run-workspace-picker ${workspacePath ? 'selected' : ''}`} onClick={() => void pickWorkspace()} disabled={pickingWorkspace || saving}>
              <span><FolderOpen size={24} /></span>
              <span><strong>{workspacePath ? folderName(workspacePath) : '选择一个文件夹'}</strong><small title={workspacePath}>{workspacePath || '例如：文稿、代码或专门创建的 ZSense Workspace'}</small></span>
              <span>{pickingWorkspace ? <LoaderCircle className="spin" size={16} /> : workspacePath ? '更换' : '选择'}</span>
            </button>
            <div className="first-run-workspace-notes">
              <span><CheckCircle2 size={16} /><span><strong>默认继承</strong><small>AI 对话、Bot 对话和定时任务会优先使用此目录。</small></span></span>
              <span><CheckCircle2 size={16} /><span><strong>随时可改</strong><small>以后可在“设置 → 本地存储”中修改全局默认值。</small></span></span>
            </div>
            <div className="first-run-summary"><Cpu size={17} /><span><small>{userName.trim() || '待填写用户名称'} · 将使用的全局模型</small><strong>{selectedProvider.name} · {model}</strong></span></div>
            {error && <div className="first-run-error" role="alert">{error}</div>}
            <footer><button className="button secondary" type="button" onClick={() => { setError(''); setStep(1) }} disabled={saving}><ArrowLeft size={16} />返回</button><button className="button primary" type="submit" disabled={saving || !workspacePath || !userName.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}{saving ? '正在保存…' : '完成并进入 ZSense'}</button></footer>
          </form>}
        </section>
      </section>
    </main>
  )
}
