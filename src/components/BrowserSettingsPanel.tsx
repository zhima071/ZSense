import {
  Camera,
  Code2,
  Download,
  ExternalLink,
  FolderOpen,
  Globe2,
  History,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useState } from 'react'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { AppSettings, BrowserDataState, BrowserPermissionPolicy } from '../types'

interface BrowserSettingsPanelProps {
  draft: AppSettings
  setDraft: Dispatch<SetStateAction<AppSettings>>
}

type BrowserManager = 'history' | 'downloads' | 'sites' | null

const emptyState: BrowserDataState = { history: [], downloads: [], sitePermissions: [] }
const permissionLabels: Record<BrowserPermissionPolicy, string> = { ask: '需要批准', allow: '始终允许', block: '禁止' }

function readableBytes(value: number) {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function SettingRow({ icon: Icon, title, description, children }: { icon: typeof Globe2; title: string; description: string; children: ReactNode }) {
  return <div className="browser-setting-row"><span className="browser-setting-icon"><Icon size={18} /></span><span className="browser-setting-copy"><strong>{title}</strong><small>{description}</small></span><div className="browser-setting-action">{children}</div></div>
}

function PermissionSelect({ value, onChange, label }: { value: BrowserPermissionPolicy; onChange: (value: BrowserPermissionPolicy) => void; label: string }) {
  return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as BrowserPermissionPolicy)}><option value="ask">需要批准</option><option value="allow">始终允许</option><option value="block">禁止</option></select>
}

