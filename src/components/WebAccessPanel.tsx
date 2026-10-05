import { Check, Copy, Globe2, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { writeTextToClipboard } from '../services/clipboard'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { WebBridgeStatus } from '../types'

// 局域网 Web 访问：同一网络里的手机/平板/另一台电脑用浏览器打开完整界面。
// embedded = 作为「局域网直连」卡片内的分隔块渲染（不再自带独立面板标题）。
export function WebAccessPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [status, setStatus] = useState<WebBridgeStatus>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const apply = useCallback((next: WebBridgeStatus) => setStatus(next), [])

  const load = useCallback(async () => {
    if (!window.zsenseDesktop?.webBridge) return
    try { setStatus(await unwrapDesktop(window.zsenseDesktop.webBridge.status())) }
    catch (reason) { setError(errorMessage(reason)) }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!window.zsenseDesktop?.webBridge?.onChanged) return
    return window.zsenseDesktop.webBridge.onChanged((next) => setStatus(next))
  }, [])

  const run = async (label: string, operation: () => Promise<WebBridgeStatus>, message = '') => {
    setBusy(label)
    setError('')
    try {
      const next = await operation()
      apply(next)
      if (message) setCopied(message)
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  const copy = async (value: string, label: string) => {
    if (!value) return
    try {
      // 桌面窗口里 navigator.clipboard 会被权限处理器拒绝，必须走应用自带的剪贴板通道。
      await writeTextToClipboard(value)
      setCopied(label)
      setError('')
      window.setTimeout(() => setCopied(''), 1_600)
    } catch (reason) { setError(`复制失败：${errorMessage(reason)}`) }
  }

  const enabled = status?.enabled === true && status?.running === true
  const lanUrl = (status?.urls || [])[0] || status?.localUrl || ''
  const switchButton = (
    <button type="button" className={`switch ${enabled ? 'on' : ''}`} role="switch" aria-checked={enabled} aria-label={`${enabled ? '关闭' : '开启'}局域网浏览器访问`} disabled={busy === 'toggle'} onClick={() => void run('toggle', async () => unwrapDesktop(window.zsenseDesktop!.webBridge.setEnabled(!enabled)), enabled ? '已关闭局域网访问。' : '已开启局域网访问。')}>{busy === 'toggle' ? <LoaderCircle className="spin" size={14} /> : <span />}</button>
  )
  const body = <>
    {enabled && status && (
      <div className="web-access-grid">
        <div className="web-access-field">
          <small>局域网访问地址（用安全锁密码进入）</small>
          <div className="web-access-value">
            <code>{lanUrl}</code>
            <button type="button" className="icon-button compact" aria-label="复制访问地址" onClick={() => void copy(lanUrl, '地址已复制')}><Copy size={14} /></button>
          </div>
        </div>
      </div>
    )}
    {!enabled && <div className="web-access-empty"><Globe2 size={22} /><strong>局域网访问已关闭</strong></div>}
    {(error || status?.error) && <div className="web-access-feedback error" role="alert">{error || status?.error}</div>}
    {copied && !error && <div className="web-access-feedback success" role="status"><Check size={14} />{copied}</div>}
  </>

  if (embedded) {
    return <section className="device-link-subpanel web-access-panel">
      <div className="web-access-body">{body}</div>
    </section>
  }
  return <section className="panel settings-block web-access-panel">
    <div className="panel-header"><div><h2>浏览器访问（局域网）</h2></div>{switchButton}</div>
    <div className="web-access-body">{body}</div>
  </section>
}
