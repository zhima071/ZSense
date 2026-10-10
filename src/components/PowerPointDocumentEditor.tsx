import { Check, ChevronLeft, ChevronRight, LoaderCircle, Save, Sparkles, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { PresentationElement, PresentationOperation, PresentationSession } from '../services/presentation-types'
import type { OfficeDocumentState } from '../types'
import './PowerPointDocumentEditor.css'

const CHANNEL = 'zsense-presentation-editor-v1'
interface Props {
  document: OfficeDocumentState
  workspacePath?: string
  editing: boolean
  onDocumentChange: (document: OfficeDocumentState) => void
  onFeedback: (feedback: { tone: 'success' | 'error'; message: string } | null) => void
  onDirtyChange: (dirty: boolean) => void
  onAskAI?: (prompt: string, behavior: 'send' | 'insert') => void
}
type ElementFields = Pick<PresentationElement, 'text' | 'x' | 'y' | 'width' | 'height'>
const emptyFields: ElementFields = { text: '', x: '', y: '', width: '', height: '' }
type SessionVersion = Pick<PresentationSession, 'sessionId' | 'sessionRevision' | 'baseContentHash'>
const sameVersion = (left: SessionVersion | null, right: SessionVersion) => left?.sessionId === right.sessionId && left.sessionRevision === right.sessionRevision && left.baseContentHash === right.baseContentHash
const STALE_DRAFT = 'PowerPoint 已被其他编辑器或 AI 修改。当前草稿仍保留，不能写回旧版本；请先复制需要保留的内容，再点击放弃修改重新读取。'

export function PowerPointDocumentEditor({ document, workspacePath, editing, onDocumentChange, onFeedback, onDirtyChange, onAskAI }: Props) {
  const [session, setSession] = useState<PresentationSession | null>(null)
  const sessionRef = useRef(session)
  const [busy, setBusy] = useState('open')
  const busyRef = useRef(busy)
  const [slideIndex, setSlideIndex] = useState(1)
  const [selectedPath, setSelectedPath] = useState('')
  const selectedPathRef = useRef('')
  selectedPathRef.current = selectedPath
  const [fields, setFields] = useState<ElementFields>(emptyFields)
  const fieldsRef = useRef(fields)
  const [formDirty, setFormDirty] = useState(false)
  const formDirtyRef = useRef(false)
  const formEditVersion = useRef(0)
  const draftBase = useRef<SessionVersion | null>(null)
  const [syncConflict, setSyncConflict] = useState('')
  const syncConflictRef = useRef('')
  const [syncPending, setSyncPending] = useState(false)
  const syncPendingRef = useRef(false)
  const readSequence = useRef(0)
  const externalVersion = useRef<{ sessionId: string; revision: number } | null>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const previewReadyRef = useRef(false)
  const [zoom, setZoom] = useState(100)
  const [requirement, setRequirement] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)
  const mounted = useRef(true)
  const callbacks = useRef({ onDocumentChange, onFeedback, onDirtyChange })
  callbacks.current = { onDocumentChange, onFeedback, onDirtyChange }
  const queue = useRef(Promise.resolve())
  const clientId = useRef(`ppt-editor-${crypto.randomUUID()}`)
  const selected = session?.slides.flatMap((slide) => slide.elements).find((element) => element.path === selectedPath)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const post = useCallback((type: string, detail: Record<string, unknown> = {}) => { frame.current?.contentWindow?.postMessage({ channel: CHANNEL, type, ...detail }, '*') }, [])
  const markBusy = useCallback((value: string) => { busyRef.current = value; setBusy(value) }, [])
  const retainDraftConflict = useCallback(() => {
    syncConflictRef.current = STALE_DRAFT; setSyncConflict(STALE_DRAFT)
    callbacks.current.onDirtyChange(true)
    post('configure', { editing: false, path: selectedPathRef.current })
  }, [post])
  const clearForm = useCallback(() => {
    formEditVersion.current += 1; draftBase.current = null; formDirtyRef.current = false; setFormDirty(false)
  }, [])
  const replaceFields = useCallback((value: ElementFields) => { fieldsRef.current = value; setFields(value) }, [])
  const enqueue = useCallback((action: () => Promise<void>) => {
    const next = queue.current.catch(() => {}).then(action)
    queue.current = next
    return next
  }, [])
  const adopt = useCallback((next: PresentationSession) => {
    if (!mounted.current) return false
    const current = sessionRef.current
    const external = externalVersion.current
    if (current?.sessionId === next.sessionId && next.sessionRevision < current.sessionRevision) return false
    if (external?.sessionId === next.sessionId && next.sessionRevision < external.revision) return false
    if (current?.document.previewUrl !== next.document.previewUrl) { previewReadyRef.current = false; setPreviewReady(false) }
    sessionRef.current = next; setSession(next)
    callbacks.current.onDocumentChange(next.document)
    callbacks.current.onDirtyChange(next.dirty || formDirtyRef.current || Boolean(syncConflictRef.current))
    return true
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (sessionRef.current?.filePath === document.filePath && sessionRef.current.document.modifiedAt === document.modifiedAt) return
    let cancelled = false
    const sequence = ++readSequence.current
    void enqueue(async () => {
      if (cancelled || !mounted.current) return
      markBusy('open')
      try {
        const next = await unwrapDesktop(window.zsenseDesktop!.office.getPresentation({ filePath: document.filePath }))
        if (cancelled || !mounted.current || sequence !== readSequence.current) return
        if ((formDirtyRef.current || sessionRef.current?.dirty) && sessionRef.current && (!sameVersion(sessionRef.current, next) || next.conflict)) retainDraftConflict()
        else adopt(next)
      } catch (error) { if (!cancelled && mounted.current && sequence === readSequence.current) callbacks.current.onFeedback({ tone: 'error', message: errorMessage(error) }) }
      finally { if (!cancelled && mounted.current) markBusy('') }
    })
    return () => { cancelled = true }
  }, [document.filePath, document.modifiedAt, adopt, enqueue, markBusy, retainDraftConflict])

  const stage = useCallback((path: string, properties: PresentationOperation['properties'], draft?: { version: number; base: SessionVersion }) => {
    return enqueue(async () => {
      if (!mounted.current || !sessionRef.current || !window.zsenseDesktop) return
      const current = sessionRef.current
      if (syncConflictRef.current || syncPendingRef.current || (draft && !sameVersion(draft.base, current))) { retainDraftConflict(); return }
      markBusy('apply'); post('configure', { editing: false, path: selectedPathRef.current }); callbacks.current.onDirtyChange(true)
      try {
        const operations = current.operations.map((operation) => ({ ...operation, properties: { ...operation.properties } }))
        const existing = operations.find((operation) => operation.path === path)
        if (existing) Object.assign(existing.properties, properties)
        else operations.push({ path, properties })
        const next = await unwrapDesktop(window.zsenseDesktop.office.stagePresentation({ filePath: current.filePath, operations,
          expectedContentHash: current.baseContentHash, expectedRevision: current.sessionRevision, clientId: clientId.current }))
        if (!mounted.current) return
        // Acknowledge only the submitted snapshot, not newer edits or a draft
        // entered on another element while the response was in flight.
        if (syncConflictRef.current || !adopt(next)) { retainDraftConflict(); return }
        if (draft && selectedPathRef.current === path && formEditVersion.current === draft.version) {
          clearForm(); callbacks.current.onDirtyChange(next.dirty)
        }
        if (formDirtyRef.current) draftBase.current = next
        callbacks.current.onFeedback({ tone: 'success', message: '修改已应用到本地工作副本，点击保存才会写回原文件。' })
      } catch (reason) {
        if (mounted.current) callbacks.current.onFeedback({ tone: 'error', message: errorMessage(reason) })
      } finally { if (mounted.current) markBusy('') }
    })
  }, [adopt, clearForm, enqueue, markBusy, post, retainDraftConflict])
  useEffect(() => {
    if (formDirtyRef.current) return
    replaceFields(selected ? { text: selected.text, x: selected.x, y: selected.y, width: selected.width, height: selected.height } : emptyFields)
  }, [selected, replaceFields])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== CHANNEL) return
      const data = event.data
      // Changing src preserves contentWindow; old frame events cannot submit
      // geometry calculated from the previous slide snapshot.
      if (data.previewRevision !== sessionRef.current?.previewRevision) return
      if (data.type === 'ready') {
        previewReadyRef.current = true; setPreviewReady(true)
        post('configure', { editing: editing && !busyRef.current && !syncConflictRef.current && !syncPendingRef.current, path: selectedPathRef.current }); post('zoom', { value: zoom }); post('navigate', { slideIndex })
      }
      if (data.type === 'selection' && typeof data.path === 'string' && sessionRef.current?.slides.some((slide) => slide.elements.some((element) => element.path === data.path))) {
        // Selecting another element must not silently throw away an un-applied draft.
        if (formDirtyRef.current && data.path !== selectedPathRef.current && !window.confirm('当前元素还有未应用的修改，确定放弃并选择其他元素吗？')) { post('configure', { editing: editing && !busyRef.current && previewReadyRef.current && !syncPendingRef.current && !syncConflictRef.current, path: selectedPathRef.current }); return }
        if (data.path !== selectedPathRef.current) { clearForm(); callbacks.current.onDirtyChange(Boolean(sessionRef.current?.dirty || syncConflictRef.current)) }
        selectedPathRef.current = data.path; setSelectedPath(data.path); setSlideIndex(data.slideIndex)
      }
      if (data.type === 'slide' && Number.isInteger(data.slideIndex) && sessionRef.current?.slides.some((slide) => slide.index === data.slideIndex)) {
        if (data.cause === 'scroll' && selectedPathRef.current) return
        if (data.slideIndex !== slideIndex && selectedPathRef.current && !selectedPathRef.current.startsWith(`/slide[${data.slideIndex}]/`)) {
          if (formDirtyRef.current && !window.confirm('当前元素还有未应用的修改，确定放弃并切换幻灯片吗？')) { post('navigate', { slideIndex }); return }
          clearForm(); selectedPathRef.current = ''; setSelectedPath(''); callbacks.current.onDirtyChange(Boolean(sessionRef.current?.dirty || syncConflictRef.current))
        }
        setSlideIndex(data.slideIndex)
      }
      if (data.type === 'geometry' && editing && typeof data.path === 'string' && data.properties && sessionRef.current?.slides.some((slide) => slide.elements.some((element) => element.path === data.path))) {
        if (busyRef.current || !previewReadyRef.current || syncPendingRef.current || syncConflictRef.current) return
        if (formDirtyRef.current && selectedPathRef.current === data.path) { formEditVersion.current += 1; replaceFields({ ...fieldsRef.current, ...data.properties }); return }
        void stage(data.path, data.properties)
      }
      if (data.type === 'zoom' && Number.isFinite(data.value)) setZoom(Math.max(50, Math.min(200, data.value)))
      if (data.type === 'save' && !busyRef.current) void save()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [editing, post, slideIndex, stage, zoom, busy, clearForm, replaceFields])
  useEffect(() => { post('configure', { editing: editing && !busy && previewReady && !syncPending && !syncConflict, path: selectedPath }) }, [editing, post, selectedPath, busy, previewReady, syncPending, syncConflict])
  useEffect(() => { post('zoom', { value: zoom }) }, [zoom, post])
  useEffect(() => window.zsenseDesktop?.office.onSessionChanged((event) => {
    if (event.filePath !== document.filePath || event.sourceClientId === clientId.current || !mounted.current) return
    const sequence = ++readSequence.current
    if (!externalVersion.current || externalVersion.current.sessionId !== event.sessionId || event.revision > externalVersion.current.revision) externalVersion.current = { sessionId: event.sessionId, revision: event.revision }
    syncPendingRef.current = true; setSyncPending(true)
    post('configure', { editing: false, path: selectedPathRef.current })
    void enqueue(async () => {
      if (!mounted.current) return
      try {
        const next = await unwrapDesktop(window.zsenseDesktop!.office.getPresentation({ filePath: document.filePath }))
        if (!mounted.current || sequence !== readSequence.current) return
        // Never diff old inspector fields against a new external snapshot:
        // untouched old x/y/size values would revert its geometry.
        if (syncConflictRef.current || ((formDirtyRef.current || sessionRef.current?.dirty) && sessionRef.current && (!sameVersion(sessionRef.current, next) || next.conflict))) retainDraftConflict()
        else adopt(next)
      } catch (reason) { if (mounted.current && sequence === readSequence.current) { retainDraftConflict(); callbacks.current.onFeedback({ tone: 'error', message: errorMessage(reason) }) } }
      finally { if (mounted.current && sequence === readSequence.current) { syncPendingRef.current = false; setSyncPending(false) } }
    })
  }), [document.filePath, adopt, enqueue, post, retainDraftConflict])

  const editField = (key: keyof ElementFields, value: string) => {
    if (!formDirtyRef.current) draftBase.current = sessionRef.current
    formEditVersion.current += 1; replaceFields({ ...fieldsRef.current, [key]: value }); formDirtyRef.current = true; setFormDirty(true); callbacks.current.onDirtyChange(true)
  }
  const applyForm = async () => {
    const target = selectedRef.current
    if (!target || !formDirtyRef.current) return
    if (syncConflictRef.current || syncPendingRef.current || !sessionRef.current || !sameVersion(draftBase.current, sessionRef.current)) { retainDraftConflict(); return }
    const properties: PresentationOperation['properties'] = {}
    for (const key of ['text', 'x', 'y', 'width', 'height'] as const) if (fieldsRef.current[key] !== target[key] && (key !== 'text' || target.textEditable)) properties[key] = fieldsRef.current[key]
    if (Object.keys(properties).length) await stage(target.path, properties, { version: formEditVersion.current, base: sessionRef.current })
    else { clearForm(); callbacks.current.onDirtyChange(Boolean(sessionRef.current?.dirty)) }
  }
  const save = async () => {
    if (syncConflictRef.current || syncPendingRef.current) return
    await applyForm()
    await enqueue(async () => {
      const current = sessionRef.current
      if (!mounted.current || !current || !window.zsenseDesktop || formDirtyRef.current || syncConflictRef.current || syncPendingRef.current) return
      markBusy('save'); post('configure', { editing: false, path: selectedPathRef.current })
      try {
        const next = await unwrapDesktop(window.zsenseDesktop.office.savePresentation({ filePath: current.filePath, expectedContentHash: current.baseContentHash,
          expectedRevision: current.sessionRevision, clientId: clientId.current }))
        if (syncConflictRef.current || !adopt(next)) return
        if (formDirtyRef.current) draftBase.current = next
        if (mounted.current) callbacks.current.onFeedback({ tone: 'success', message: next.message || 'PowerPoint 已保存。' })
      } catch (reason) { if (mounted.current) callbacks.current.onFeedback({ tone: 'error', message: errorMessage(reason) }) }
      finally { if (mounted.current) markBusy('') }
    })
  }
  const discard = async () => {
    if (!window.zsenseDesktop || !window.confirm('确定放弃当前所有未保存的 PowerPoint 修改吗？')) return
    const version = formEditVersion.current
    await enqueue(async () => {
      if (!mounted.current) return
      markBusy('discard')
      try {
        const next = await unwrapDesktop(window.zsenseDesktop!.office.discardPresentation({ filePath: document.filePath, clientId: clientId.current }))
        if (!mounted.current) return
        if (formDirtyRef.current && version !== formEditVersion.current) { retainDraftConflict(); return }
        clearForm(); syncConflictRef.current = ''; setSyncConflict(''); externalVersion.current = null
        adopt(next)
      } catch (reason) { if (mounted.current) callbacks.current.onFeedback({ tone: 'error', message: errorMessage(reason) }) }
      finally { if (mounted.current) markBusy('') }
    })
  }
  const askAI = async () => {
    if (!onAskAI || !requirement.trim() || !sessionRef.current || syncConflictRef.current || syncPendingRef.current) return
    if (sessionRef.current.dirty || formDirtyRef.current) {
      if (!window.confirm('AI 编辑前需要先保存你的手动修改。是否保存并继续？')) return
      await save(); if (sessionRef.current?.dirty || formDirtyRef.current || syncConflictRef.current) return
    }
    const current = sessionRef.current
    const target = selectedRef.current
    const scope = target?.path || `/slide[${slideIndex}]`
    onAskAI(`请编辑这个 PowerPoint 文件：${current.filePath}\n${workspacePath ? `工作区：${workspacePath}\n` : ''}编辑范围：${scope}（${target ? '仅选中的元素' : '仅当前幻灯片'}）\n原文件版本：${current.baseContentHash}\n${target?.text ? `当前文字：${target.text.slice(0, 5000)}\n` : ''}要求：${requirement.trim()}\n请使用 officecli，先读取当前文件确认目标路径仍存在，只修改上述范围，不要覆盖其他幻灯片或元素。保存并验证后再说明结果。`, 'send')
    setRequirement('')
  }
  const navigate = (next: number) => {
    if (formDirtyRef.current && !window.confirm('当前元素还有未应用的修改，确定放弃并切换幻灯片吗？')) return
    const value = Math.max(1, Math.min(session?.slides.length || 1, next))
    clearForm(); selectedPathRef.current = ''; setSelectedPath(''); callbacks.current.onDirtyChange(Boolean(sessionRef.current?.dirty || syncConflictRef.current))
    setSlideIndex(value); post('configure', { editing: editing && !busyRef.current && previewReadyRef.current && !syncPendingRef.current && !syncConflictRef.current, path: '' }); post('navigate', { slideIndex: value })
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      if (!frame.current?.closest('.office-artifact-pane')?.contains(event.target as Node)) return
      event.preventDefault(); if (!busyRef.current) void save()
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown)
  })
  const writesBlocked = Boolean(busy || syncPending || syncConflict || session?.conflict)
  return <section className={`ppt-document-editor ${editing ? 'editing' : ''}`} aria-label="PowerPoint 编辑器">
    <div className="ppt-toolbar">
      <button type="button" onClick={() => navigate(slideIndex - 1)} disabled={slideIndex <= 1} aria-label="上一张幻灯片" title="上一张幻灯片"><ChevronLeft size={15} /></button>
      <select aria-label="当前幻灯片" value={slideIndex} onChange={(event) => navigate(Number(event.target.value))}>{session?.slides.length ? session.slides.map((slide) => <option key={slide.path} value={slide.index}>{slide.index} / {session.slides.length} · {slide.title.slice(0, 40)}</option>) : <option value={1}>没有幻灯片</option>}</select>
      <button type="button" onClick={() => navigate(slideIndex + 1)} disabled={slideIndex >= (session?.slides.length || 1)} aria-label="下一张幻灯片" title="下一张幻灯片"><ChevronRight size={15} /></button>
      <span className="ppt-toolbar-spacer" />
      <button type="button" onClick={() => setZoom((value) => Math.max(50, value - 10))} disabled={zoom <= 50} aria-label="缩小幻灯片" title="缩小"><ZoomOut size={15} /></button>
      <button type="button" onClick={() => setZoom(100)} aria-label="恢复默认缩放" title="恢复默认缩放">{zoom}%</button>
      <button type="button" onClick={() => setZoom((value) => Math.min(200, value + 10))} disabled={zoom >= 200} aria-label="放大幻灯片" title="放大"><ZoomIn size={15} /></button>
      <button type="button" onClick={() => void discard()} disabled={Boolean(busy) || syncPending || !(session?.dirty || formDirty || syncConflict)} aria-label="放弃 PowerPoint 修改" title="放弃修改"><Undo2 size={15} /></button>
      <button className="ppt-save" type="button" onClick={() => void save()} disabled={writesBlocked || !(session?.dirty || formDirty)} title="保存到原文件（Ctrl/Cmd+S）">{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存</button>
    </div>
    {(syncConflict || session?.conflict) && <div className="ppt-conflict" role="alert">{syncConflict || session?.conflict}</div>}
    {!session && busy ? <div className="office-artifact-state"><LoaderCircle className="spin" size={22} />正在读取幻灯片结构…</div> : <iframe ref={frame} src={session?.document.previewUrl || document.previewUrl} sandbox="allow-scripts" title={`${document.name} 幻灯片预览`} />}
    {editing && <div className="ppt-inspector">
      <header><strong>{selected ? selected.name : `幻灯片 ${slideIndex}`}</strong><small>{selected ? selected.path : '点击幻灯片中的文字、图片或形状选择；拖动移动，右下角拖动缩放'}</small></header>
      <div className="ppt-element-row"><select aria-label="选择幻灯片元素" value={selectedPath} onChange={(event) => { if (formDirty && !window.confirm('放弃当前未应用的修改？')) return; clearForm(); selectedPathRef.current = event.target.value; setSelectedPath(event.target.value); callbacks.current.onDirtyChange(Boolean(sessionRef.current?.dirty || syncConflictRef.current)); post('navigate', { slideIndex, path: event.target.value }) }}><option value="">整张幻灯片</option>{session?.slides.find((slide) => slide.index === slideIndex)?.elements.map((element) => <option key={element.path} value={element.path}>{element.name} · {element.text.slice(0, 30) || element.type}</option>)}</select>{(busy || syncPending) && <LoaderCircle className="spin" size={15} />}</div>
      {selected && <>
        {selected.textEditable && <label className="ppt-text-field"><span>替换元素全文</span><textarea rows={2} value={fields.text} onChange={(event) => editField('text', event.target.value)} placeholder="只替换这个元素的文字；其他元素保持不变" /></label>}
        <div className="ppt-geometry-fields">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}><span>{['左侧', '顶部', '宽度', '高度'][index]}</span><input aria-label={['元素左侧位置', '元素顶部位置', '元素宽度', '元素高度'][index]} value={fields[key]} placeholder="例如 2cm" onChange={(event) => editField(key, event.target.value)} /></label>)}<button type="button" onClick={() => void applyForm()} disabled={writesBlocked || !formDirty}><Check size={14} />应用</button></div>
      </>}
      {onAskAI && <div className="ppt-ai-row"><input value={requirement} onChange={(event) => setRequirement(event.target.value)} placeholder={selected ? '让 AI 修改选中元素…' : '让 AI 修改当前幻灯片…'} aria-label="PowerPoint AI 编辑要求" onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void askAI() }} /><button type="button" onClick={() => void askAI()} disabled={writesBlocked || !requirement.trim()}><Sparkles size={14} />AI 编辑</button></div>}
      <footer>{formDirty ? '有未应用的修改' : session?.dirty ? `${session.pendingCount} 处修改尚未保存` : '所有修改已保存'} · 本地工作副本，不会自动覆盖原文件</footer>
    </div>}
  </section>
}
