import { Eye, EyeOff, LoaderCircle, LockKeyhole } from 'lucide-react'
import { FormEvent, useEffect, useRef, useState } from 'react'
import brandLogo from '../assets/zsense-brand.png'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { AuthStatus, AuthUser } from '../types'

interface AppLockScreenProps {
  user: AuthUser
  onUnlock: (password: string) => Promise<AuthStatus>
  onReset: (input: { code: string; password: string }) => Promise<AuthStatus>
}

export function AppLockScreen({ user, onUnlock, onReset }: AppLockScreenProps) {
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const passwordRef = useRef<HTMLInputElement>(null)
  const [boundEmail, setBoundEmail] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [resetConfirm, setResetConfirm] = useState('')
  const [resetBusy, setResetBusy] = useState('')
  const [resetHint, setResetHint] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const status = await unwrapDesktop(window.zsenseDesktop!.auth.emailStatus())
        if (status.bound) setBoundEmail(status.masked || '')
      } catch { /* 读不到就不显示邮箱 */ }
    })()
  }, [])

  const sendResetCode = async () => {
    setResetBusy('send'); setError(''); setResetHint('')
    try {
      const result = await unwrapDesktop(window.zsenseDesktop!.auth.sendResetCode())
      const minutes = Math.max(1, Math.round((result.expiresInSeconds || 600) / 60))
      setResetHint(`验证码已发送到 ${result.masked || boundEmail}，${minutes} 分钟内有效。`)
    } catch (reason) { setError(errorMessage(reason)) } finally { setResetBusy('') }
  }

  const submitReset = async () => {
    setError(''); setResetHint('')
    if (resetCode.trim().length < 4) { setError('请输入邮件里收到的验证码。'); return }
    if (resetPassword.length < 4) { setError('新的安全锁密码至少需要 4 位。'); return }
    if (resetPassword !== resetConfirm) { setError('两次输入的新密码不一致。'); return }
    setResetBusy('reset')
    try { await onReset({ code: resetCode.trim(), password: resetPassword }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '重置失败，请重试。') }
    finally { setResetBusy('') }
  }

  useEffect(() => { passwordRef.current?.focus() }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true)
    setError('')
    try { await onUnlock(password) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '解锁失败，请重试。') }
    finally { setSubmitting(false) }
  }

  return <main className="app-lock-screen">
    <section className="app-lock-card" aria-labelledby="app-lock-title">
      <img src={brandLogo} alt="ZSense" />
      <span className="app-lock-icon"><LockKeyhole size={22} /></span>
      <h1 id="app-lock-title">ZSense 已锁定</h1>
      <p>输入安全锁密码继续使用 <strong>{user.displayName}</strong> 的本地工作台。</p>
      <form onSubmit={submit}>
        <label>
          <span>密码</span>
          <span className="password-input">
            <input ref={passwordRef} type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" minLength={4} maxLength={128} required />
            <button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? '隐藏密码' : '显示密码'} title={visible ? '隐藏密码' : '显示密码'}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </span>
        </label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="button primary" disabled={!password || submitting}>{submitting ? <LoaderCircle className="spin" size={16} /> : <LockKeyhole size={16} />}{submitting ? '正在解锁…' : '解锁 ZSense'}</button>
      </form>
          <details className="app-lock-reset">
        <summary>忘记安全锁密码？用邮箱重置</summary>
        <div className="app-lock-reset-body">
          <p>验证码会发送到已绑定邮箱 {boundEmail || '（还没有绑定邮箱，请先用密码进入后在设置里绑定）'}。</p>
          <button type="button" className="button secondary small" disabled={resetBusy === 'send' || !boundEmail} onClick={() => void sendResetCode()}>{resetBusy === 'send' ? <LoaderCircle className="spin" size={14} /> : null}发送验证码</button>
          <input value={resetCode} onChange={(event) => setResetCode(event.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" placeholder="邮件里的验证码" aria-label="邮箱验证码" />
          <input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="新的安全锁密码" aria-label="新的安全锁密码" autoComplete="new-password" />
          <input type="password" value={resetConfirm} onChange={(event) => setResetConfirm(event.target.value)} placeholder="确认新密码" aria-label="确认新的安全锁密码" autoComplete="new-password" />
          <button type="button" className="button primary small" disabled={resetBusy === 'reset'} onClick={() => void submitReset()}>{resetBusy === 'reset' ? <LoaderCircle className="spin" size={14} /> : null}重置并进入</button>
          {resetHint && <div className="auth-hint">{resetHint}</div>}
        </div>
      </details>
</section>
  </main>
}
