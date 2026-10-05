import { AlertCircle, CheckCircle2, Clock3, FileSearch, LoaderCircle, RefreshCw, Search, Send, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { unwrapDesktop } from '../services/desktop'
import type { Bot, OfficeSearchHit, OfficeWorkItem } from '../types'

interface Props {
  bots: Bot[]
  onOpenConversation: (task: OfficeWorkItem) => void
}

const statusLabel: Record<OfficeWorkItem['status'], string> = {
  running: '执行中', review: '等待审核', delivering: '发送中', completed: '已完成', failed: '失败', interrupted: '已中断',
}

export function OfficeTasksPage({ bots, onOpenConversation }: Props) {
  const [items, setItems] = useState<OfficeWorkItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [botId, setBotId] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<OfficeSearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [searching, setSearching] = useState(false)

  const refresh = useCallback(async () => {
    if (!window.zsenseDesktop) return
    try {
      const result = await unwrapDesktop(window.zsenseDesktop.officeTasks.list())
      setItems(result)
      setSelectedId((current) => current && result.some((item) => item.id === current) ? current : result[0]?.id || '')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '任务读取失败。') }
  }, [])

  useEffect(() => {
    void refresh()
    return window.zsenseDesktop?.officeTasks.onChanged(() => { void refresh() })
  }, [refresh])

  const visible = useMemo(() => items.filter((item) => !botId || item.botId === botId), [items, botId])
  const selected = visible.find((item) => item.id === selectedId) || visible[0]
  const search = async () => {
    if (!query.trim() || !botId || !window.zsenseDesktop) return
    setSearching(true)
    setError('')
    try { setHits(await unwrapDesktop(window.zsenseDesktop.officeTasks.search(botId, query.trim()))) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '检索失败。') }
    finally { setSearching(false) }
  }
  const deliver = async (task: OfficeWorkItem) => {
    if (!window.zsenseDesktop || busy) return
    const fileCaveat = task.sourceChannel === 'dingtalk' && task.artifacts.length ? '\n\n注意：当前钉钉机器人通道只能发送文字结果，生成文件不会自动上传；任务会明确标为部分交付。' : ''
    if (!window.confirm(`确认将「${task.title}」的结果发送回${task.sourceChannel === 'dingtalk' ? '钉钉' : '飞书'}原会话？\n\n发送后可能无法撤回。${fileCaveat}`)) return
    setBusy(true)
    setError('')
    try { await unwrapDesktop(window.zsenseDesktop.officeTasks.deliver(task.id)); await refresh() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '发送失败。') }
    finally { setBusy(false) }
  }

  return <div className="office-tasks-page">
    <header className="office-tasks-header">
      <div><small>OFFICE WORKBENCH</small><h1>任务工作台</h1><p>来源、执行、核查和交付状态集中在这里；文件任务发送前须人工审核。</p></div>
      <button type="button" className="office-tasks-icon" title="刷新任务" aria-label="刷新任务" onClick={() => void refresh()}><RefreshCw size={16} /></button>
    </header>
    <section className="office-search-strip" aria-label="本地知识检索">
      <FileSearch size={18} />
      <select value={botId} onChange={(event) => { setBotId(event.target.value); setHits([]) }} aria-label="筛选 Bot"><option value="">全部任务 · 选择 Bot 后搜索</option><option value="__zsense_native__">AI 对话</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
      <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search() }} placeholder="搜索该 Bot 处理过的文件与回答" aria-label="搜索本地知识" />
      <button type="button" onClick={() => void search()} disabled={!botId || !query.trim() || searching}><Search size={15} />{searching ? '搜索中' : '搜索'}</button>
    </section>
    {error && <div className="office-task-error" role="alert"><AlertCircle size={15} />{error}</div>}
    {hits.length > 0 && <section className="office-search-results"><strong>检索结果 · {hits.length}</strong>{hits.map((hit) => <button key={hit.id} type="button" onClick={() => { setSelectedId(hit.taskId); setHits([]) }}><span>{hit.title}</span><small>{hit.snippet}</small></button>)}</section>}
    <div className="office-task-layout">
      <section className="office-task-list" aria-label="任务列表">
        <div className="office-task-list-heading"><strong>最近任务</strong><span>{visible.length}</span></div>
        {!visible.length && <p className="office-task-empty">暂无任务。对话或消息网关收到请求后会自动记录在这里。</p>}
        {visible.map((item) => <button type="button" key={item.id} className={`office-task-row ${selected?.id === item.id ? 'active' : ''}`} onClick={() => setSelectedId(item.id)}>
          <span className={`office-task-status ${item.status}`}>{item.status === 'completed' ? <CheckCircle2 size={16} /> : item.status === 'running' || item.status === 'delivering' ? <LoaderCircle size={16} /> : item.status === 'review' ? <ShieldCheck size={16} /> : <AlertCircle size={16} />}</span>
          <span><strong>{item.title}</strong><small>{item.sourceChannel} · {statusLabel[item.status]} · {new Date(item.updatedAt).toLocaleString('zh-CN')}</small></span>
        </button>)}
      </section>
      <section className="office-task-detail" aria-label="任务详情">
        {!selected ? <p className="office-task-empty">选择左侧任务查看处理进度。</p> : <>
          <div className="office-task-detail-title"><div><small>{selected.sourceChannel} · {statusLabel[selected.status]}</small><h2>{selected.title}</h2></div><button type="button" onClick={() => onOpenConversation(selected)}>打开会话</button></div>
          <p className="office-task-request">{selected.request}</p>
          <div className="office-task-provenance"><span>Bot：{bots.find((bot) => bot.id === selected.botId)?.name || (selected.botId === '__zsense_native__' ? 'AI 对话' : selected.botId)}</span><span>来源消息：{selected.sourceMessageId || '本地对话'}</span><span>更新时间：{new Date(selected.updatedAt).toLocaleString('zh-CN')}</span></div>
          <h3>执行进度</h3><ol className="office-task-steps">{selected.steps.map((step) => <li key={step.id} className={step.status}><span>{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : step.status === 'failed' ? '!' : '○'}</span><div>{step.label}{step.detail && <small>{step.detail}</small>}</div></li>)}</ol>
          {selected.evidence.length > 0 && <><h3>来源证据</h3><div className="office-task-evidence">{selected.evidence.map((source, index) => <div key={`${source.sourceId}-${index}`}><strong>{source.label}</strong><small>{source.page ? `第 ${source.page} 页 · ` : ''}{source.cell ? `${source.cell} · ` : ''}{source.path || source.sourceId || source.type}</small></div>)}</div></>}
          {selected.artifacts.length > 0 && <><h3>磁盘产物核查</h3><div className="office-task-evidence">{selected.artifacts.map((artifact) => <div key={artifact.path}><strong>{artifact.verified ? '✓' : '!'} {artifact.name}</strong><small>{artifact.verified ? `SHA-256 ${artifact.sha256}` : artifact.error || '未通过'} · {artifact.path}</small></div>)}</div></>}
          {selected.output && <><h3>结果预览</h3><pre className="office-task-output">{selected.output}</pre></>}
          {selected.error && <p className="office-task-warning"><AlertCircle size={15} />{selected.errorCode} · {selected.error}</p>}
          <footer className="office-task-footer"><span><Clock3 size={14} />交付：{selected.deliveryStatus === 'accepted' ? '平台已接受' : selected.deliveryStatus === 'review_required' ? '等待审核' : selected.deliveryStatus === 'not_required' ? '本地结果' : selected.deliveryStatus === 'text_only' ? '仅文字已发送，文件未上传' : selected.deliveryStatus}</span>{selected.status === 'review' && <button type="button" disabled={busy} onClick={() => void deliver(selected)}><Send size={15} />审核并发送</button>}</footer>
        </>}
      </section>
    </div>
  </div>
}
