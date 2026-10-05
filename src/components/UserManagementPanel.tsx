import {
  Download, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw,
  Pencil, ShieldCheck, Trash2, Upload, UserRound, X,
} from 'lucide-react'
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { AppSettings, AuthUser, CreateUserInput, UserRole } from '../types'

interface UserManagementPanelProps {
  currentUser: AuthUser
  settings: AppSettings
  onSaveSettings: (settings: AppSettings) => Promise<void>
  onCurrentUserChanged: (user: AuthUser) => void
}

const emptyDraft: CreateUserInput = { username: '', displayName: '', role: 'member' }

export function UserManagementPanel({ currentUser, settings, onSaveSettings, onCurrentUserChanged }: UserManagementPanelProps) {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState<CreateUserInput>(emptyDraft)
  const [deleteTarget, setDeleteTarget] = useState<AuthUser>()
  const [editTarget, setEditTarget] = useState<AuthUser>()
  const [editDraft, setEditDraft] = useState({ username: '', displayName: '' })
  const [lockEditorOpen, setLockEditorOpen] = useState(false)
  const [lockPassword, setLockPassword] = useState('')
  const [lockConfirmation, setLockConfirmation] = useState('')
  const [lockPasswordVisible, setLockPasswordVisible] = useState(false)
  const [lockConfirmationVisible, setLockConfirmationVisible] = useState(false)
  const [lockBusy, setLockBusy] = useState(false)
  const [webUrl, setWebUrl] = useState('')
  const activeUser = useMemo(() => users.find((user) => user.id === currentUser.id) || currentUser, [currentUser, users])

  // 局域网访问地址：直接读浏览器访问服务的状态，显示在「当前使用者」卡片里
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const status = await unwrapDesktop(window.zsenseDesktop!.webBridge.status())
        if (alive) setWebUrl((status.urls || [])[0] || status.localUrl || '')
      } catch { /* 读取失败就不显示地址 */ }
    })()
    return () => { alive = false }
  }, [])

  const copyAddress = useCallback(async () => {
    if (!webUrl) return
    try {
      await window.zsenseDesktop?.clipboard.writeText(webUrl)
      setMessage('访问地址已复制。')
    } catch (error) {
      setError(errorMessage(error))
    }
  }, [webUrl])

  const clearFeedback = () => { setError(''); setMessage('') }

  const closeLockEditor = () => {
    setLockEditorOpen(false)
    setLockPassword('')
    setLockConfirmation('')
    setLockPasswordVisible(false)
    setLockConfirmationVisible(false)
  }

  const load = useCallback(async () => {
    if (!window.zsenseDesktop) return
    setLoading(true)
    setError('')
    try { setUsers(await unwrapDesktop(window.zsenseDesktop.auth.users.list())) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const createUser = async (event: FormEvent) => {
    event.preventDefault()
    if (!window.zsenseDesktop) return
    clearFeedback()
    setBusyId('create')
    try {
      await unwrapDesktop(window.zsenseDesktop.auth.users.create(draft))
      setCreateOpen(false)
      setDraft(emptyDraft)
      setMessage('本机身份已创建；身份只用于权限和数据归属，不设置账号密码。')
      await load()
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusyId(undefined) }
  }

  const updateUser = async (user: AuthUser, changes: Partial<Pick<AuthUser, 'username' | 'displayName' | 'role' | 'enabled'>>) => {
    if (!window.zsenseDesktop) return
    setBusyId(user.id)
    clearFeedback()
    try {
      const updated = await unwrapDesktop(window.zsenseDesktop.auth.users.update({
        id: user.id, username: changes.username ?? user.username, displayName: changes.displayName ?? user.displayName,
        role: changes.role ?? user.role, enabled: changes.enabled ?? user.enabled,
      }))
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (updated.id === currentUser.id) onCurrentUserChanged(updated)
      return updated
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusyId(undefined) }
  }

  const openRename = (user: AuthUser) => {
    clearFeedback()
    setEditTarget(user)
    setEditDraft({ username: user.username, displayName: user.displayName })
  }

  const saveRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!editTarget) return
    const updated = await updateUser(editTarget, editDraft)
    if (!updated) return
    setEditTarget(undefined)
    setMessage('本机身份名称已更新。')
  }

  const deleteUser = async () => {
    if (!window.zsenseDesktop || !deleteTarget) return
    setBusyId(deleteTarget.id)
    clearFeedback()
    try {
      setUsers(await unwrapDesktop(window.zsenseDesktop.auth.users.delete(deleteTarget.id)))
      setDeleteTarget(undefined)
      setMessage('本机身份已删除。')
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusyId(undefined) }
  }

  const transferConfiguration = async (mode: 'export' | 'import') => {
    if (!window.zsenseDesktop) return
    setBusyId(`configuration-${mode}`)
    clearFeedback()
    try {
      const result = await unwrapDesktop(mode === 'export' ? window.zsenseDesktop.configuration.export() : window.zsenseDesktop.configuration.import())
      if (!result.canceled) {
        const total = result.counts ? Object.values(result.counts).reduce((sum, value) => sum + value, 0) : 0
        setMessage(`${result.message}${total ? ` 共处理 ${total} 项配置。` : ''}`)
      }
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusyId(undefined) }
  }

  const saveLockPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (!window.zsenseDesktop || lockBusy) return
    clearFeedback()
    if (lockPassword.length < 4) return setError('安全锁密码至少需要 4 位。')
    if (lockPassword !== lockConfirmation) return setError('两次输入的安全锁密码不一致。')
    setLockBusy(true)
    try {
      await unwrapDesktop(window.zsenseDesktop.auth.setLockPassword(lockPassword))
      await onSaveSettings({ ...settings, appLockEnabled: true, appLockPasswordConfigured: true })
      closeLockEditor()
      setMessage('安全锁密码已保存并启用；重新打开应用、电脑锁屏或手动锁定后需要输入该密码。')
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setLockBusy(false) }
  }

  const toggleApplicationLock = async () => {
    if (lockBusy) return
    clearFeedback()
    if (!settings.appLockEnabled && !settings.appLockPasswordConfigured) {
      setLockEditorOpen(true)
      return
    }
    setLockBusy(true)
    try {
      await onSaveSettings({ ...settings, appLockEnabled: !settings.appLockEnabled })
      setMessage(settings.appLockEnabled ? '安全锁已关闭。' : '安全锁已启用，下次打开应用时会默认锁定。')
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setLockBusy(false) }
  }

  return <>
    <section className="panel settings-block user-security-overview">
      <div className="panel-header"><div><h2>本机与安全</h2><p>身份只用于本机权限与数据归属；进入 ZSense 仅由独立安全锁保护，不再使用账号密码。</p></div></div>
      <div className="user-security-grid">
        <article className={`user-security-card lock-card ${settings.appLockEnabled ? 'enabled' : ''}`}>
          <header><span className="user-security-icon"><LockKeyhole size={18} /></span><span><small>访问保护</small><strong>安全锁</strong></span><button type="button" className={`switch ${settings.appLockEnabled ? 'on' : ''}`} role="switch" aria-checked={settings.appLockEnabled} aria-label={`${settings.appLockEnabled ? '关闭' : '启用'}安全锁`} disabled={lockBusy} onClick={() => void toggleApplicationLock()}><span /></button></header>
          <p>{settings.appLockEnabled ? '应用启动、系统锁屏或手动锁定后需要解锁。' : '当前直接进入应用；开启后使用独立安全锁密码。'}</p>
          <footer><span className={`security-state ${settings.appLockEnabled ? 'active' : ''}`}><i />{settings.appLockEnabled ? '已启用' : '未启用'}</span><button type="button" className="button secondary small" onClick={() => { clearFeedback(); setLockEditorOpen(true) }}><KeyRound size={14} />{settings.appLockPasswordConfigured ? '重置安全锁密码' : '设置安全锁密码'}</button></footer>
        </article>

        <article className="user-security-card profile-card">
          <header><span className="user-security-icon"><UserRound size={18} /></span><span><small>当前使用者</small><strong>{activeUser.displayName}</strong></span><b>{activeUser.role === 'admin' ? '管理员' : '普通用户'}</b></header>
          <p>@{activeUser.username} · 本机身份不用于登录，也没有账号密码。</p>
          <p className="user-security-address">局域网访问地址 <code>{webUrl || '读取中…'}</code>{webUrl ? <button type="button" className="text-button" onClick={() => void copyAddress()}>复制</button> : null}</p>
          <footer><span className="security-state active"><i />{activeUser.enabled ? '身份已启用' : '身份已停用'}</span></footer>
        </article>

        <article className="user-security-card transfer-card">
          <header><span className="user-security-icon"><ShieldCheck size={18} /></span><span><small>跨平台迁移</small><strong>配置导入与导出</strong></span></header>
          <p>配置文件不包含安全锁密码、API Key、网关密钥、对话、记忆或本机路径。</p>
          <footer className="security-card-actions"><button type="button" className="button secondary small" onClick={() => void transferConfiguration('import')} disabled={Boolean(busyId)}>{busyId === 'configuration-import' ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}导入</button><button type="button" className="button secondary small" onClick={() => void transferConfiguration('export')} disabled={Boolean(busyId)}>{busyId === 'configuration-export' ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}导出</button></footer>
        </article>
      </div>
      {error && <div className="inline-error user-management-error" role="alert">{error}</div>}
      {message && <div className="configuration-transfer-result" role="status"><ShieldCheck size={16} /><span>{message}</span></div>}
    </section>

    <section className="panel settings-block user-identities-block">
      <div className="panel-header"><div><h2>本机身份</h2><p>用于区分数据归属和管理权限，不需要账号密码。</p></div><div className="user-panel-actions"><button type="button" className="button secondary small" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新</button><button type="button" className="button primary small" onClick={() => { clearFeedback(); setCreateOpen(true) }}><Plus size={14} />新建身份</button></div></div>
      <div className="identity-list" aria-busy={loading}>
        {users.map((user) => {
          const isCurrent = user.id === currentUser.id
          const busy = busyId === user.id
          return <article className="identity-row" key={user.id}>
            <div className="user-identity"><span className="user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}{isCurrent && <em>当前</em>}</strong><small>@{user.username}</small></span><button type="button" className="text-button identity-rename" onClick={() => openRename(user)} disabled={busy} aria-label={`重命名 ${user.displayName}`}><Pencil size={13} />重命名</button></div>
            <div className="identity-meta"><span>更新于 {new Date(user.updatedAt || user.createdAt).toLocaleDateString('zh-CN')}</span><span>无账号密码</span></div>
            <div className="identity-controls"><label className="user-table-select"><span className="sr-only">{user.displayName}的角色</span><select value={user.role} disabled={busy || isCurrent} onChange={(event) => void updateUser(user, { role: event.target.value as UserRole })}><option value="admin">管理员</option><option value="member">普通用户</option></select></label><button className={`user-status-toggle ${user.enabled ? 'enabled' : ''}`} role="switch" aria-checked={user.enabled} disabled={busy || isCurrent} onClick={() => void updateUser(user, { enabled: !user.enabled })}><i />{user.enabled ? '已启用' : '已停用'}</button>{busy && <LoaderCircle className="spin" size={15} />}<button className="icon-button bordered danger-icon" onClick={() => { clearFeedback(); setDeleteTarget(user) }} disabled={busy || isCurrent} aria-label={`删除 ${user.displayName}`} title={isCurrent ? '不能删除当前身份' : '删除身份'}><Trash2 size={15} /></button></div>
          </article>
        })}
        {loading && <div className="user-table-empty"><LoaderCircle className="spin" size={19} />正在读取本机身份…</div>}
        {!loading && !users.length && <div className="user-table-empty">还没有可显示的本机身份。</div>}
      </div>
    </section>

    {lockEditorOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !lockBusy) closeLockEditor() }}>
      <form className="user-dialog compact" role="dialog" aria-modal="true" aria-labelledby="lock-password-title" onSubmit={saveLockPassword}>
        <header><div><span className="eyebrow">SECURITY LOCK</span><h2 id="lock-password-title">{settings.appLockPasswordConfigured ? '重置安全锁密码' : '设置安全锁密码'}</h2><p>这个密码只用于解锁 ZSense，不是账号密码，也不会随配置导出。</p></div><button className="icon-button" type="button" onClick={closeLockEditor} aria-label="关闭"><X size={18} /></button></header>
        <div className="user-dialog-fields"><div className="user-dialog-field"><label htmlFor="security-lock-password">新安全锁密码</label><div className="user-password-input"><input id="security-lock-password" autoFocus value={lockPassword} onChange={(event) => setLockPassword(event.target.value)} type={lockPasswordVisible ? 'text' : 'password'} autoComplete="new-password" minLength={4} maxLength={128} required /><button type="button" onClick={() => setLockPasswordVisible((visible) => !visible)} aria-label={lockPasswordVisible ? '隐藏安全锁密码' : '显示安全锁密码'} aria-pressed={lockPasswordVisible} title={lockPasswordVisible ? '隐藏密码' : '显示密码'}>{lockPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><small>至少 4 位，无字母或数字组合要求。</small></div><div className="user-dialog-field"><label htmlFor="security-lock-confirmation">确认安全锁密码</label><div className="user-password-input"><input id="security-lock-confirmation" value={lockConfirmation} onChange={(event) => setLockConfirmation(event.target.value)} type={lockConfirmationVisible ? 'text' : 'password'} autoComplete="new-password" minLength={4} maxLength={128} required /><button type="button" onClick={() => setLockConfirmationVisible((visible) => !visible)} aria-label={lockConfirmationVisible ? '隐藏确认密码' : '显示确认密码'} aria-pressed={lockConfirmationVisible} title={lockConfirmationVisible ? '隐藏密码' : '显示密码'}>{lockConfirmationVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></div></div>
        {error && <div className="auth-error user-dialog-error" role="alert">{error}</div>}
        <footer><button className="button secondary" type="button" onClick={closeLockEditor}>取消</button><button className="button primary" type="submit" disabled={lockBusy || lockPassword.length < 4 || lockPassword !== lockConfirmation}>{lockBusy && <LoaderCircle className="spin" size={16} />}{settings.appLockPasswordConfigured ? '保存新密码' : '保存并启用'}</button></footer>
      </form>
    </div>}

    {createOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false) }}>
      <form className="user-dialog" role="dialog" aria-modal="true" aria-labelledby="create-user-title" onSubmit={createUser}>
        <header><div><span className="eyebrow">LOCAL IDENTITY</span><h2 id="create-user-title">新建本机身份</h2><p>只用于当前设备上的权限与数据归属，不创建账号密码。</p></div><button className="icon-button" type="button" onClick={() => setCreateOpen(false)} aria-label="关闭"><X size={18} /></button></header>
        <div className="user-dialog-fields"><label><span>显示名称</span><input autoFocus value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder="例如：运营同事" autoComplete="name" required /></label><label><span>身份标识</span><input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="例如：operator" autoComplete="off" minLength={3} maxLength={40} required /><small>3–40 位，可使用字母、数字、点、下划线和短横线。</small></label><label><span>权限</span><select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as UserRole })}><option value="member">普通用户</option><option value="admin">管理员</option></select><small>{draft.role === 'admin' ? '可以管理本机身份和全部工作台功能。' : '可以使用工作台，但不能管理本机身份。'}</small></label></div>
        {error && <div className="auth-error user-dialog-error" role="alert">{error}</div>}
        <footer><button className="button secondary" type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="button primary" type="submit" disabled={busyId === 'create'}>{busyId === 'create' && <LoaderCircle className="spin" size={16} />}创建身份</button></footer>
      </form>
    </div>}

    {editTarget && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && busyId !== editTarget.id) setEditTarget(undefined) }}>
      <form className="user-dialog compact" role="dialog" aria-modal="true" aria-labelledby="rename-user-title" onSubmit={saveRename}>
        <header><div><span className="eyebrow">LOCAL IDENTITY</span><h2 id="rename-user-title">重命名本机身份</h2><p>显示名称会立即同步到侧边栏；身份标识用于本机数据归属。</p></div><button className="icon-button" type="button" onClick={() => setEditTarget(undefined)} aria-label="关闭"><X size={18} /></button></header>
        <div className="user-dialog-fields"><label><span>显示名称</span><input autoFocus value={editDraft.displayName} onChange={(event) => setEditDraft({ ...editDraft, displayName: event.target.value })} maxLength={80} required /></label><label><span>身份标识</span><input value={editDraft.username} onChange={(event) => setEditDraft({ ...editDraft, username: event.target.value })} minLength={3} maxLength={40} pattern="[A-Za-z0-9._-]{3,40}" required /><small>3–40 位，可使用字母、数字、点、下划线和短横线。</small></label></div>
        {error && <div className="auth-error user-dialog-error" role="alert">{error}</div>}
        <footer><button className="button secondary" type="button" onClick={() => setEditTarget(undefined)}>取消</button><button className="button primary" type="submit" disabled={busyId === editTarget.id}>{busyId === editTarget.id && <LoaderCircle className="spin" size={16} />}保存名称</button></footer>
      </form>
    </div>}

    {deleteTarget && <div className="dialog-backdrop" role="presentation"><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-user-title"><div className="confirm-icon"><Trash2 size={22} /></div><h2 id="delete-user-title">删除 {deleteTarget.displayName}？</h2><p>该本机身份及权限将被移除。Bot、记忆、技能和消息网关不会被删除。</p><div><button className="button secondary" onClick={() => setDeleteTarget(undefined)}>取消</button><button className="button primary danger-action" onClick={() => void deleteUser()} disabled={busyId === deleteTarget.id}>{busyId === deleteTarget.id && <LoaderCircle className="spin" size={16} />}确认删除</button></div></section></div>}
  </>
}
