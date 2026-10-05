import { Check, Download, KeyRound, LockKeyhole, LoaderCircle, Mail, Pencil, ShieldCheck, Upload, UserRound } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { AppSettings, AuthUser } from '../types'

interface AccountPanelProps {
  currentUser: AuthUser
  settings: AppSettings
  onSaveSettings: (settings: AppSettings) => Promise<void>
}

/**
 * 账号与安全：本机只有一个账号（初始用户名），不再有新建身份 / 角色 / 启用停用那一套。
 * 绑定邮箱、安全锁和独立的远程网页访问密码都在此配置。
 */
export function AccountPanel({ currentUser, settings, onSaveSettings }: AccountPanelProps) {
  const [email, setEmail] = useState('')
  const [boundMasked, setBoundMasked] = useState('')
  const [deviceEmailVerified, setDeviceEmailVerified] = useState(false)
  const [shownName, setShownName] = useState(currentUser.displayName)
  const [accountPasswordOpen, setAccountPasswordOpen] = useState(false)
  const [accountPassword, setAccountPassword] = useState('')
  const [accountPasswordConfirm, setAccountPasswordConfirm] = useState('')
  const [accountPasswordConfigured, setAccountPasswordConfigured] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState(currentUser.displayName)
  const [bindCode, setBindCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [bindHint, setBindHint] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [lockOpen, setLockOpen] = useState(false)
  const [lockPassword, setLockPassword] = useState('')
  const [lockConfirm, setLockConfirm] = useState('')

  const load = useCallback(async () => {
    try {
      const status = await unwrapDesktop(window.zsenseDesktop!.auth.emailStatus())
      setBoundMasked(status.masked || '')
      const link = await unwrapDesktop(window.zsenseDesktop!.deviceLink.status())
      setDeviceEmailVerified(link.remote.accountVerified === true)
      const account = await unwrapDesktop(window.zsenseDesktop!.auth.accountPasswordStatus())
      setAccountPasswordConfigured(Boolean(account.configured))
    } catch (reason) { setError(errorMessage(reason)) }
  }, [])
  useEffect(() => { void load() }, [load])

  // 安全锁关闭时的公网网页登录凭据，与本机应用解锁相互独立。
  const saveAccountPassword = async (event: FormEvent) => {
    event.preventDefault()
    setError(''); setMessage('')
    if (accountPassword.length < 4) { setError('远程访问密码至少需要 4 位。'); return }
    if (accountPassword !== accountPasswordConfirm) { setError('两次输入的远程访问密码不一致。'); return }
    setBusy('account-password')
    try {
      await unwrapDesktop(window.zsenseDesktop!.auth.setAccountPassword(accountPassword))
      setAccountPasswordConfigured(true)
      setAccountPasswordOpen(false); setAccountPassword(''); setAccountPasswordConfirm('')
      setMessage('远程访问密码已保存。安全锁关闭时可用它登录远程网页；已配对设备仍可通过密钥进入。')
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  // 跨平台迁移：导出/导入一份不含敏感信息的配置文件
  const transferConfiguration = async (mode: 'export' | 'import') => {
    if (!window.zsenseDesktop) return
    setBusy(mode); setError(''); setMessage('')
    try {
      const result = await unwrapDesktop(mode === 'export' ? window.zsenseDesktop.configuration.export() : window.zsenseDesktop.configuration.import())
      if (!result.canceled) {
        const total = result.counts ? Object.values(result.counts).reduce((sum, value) => sum + value, 0) : 0
        setMessage(`${result.message}${total ? ` 共处理 ${total} 项配置。` : ''}`)
      }
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy('') }
  }

  // 重命名：只改这一处账号名，设备互联里的设备名会跟着一起变
  const saveName = async (event: FormEvent) => {
    event.preventDefault()
    setError(''); setMessage('')
    if (nameDraft.trim().length < 2) { setError('用户名至少需要 2 个字。'); return }
    setBusy('name')
    try {
      await unwrapDesktop(window.zsenseDesktop!.onboarding.setName(nameDraft.trim()))
      setShownName(nameDraft.trim())
      setRenameOpen(false)
      setMessage('名称已更新；设备互联里的设备名会一起变成它。')
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  // 绑定邮箱：必须先用验证码验证这个邮箱，验证通过才写入绑定（不允许"点一下就算绑上"）
  const sendBindCode = async () => {
    setBusy('send-code'); setError(''); setMessage(''); setBindHint('')
    try {
      const result = await unwrapDesktop(window.zsenseDesktop!.auth.sendBindCode(email.trim()))
      setCodeSent(true)
      const minutes = Math.max(1, Math.round((result.expiresInSeconds || 600) / 60))
      setBindHint(`验证码已发送到 ${result.masked || email.trim()}，${minutes} 分钟内有效。`)
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  const verifyBind = async (event: FormEvent) => {
    event.preventDefault()
    setError(''); setMessage('')
    if (bindCode.trim().length < 4) { setError('请输入邮件里收到的验证码。'); return }
    setBusy('verify')
    try {
      await unwrapDesktop(window.zsenseDesktop!.auth.verifyBindCode({ email: email.trim(), code: bindCode.trim() }))
      setCodeSent(false); setBindCode(''); setBindHint('')
      setMessage('邮箱已验证并绑定本机设备公钥。同邮箱的已验证设备会自动出现在受信任列表；远程读取和执行仍需单独授权。')
      await load()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  // 安全锁关闭时点按钮 = 开启：已经设过密码就直接开，没设过才弹出来设置密码
  const handleLockButton = async () => {
    setError(''); setMessage('')
    if (!settings.appLockEnabled && settings.appLockPasswordConfigured) {
      setBusy('enable')
      try {
        await onSaveSettings({ ...settings, appLockEnabled: true })
        setMessage('安全锁已开启；下次打开 ZSense 需要输入密码。')
      } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
      return
    }
    setLockOpen((open) => !open)
  }

  const saveLock = async (event: FormEvent) => {
    event.preventDefault()
    setError(''); setMessage('')
    if (lockPassword.length < 4) { setError('安全锁密码至少需要 4 位。'); return }
    if (lockPassword !== lockConfirm) { setError('两次输入的安全锁密码不一致。'); return }
    setBusy('lock')
    try {
      await unwrapDesktop(window.zsenseDesktop!.auth.setLockPassword(lockPassword))
      await onSaveSettings({ ...settings, appLockEnabled: true, appLockPasswordConfigured: true })
      setLockOpen(false); setLockPassword(''); setLockConfirm('')
      setMessage('安全锁密码已保存，安全锁已启用；下次打开 ZSense 需要输入它。')
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  const disableLock = async () => {
    setBusy('off'); setError(''); setMessage('')
    try {
      await onSaveSettings({ ...settings, appLockEnabled: false })
      setMessage('安全锁已关闭，打开 ZSense 时不再要求输入密码。')
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy('') }
  }

  return <>
    <section className="panel settings-block account-panel">
      <div className="panel-header"><div><h2>账号</h2><p>本机只有一个账号，就是最初创建的这一个。</p></div></div>
      <article className="account-card">
        <header><span className="user-security-icon"><UserRound size={18} /></span><span><small>账号</small><strong>{shownName}</strong></span><b>{currentUser.role === 'admin' ? '管理员' : '普通用户'}</b><button type="button" className="text-button" onClick={() => { setError(''); setMessage(''); setNameDraft(currentUser.displayName); setRenameOpen((open) => !open) }}><Pencil size={13} />重命名</button></header>
        {renameOpen && <form className="account-lock-form" onSubmit={saveName}>
          <input autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} maxLength={40} placeholder="新的名称" aria-label="新的名称" />
          <button type="submit" className="button primary small" disabled={busy === 'name'}>{busy === 'name' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存名称</button>
          <small>改的是这台机器唯一的账号名 —— 设备互联里的设备名也会变成它。</small>
        </form>}
        <p>@{currentUser.username} · 本机账号不用于登录，进入 ZSense 只由安全锁保护。</p>
        <form className="account-email-form" onSubmit={verifyBind}>
          <label>
            <span>邮箱（需验证码验证）</span>
            <span className="account-email-input">
              <Mail size={15} />
              <input type="email" value={email} onChange={(event) => { setEmail(event.target.value); setCodeSent(false) }} placeholder={boundMasked || 'you@example.com'} autoComplete="email" />
              <button type="button" className="button secondary small" disabled={busy !== '' || !email.trim()} onClick={() => void sendBindCode()}>{busy === 'send-code' ? <LoaderCircle className="spin" size={14} /> : <Mail size={14} />}发送验证码</button>
            </span>
          </label>
          {codeSent && <span className="account-email-code">
            <input value={bindCode} onChange={(event) => setBindCode(event.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" maxLength={8} placeholder="邮件里的验证码" aria-label="邮箱验证码" />
            <button type="submit" className="button primary small" disabled={busy !== ''}>{busy === 'verify' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}验证并绑定</button>
          </span>}
          {bindHint && <small className="account-email-hint">{bindHint}</small>}
          <small>{boundMasked ? `已绑定：${boundMasked}${deviceEmailVerified ? ' · 设备身份已验证' : ' · 旧绑定尚未验证设备身份，请重新输入邮箱并完成验证码'}。也可用此邮箱重置安全锁。` : '验证后可重置安全锁，也会将本机公钥绑定到交换中心，自动发现同邮箱设备。'}</small>
        </form>

        <div className="account-password-row">
          <span className={`security-state ${accountPasswordConfigured ? 'active' : ''}`}><i />远程访问密码{accountPasswordConfigured ? '已设置' : '未设置'}</span>
          <button type="button" className="button secondary small" onClick={() => { setError(''); setMessage(''); setAccountPasswordOpen((open) => !open) }}><KeyRound size={14} />{accountPasswordConfigured ? '修改远程访问密码' : '设置远程访问密码'}</button>
          <small>安全锁关闭时，直接打开远程网页需使用此密码；未设置则仅已配对设备能通过密钥进入。</small>
        </div>
        {accountPasswordOpen && <form className="account-lock-form" onSubmit={saveAccountPassword}>
          <input type="password" autoFocus value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} placeholder="远程访问密码（至少 4 位）" aria-label="远程访问密码" autoComplete="new-password" />
          <input type="password" value={accountPasswordConfirm} onChange={(event) => setAccountPasswordConfirm(event.target.value)} placeholder="再输一次" aria-label="确认远程访问密码" autoComplete="new-password" />
          <button type="submit" className="button primary small" disabled={busy === 'account-password'}>{busy === 'account-password' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存远程访问密码</button>
        </form>}
        <footer>
          <span className={`security-state ${settings.appLockEnabled ? 'active' : ''}`}><i />安全锁{settings.appLockEnabled ? '已启用' : '未启用'}</span>
          <button type="button" className="button secondary small" disabled={busy === 'enable'} onClick={() => void handleLockButton()}>{busy === 'enable' ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{settings.appLockEnabled ? (settings.appLockPasswordConfigured ? '重置安全锁密码' : '设置安全锁密码') : '开启安全锁'}</button>
          {settings.appLockEnabled && <button type="button" className="button secondary small" disabled={busy === 'off'} onClick={() => void disableLock()}>{busy === 'off' ? <LoaderCircle className="spin" size={14} /> : <LockKeyhole size={14} />}关闭安全锁</button>}
        </footer>
        {lockOpen && <form className="account-lock-form" onSubmit={saveLock}>
          <input type="password" autoFocus value={lockPassword} onChange={(event) => setLockPassword(event.target.value)} placeholder="新的安全锁密码（至少 4 位）" autoComplete="new-password" minLength={4} maxLength={128} />
          <input type="password" value={lockConfirm} onChange={(event) => setLockConfirm(event.target.value)} placeholder="再输一次" autoComplete="new-password" minLength={4} maxLength={128} />
          <button type="submit" className="button primary small" disabled={busy === 'lock'}>{busy === 'lock' ? <LoaderCircle className="spin" size={14} /> : <LockKeyhole size={14} />}保存并启用</button>
          <small>忘记密码时，可以在锁屏页用已绑定邮箱重置。</small>
        </form>}
      </article>

      <article className="account-card transfer-card">
        <header><span className="user-security-icon"><ShieldCheck size={18} /></span><span><small>跨平台迁移</small><strong>配置导入与导出</strong></span></header>
        <p>配置文件不包含安全锁密码、API Key、网关密钥、对话、记忆或本机路径。</p>
        <footer className="security-card-actions">
          <button type="button" className="button secondary small" onClick={() => void transferConfiguration('import')} disabled={busy !== ''}>{busy === 'import' ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}导入</button>
          <button type="button" className="button secondary small" onClick={() => void transferConfiguration('export')} disabled={busy !== ''}>{busy === 'export' ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}导出</button>
        </footer>
      </article>
      {error && <div className="inline-error user-management-error" role="alert">{error}</div>}
      {message && <div className="configuration-transfer-result" role="status"><Check size={16} /><span>{message}</span></div>}
    </section>
  </>
}
