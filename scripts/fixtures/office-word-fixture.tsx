import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WordDocumentEditor } from '../../src/components/WordDocumentEditor'
import type { DesktopResult, OfficeDocumentState } from '../../src/types'
import '../../src/styles.css'

const request = async (action: string, payload: unknown = {}) => {
  const response = await fetch(`/__word-qa/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  return response.json()
}
const listeners = new Set<(event: import('../../src/types').OfficeSessionEvent) => void>()
declare global { interface Window { __wordQa: { emit: (event: import('../../src/types').OfficeSessionEvent) => void; setDocument?: (document: OfficeDocumentState) => void } } }
window.__wordQa = { emit: (event) => { for (const listener of listeners) listener(event) } }
window.zsenseDesktop = {
  office: {
    getWord: (payload: unknown) => request('getWord', payload),
    stageWordOperations: (payload: unknown) => request('stageWordOperations', payload),
    saveWord: (payload: unknown) => request('saveWord', payload),
    discardWord: (payload: unknown) => request('discardWord', payload),
    onSessionChanged: (listener: (event: import('../../src/types').OfficeSessionEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  },
} as unknown as NonNullable<Window['zsenseDesktop']>

function Fixture() {
  const [document, setDocument] = useState<OfficeDocumentState | null>(null)
  const [dirty, setDirty] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  useEffect(() => { window.__wordQa.setDocument = setDocument; return () => { delete window.__wordQa.setDocument } }, [])
  useEffect(() => { void request('initial').then((result: DesktopResult<OfficeDocumentState>) => { if (result.ok && result.data) setDocument(result.data) }) }, [])
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div data-testid="word-feedback">{feedback?.message || ''}</div>
    <div data-testid="word-dirty">{String(dirty)}</div>
    {document && <WordDocumentEditor document={document} editing workspacePath="/isolated-fixture" onDocumentChange={setDocument} onDirtyChange={setDirty} onFeedback={setFeedback} />}
  </div>
}
createRoot(window.document.getElementById('root')!).render(<Fixture />)
