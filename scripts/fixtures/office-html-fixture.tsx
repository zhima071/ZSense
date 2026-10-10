import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OfficeArtifactPane, type OfficeArtifactPaneHandle } from '../../src/components/OfficeArtifactPane'
import { HtmlArtifactEditor } from '../../src/components/HtmlArtifactEditor'
import type { OfficeDocumentState, OfficeSessionEvent } from '../../src/types'
import '../../src/styles.css'

type Feedback = { tone: 'success' | 'error'; message: string } | null
interface ChildCallbacks {
  document: OfficeDocumentState
  onDocumentChange: (document: OfficeDocumentState) => void
  onFeedback: (feedback: Feedback) => void
  onDirtyChange: (dirty: boolean) => void
}
interface Fiber {
  type?: unknown
  memoizedProps?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
}
interface HtmlQa {
  files: string[]
  calls: Array<{ action: string; payload: Record<string, unknown> }>
  captured: ChildCallbacks | null
  capture: () => void
  callbacksUnchanged: () => boolean
  invokeCaptured: () => void
  forceFile: (index: number) => void
  emit: (event: OfficeSessionEvent) => void
}
declare global { interface Window { __htmlQa: HtmlQa } }

const listeners = new Set<(event: OfficeSessionEvent) => void>()
const request = async (action: string, payload: Record<string, unknown> = {}) => {
  window.__htmlQa.calls.push({ action, payload })
  const response = await fetch(`/__html-qa/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  return response.json()
}
window.zsenseDesktop = { office: {
  open: (filePath: string, options?: { requestId?: string }) => request('open', { filePath, ...options }),
  cancelOpen: (requestId: string) => request('cancelOpen', { requestId }),
  getHtml: (payload: Record<string, unknown>) => request('getHtml', payload),
  stageHtml: (payload: Record<string, unknown>) => request('stageHtml', payload),
  saveHtml: (payload: Record<string, unknown>) => request('saveHtml', payload),
  discardHtml: (payload: Record<string, unknown>) => request('discardHtml', payload),
  refresh: (filePath: string) => request('refresh', { filePath }),
  reveal: (filePath: string) => request('reveal', { filePath }),
  openExternally: (filePath: string) => request('openExternally', { filePath }),
  onSessionChanged: (listener: (event: OfficeSessionEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
} } as unknown as NonNullable<Window['zsenseDesktop']>

const root = createRoot(window.document.getElementById('root')!)
// Test-only fiber inspection captures the real child props, without instrumenting production code.
function childCallbacks(): ChildCallbacks {
  const current = (root as unknown as { _internalRoot: { current: Fiber } })._internalRoot.current
  const visit = (node: Fiber | null | undefined): ChildCallbacks | null => {
    if (!node) return null
    if (node.type === HtmlArtifactEditor) return node.memoizedProps as ChildCallbacks
    return visit(node.child) || visit(node.sibling)
  }
  const props = visit(current)
  if (!props) throw new Error('The actual HTML editor is not mounted in the fixture')
  return props
}
Object.assign(window.__htmlQa, {
  calls: [], captured: null,
  capture: () => { window.__htmlQa.captured = childCallbacks() },
  callbacksUnchanged: () => {
    const initial = window.__htmlQa.captured, current = childCallbacks()
    return Boolean(initial && initial.onDocumentChange === current.onDocumentChange && initial.onFeedback === current.onFeedback && initial.onDirtyChange === current.onDirtyChange)
  },
  invokeCaptured: () => {
    const captured = window.__htmlQa.captured
    if (!captured) throw new Error('Capture real callbacks first')
    captured.onFeedback({ tone: 'error', message: 'stale-file-callback-must-not-appear' })
    captured.onDirtyChange(true)
    captured.onDocumentChange({ ...captured.document, name: 'stale-file-callback-document' })
  },
  emit: (event: OfficeSessionEvent) => { for (const listener of listeners) listener(event) },
})

function Fixture() {
  const [filePath, setFilePath] = useState(window.__htmlQa.files[0])
  const [rerenders, setRerenders] = useState(0)
  const pane = useRef<OfficeArtifactPaneHandle>(null)
  window.__htmlQa.forceFile = (index) => setFilePath(window.__htmlQa.files[index])
  const switchFile = async (index: number) => { if (await pane.current?.requestNavigation()) setFilePath(window.__htmlQa.files[index]) }
  return <div className="native-chat-layout has-office-artifact" style={{ height: '100vh', width: '100vw' }}>
    <section style={{ padding: 20 }}>
      <button type="button" onClick={() => setRerenders((value) => value + 1)}>重绘父界面</button>
      <button type="button" onClick={() => void switchFile(0)}>切换到第一个 HTML</button>
      <button type="button" onClick={() => void switchFile(1)}>切换到第二个 HTML</button>
      <output data-testid="parent-rerenders">{rerenders}</output>
    </section>
    <OfficeArtifactPane ref={pane} filePath={filePath} workspacePath={filePath.replace(/[\\/][^\\/]+$/, '')} onClose={() => undefined} />
  </div>
}
root.render(<Fixture />)
