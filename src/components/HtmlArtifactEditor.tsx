import { AlignCenter, AlignLeft, AlignRight, Bold, Bot, CheckCircle2, Code2, Crop, History, ImagePlus, Italic, LoaderCircle, Palette, Redo2, Save, Underline, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { HtmlDocumentSession, OfficeDocumentState } from '../types'

type Feedback = { tone: 'success' | 'error'; message: string } | null

interface HtmlSelection {
  selector: string
  tag: string
  text: string
  dynamic: boolean
  style: {
    color: string
    backgroundColor: string
    fontSize: string
    fontWeight: string
    fontStyle: string
    textDecorationLine: string
    textAlign: string
  }
  image?: {
    src: string
    alt: string
    objectFit: string
    objectPosition: string
    borderRadius: string
    borderWidth: string
    borderColor: string
  }
}

interface HtmlArtifactEditorProps {
  document: OfficeDocumentState
  workspacePath?: string
  editing: boolean
  onDocumentChange: (document: OfficeDocumentState) => void
  onDirtyChange: (dirty: boolean) => void
  onFeedback: (feedback: Feedback) => void
  onAskAI?: (prompt: string, behavior: 'send' | 'insert') => void
}

const CHANNEL = 'zsense-html-editor-v1'

function relativeArtifactPath(filePath: string, workspacePath = '') {
  if (!workspacePath) return filePath
  const normalizedRoot = workspacePath.replace(/[\\/]+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedCompareRoot = normalizedRoot.replace(/\\/g, '/')
  return normalizedFile.startsWith(`${normalizedCompareRoot}/`) ? normalizedFile.slice(normalizedCompareRoot.length + 1) : filePath
}

function rgbToHex(value: string, fallback: string) {
  if (/^#[\da-f]{6}$/i.test(value)) return value
  if (/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(value.trim())) return fallback
  const match = value.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i)
  if (!match) return fallback
  return `#${match.slice(1, 4).map((item) => Math.max(0, Math.min(255, Number(item))).toString(16).padStart(2, '0')).join('')}`
}

function selectionFromMessage(data: Partial<HtmlSelection>): HtmlSelection | null {
  if (!data.selector || !data.tag || !data.style) return null
  return {
    selector: data.selector,
    tag: data.tag,
    text: data.text || '',
    dynamic: Boolean(data.dynamic),
    style: data.style,
    image: data.image,
  }
}

export function HtmlArtifactEditor({ document, workspacePath, editing, onDocumentChange, onDirtyChange, onFeedback, onAskAI }: HtmlArtifactEditorProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const clientIdRef = useRef(`html-editor-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`)
  const stageQueueRef = useRef<Promise<void>>(Promise.resolve())
  const latestSourceRef = useRef('')
  const stagedRevisionRef = useRef(0)
  const sourceRequestRef = useRef<{ id: string; resolve: (source: string) => void; reject: (reason: Error) => void; timeout: number } | null>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const aiInputRef = useRef<HTMLTextAreaElement>(null)
  const [session, setSession] = useState<HtmlDocumentSession | null>(null)
  const [selection, setSelection] = useState<HtmlSelection | null>(null)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [historyLength, setHistoryLength] = useState(0)
  const [changes, setChanges] = useState<{ id: string; summary: string; at: Date }[]>([])
  const [changesOpen, setChangesOpen] = useState(false)
  const [frameRevision, setFrameRevision] = useState(0)
  const [busy, setBusy] = useState<'loading' | 'saving' | ''>('loading')
  const [aiPrompt, setAiPrompt] = useState('')
  const [imagePicking, setImagePicking] = useState(false)
  const [bridgeState, setBridgeState] = useState<'connecting' | 'ready' | 'unavailable'>('connecting')

  const frameUrl = useMemo(() => `${document.previewUrl}${document.previewUrl.includes('?') ? '&' : '?'}editorRevision=${frameRevision}`, [document.previewUrl, frameRevision])

  const postToFrame = useCallback((type: string, detail: Record<string, unknown> = {}) => {
    iframeRef.current?.contentWindow?.postMessage({ channel: CHANNEL, type, ...detail }, '*')
  }, [])

  const requestFrameSource = useCallback(() => new Promise<string>((resolve, reject) => {
    if (!iframeRef.current?.contentWindow) {
      reject(new Error('HTML 预览尚未就绪。'))
      return
    }
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
    const timeout = window.setTimeout(() => {
      if (sourceRequestRef.current?.id !== id) return
      sourceRequestRef.current = null
      reject(new Error('未能读取预览中的最新 HTML，请等待预览加载完成后再保存。'))
    }, 2_500)
    sourceRequestRef.current = { id, resolve, reject, timeout }
    postToFrame('request-source', { requestId: id })
  }), [postToFrame])

  useEffect(() => () => {
    const pending = sourceRequestRef.current
    if (!pending) return
    window.clearTimeout(pending.timeout)
    pending.reject(new Error('HTML 编辑器已关闭。'))
    sourceRequestRef.current = null
  }, [])

  useEffect(() => {
    let cancelled = false
    setBusy('loading')
    setSelection(null)
    setChanges([])
    setChangesOpen(false)
    setAiPrompt('')
    unwrapDesktop(window.zsenseDesktop!.office.getHtml({ filePath: document.filePath })).then((nextSession) => {
      if (cancelled) return
      setSession(nextSession)
      latestSourceRef.current = nextSession.source
      stagedRevisionRef.current = nextSession.revision
      historyRef.current = [nextSession.source]
      historyIndexRef.current = 0
      setHistoryIndex(0)
      setHistoryLength(1)
      onDirtyChange(nextSession.dirty)
    }).catch((reason) => {
      if (!cancelled) onFeedback({ tone: 'error', message: `HTML 编辑器启动失败：${errorMessage(reason)}` })
    }).finally(() => {
      if (!cancelled) setBusy('')
    })
    return () => { cancelled = true }
  }, [document.filePath, onDirtyChange, onFeedback])

  useEffect(() => {
    postToFrame('set-editing', { enabled: editing })
    if (!editing) return
    setBridgeState((current) => current === 'ready' ? current : 'connecting')
    const timeout = window.setTimeout(() => setBridgeState((current) => current === 'ready' ? current : 'unavailable'), 2_500)
    return () => window.clearTimeout(timeout)
  }, [editing, frameRevision, postToFrame])

  useEffect(() => window.zsenseDesktop!.office.onSessionChanged((event) => {
    if (event.filePath !== document.filePath || event.sourceClientId === clientIdRef.current || event.source !== 'agent') return
    void unwrapDesktop(window.zsenseDesktop!.office.getHtml({ filePath: document.filePath })).then((nextSession) => {
      setSession(nextSession)
      latestSourceRef.current = nextSession.source
      stagedRevisionRef.current = nextSession.revision
      historyRef.current = [nextSession.source]
      historyIndexRef.current = 0
      setHistoryIndex(0)
      setHistoryLength(1)
      setChanges((items) => [...items, { id: `${Date.now()}-agent`, summary: 'AI 已更新 HTML 文件', at: new Date() }].slice(-80))
      setSelection(null)
      setFrameRevision((value) => value + 1)
      onDirtyChange(nextSession.dirty)
      onFeedback({ tone: 'success', message: 'AI 对 HTML 的修改已实时同步到右侧预览。' })
    }).catch((reason) => onFeedback({ tone: 'error', message: `HTML 刷新失败：${errorMessage(reason)}` }))
  }), [document.filePath, onDirtyChange, onFeedback])

  const stageSource = useCallback((source: string, summary: string, recordHistory: boolean) => {
    if (!source.trim()) return Promise.reject(new Error('HTML 内容不能为空。'))
    latestSourceRef.current = source
    if (recordHistory) {
      const current = historyRef.current[historyIndexRef.current]
      if (current !== source) {
        historyRef.current = [...historyRef.current.slice(0, historyIndexRef.current + 1), source].slice(-60)
        historyIndexRef.current = historyRef.current.length - 1
        setHistoryIndex(historyIndexRef.current)
        setHistoryLength(historyRef.current.length)
      }
      setChanges((items) => [...items, { id: `${Date.now()}-${Math.random()}`, summary, at: new Date() }].slice(-80))
    }
    const operation = stageQueueRef.current.catch(() => undefined).then(async () => {
      const result = await unwrapDesktop(window.zsenseDesktop!.office.stageHtml({ filePath: document.filePath, source, clientId: clientIdRef.current }))
      stagedRevisionRef.current = result.revision
      setSession((current) => current ? { ...current, source, revision: result.revision, dirty: result.dirty, pendingCount: result.pendingCount } : current)
      onDirtyChange(result.dirty)
    })
    stageQueueRef.current = operation
    void operation.catch((reason) => {
      onDirtyChange(true)
      onFeedback({ tone: 'error', message: `HTML 实时同步失败：${errorMessage(reason)}` })
    })
    return operation
  }, [document.filePath, onDirtyChange, onFeedback])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data as { channel?: string; type?: string; source?: string; summary?: string; requestId?: string } & Partial<HtmlSelection>
      if (data?.channel !== CHANNEL) return
      setBridgeState('ready')
      if (data.type === 'ready') { postToFrame('set-editing', { enabled: editing }); return }
      if (data.type === 'source' && typeof data.source === 'string' && data.requestId === sourceRequestRef.current?.id) {
        const pending = sourceRequestRef.current
        if (!pending) return
        sourceRequestRef.current = null
        window.clearTimeout(pending.timeout)
        pending.resolve(data.source)
        return
      }
      if (data.type === 'selection') {
        const nextSelection = selectionFromMessage(data)
        if (nextSelection) setSelection(nextSelection)
        return
      }
      if (data.type === 'changed' && typeof data.source === 'string') {
        stageSource(data.source, data.summary || '修改 HTML 元素', true)
        return
      }
      if (data.type === 'ask-ai') {
        setSelection((current) => current || selectionFromMessage(data))
        window.requestAnimationFrame(() => aiInputRef.current?.focus())
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [editing, postToFrame, stageSource])

  const restoreHistory = async (nextIndex: number) => {
    const source = historyRef.current[nextIndex]
    if (typeof source !== 'string') return
    historyIndexRef.current = nextIndex
    setHistoryIndex(nextIndex)
    stageSource(source, nextIndex < historyIndex ? '撤销 HTML 修改' : '重做 HTML 修改', false)
    await stageQueueRef.current
    setFrameRevision((value) => value + 1)
    setSelection(null)
  }

  const save = async () => {
    if (busy || !session?.dirty) return
    setBusy('saving')
    try {
      const frameSource = await requestFrameSource()
      await stageSource(frameSource, '保存前同步 HTML', false)
      while (true) {
        const pending = stageQueueRef.current
        await pending
        if (pending === stageQueueRef.current) break
      }
      const source = latestSourceRef.current
      const expectedRevision = stagedRevisionRef.current
      const result = await unwrapDesktop(window.zsenseDesktop!.office.saveHtml({ filePath: document.filePath, source, expectedRevision, clientId: clientIdRef.current }))
      if (result.document) onDocumentChange({ ...result.document, previewUrl: document.previewUrl })
      latestSourceRef.current = source
      stagedRevisionRef.current = result.revision
      setSession((current) => current ? { ...current, dirty: false, pendingCount: 0, revision: result.revision } : current)
      onDirtyChange(false)
      onFeedback({ tone: 'success', message: result.message })
    } catch (reason) {
      onFeedback({ tone: 'error', message: `HTML 保存失败：${errorMessage(reason)}` })
    } finally {
      setBusy('')
    }
  }

  const askAI = (behavior: 'send' | 'insert') => {
    if (!selection || !aiPrompt.trim() || !onAskAI) return
    const file = relativeArtifactPath(document.filePath, workspacePath)
    const elementOrigin = selection.dynamic ? '该元素由 JavaScript 动态生成，请修改生成它的 HTML/CSS/JavaScript 源码，不要把运行后的 DOM 快照写回文件。' : '该元素是静态 HTML 元素。'
    const prompt = `请编辑当前工作区中的 HTML 文件“${file}”。目标元素：${selection.selector}（${selection.tag}）。当前文字：${selection.text || '无文字'}。${elementOrigin} 修改要求：${aiPrompt.trim()}。请先读取文件，只修改这个元素及完成要求所必需的相关 CSS/JavaScript，并保留其他内容；完成后直接写回该文件。不要生成 diff 审阅内容，直接完成文件修改。`
    onAskAI(prompt, behavior)
    if (behavior === 'send') setAiPrompt('')
  }

  const pickReplacementImage = async () => {
    if (imagePicking || !window.zsenseDesktop) return
    if (typeof window.zsenseDesktop.office.pickHtmlImage !== 'function') {
      onFeedback({ tone: 'error', message: 'HTML 图片编辑桥接版本不一致。请完全退出 ZSense 后重新打开新版应用。' })
      return
    }
    setImagePicking(true)
    try {
      const picked = await unwrapDesktop(window.zsenseDesktop.office.pickHtmlImage())
      if (picked) postToFrame('set-image-source', picked)
    } catch (reason) {
      onFeedback({ tone: 'error', message: `替换图片失败：${errorMessage(reason)}` })
    } finally {
      setImagePicking(false)
    }
  }

  return (
    <section className={`html-artifact-editor ${editing ? 'editing' : ''}`} aria-label="HTML 隔离预览和编辑器">
      <header className="html-editor-commandbar">
        <span><Code2 size={15} /><strong>{editing ? '可视化编辑' : '隔离预览'}</strong><small>{editing ? bridgeState === 'ready' ? '编辑桥接已连接' : bridgeState === 'unavailable' ? '编辑桥接未连接' : '正在连接编辑桥接…' : session?.dirty ? '有未保存修改' : '已与磁盘同步'}</small></span>
        <div>
          <button type="button" onClick={() => void restoreHistory(historyIndex - 1)} disabled={!editing || historyIndex <= 0 || Boolean(busy)} title="撤销" aria-label="撤销 HTML 修改"><Undo2 size={15} /></button>
          <button type="button" onClick={() => void restoreHistory(historyIndex + 1)} disabled={!editing || historyIndex < 0 || historyIndex >= historyLength - 1 || Boolean(busy)} title="重做" aria-label="重做 HTML 修改"><Redo2 size={15} /></button>
          <button className={changesOpen ? 'active' : ''} type="button" onClick={() => setChangesOpen((value) => !value)} disabled={!editing} title="查看变更" aria-label="查看 HTML 变更"><History size={15} /><span>变更</span></button>
          <button className="html-save-button" type="button" onClick={() => void save()} disabled={!session?.dirty || Boolean(busy)} title="保存到原文件">{busy === 'saving' ? <LoaderCircle className="spin" size={14} /> : session?.dirty ? <Save size={14} /> : <CheckCircle2 size={14} />}<span>{busy === 'saving' ? '保存中' : session?.dirty ? '保存' : '已保存'}</span></button>
        </div>
      </header>

      <div className="html-editor-workspace">
        <section className="html-preview-shell" aria-label={`${document.name} 页面预览`}>
          {busy === 'loading' && <div className="html-editor-loading"><LoaderCircle className="spin" size={22} /><span>正在启动隔离预览…</span></div>}
          <iframe
            ref={iframeRef}
            key={frameUrl}
            src={frameUrl}
            sandbox="allow-scripts allow-forms allow-modals"
            title={`${document.name} HTML 隔离预览`}
            onLoad={() => {
              setBridgeState('connecting')
              postToFrame('set-editing', { enabled: editing })
            }}
          />
        </section>

        {editing && <aside className="html-inspector" aria-label="HTML 元素编辑工具">
          <header>
            <span><Bot size={16} /><strong>{selection ? `已选择 <${selection.tag}>` : '选择页面元素'}</strong>{selection && <em className={selection.dynamic ? 'dynamic' : 'static'}>{selection.dynamic ? '动态元素' : '静态元素'}</em>}</span>
            <small>{selection?.selector || '点击预览中的元素开始编辑；静态文字可双击直接修改。'}</small>
          </header>

          {bridgeState === 'unavailable' ? <div className="html-inspector-empty error"><Code2 size={24} /><p>页面预览已打开，但编辑桥接没有响应。请关闭右侧文件后重新打开。</p></div> : selection ? <>
            {selection.dynamic ? <div className="html-dynamic-notice" role="note"><Code2 size={16} /><span><strong>这是 JavaScript 动态元素</strong><small>为避免破坏页面逻辑，只提供 AI 编辑。AI 会修改生成该元素的源代码。</small></span></div> : selection.image ? <section className="html-manual-panel" aria-label="图片手动编辑">
              <header><ImagePlus size={16} /><span><strong>图片</strong><small>替换图片、调整裁剪方式与边框</small></span></header>
              <button className="button secondary small html-image-replace" type="button" onClick={() => void pickReplacementImage()} disabled={imagePicking}>{imagePicking ? <LoaderCircle className="spin" size={14} /> : <ImagePlus size={14} />}{imagePicking ? '正在选择…' : '替换本地图片'}</button>
              <label htmlFor="html-image-alt"><span>图片说明</span><input id="html-image-alt" type="text" value={selection.image.alt} onChange={(event) => setSelection({ ...selection, image: { ...selection.image!, alt: event.target.value } })} placeholder="用于无障碍阅读的图片说明" /></label>
              <button className="button secondary small" type="button" onClick={() => postToFrame('set-image-alt', { value: selection.image?.alt || '' })}>应用图片说明</button>
              <div className="html-panel-heading"><Crop size={14} /><strong>裁剪与填充</strong></div>
              <div className="html-style-grid two-column">
                <label htmlFor="html-image-fit"><span>填充方式</span><select id="html-image-fit" value={selection.image.objectFit || 'fill'} onChange={(event) => postToFrame('apply-image-style', { property: 'objectFit', value: event.target.value })}><option value="cover">裁剪填满</option><option value="contain">完整显示</option><option value="fill">拉伸填满</option><option value="none">原始尺寸</option></select></label>
                <label htmlFor="html-image-position"><span>裁剪焦点</span><select id="html-image-position" value={selection.image.objectPosition || '50% 50%'} onChange={(event) => postToFrame('apply-image-style', { property: 'objectPosition', value: event.target.value })}><option value="50% 50%">居中</option><option value="50% 0%">顶部</option><option value="50% 100%">底部</option><option value="0% 50%">左侧</option><option value="100% 50%">右侧</option></select></label>
              </div>
              <div className="html-panel-heading"><Palette size={14} /><strong>图片边框</strong></div>
              <div className="html-style-grid three-column">
                <label htmlFor="html-image-border-width"><span>粗细</span><select id="html-image-border-width" value={selection.image.borderWidth || '0px'} onChange={(event) => postToFrame('apply-image-style', { property: 'borderWidth', value: event.target.value })}>{['0px', '1px', '2px', '3px', '4px', '6px', '8px'].map((value) => <option key={value}>{value}</option>)}</select></label>
                <label htmlFor="html-image-border-radius"><span>圆角</span><select id="html-image-border-radius" value={selection.image.borderRadius || '0px'} onChange={(event) => postToFrame('apply-image-style', { property: 'borderRadius', value: event.target.value })}>{['0px', '4px', '8px', '12px', '16px', '24px', '999px'].map((value) => <option key={value}>{value}</option>)}</select></label>
                <label htmlFor="html-image-border-color"><span>颜色</span><input id="html-image-border-color" type="color" value={rgbToHex(selection.image.borderColor, '#2563eb')} onChange={(event) => postToFrame('apply-image-style', { property: 'borderColor', value: event.target.value })} /></label>
              </div>
            </section> : <section className="html-manual-panel" aria-label="静态元素手动编辑">
              <header><Palette size={16} /><span><strong>手动编辑</strong><small>即时更新到本地编辑会话，不消耗 AI 用量</small></span></header>
              <label htmlFor="html-element-text"><span>元素文字</span><textarea id="html-element-text" rows={4} value={selection.text} onChange={(event) => setSelection({ ...selection, text: event.target.value })} /></label>
              <button className="button secondary small" type="button" onClick={() => postToFrame('set-text', { value: selection.text })}>应用文字</button>

              <div className="html-format-buttons" aria-label="文字样式">
                <button className={/^(bold|[6-9]00)$/i.test(selection.style.fontWeight) ? 'active' : ''} type="button" onClick={() => postToFrame('apply-style', { property: 'fontWeight', value: /^(bold|[6-9]00)$/i.test(selection.style.fontWeight) ? '400' : '700' })} aria-pressed={/^(bold|[6-9]00)$/i.test(selection.style.fontWeight)}><Bold size={15} /><span>加粗</span></button>
                <button className={selection.style.fontStyle === 'italic' ? 'active' : ''} type="button" onClick={() => postToFrame('apply-style', { property: 'fontStyle', value: selection.style.fontStyle === 'italic' ? 'normal' : 'italic' })} aria-pressed={selection.style.fontStyle === 'italic'}><Italic size={15} /><span>斜体</span></button>
                <button className={selection.style.textDecorationLine.includes('underline') ? 'active' : ''} type="button" onClick={() => postToFrame('apply-style', { property: 'textDecoration', value: selection.style.textDecorationLine.includes('underline') ? 'none' : 'underline' })} aria-pressed={selection.style.textDecorationLine.includes('underline')}><Underline size={15} /><span>下划线</span></button>
              </div>

              <div className="html-style-grid three-column">
                <label htmlFor="html-font-size"><span>字号</span><select id="html-font-size" value={selection.style.fontSize} onChange={(event) => postToFrame('apply-style', { property: 'fontSize', value: event.target.value })}>{!["12px", "14px", "16px", "18px", "20px", "24px", "32px", "40px", "48px"].includes(selection.style.fontSize) && <option value={selection.style.fontSize}>{selection.style.fontSize}</option>}{['12px', '14px', '16px', '18px', '20px', '24px', '32px', '40px', '48px'].map((value) => <option key={value}>{value}</option>)}</select></label>
                <label htmlFor="html-text-color"><span>文字颜色</span><input id="html-text-color" type="color" value={rgbToHex(selection.style.color, '#172033')} onChange={(event) => postToFrame('apply-style', { property: 'color', value: event.target.value })} /></label>
                <label htmlFor="html-background-color"><span>背景颜色</span><input id="html-background-color" type="color" value={rgbToHex(selection.style.backgroundColor, '#ffffff')} onChange={(event) => postToFrame('apply-style', { property: 'backgroundColor', value: event.target.value })} /></label>
              </div>

              <div className="html-align-buttons" aria-label="文字对齐">
                <button className={selection.style.textAlign === 'left' || selection.style.textAlign === 'start' ? 'active' : ''} type="button" onClick={() => postToFrame('apply-style', { property: 'textAlign', value: 'left' })} aria-label="左对齐" title="左对齐"><AlignLeft size={15} /></button>
                <button className={selection.style.textAlign === 'center' ? 'active' : ''} type="button" onClick={() => postToFrame('apply-style', { property: 'textAlign', value: 'center' })} aria-label="居中" title="居中"><AlignCenter size={15} /></button>
                <button className={selection.style.textAlign === 'right' || selection.style.textAlign === 'end' ? 'active' : ''} type="button" onClick={() => postToFrame('apply-style', { property: 'textAlign', value: 'right' })} aria-label="右对齐" title="右对齐"><AlignRight size={15} /></button>
              </div>
            </section>}

            <section className="html-ai-edit-card">
              <header><Bot size={16} /><span><strong>AI 编辑当前元素</strong><small>{selection.dynamic ? '将定位生成该元素的 JavaScript 并修改源代码' : 'AI 会读取并修改当前工作区中的原始 HTML'}</small></span></header>
              <label htmlFor="html-ai-prompt"><span>修改要求</span><textarea ref={aiInputRef} id="html-ai-prompt" rows={4} value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="例如：改成蓝色渐变按钮，并增加悬浮动画" /></label>
              <div><button className="button secondary small" type="button" onClick={() => askAI('insert')} disabled={!aiPrompt.trim() || !onAskAI}>添加到输入框</button><button className="button primary small" type="button" onClick={() => askAI('send')} disabled={!aiPrompt.trim() || !onAskAI}>直接发送</button></div>
            </section>
          </> : <div className="html-inspector-empty"><Code2 size={24} /><p>单击页面元素后，这里会显示手动编辑和 AI 编辑功能。JavaScript 动态元素只提供 AI 编辑。</p></div>}
        </aside>}

        {editing && changesOpen && <aside className="html-change-panel" aria-label="HTML 变更记录">
          <header><strong>本次变更</strong><small>{changes.length} 项 · 最多保留 80 项</small></header>
          {changes.length ? <ol>{[...changes].reverse().map((item) => <li key={item.id}><span>{item.summary}</span><time>{item.at.toLocaleTimeString('zh-CN', { hour12: false })}</time></li>)}</ol> : <div><History size={22} /><span>还没有修改记录</span></div>}
        </aside>}
      </div>
    </section>
  )
}
