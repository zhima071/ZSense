import { BrainCircuit, ChevronDown, Code2, Cpu, FileSpreadsheet, FileText, FolderOpen, Image as ImageIcon, LoaderCircle, Plus, Presentation, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { mergeChatAttachments } from '../services/chat-attachments'
import { unwrapDesktop } from '../services/desktop'
import { isImageDocumentPath, isPreviewableDocumentPath, previewableDocumentPathFromHref } from '../services/office-artifacts'
import { RemoteWorkspacePicker } from './RemoteWorkspacePicker'
import { ChatComposerControlTooltip } from './ChatComposerControlTooltip'
import type { ChatAttachment, ChatUsage, ModelConfiguration, ModelProvider, ReasoningEffort } from '../types'

interface ChatComposerToolbarProps {
  layout?: 'toolbar' | 'composer'
  attachments: ChatAttachment[]
  usage?: ChatUsage
  savedModelConfigurations: ModelConfiguration[]
  selectedModelProvider: ModelProvider | ''
  selectedModel: string
  reasoningEffort: ReasoningEffort
  workspacePath: string
  disabled?: boolean
  attachmentDisabled?: boolean
  onPickAttachments: () => Promise<ChatAttachment[]>
  onPickWorkspace: () => Promise<string>
  onAttachmentsChange: (attachments: ChatAttachment[]) => void
  onWorkspaceChange: (workspacePath: string) => void | Promise<void>
  onModelChange: (provider: ModelProvider, model: string) => void
  onReasoningEffortChange: (effort: ReasoningEffort) => void
  onError: (message: string) => void
  onOpenAttachment?: (filePath: string) => void
}

const providerNames: Record<ModelProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  zai: 'GLM / 智谱',
  'kimi-coding-cn': 'Kimi',
  nous: 'Nous',
  custom: '自定义 API',
}

