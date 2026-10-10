import { Check, LoaderCircle, RotateCw, Scissors, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { GlobalScreenshotStatus } from '../electron'

function readableShortcut(value: string) {
  if (!value) return '未设置'
  const mac = window.zsenseDesktop?.platform === 'darwin'
  return value.replace('CommandOrControl', mac ? '⌘' : 'Ctrl').replace('Control', 'Ctrl').replace('Shift', mac ? '⇧' : 'Shift').replace('Alt', mac ? '⌥' : 'Alt').replaceAll('+', mac ? '' : ' + ')
}

function shortcutFromKey(event: KeyboardEvent<HTMLInputElement>) {
  if (!event.shiftKey || !(event.metaKey || event.ctrlKey)) return ''
  const code = event.code
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3)
    : /^Digit[0-9]$/.test(code) ? code.slice(5)
      : /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code) ? code : ''
  return key ? `CommandOrControl+${event.altKey ? 'Alt+' : ''}Shift+${key}` : ''
}

export function GlobalScreenshotSettings() {
  const available = Boolean(window.zsenseDesktop?.screenshot?.globalStatus) && window.zsenseDesktop?.transport !== 'web-bridge'
  const [status, setStatus] = useState<GlobalScreenshotStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!available) return
    let active = true
    const refresh = () => {
      void unwrapDesktop(window.zsenseDesktop!.screenshot.globalStatus()).then((value) => { if (active) setStatus(value) }).catch((reason) => { if (active) setError(errorMessage(reason)) })
    }
    refresh()
    const unsubscribe = window.zsenseDesktop!.screenshot.onGlobalError((value) => { if (active) { setError(value); refresh() } })
    window.addEventListener('focus', refresh)
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', refresh) }
  }, [available])

  const setShortcut = async (shortcut: string) => {
    if (!available || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setStatus(await unwrapDesktop(window.zsenseDesktop!.screenshot.setGlobalShortcut(shortcut)))
      setRecording(false)
      setMessage(shortcut ? '快捷键已保存并立即生效。' : '全局快捷键已关闭；仍可从这里手动截图。')
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }

  const start = async () => {
    if (!available || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try { setStatus(await unwrapDesktop(window.zsenseDesktop!.screenshot.startGlobal())) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }

  const recheckPermissions = async () => {
    if (!available || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const next = await unwrapDesktop(window.zsenseDesktop!.screenshot.recheckGlobalPermissions())
      setStatus(next)
      if (next.screenCapturePermission === 'granted') setMessage('系统已报告录屏授权；可以手动尝试截图。此次检测未读取屏幕。')
      else if (next.screenCapturePermission === 'not-determined') setMessage('尚未请求录屏权限；可以主动申请一次。此次检测未读取屏幕。')
      else setError('当前应用仍未获得录屏权限。请在系统设置中确认 ZSense 权限，并完整退出后重开；此次检测未读取屏幕。')
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false) }
  }

  const requestPermissions = async () => {
    const screenshot = window.zsenseDesktop?.screenshot
    if (!available || busy || window.zsenseDesktop?.platform !== 'darwin' || !screenshot?.requestGlobalPermissions || status?.screenCaptureRequestAttempted || !['denied', 'not-determined'].includes(status?.screenCapturePermission || '')) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const next = await unwrapDesktop(screenshot.requestGlobalPermissions())
      setStatus(next)
      if (next.screenCapturePermission === 'granted') setMessage('系统已报告录屏授权；可以手动尝试截图。此次申请未读取屏幕。')
      else setMessage('已发起一次系统录屏授权申请，未读取屏幕。请在系统设置中允许 ZSense，并完整退出后重开；本次启动不会重复申请。')
    } catch (reason) {
      setError(errorMessage(reason))
      // A failed native request may already have displayed system consent. Read
      // back the attempt latch without requesting permission or capturing again.
      try { setStatus(await unwrapDesktop(screenshot.globalStatus())) } catch { /* Keep the original request error. */ }
    } finally { setBusy(false) }
  }

  const captureKey = (event: KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') { setRecording(false); return }
    const shortcut = shortcutFromKey(event)
    if (!shortcut) {
      if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) setError('请按住 Ctrl/⌘ + Shift，再按一个字母、数字或 F 功能键。')
      return
    }
    void setShortcut(shortcut)
  }

  return <div className="global-screenshot-row">
    <span className="setting-icon"><Scissors size={18} /></span>
    <span className="global-screenshot-copy"><strong>全局截图</strong><small>在任意应用上按快捷键，框选鼠标所在显示器；可画圈、批注、下载、复制或置顶贴图。</small></span>
    <div className="global-screenshot-controls">
      {recording ? <input autoFocus readOnly value="请按 Ctrl/⌘ + Shift + 按键…" onKeyDown={captureKey} onBlur={() => setRecording(false)} aria-label="录制全局截图快捷键" />
        : <button type="button" className="global-screenshot-key" onClick={() => { setRecording(true); setError('') }} disabled={!available || busy} title="点击后按下新的快捷键" aria-label={`设置全局截图快捷键，当前 ${readableShortcut(status?.shortcut || '')}`}>{readableShortcut(status?.shortcut || '')}</button>}
      <button type="button" className="button secondary small" onClick={() => void start()} disabled={!available || busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Scissors size={15} />}立即截图</button>
      {available && window.zsenseDesktop?.platform === 'darwin' && <button type="button" className="button secondary small" onClick={() => void recheckPermissions()} disabled={busy} title="只检测录屏权限，不读取屏幕"><RotateCw size={15} />检测权限</button>}
      {available && window.zsenseDesktop?.platform === 'darwin' && typeof window.zsenseDesktop?.screenshot.requestGlobalPermissions === 'function' && status && ['denied', 'not-determined'].includes(status.screenCapturePermission) && <button type="button" className="button secondary small" onClick={() => void requestPermissions()} disabled={busy || status.screenCaptureRequestAttempted} title="仅发起一次系统录屏授权申请，不读取屏幕"><ShieldCheck size={15} />重新申请权限</button>}
      <button type="button" className="button secondary small" onClick={() => void setShortcut('CommandOrControl+Shift+8')} disabled={!available || busy || status?.shortcut === 'CommandOrControl+Shift+8'}>恢复默认</button>
    </div>
    <div className="global-screenshot-feedback" aria-live="polite">
      {!available && <small>全局截图仅在本机桌面应用中使用。</small>}
      {available && window.zsenseDesktop?.platform === 'darwin' && status && <small>录屏权限：{status.screenCapturePermission === 'granted' ? '系统已授权' : status.screenCapturePermission === 'not-determined' ? '尚未申请' : status.screenCapturePermission === 'restricted' ? '系统限制' : status.screenCapturePermission === 'denied' ? '当前应用未获授权' : '无法确认'}{status.screenCaptureNeedsRestart ? '；截图暂已暂停，请完整退出并重开。' : ''}</small>}
      {status?.error && !error && <small className="error">{status.error}</small>}
      {error && <small className="error" role="alert">{error}</small>}
      {message && <small><Check size={13} />{message}</small>}
    </div>
  </div>
}
