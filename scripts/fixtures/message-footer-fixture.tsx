// Disposable renderer fixture: no Electron, real conversations, or device services.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatMessageMeta } from '../../src/components/ChatMessageMeta'
import { GlobalIconTooltips } from '../../src/components/GlobalIconTooltips'
import '../../src/styles.css'

type Options = { model: string; branch: boolean; branchDisabled: boolean; role: 'assistant' | 'user'; showModel: boolean }
type Snapshot = { branchCalls: string[]; branched: string[]; copied: string[]; quotes: number; regenerated: number; deleted: number; errors: string[] }
const defaults: Options = { model: 'deepseek-flash', branch: true, branchDisabled: false, role: 'assistant', showModel: true }
const content = '这是一条隔离的 AI 回复，用于检查回复底部信息和操作按钮。'
const messageId = 'footer-qa-assistant'
const empty = (): Snapshot => ({ branchCalls: [], branched: [], copied: [], quotes: 0, regenerated: 0, deleted: 0, errors: [] })

declare global {
  interface Window {
    __messageFooterQa: {
      reset: () => void
      configure: (options: Partial<Options>) => void
      resolveBranch: () => void
      rejectBranch: () => void
      snapshot: () => Snapshot
    }
  }
}

function Fixture() {
  const [options, setOptions] = useState(defaults)
  const [epoch, setEpoch] = useState(0)
  const [error, setError] = useState('')
  const state = useRef(empty())
  const pending = useRef<{ resolve: () => void; reject: (error: Error) => void }>()
  Object.assign(window, { zsenseDesktop: {
    isDesktop: false,
    clipboard: { writeText: async (text: string) => { state.current.copied.push(text); return { ok: true, data: true } } },
  } })
  window.__messageFooterQa = {
    reset: () => { state.current = empty(); pending.current = undefined; setError(''); setOptions(defaults); setEpoch((value) => value + 1) },
    configure: (patch) => setOptions((current) => ({ ...current, ...patch })),
    resolveBranch: () => { pending.current?.resolve(); pending.current = undefined },
    rejectBranch: () => { pending.current?.reject(new Error('隔离测试模拟分支创建失败')); pending.current = undefined },
    snapshot: () => state.current,
  }
  const branch = async () => {
    state.current.branchCalls.push(messageId)
    await new Promise<void>((resolve, reject) => { pending.current = { resolve, reject } })
    state.current.branched.push(messageId)
  }
  return <>
    <main style={{ padding: '40px 12px', width: '100%', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 18, marginBottom: 20 }}>隔离回复底栏验证</h1>
      <div className="chat-message-list">
        <article className={`chat-message ${options.role}`}>
          <span className="mini-avatar">QA</span>
          <div>
            <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>{content}</p>
            <ChatMessageMeta key={epoch} messageId={messageId} content={content} createdAt="2026-10-10T03:13:56Z"
              model={options.model} showModel={options.showModel} durationMs={43_000} outputTokens={9804}
              copyDescription="这条 AI 回复" quoteDescription="引用 AI 回复"
              onQuote={() => { state.current.quotes += 1 }} onRegenerate={() => { state.current.regenerated += 1 }}
              onDelete={async () => { state.current.deleted += 1 }}
              onBranch={options.role === 'assistant' && options.branch ? branch : undefined} branchDisabled={options.branchDisabled}
              onError={(message) => { state.current.errors.push(message); setError(message) }} />
          </div>
        </article>
      </div>
      {error && <p role="alert" style={{ marginTop: 20 }}>{error}</p>}
    </main>
    <GlobalIconTooltips />
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