const reasoningOptions: { value: ReasoningEffort; label: string }[] = [
  { value: 'none', label: 'none' },
  { value: 'low', label: 'low' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' },
]

function configurationKey(provider: string, model: string) {
  return `${provider}\u241f${model}`
}

function finiteNonnegative(value?: number) {
  return Number.isFinite(value) ? Math.max(0, value || 0) : 0
}

function contextPercent(value?: number) {
  return Math.min(100, finiteNonnegative(value))
}

function compactTokens(rawValue: number) {
  const value = finiteNonnegative(rawValue)
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions.toFixed(Number.isInteger(millions) || value >= 10_000_000 ? 0 : 1)}M`
  }
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return Math.max(0, Math.round(value)).toLocaleString('zh-CN')
}

function usageLabel(usage?: ChatUsage) {
  if (!usage) return '等待首次响应'
  if (usage.contextMax > 0) return `${compactTokens(usage.contextUsed)} / ${compactTokens(usage.contextMax)} · ${Math.round(contextPercent(usage.contextPercent))}%`
  if (usage.contextUsed > 0) return `约 ${compactTokens(usage.contextUsed)} tokens`
  return '当前会话暂未返回用量'
}

function workspaceName(workspacePath: string) {
  const normalized = workspacePath.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).pop() || workspacePath
}

function AttachmentIcon({ attachment, size }: { attachment: ChatAttachment; size: number }) {
  const extension = attachment.name.split('.').pop()?.toLowerCase()
  if (extension === 'xlsx' || extension === 'xls') return <FileSpreadsheet size={size} />
  if (extension === 'pptx' || extension === 'ppt') return <Presentation size={size} />
  if (extension === 'html' || extension === 'htm' || extension === 'xhtml') return <Code2 size={size} />
  return attachment.kind === 'image' ? <ImageIcon size={size} /> : <FileText size={size} />
}

const imageThumbnailCache = new Map<string, Promise<string>>()

function imageAttachment(attachment: ChatAttachment) {
  return attachment.kind === 'image' || attachment.mimeType.startsWith('image/') || isImageDocumentPath(attachment.path || attachment.name)
}

function loadImageThumbnail(filePath: string) {
  const cached = imageThumbnailCache.get(filePath)
  if (cached) return cached
  const thumbnailApi = window.zsenseDesktop?.office.imageThumbnail
  if (!thumbnailApi) return Promise.reject(new Error('当前版本不支持图片缩略图。'))
  const pending = unwrapDesktop(thumbnailApi(filePath)).then((result) => result.dataUrl).catch((error) => {
    imageThumbnailCache.delete(filePath)
    throw error
  })
  imageThumbnailCache.set(filePath, pending)
  if (imageThumbnailCache.size > 200) imageThumbnailCache.delete(imageThumbnailCache.keys().next().value || '')
  return pending
}

function ChatImageThumbnail({ attachment, history = false }: { attachment: ChatAttachment; history?: boolean }) {
  const [thumbnailUrl, setThumbnailUrl] = useState('')
  useEffect(() => {
    let active = true
    setThumbnailUrl('')
    if (!attachment.path) return () => { active = false }
    void loadImageThumbnail(attachment.path).then((url) => { if (active) setThumbnailUrl(url) }).catch(() => undefined)
    return () => { active = false }
  }, [attachment.path])
  return <span className={`chat-image-thumbnail ${history ? 'history' : 'pending'} ${thumbnailUrl ? 'loaded' : 'loading'}`} aria-hidden={!thumbnailUrl}>
    {thumbnailUrl
      ? <img src={thumbnailUrl} alt={`图片附件 ${attachment.name} 的缩略图`} loading={history ? 'lazy' : 'eager'} draggable={false} />
      : <ImageIcon size={history ? 22 : 17} aria-hidden="true" />}
  </span>
}

export function ChatComposerToolbar({
  layout = 'toolbar',
  attachments,
  usage,
  savedModelConfigurations,
  selectedModelProvider,
  selectedModel,
  reasoningEffort,
  workspacePath,
  disabled = false,
  attachmentDisabled = disabled,
  onPickAttachments,
  onPickWorkspace,
  onAttachmentsChange,
  onWorkspaceChange,
  onModelChange,
  onReasoningEffortChange,
  onError,
  onOpenAttachment,
}: ChatComposerToolbarProps) {
  const [picking, setPicking] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [remoteWorkspaceOpen, setRemoteWorkspaceOpen] = useState(false)
  const modelOptions = useMemo(() => {
    const seen = new Set<string>()
    const options = savedModelConfigurations.filter((item) => item.model).filter((item) => {
      const key = configurationKey(item.provider, item.model)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (selectedModelProvider && selectedModel) {
      const key = configurationKey(selectedModelProvider, selectedModel)
      if (!seen.has(key)) options.unshift({ provider: selectedModelProvider, model: selectedModel, baseUrl: '', apiKeyName: '', apiKeyConfigured: false, updatedAt: '' })
    }
    return options
  }, [savedModelConfigurations, selectedModel, selectedModelProvider])
  const selectedKey = selectedModelProvider && selectedModel ? configurationKey(selectedModelProvider, selectedModel) : ''
  const selectedModelOption = modelOptions.find((item) => configurationKey(item.provider, item.model) === selectedKey)
  const selectedModelLabel = selectedModelOption ? `${providerNames[selectedModelOption.provider]} · ${selectedModelOption.model}` : '暂无可用模型'
  const selectedModelSummary = selectedModelOption?.model || '暂无模型'
  const effectiveUsage = useMemo<ChatUsage | undefined>(() => {
    const synchronizedContextMax = finiteNonnegative(selectedModelOption?.contextWindow)
    if (!usage && !synchronizedContextMax) return undefined
    const contextUsed = finiteNonnegative(usage?.contextUsed)
    const contextMax = synchronizedContextMax || finiteNonnegative(usage?.contextMax)
    return {
      contextUsed,
      contextMax,
      contextPercent: contextMax > 0 ? Math.min(contextUsed, contextMax) / contextMax * 100 : contextPercent(usage?.contextPercent),
      inputTokens: finiteNonnegative(usage?.inputTokens),
      outputTokens: finiteNonnegative(usage?.outputTokens),
      totalTokens: finiteNonnegative(usage?.totalTokens),
    }
  }, [selectedModelOption?.contextWindow, usage])
  const fullUsageLabel = usageLabel(effectiveUsage)
  const percent = contextPercent(effectiveUsage?.contextPercent)

  const pickAttachments = async () => {
    if (attachmentDisabled || picking) return
    setPicking(true)
    try {
      const picked = await onPickAttachments()
      if (!picked.length) return
      onAttachmentsChange(mergeChatAttachments(attachments, picked))
    } catch (error) {
      onError(error instanceof Error ? error.message : '选择附件失败。')
    } finally {
      setPicking(false)
    }
  }

  const pickWorkspace = async () => {
    if (disabled || pickingWorkspace) return
    if (window.zsenseDesktop?.transport === 'web-bridge') { setRemoteWorkspaceOpen(true); return }
    setPickingWorkspace(true)
    try {
      const selectedPath = await onPickWorkspace()
      if (selectedPath) await onWorkspaceChange(selectedPath)
    } catch (error) {
      onError(error instanceof Error ? error.message : '选择会话工作区失败。')
    } finally {
      setPickingWorkspace(false)
    }
  }

  return (
    <>
    <div className={`chat-composer-toolbar ${layout === 'composer' ? 'composer-layout' : ''}`}>
      <div className="chat-composer-toolbar-main">
        <button className="chat-attachment-button chat-compact-control" type="button" onClick={() => void pickAttachments()} disabled={attachmentDisabled || picking} aria-label={picking ? '正在选择附件' : `添加附件，当前已选择 ${attachments.length} 个`} data-tooltip="off">
          <span className="chat-control-summary attachment-summary" aria-hidden="true">
            {picking ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
          </span>
          <ChatComposerControlTooltip className="chat-attachment-detail">
            <small>添加附件</small>
            <strong>{picking ? '正在选择…' : attachments.length ? `已选择 ${attachments.length} 个文件` : '图片与文件'}</strong>
            <em>点击添加，单次最多 8 个附件</em>
          </ChatComposerControlTooltip>
        </button>

        <button
          className={`chat-workspace-button chat-compact-control ${workspacePath ? 'selected' : ''}`}
          type="button"
          onClick={() => void pickWorkspace()}
          disabled={disabled || pickingWorkspace}
          aria-label={workspacePath ? `更换会话工作区，当前为 ${workspacePath}` : '选择会话工作区'}
          data-tooltip="off"
        >
          <span className="chat-control-summary" aria-hidden="true">
            {pickingWorkspace ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
            <strong>{pickingWorkspace ? '正在选择…' : workspacePath ? workspaceName(workspacePath) : '选择文件夹'}</strong>
          </span>
          <ChatComposerControlTooltip className="chat-workspace-detail">
            <small>当前工作区</small>
            <strong>{pickingWorkspace ? '正在选择…' : workspacePath || '尚未指定工作区'}</strong>
            <em>点击可更换此会话的文件保存位置</em>
          </ChatComposerControlTooltip>
        </button>

        <label className={`chat-toolbar-select chat-reasoning-select chat-compact-control ${disabled ? 'is-disabled' : ''}`}>
          <span className="chat-control-summary" aria-hidden="true"><BrainCircuit size={14} /><strong>{reasoningEffort}</strong><ChevronDown className="chat-control-chevron" size={12} /></span>
          <select value={reasoningEffort} disabled={disabled} aria-label="设置当前会话推理强度" onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort)}>
            {reasoningOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <ChatComposerControlTooltip className="chat-reasoning-detail">
            <small>推理强度</small>
            <strong>{reasoningEffort}</strong>
            <em>点击可选择 none / low / high / max</em>
          </ChatComposerControlTooltip>
        </label>

        <label className={`chat-toolbar-select chat-model-select chat-compact-control ${disabled || !modelOptions.length ? 'is-disabled' : ''}`}>
          <span className="chat-control-summary" aria-hidden="true"><Cpu size={14} /><strong>{selectedModelSummary}</strong><ChevronDown className="chat-control-chevron" size={12} /></span>
          <select
            value={selectedKey}
            disabled={disabled || !modelOptions.length}
            aria-label="快速切换当前会话模型"
            onChange={(event) => {
              const selected = modelOptions.find((item) => configurationKey(item.provider, item.model) === event.target.value)
              if (selected) onModelChange(selected.provider, selected.model)
            }}
          >
            {!modelOptions.length && <option value="">暂无可用模型</option>}
            {modelOptions.map((item) => <option key={configurationKey(item.provider, item.model)} value={configurationKey(item.provider, item.model)}>{providerNames[item.provider]} · {item.model}</option>)}
          </select>
          <ChatComposerControlTooltip className="chat-model-detail">
            <small>当前模型</small>
            <strong>{selectedModelLabel}</strong>
            <em>点击可快速切换此会话使用的模型</em>
          </ChatComposerControlTooltip>
        </label>

        <div className="chat-context-usage chat-compact-control" tabIndex={0} role="progressbar" aria-label="上下文使用量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={fullUsageLabel}>
          <span className="chat-control-summary" aria-hidden="true">
            <svg className="chat-context-ring" width={22} height={22} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
              <circle className="chat-context-ring-track" cx={14} cy={14} r={10} />
              <circle className="chat-context-ring-value" cx={14} cy={14} r={10} pathLength={100} strokeDasharray={100} strokeDashoffset={100 - percent} opacity={percent > 0 ? 1 : 0} />
            </svg>
          </span>
          <ChatComposerControlTooltip className="chat-context-detail">
            <small>上下文使用量</small>
            <strong>{fullUsageLabel}</strong>
          </ChatComposerControlTooltip>
        </div>
      </div>

      {attachments.length > 0 && <div className="chat-attachment-list" aria-label="待发送附件">
        {attachments.map((attachment) => {
          const isImage = imageAttachment(attachment)
          return <span className={`chat-attachment-chip ${isImage ? 'image' : ''}`} key={attachment.id}>
            {isPreviewableDocumentPath(attachment.path || attachment.name) && attachment.path && onOpenAttachment ? <button className="chat-attachment-open" type="button" onClick={() => onOpenAttachment(attachment.path!)} disabled={attachmentDisabled} title={isImage ? '查看图片' : `在右侧打开 ${attachment.name}`} aria-label={`在右侧打开附件 ${attachment.name}`}>
              {isImage ? <ChatImageThumbnail attachment={attachment} /> : <AttachmentIcon attachment={attachment} size={13} />}
              {!isImage && <span><strong>{attachment.name}</strong></span>}
            </button> : <span className="chat-attachment-label" title={isImage ? undefined : attachment.name}>
              {isImage ? <ChatImageThumbnail attachment={attachment} /> : <AttachmentIcon attachment={attachment} size={13} />}
              {!isImage && <span>{attachment.name}</span>}
            </span>}
            <button type="button" onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== attachment.id))} disabled={attachmentDisabled} aria-label={`移除附件 ${attachment.name}`}><X size={12} /></button>
          </span>
        })}
      </div>}
    </div>
    {remoteWorkspaceOpen && <RemoteWorkspacePicker initialPath={workspacePath} onClose={() => setRemoteWorkspaceOpen(false)} onSelect={onWorkspaceChange} />}
    </>
  )
}

export function ChatMessageAttachments({ attachments = [], workspacePath = '', onOpenAttachment }: { attachments?: ChatAttachment[]; workspacePath?: string; onOpenAttachment?: (filePath: string) => void }) {
  if (!attachments.length) return null
  return <div className="chat-message-attachments" aria-label="消息附件">
    {attachments.map((attachment) => {
      const previewPath = isPreviewableDocumentPath(attachment.path || attachment.name) ? (attachment.path || previewableDocumentPathFromHref(attachment.name, workspacePath)) : ''
      if (previewPath && onOpenAttachment) return <button className={`chat-message-attachment ${imageAttachment(attachment) ? 'image' : 'office'}`} type="button" key={attachment.id} title={`在右侧打开 ${attachment.name}`} aria-label={`在右侧打开附件 ${attachment.name}`} onClick={() => onOpenAttachment(previewPath)}>
        {imageAttachment(attachment) ? <ChatImageThumbnail attachment={{ ...attachment, path: previewPath }} history /> : <AttachmentIcon attachment={attachment} size={14} />}
        <span><strong>{attachment.name}</strong>{imageAttachment(attachment) && <small>点击查看大图</small>}</span>
      </button>
      return <span className="chat-message-attachment" key={attachment.id} title={attachment.name}>
        <AttachmentIcon attachment={attachment} size={12} />
        <span>{attachment.name}</span>
      </span>
    })}
  </div>
}
