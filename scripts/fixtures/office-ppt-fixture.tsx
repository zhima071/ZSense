import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import { OfficeArtifactPane, type OfficeArtifactPaneHandle } from '../../src/components/OfficeArtifactPane'
import '../../src/styles.css'

interface ResponseGate { id: number; method: string; assigned: boolean; waiting: boolean; result: unknown; promise: Promise<void>; release: () => void }
const fixture = window as unknown as { __pptFixture: { files: string[]; forceFile: (file: string) => void; prompts: string[]; calls: string[]; emit: (event: unknown) => void;
  holdNext: (method: string) => number; release: (id: number) => void; gate: (id: number) => { waiting: boolean; result: unknown } } }
const prompts: string[] = [], calls: string[] = []
const listeners = new Set<(event: unknown) => void>()
const gates: ResponseGate[] = []
const holdNext = (method: string) => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  const gate = { id: gates.length, method, assigned: false, waiting: false, result: null, promise, release }
  gates.push(gate); return gate.id
}
const invoke = async (method: string, request: unknown) => {
  calls.push(method)
  const gate = gates.find((candidate) => candidate.method === method && !candidate.assigned)
  if (gate) gate.assigned = true
  const response = await fetch('/__ppt/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, request }) })
  const result = await response.json()
  // Capture the real response first, then explicitly hold its delivery. The
  // regression controls ordering without timers, retries, or mocked sessions.
  if (gate) { gate.result = result; gate.waiting = true; await gate.promise }
  return result
}
window.zsenseDesktop = { isDesktop: true, office: {
  open: (filePath: string) => invoke('open', { filePath }), cancelOpen: () => Promise.resolve({ ok: true, data: undefined }),
  refresh: (filePath: string) => invoke('refresh', { filePath }), reveal: () => Promise.resolve({ ok: true, data: undefined }), openExternally: () => Promise.resolve({ ok: true, data: undefined }),
  getPresentation: (request: unknown) => invoke('getPresentation', request), stagePresentation: (request: unknown) => invoke('stagePresentation', request),
  savePresentation: (request: unknown) => invoke('savePresentation', request), discardPresentation: (request: unknown) => invoke('discardPresentation', request),
  onSessionChanged: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
} } as unknown as NonNullable<Window['zsenseDesktop']>
function Fixture() {
  const [filePath, setFilePath] = useState(fixture.__pptFixture.files[0])
  const pane = useRef<OfficeArtifactPaneHandle>(null)
  fixture.__pptFixture = { ...fixture.__pptFixture, forceFile: setFilePath, prompts, calls, holdNext,
    release: (id) => gates[id].release(), gate: (id) => ({ waiting: gates[id].waiting, result: gates[id].result }),
    emit: (event) => listeners.forEach((listener) => listener(event)) }
  const change = async (file: string) => { if (await pane.current?.requestNavigation()) setFilePath(file) }
  return <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }}>
    <nav><button onClick={() => void change(fixture.__pptFixture.files[0])}>文稿 A</button><button onClick={() => void change(fixture.__pptFixture.files[1])}>文稿 B</button></nav>
    <div style={{ height: 'calc(100vh - 30px)', display: 'flex', minHeight: 0 }}><div style={{ flex: 1 }}>隔离测试，不连接应用数据</div><OfficeArtifactPane ref={pane} filePath={filePath} onClose={() => setFilePath('')} onAskAI={(prompt) => { prompts.push(prompt) }} /></div>
  </div>
}
createRoot(window.document.getElementById('root')!).render(<Fixture />)
