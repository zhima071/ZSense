import { ArrowRight, Check, LoaderCircle, LockKeyhole, Mail, Network, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import brandLogo from '../assets/zsense-brand.png'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { AppSettings, AuthUser } from '../types'

interface OnboardingFlowProps {
  user: AuthUser
  settings: AppSettings
  onSaveSettings: (settings: AppSettings) => Promise<void>
}

/**
 * 首启引导（合并成一条流程，只走一次）：
 *   ① 设置用户名 → ② 邮箱验证码绑定 → ③ 可选开启安全锁；公网设备号之后由交换中心按设备公钥分配。
 * 完成后交给「AI 模型」那一步（没配过才出现），全程不重复。
 */
const STEPS = ['设置用户名', '绑定邮箱', '安全锁'] as const

export function OnboardingFlow({ user, settings, onSaveSettings }: OnboardingFlowProps) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(user.displayName || '')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [emailMasked, setEmailMasked] = useState('')
  const [lockChoice, setLockChoice] = useState<'ask' | 'on' | 'off'>('ask')
  const [lockPassword, setLockPassword] = useState('')
  const [lockConfirm, setLockConfirm] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const status = await unwrapDesktop(window.zsenseDesktop!.auth.emailStatus())
        if (status.bound) { setEmailMasked(status.masked || ''); setCodeSent(true) }
      } catch { /* 读不到就按未绑定处理 */ }
    })()
  }, [])

  const next = async () => {
    setError(''); setHint('')
    if (step === 0) {
      if (name.trim().length < 2) { setError('用户名至少需要 2 个字。'); return }
      setBusy('name')
      try {
        await unwrapDesktop(window.zsenseDesktop!.onboarding.setName(name.trim()))
        setStep(1)
      } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
      return
    }
    if (step === 1) {
      const alreadyBound = Boolean(emailMasked) && !email.trim()
      if (!alreadyBound && code.trim().length < 4) { setError('请先发送验证码，再填入邮件里收到的验证码。'); return }
      setBusy('email')
      try {
        if (!alreadyBound) {
          await unwrapDesktop(window.zsenseDesktop!.auth.verifyBindCode({ email: email.trim(), code: code.trim() }))
          setEmailMasked(email.trim())
        }
        setStep(2)
      } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
      return
    }
    if (step === 2) {
      if (lockChoice === 'ask') { setError('请选择是否开启安全锁（可以直接选「暂不开启」）。'); return }
      if (lockChoice === 'on') {
        if (lockPassword.length < 4) { setError('安全锁密码至少需要 4 位。'); return }
        if (lockPassword !== lockConfirm) { setError('两次输入的安全锁密码不一致。'); return }
        setBusy('lock')
        try {
          await unwrapDesktop(window.zsenseDesktop!.auth.setLockPassword(lockPassword))
          await onSaveSettings({ ...settings, appLockEnabled: true, appLockPasswordConfigured: true })
        } catch (reason) { setError(errorMessage(reason)); setBusy(''); return }
        setBusy('')
      } else if (settings.appLockEnabled) {
        await onSaveSettings({ ...settings, appLockEnabled: false })
      }
      // 三步走完即完成引导（设备号进主界面后在「设置 → 设备互联」里查看）
      setBusy('done')
      try {
        await unwrapDesktop(window.zsenseDesktop!.onboarding.complete())
      } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
      return
    }
  }

  const sendCode = async () => {
    setError(''); setHint('')
    if (!email.trim()) { setError('请先填写要绑定的邮箱。'); return }
    setBusy('send')
    try {
      const result = await unwrapDesktop(window.zsenseDesktop!.auth.sendBindCode(email.trim()))
      setCodeSent(true)
      const minutes = Math.max(1, Math.round((result.expiresInSeconds || 600) / 60))
      setHint(`验证码已发送到 ${result.masked || email.trim()}，${minutes} 分钟内有效。`)
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  return <main className="app-lock-screen">
    <section className="app-lock-card onboarding-card">
      <img src={brandLogo} alt="ZSense" />
      <span className="app-lock-icon"><Network size={22} /></span>
      <h1>先花一分钟设置好</h1>
      <p>共 4 步，设置完成后就能开始使用 <strong>{user.displayName}</strong> 的本地工作台。</p>

      <ol className="onboarding-steps">
        {STEPS.map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>
          <i>{index < step ? '✓' : index + 1}</i><span>{label}</span>
        </li>)}
      </ol>

      <div className="onboarding-body">
        {step === 0 && <label className="onboarding-field">
          <span>用户名</span>
          <span className="account-email-input"><UserRound size={15} /><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="例如 Hank" /></span>
          <small>用来标识这台设备与数据归属，之后可以在设置里改。</small>
        </label>}

        {step === 1 && <>
          <label className="onboarding-field">
            <span>邮箱</span>
            <span className="account-email-input">
              <Mail size={15} />
              <input type="email" value={email} onChange={(event) => { setEmail(event.target.value); setCodeSent(false) }} placeholder="you@example.com" autoComplete="email" />
              <button type="button" className="button secondary small" disabled={busy !== '' || !email.trim()} onClick={() => void sendCode()}>{busy === 'send' ? <LoaderCircle className="spin" size={14} /> : <Mail size={14} />}发送验证码</button>
            </span>
          </label>
          {(codeSent || emailMasked) && <label className="onboarding-field">
            <span>邮件里的验证码</span>
            <span className="account-email-input"><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" placeholder="6 位数字" aria-label="邮箱验证码" /></span>
            <small>{emailMasked && !codeSent ? `已经绑定过 ${emailMasked}，这一步可以直接继续。` : '收不到就再点一次「发送验证码」。'}</small>
          </label>}
        </>}

        {step === 2 && <>
          <div className="onboarding-choice">
            <button type="button" className={`onboarding-option ${lockChoice === 'on' ? 'selected' : ''}`} onClick={() => setLockChoice('on')}><LockKeyhole size={16} /><span><strong>开启安全锁</strong><small>每次打开应用需要输入密码</small></span></button>
            <button type="button" className={`onboarding-option ${lockChoice === 'off' ? 'selected' : ''}`} onClick={() => setLockChoice('off')}><Check size={16} /><span><strong>暂不开启</strong><small>直接进入，之后可随时开启</small></span></button>
          </div>
          {lockChoice === 'on' && <div className="onboarding-field">
            <span>安全锁密码</span>
            <span className="account-email-input"><input type="password" value={lockPassword} onChange={(event) => setLockPassword(event.target.value)} placeholder="至少 4 位" autoComplete="new-password" /></span>
            <span className="account-email-input"><input type="password" value={lockConfirm} onChange={(event) => setLockConfirm(event.target.value)} placeholder="再输一次" autoComplete="new-password" /></span>
            <small>忘记密码时，可以用已绑定邮箱重置。</small>
          </div>}
        </>}

        {hint && <div className="auth-hint">{hint}</div>}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>

      <div className="onboarding-actions">
        {step > 0 && <button type="button" className="button secondary" disabled={busy !== ''} onClick={() => { setError(''); setHint(''); setStep(step - 1) }}>上一步</button>}
        <button type="button" className="button primary" disabled={busy !== ''} onClick={() => void next()}>
          {busy ? <LoaderCircle className="spin" size={16} /> : step === 2 ? <Check size={16} /> : null}
          {step === 2 ? '完成设置' : '下一步'}{step < 2 ? <ArrowRight size={15} /> : null}
        </button>
      </div>
    </section>
  </main>
}