export function BrowserSettingsPanel({ draft, setDraft }: BrowserSettingsPanelProps) {
  const [data, setData] = useState<BrowserDataState>(emptyState)
  const [manager, setManager] = useState<BrowserManager>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [siteOrigin, setSiteOrigin] = useState('')
  const [siteCamera, setSiteCamera] = useState<BrowserPermissionPolicy>('ask')
  const [siteMicrophone, setSiteMicrophone] = useState<BrowserPermissionPolicy>('ask')

  const loadState = useCallback(async () => {
    if (!window.zsenseDesktop?.browser) return
    setBusy('load')
    setError('')
    try { setData(await unwrapDesktop(window.zsenseDesktop.browser.state())) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy('') }
  }, [])

  useEffect(() => { void loadState() }, [loadState])

  const clearData = async () => {
    if (!window.zsenseDesktop?.browser) return
    setBusy('clear-data')
    setError('')
    try { setData(await unwrapDesktop(window.zsenseDesktop.browser.clearData())); setConfirmClear(false) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy('') }
  }

  const clearHistory = async (kind: 'history' | 'downloads') => {
    if (!window.zsenseDesktop?.browser) return
    setBusy(`clear-${kind}`)
    setError('')
    try { setData(await unwrapDesktop(window.zsenseDesktop.browser.clearHistory(kind))) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy('') }
  }

  const pickDownloadDirectory = async () => {
    if (!window.zsenseDesktop?.browser) return
    setBusy('directory')
    setError('')
    try {
      const selected = await unwrapDesktop(window.zsenseDesktop.browser.pickDownloadDirectory())
      if (selected) setDraft((current) => ({ ...current, browserDownloadPath: selected }))
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy('') }
  }

  const saveSitePermission = async () => {
    if (!window.zsenseDesktop?.browser || !siteOrigin.trim()) return
    setBusy('site')
    setError('')
    try {
      setData(await unwrapDesktop(window.zsenseDesktop.browser.setSitePermission({ origin: siteOrigin, camera: siteCamera, microphone: siteMicrophone })))
      setSiteOrigin('')
      setSiteCamera('ask')
      setSiteMicrophone('ask')
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy('') }
  }

  const removeSitePermission = async (origin: string) => {
    if (!window.zsenseDesktop?.browser) return
    setBusy(`site:${origin}`)
    try { setData(await unwrapDesktop(window.zsenseDesktop.browser.removeSitePermission(origin))) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy('') }
  }

  return <div className="browser-settings-stack">
    <section className="panel settings-block browser-settings-intro">
      <div className="browser-settings-brand"><span><Globe2 size={25} /></span><div><h2>浏览器</h2><p>管理 ZSense Agent 的 Browser Use 偏好、浏览数据和网站访问权限。</p></div></div>
      <button type="button" className={`switch ${draft.browserEnabled ? 'on' : ''}`} role="switch" aria-checked={draft.browserEnabled} aria-label={`${draft.browserEnabled ? '关闭' : '开启'}内置浏览器`} onClick={() => setDraft((current) => ({ ...current, browserEnabled: !current.browserEnabled }))}><span /></button>
    </section>

    <section className={`panel settings-block browser-settings-card ${draft.browserEnabled ? '' : 'disabled'}`}>
      <div className="browser-settings-section-title"><h3>常规</h3></div>
      <SettingRow icon={ExternalLink} title="网页 URL 和链接打开位置" description="网页链接默认打开位置">
        <select value={draft.browserWebLinkTarget} onChange={(event) => setDraft((current) => ({ ...current, browserWebLinkTarget: event.target.value as AppSettings['browserWebLinkTarget'] }))} aria-label="网页链接打开位置"><option value="system">默认浏览器</option><option value="zsense">ZSense</option></select>
      </SettingRow>
      <SettingRow icon={Globe2} title="本地 URL 打开位置" description="localhost、127.0.0.1 等本地开发站点的默认打开位置">
        <select value={draft.browserLocalUrlTarget} onChange={(event) => setDraft((current) => ({ ...current, browserLocalUrlTarget: event.target.value as AppSettings['browserLocalUrlTarget'] }))} aria-label="本地网址打开位置"><option value="zsense">ZSense</option><option value="system">默认浏览器</option></select>
      </SettingRow>
      <SettingRow icon={Globe2} title="显示完整网址" description="在地址栏中显示路径、查询参数和片段">
        <button type="button" className={`switch ${draft.browserShowFullUrl ? 'on' : ''}`} role="switch" aria-checked={draft.browserShowFullUrl} aria-label={`${draft.browserShowFullUrl ? '关闭' : '开启'}完整网址显示`} title={`${draft.browserShowFullUrl ? '关闭' : '开启'}完整网址显示`} onClick={() => setDraft((current) => ({ ...current, browserShowFullUrl: !current.browserShowFullUrl }))}><span /></button>
      </SettingRow>
      <SettingRow icon={Trash2} title="浏览数据" description="清除浏览历史、网站数据、缓存和下载历史">
        <button type="button" className="button secondary small" onClick={() => setConfirmClear(true)}>清除浏览数据</button>
      </SettingRow>
      <SettingRow icon={History} title="浏览历史" description={`查看和管理内置浏览器访问过的页面 · ${data.history.length} 条`}>
        <button type="button" className="button secondary small" onClick={() => setManager('history')}>管理</button>
      </SettingRow>
      <SettingRow icon={ImageIcon} title="网页截图" description="控制 Agent 是否可以截取当前网页并保存到会话工作区">
        <select value={draft.browserScreenshotPolicy} onChange={(event) => setDraft((current) => ({ ...current, browserScreenshotPolicy: event.target.value as AppSettings['browserScreenshotPolicy'] }))} aria-label="网页截图策略"><option value="always">始终允许</option><option value="ask">需要批准</option><option value="never">禁止</option></select>
      </SettingRow>
    </section>

    <section className={`panel settings-block browser-settings-card ${draft.browserEnabled ? '' : 'disabled'}`}>
      <div className="browser-settings-section-title"><h3>下载</h3></div>
      <SettingRow icon={FolderOpen} title="位置" description={draft.browserDownloadPath || '系统下载文件夹'}>
        <button type="button" className="button secondary small" disabled={busy === 'directory'} onClick={() => void pickDownloadDirectory()}>{busy === 'directory' ? <LoaderCircle className="spin" size={14} /> : null}更改</button>
      </SettingRow>
      <SettingRow icon={Download} title="下载前询问保存位置" description="对在内置浏览器中发起的下载显示保存对话框">
        <button type="button" className={`switch ${draft.browserAskDownloadLocation ? 'on' : ''}`} role="switch" aria-checked={draft.browserAskDownloadLocation} aria-label={`${draft.browserAskDownloadLocation ? '关闭' : '开启'}下载前询问保存位置`} title={`${draft.browserAskDownloadLocation ? '关闭' : '开启'}下载前询问保存位置`} onClick={() => setDraft((current) => ({ ...current, browserAskDownloadLocation: !current.browserAskDownloadLocation }))}><span /></button>
      </SettingRow>
      <SettingRow icon={History} title="下载历史记录" description={`查看和管理从内置浏览器下载的文件 · ${data.downloads.length} 条`}>
        <button type="button" className="button secondary small" onClick={() => setManager('downloads')}>管理</button>
      </SettingRow>
    </section>

    <section className={`panel settings-block browser-settings-card ${draft.browserEnabled ? '' : 'disabled'}`}>
      <div className="browser-settings-section-title"><h3>浏览器权限</h3></div>
      <SettingRow icon={Camera} title="网站设置" description={`管理内置浏览器的摄像头和麦克风权限 · ${data.sitePermissions.length} 个网站`}>
        <button type="button" className="button secondary small" onClick={() => setManager('sites')}>管理</button>
      </SettingRow>
      <SettingRow icon={History} title="历史记录" description="选择 ZSense Agent 是否可以访问内置浏览器历史记录">
        <PermissionSelect label="Agent 浏览历史访问策略" value={draft.browserHistoryAccess} onChange={(value) => setDraft((current) => ({ ...current, browserHistoryAccess: value }))} />
      </SettingRow>
      <SettingRow icon={KeyRound} title="启用站点工具" description="允许兼容网站公开 WebMCP 站点工具；实际调用仍受 Agent 审批策略约束">
        <button type="button" className={`switch ${draft.browserWebMcpEnabled ? 'on' : ''}`} role="switch" aria-checked={draft.browserWebMcpEnabled} aria-label={`${draft.browserWebMcpEnabled ? '关闭' : '开启'}站点工具`} title={`${draft.browserWebMcpEnabled ? '关闭' : '开启'}站点工具`} onClick={() => setDraft((current) => ({ ...current, browserWebMcpEnabled: !current.browserWebMcpEnabled }))}><span /></button>
      </SettingRow>
    </section>

    <section className={`panel settings-block browser-settings-card ${draft.browserEnabled ? '' : 'disabled'}`}>
      <div className="browser-settings-section-title"><h3>Agent 权限</h3><p>选择默认权限；敏感提交、登录、发布、购买和删除仍会单独审批。</p></div>
      <div className="browser-permission-table" role="group" aria-label="Agent 浏览器默认权限">
        <div className="browser-permission-head"><span>网站或模式</span><span>浏览</span><span>下载</span><span>上传</span></div>
        <div className="browser-permission-line"><strong>默认</strong><PermissionSelect label="默认浏览权限" value={draft.browserAgentBrowsePermission} onChange={(value) => setDraft((current) => ({ ...current, browserAgentBrowsePermission: value }))} /><PermissionSelect label="默认下载权限" value={draft.browserAgentDownloadPermission} onChange={(value) => setDraft((current) => ({ ...current, browserAgentDownloadPermission: value }))} /><PermissionSelect label="默认上传权限" value={draft.browserAgentUploadPermission} onChange={(value) => setDraft((current) => ({ ...current, browserAgentUploadPermission: value }))} /></div>
      </div>
    </section>

    <section className={`panel settings-block browser-settings-card browser-developer-card ${draft.browserEnabled ? '' : 'disabled'}`}>
      <div className="browser-settings-section-title"><h3>开发者模式</h3></div>
      <SettingRow icon={Code2} title="启用完整 CDP 访问权限" description="允许 Agent 通过 Chrome DevTools Protocol 读取和控制浏览器内部能力；每种调用仍会请求批准">
        <button type="button" className={`switch ${draft.browserFullCdpAccess ? 'on' : ''}`} role="switch" aria-checked={draft.browserFullCdpAccess} aria-label={`${draft.browserFullCdpAccess ? '关闭' : '开启'}完整 CDP 访问`} title={`${draft.browserFullCdpAccess ? '关闭' : '开启'}完整 CDP 访问`} onClick={() => setDraft((current) => ({ ...current, browserFullCdpAccess: !current.browserFullCdpAccess }))}><span /></button>
      </SettingRow>
      {draft.browserFullCdpAccess && <div className="browser-risk-note"><ShieldCheck size={16} /><span><strong>风险升高</strong>完整 CDP 可以读取页面内部状态。请只在开发和调试受信任网站时开启。</span></div>}
    </section>

    {error && <div className="scheduled-form-error" role="alert">{error}</div>}
    {busy === 'load' && <div className="browser-settings-loading"><LoaderCircle className="spin" size={16} />正在读取浏览器数据…</div>}

    {confirmClear && <div className="browser-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmClear(false) }}><section className="browser-manager-dialog compact" role="alertdialog" aria-modal="true" aria-labelledby="clear-browser-title"><header><div><h3 id="clear-browser-title">清除浏览数据？</h3><p>将清除 ZSense 内置浏览器的历史、Cookie、站点数据、缓存和下载记录，不影响系统默认浏览器。</p></div><button className="icon-button" onClick={() => setConfirmClear(false)} aria-label="关闭"><X size={16} /></button></header><footer><button className="button secondary" onClick={() => setConfirmClear(false)}>取消</button><button className="button danger" disabled={busy === 'clear-data'} onClick={() => void clearData()}>{busy === 'clear-data' && <LoaderCircle className="spin" size={15} />}确认清除</button></footer></section></div>}

    {manager && <div className="browser-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setManager(null) }}><section className="browser-manager-dialog" role="dialog" aria-modal="true" aria-label={manager === 'history' ? '浏览历史' : manager === 'downloads' ? '下载历史' : '网站设置'}><header><div><h3>{manager === 'history' ? '浏览历史' : manager === 'downloads' ? '下载历史记录' : '网站设置'}</h3><p>{manager === 'sites' ? '只对你明确保存的网站授予摄像头或麦克风权限。' : '这些记录只保存在当前设备的 ZSense 数据目录中。'}</p></div><button className="icon-button" onClick={() => setManager(null)} aria-label="关闭"><X size={17} /></button></header>
      {manager === 'history' && <><div className="browser-manager-list">{data.history.length ? data.history.map((entry) => <article key={entry.id}><span><Globe2 size={16} /></span><div><strong>{entry.title || entry.url}</strong><small>{entry.url}</small></div><time>{new Date(entry.visitedAt).toLocaleString('zh-CN')}</time></article>) : <div className="browser-manager-empty"><History size={25} /><span>还没有浏览历史</span></div>}</div><footer><button className="button danger secondary" disabled={!data.history.length || busy === 'clear-history'} onClick={() => void clearHistory('history')}><Trash2 size={14} />清空历史</button></footer></>}
      {manager === 'downloads' && <><div className="browser-manager-list">{data.downloads.length ? data.downloads.map((entry) => <article key={entry.id}><span><Download size={16} /></span><div><strong>{entry.fileName}</strong><small>{entry.state === 'completed' ? entry.savePath || entry.url : `${permissionLabels.ask.replace('需要批准', '下载')} ${entry.state}`}</small></div><time>{readableBytes(entry.receivedBytes || entry.totalBytes)}</time></article>) : <div className="browser-manager-empty"><Download size={25} /><span>还没有下载记录</span></div>}</div><footer><button className="button danger secondary" disabled={!data.downloads.length || busy === 'clear-downloads'} onClick={() => void clearHistory('downloads')}><Trash2 size={14} />清空记录</button></footer></>}
      {manager === 'sites' && <><div className="browser-site-form"><label><span>网站来源</span><input value={siteOrigin} onChange={(event) => setSiteOrigin(event.target.value)} placeholder="https://example.com" /></label><label><span>摄像头</span><PermissionSelect label="网站摄像头权限" value={siteCamera} onChange={setSiteCamera} /></label><label><span>麦克风</span><PermissionSelect label="网站麦克风权限" value={siteMicrophone} onChange={setSiteMicrophone} /></label><button className="button primary" disabled={!siteOrigin.trim() || busy === 'site'} onClick={() => void saveSitePermission()}><Plus size={15} />添加</button></div><div className="browser-manager-list site-list">{data.sitePermissions.length ? data.sitePermissions.map((entry) => <article key={entry.origin}><span><ShieldCheck size={16} /></span><div><strong>{entry.origin}</strong><small>摄像头：{permissionLabels[entry.camera]} · 麦克风：{permissionLabels[entry.microphone]}</small></div><button className="icon-button" disabled={busy === `site:${entry.origin}`} onClick={() => void removeSitePermission(entry.origin)} aria-label={`删除 ${entry.origin} 的网站权限`} title="删除"><Trash2 size={15} /></button></article>) : <div className="browser-manager-empty"><ShieldCheck size={25} /><span>没有自定义网站权限</span></div>}</div></>}
    </section></div>}
  </div>
}
