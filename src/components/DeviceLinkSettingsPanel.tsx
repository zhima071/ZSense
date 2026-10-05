import {Lock,  Check, Copy, Laptop2, Link2, LoaderCircle, MonitorSmartphone, Network, Play, RefreshCw, ShieldCheck, Unlink2, Wifi, WifiOff, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { writeTextToClipboard } from '../services/clipboard'
import { errorMessage, unwrapDesktop } from '../services/desktop'
import type { DeviceLinkRemoteRunResult, DeviceLinkRemoteStatus, DeviceLinkStatus } from '../types'

type DeviceAction = 'toggle' | 'refresh' | 'code' | 'unified' | `connect:${string}` | `disconnect:${string}` | `unpair:${string}` | `access:${string}` | `status:${string}` | null
type TrustedPeer = DeviceLinkStatus['trustedPeers'][number]

function relativeTime(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '尚未连接'
  const delta = Math.max(0, Date.now() - timestamp)
  if (delta < 15_000) return '刚刚'
  if (delta < 60_000) return `${Math.floor(delta / 1_000)} 秒前`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
}

function platformIcon(platform: string) {
  return platform === 'darwin' || platform === 'win32' ? MonitorSmartphone : Laptop2
}

export function DeviceLinkSettingsPanel({ onOpenSecurity }: { onOpenSecurity?: () => void } = {}) {
  const [status, setStatus] = useState<DeviceLinkStatus>()
  const [deviceCopied, setDeviceCopied] = useState(false)
  const [action, setAction] = useState<DeviceAction>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [connectionTarget, setConnectionTarget] = useState('')
  const [connectionCode, setConnectionCode] = useState('')
  // 远程连接（公网）：与局域网直连相互独立，前置条件是已开启设备锁
  const remote = status?.remote ?? {
    enabled: false, running: false, hostname: 'app.zsense.space', url: '',
    mode: 'named' as const, tunnelName: 'zsense', tokenConfigured: false,
    deviceLockEnabled: false, startedAt: '', deviceId: '', publicUrl: '', hubUrl: 'https://hub.zsense.space',
    identityPublicKey: '', publicKeyFingerprint: '', accountVerified: false, sameEmailPeers: [],
    upstreamMode: 'auto' as const, upstream: '', registeredAt: '', lastError: '',
  }
  // 邮箱仅由中心验证归属；免密连接必须由已绑定的设备公钥验签。
  const connectSameEmailPeer = async (peer: { deviceId: string; name: string; url: string }) => {
    setNotice('')
    if (!/^[a-z0-9][a-z0-9-]{1,58}$/.test(peer.deviceId)) { setNotice('对方设备号无效，请检查设备列表。'); return }
    const safeUrl = `https://${peer.deviceId}.zsense.space`
    try {
      const result = await unwrapDesktop(window.zsenseDesktop!.deviceLink.trustConnect(peer.deviceId))
      window.open(result.url || safeUrl, '_blank', 'noopener')
      setNotice(`已免密进入 ${peer.name || peer.deviceId}。`)
    } catch (reason) {
      // 密钥验证失败时仍可打开目标地址，用对方安全锁密码进入。
      setNotice(`${errorMessage(reason)} 已改为直接打开，可用对方安全锁密码进入。`)
      window.open(safeUrl, '_blank', 'noopener')
    }
  }

  const revokeRemoteIdentity = async () => {
    if (!remote.deviceId || !window.confirm(`永久撤销公网设备号 ${remote.deviceId}？旧地址将立即停止转发且不能被重新注册；下次开启会由中心分配新设备号。`)) return
    await run('unified', () => unwrapDesktop(window.zsenseDesktop!.deviceLink.revokeRemoteIdentity()), '公网设备号已永久撤销，相关远程会话已失效。')
  }
  const copyRemoteUrl = async () => {
    try {
      await writeTextToClipboard(remote.deviceId || remote.publicUrl || remote.url)
      setNotice('设备号已复制。')
    } catch {
      setNotice('复制失败，请手动选中地址复制。')
    }
     setDeviceCopied(true)
    window.setTimeout(() => setDeviceCopied(false), 1_500)
  }

  const [copiedCode, setCopiedCode] = useState<'cloud' | 'lan' | null>(null)
  const [remoteStatus, setRemoteStatus] = useState<{ peer: TrustedPeer; status: DeviceLinkRemoteStatus }>()
  const [taskPeer, setTaskPeer] = useState<TrustedPeer>()
  const [taskPrompt, setTaskPrompt] = useState('')
  const [taskBusy, setTaskBusy] = useState(false)
  const [taskResult, setTaskResult] = useState<{ peerName: string; result: DeviceLinkRemoteRunResult }>()

  const applyStatus = useCallback((next: DeviceLinkStatus) => {
    setStatus(next)
  }, [])

  const copyPairingCode = async (mode: 'cloud' | 'lan') => {
    try {
      // 复制前读取最新状态：过期的 6 位码会在主进程轮换，界面与剪贴板保持一致。
      const current = await unwrapDesktop(window.zsenseDesktop!.deviceLink.status())
      applyStatus(current)
      if (!current.pairingCode || (mode === 'lan' && !current.pairingIdentityCode)) throw new Error('请先启用设备互联以生成配对码。')
      await writeTextToClipboard(mode === 'lan' ? `${current.pairingCode}-${current.pairingIdentityCode}` : current.pairingCode)
      setCopiedCode(mode)
      window.setTimeout(() => setCopiedCode((previous) => previous === mode ? null : previous), 1_500)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const load = useCallback(async () => {
    if (!window.zsenseDesktop?.deviceLink) return
    try {
      applyStatus(await unwrapDesktop(window.zsenseDesktop.deviceLink.status()))
      setError('')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }, [applyStatus])

  useEffect(() => {
    void load()
    return window.zsenseDesktop?.deviceLink?.onChanged(applyStatus)
  }, [applyStatus, load])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 打开设备互联界面时自动扫描一次：不点任何按钮也能看到局域网里的设备。
  const autoScannedRef = useRef(false)
  useEffect(() => {
    if (autoScannedRef.current || !status?.enabled || !status?.running) return
    autoScannedRef.current = true
    void run('refresh', () => unwrapDesktop(window.zsenseDesktop!.deviceLink.refresh()))
  }, [status?.enabled, status?.running])

  const run = async (nextAction: Exclude<DeviceAction, null>, operation: () => Promise<DeviceLinkStatus>, success = '') => {
    setAction(nextAction)
    setError('')
    setNotice('')
    try {
      applyStatus(await operation())
      if (success) setNotice(success)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setAction(null)
    }
  }

  const discovered = useMemo(() => status?.discoveredDevices.filter((device) => !device.paired) || [], [status])
  const onlineCount = status?.trustedPeers.filter((peer) => peer.connectionMode === 'lan').length || 0
  const cloudCount = status?.trustedPeers.filter((peer) => peer.connectionMode === 'cloud').length || 0
  const available = Boolean(window.zsenseDesktop?.deviceLink)
  const target = connectionTarget.trim().toLowerCase()
  const trustedTarget = status?.trustedPeers.find((peer) => peer.deviceId.toLowerCase() === target || peer.remoteDeviceId?.toLowerCase() === target)
  const nearbyTarget = discovered.find((device) => device.deviceId.toLowerCase() === target)
  const manualTarget = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(target)
  const localTarget = Boolean(nearbyTarget || manualTarget)
  const requiredCode = localTarget ? /^\d{6}-[0-9A-F]{16}$/ : /^\d{6}$/
  const canConnect = Boolean(status?.enabled && target && action === null && (trustedTarget || requiredCode.test(connectionCode)))

  const connectUnified = async () => {
    if (!canConnect) return
    setAction('unified')
    setError('')
    setNotice('')
    try {
      if (trustedTarget?.source === 'remote' || trustedTarget?.connectionMode === 'cloud') {
        const result = await unwrapDesktop(window.zsenseDesktop!.deviceLink.trustConnect(trustedTarget.remoteDeviceId || trustedTarget.deviceId))
        window.open(result.url, '_blank', 'noopener')
        setNotice(`已通过云端打开 ${trustedTarget.name}；设备密钥已验证。`)
      } else if (trustedTarget) {
        applyStatus(await unwrapDesktop(window.zsenseDesktop!.deviceLink.connect(trustedTarget.deviceId)))
        setNotice(`已通过局域网连接 ${trustedTarget.name}。`)
      } else if (nearbyTarget) {
        applyStatus(await unwrapDesktop(window.zsenseDesktop!.deviceLink.pair(nearbyTarget.deviceId, connectionCode)))
        setNotice(`已通过局域网与 ${nearbyTarget.name} 安全配对。`)
      } else if (manualTarget) {
        const [address, port] = target.split(':')
        applyStatus(await unwrapDesktop(window.zsenseDesktop!.deviceLink.pairByAddress({ address, port: Number(port) || 39072, code: connectionCode })))
        setNotice(`已通过局域网地址 ${target} 安全配对。`)
      } else {
        const result = await unwrapDesktop(window.zsenseDesktop!.deviceLink.pairConnect(target, connectionCode))
        window.open(result.url, '_blank', 'noopener')
        await load()
        setNotice(`已通过云端与 ${target} 配对；双方分别授权后即可互发 Agent 任务。`)
      }
      setConnectionCode('')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setAction(null)
    }
  }

  const loadRemoteStatus = async (peer: TrustedPeer) => {
    setAction(`status:${peer.deviceId}`)
    setError('')
    setNotice('')
    try {
      setRemoteStatus({ peer, status: await unwrapDesktop(window.zsenseDesktop!.deviceLink.remoteStatus(peer.deviceId)) })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setAction(null)
    }
  }

  const sendRemoteTask = async () => {
    if (!taskPeer || !taskPrompt.trim() || taskBusy) return
    setTaskBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await unwrapDesktop(window.zsenseDesktop!.deviceLink.remoteRun({ deviceId: taskPeer.deviceId, prompt: taskPrompt.trim() }))
      setTaskResult({ peerName: taskPeer.name, result })
      setTaskPeer(undefined)
      setTaskPrompt('')
      setNotice(`远程任务已在 ${taskPeer.name} 上执行完成。`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setTaskBusy(false)
    }
  }

  if (!available) {
    return <div className="panel settings-block device-link-panel"><div className="device-link-empty"><Network size={24} /><strong>设备互联仅在桌面端可用</strong><small>请打开 ZSense macOS 或 Windows 应用进行配置。</small></div></div>
  }

  if (!status) {
    return <div className="panel settings-block device-link-panel"><div className="device-link-loading" role="status"><LoaderCircle className="spin" size={20} />正在读取本机设备状态…</div></div>
  }

  return <div className="device-link-settings">
    <section className="panel settings-block device-link-panel">
      <div className="panel-header device-link-header">
        <div><h2>设备互联</h2><p className="device-link-summary">从同一入口连接附近设备或云端设备；连接后会标明实际通道。远程访问须先开启安全锁。</p></div>
        <div className="device-link-header-actions">
          <span className={`status-label ${status.running ? 'online' : status.enabled ? 'paused' : 'offline'}`}><i />{status.running ? onlineCount || cloudCount ? `${onlineCount} 台局域网 · ${cloudCount} 台云端在线` : '正在发现' : status.enabled ? '启动失败' : '已关闭'}</span>
          <button type="button" className={`switch ${status.enabled ? 'on' : ''}`} role="switch" aria-checked={status.enabled} aria-label={`${status.enabled ? '关闭' : '启用'}设备互联`} disabled={action === 'toggle'} onClick={() => void run('toggle', async () => {
            await unwrapDesktop(window.zsenseDesktop!.deviceLink.setEnabled(!status.enabled))
            if (!status.enabled) {
              try { await window.zsenseDesktop!.webBridge.setEnabled(true) } catch { /* 浏览器访问开启失败不影响设备互联 */ }
              if (remote.deviceLockEnabled) {
                try { await unwrapDesktop(window.zsenseDesktop!.deviceLink.setRemoteEnabled(true)) } catch { /* 远程开启失败不阻塞其它能力 */ }
              } else {
                setNotice('局域网与浏览器访问已开启；开启「安全锁」后远程连接会自动可用。')
                onOpenSecurity?.()
              }
            } else {
              try { await unwrapDesktop(window.zsenseDesktop!.deviceLink.setRemoteEnabled(false)) } catch { /* 忽略 */ }
              try { await unwrapDesktop(window.zsenseDesktop!.webBridge.setEnabled(false)) } catch { /* 忽略 */ }
            }
            return unwrapDesktop(window.zsenseDesktop!.deviceLink.status())
          }, status.enabled ? '设备互联已关闭。' : '设备互联已启用。')}><span /></button>
        </div>
      </div>


      <div className="device-link-local-card">
        <div className="device-link-local-identity">
          <div className="device-link-local-icon"><MonitorSmartphone size={22} /></div>
          <div className="device-link-local-main">
            <small>本机设备</small>
            <div className="device-link-local-meta"><span>{status.device.platformLabel}</span><span>{status.device.addresses.join(' / ') || '暂无局域网地址'}</span>{status.device.port > 0 && <span>端口 {status.device.port}</span>}</div>
          </div>
        </div>
        <div className="device-link-code-block">
          <small>设备号</small>
          <strong aria-label={`本机设备号 ${remote.deviceId || '生成中'}`}>{remote.deviceId || '生成中…'}</strong>
          <button type="button" className="icon-button compact" title="复制设备地址" aria-label="复制设备地址" disabled={!remote.deviceId} onClick={() => void copyRemoteUrl()}>{deviceCopied ? <Check size={15} /> : <Copy size={15} />}</button>
        </div>
        <div className="device-link-code-block device-link-code-block--secure">
          <small>配对码 · 云端使用 6 位数字</small>
          <strong aria-label={`本机 6 位配对码 ${status.pairingCode || '未启用'}`}>{status.pairingCode || '—'}</strong>
          <div className="device-link-pair-code-actions">
            <button type="button" className="button secondary small" title="复制云端配对码（仅 6 位数字）" disabled={!status.pairingCode} onClick={() => void copyPairingCode('cloud')}>{copiedCode === 'cloud' ? <Check size={14} /> : <Copy size={14} />}复制云端码</button>
            <button type="button" className="icon-button compact" title="刷新配对码" aria-label="刷新配对码" disabled={!status.running || action !== null} onClick={() => void run('code', () => unwrapDesktop(window.zsenseDesktop!.deviceLink.refreshCode()), '已生成新的配对码。')}>{action === 'code' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button>
          </div>
          <div className="device-link-pair-lan-row">
            <small>局域网身份码 <code>{status.pairingIdentityCode || '—'}</code></small>
            <button type="button" className="button secondary small" title="复制局域网安全码（6 位数字 + 16 位身份码）" disabled={!status.pairingCode || !status.pairingIdentityCode} onClick={() => void copyPairingCode('lan')}>{copiedCode === 'lan' ? <Check size={14} /> : <Copy size={14} />}复制局域网码</button>
          </div>
        </div>
      </div>
      {(error || status.error || notice) && <div className={`device-link-feedback ${error || status.error ? 'error' : 'success'}`} role={error || status.error ? 'alert' : 'status'}>{error || status.error || notice}</div>}
      {status.enabled && <form className="device-link-unified" onSubmit={(event) => { event.preventDefault(); void connectUnified() }}>
        <div className="device-link-unified-heading"><strong>连接另一台设备</strong><small>输入附近设备 ID、局域网 IP，或云端设备号</small></div>
        <div className="device-link-unified-fields">
          <label><span>目标设备</span><input list="zsense-nearby-devices" value={connectionTarget} maxLength={128} autoComplete="off" placeholder="设备 ID / 192.168.x.x / 云端设备号" onChange={(event) => setConnectionTarget(event.target.value.trim().slice(0, 128))} /></label>
          <datalist id="zsense-nearby-devices">{discovered.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.name} · 局域网</option>)}{status.trustedPeers.map((peer) => <option key={peer.deviceId} value={peer.remoteDeviceId || peer.deviceId}>{peer.name} · {peer.source === 'remote' ? '云端' : '局域网'}</option>)}</datalist>
          <label><span>{trustedTarget ? '已配对' : localTarget ? '完整安全配对码' : '6 位配对码'}</span><input value={connectionCode} maxLength={23} autoComplete="one-time-code" placeholder={trustedTarget ? '无需再次输入' : localTarget ? '123456-0123456789ABCDEF' : '123456'} disabled={Boolean(trustedTarget)} onChange={(event) => setConnectionCode(event.target.value.toUpperCase().replace(/[^0-9A-F-]/g, '').slice(0, 23))} /></label>
          <button type="submit" className="button primary" disabled={!canConnect}>{action === 'unified' ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}{action === 'unified' ? '连接中…' : '连接'}</button>
        </div>
        <small className="device-link-unified-hint">局域网首次连接使用完整安全配对码；云端首次连接使用前 6 位数字。已配对设备无需重复输入。设备不在附近时可填写 IP:端口。</small>
      </form>}
    </section>

    <div className="device-link-pair-row">
    {status.enabled && <div className="device-link-grid">
      <section className="panel settings-block device-link-list-card" data-lan-block="nearby">
        <div className="panel-header"><div><h2>附近设备</h2>{status.scanProgress && <small role="status">扫描中 {status.scanProgress.scanned}/{status.scanProgress.total}</small>}</div><button type="button" className="icon-button compact" title="立即扫描局域网" aria-label="立即扫描局域网" disabled={action !== null} onClick={() => void run('refresh', () => unwrapDesktop(window.zsenseDesktop!.deviceLink.refresh()), '扫描完成。')}>{action === 'refresh' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button></div>
        <div className="device-link-device-list">
          {discovered.map((device) => {
            const Icon = platformIcon(device.platform)
            return <div className="device-link-device-row" key={device.deviceId} title={`${device.platformLabel} · ${device.address} · ${relativeTime(device.lastSeenAt)}`}>
              <span className="device-link-platform-icon"><Icon size={18} /></span>
              <span className="device-link-device-meta"><strong>{device.name}</strong><small>{device.address} · {device.platformLabel}</small></span>
              <button type="button" className="button secondary small" onClick={() => setConnectionTarget(device.deviceId)}>选择</button>
            </div>
          })}
          {!discovered.length && <div className="device-link-empty"><Wifi size={22} /><strong>暂未发现新设备</strong><small>可以直接在上方输入云端设备号，或使用对方的局域网 IP。</small></div>}
        </div>
      </section>

      <section className="panel settings-block device-link-list-card" data-lan-block="trusted">
        <div className="panel-header"><div><h2>受信任设备</h2></div><span className="device-link-count">{status.trustedPeers.length}</span></div>
        <div className="device-link-device-list">
          {status.trustedPeers.map((peer) => {
            const Icon = platformIcon(peer.platform)
            const connecting = action === `connect:${peer.deviceId}`
            const disconnecting = action === `disconnect:${peer.deviceId}`
            const unpairing = action === `unpair:${peer.deviceId}`
            const checkingStatus = action === `status:${peer.deviceId}`
            const togglingAccess = action === `access:${peer.deviceId}`
            const access = peer.access || { allowStatus: false, allowFiles: false, allowTasks: false }
            const setAccess = (next: { allowStatus: boolean; allowFiles: boolean; allowTasks: boolean }) => void run(`access:${peer.deviceId}`, () => unwrapDesktop(window.zsenseDesktop!.deviceLink.setPeerAccess({ deviceId: peer.deviceId, access: next })), `${peer.name} 的远程权限已更新。`)
            return <div className="device-link-peer" key={peer.deviceId}>
              <div className="device-link-device-row trusted" title={`${peer.platformLabel} · ${peer.address} · 最后连接 ${relativeTime(peer.lastSeenAt)}`}>
                <span className={`device-link-platform-icon ${peer.online ? 'online' : ''}`}><Icon size={18} /></span>
                <span className="device-link-device-meta"><strong>{peer.name}<i className={peer.connectionMode !== 'offline' ? 'online' : ''}>{peer.connectionMode === 'lan' || peer.connectionMode === 'cloud' ? '在线' : peer.connected ? '离线' : '已断开'}</i><em className={`device-link-peer-via ${peer.connectionMode === 'cloud' ? 'remote' : 'lan'}`}>{peer.connectionMode === 'lan' ? '局域网连接' : peer.connectionMode === 'cloud' ? '云端连接' : '未连接'}</em></strong></span>
                <div className="device-link-actions">
                  {peer.remoteDeviceId && peer.identityPublicKey && peer.connected && <button type="button" className="button secondary small" title="使用已配对的设备密钥免密打开远程页面" onClick={() => void connectSameEmailPeer({ deviceId: peer.remoteDeviceId!, name: peer.name, url: `https://${peer.remoteDeviceId}.zsense.space` })}>远程打开</button>}
                  {peer.connected ? <button type="button" className="button secondary small" disabled={action !== null} onClick={() => void run(`disconnect:${peer.deviceId}`, () => unwrapDesktop(window.zsenseDesktop!.deviceLink.disconnect(peer.deviceId)), `已断开 ${peer.name}，授权仍保留。`)}>{disconnecting ? <LoaderCircle className="spin" size={14} /> : <WifiOff size={14} />}断开</button> : <button type="button" className="button secondary small" disabled={action !== null} onClick={() => void run(`connect:${peer.deviceId}`, () => unwrapDesktop(window.zsenseDesktop!.deviceLink.connect(peer.deviceId)), `已重新连接 ${peer.name}。`)}>{connecting ? <LoaderCircle className="spin" size={14} /> : <Wifi size={14} />}重连</button>}
                  <button type="button" className="button danger-outline small" disabled={action !== null} onClick={() => { if (window.confirm(`撤销 ${peer.name} 的设备授权？之后需要重新输入配对码。`)) void run(`unpair:${peer.deviceId}`, () => unwrapDesktop(window.zsenseDesktop!.deviceLink.unpair(peer.deviceId)), `已撤销 ${peer.name} 的授权。`) }}>{unpairing ? <LoaderCircle className="spin" size={14} /> : <Unlink2 size={14} />}撤销</button>
                </div>
              </div>
              <div className="device-link-peer-access">
                {peer.source === 'remote' ? <>
                  <span className="device-link-peer-access-label">云端设备已验证公钥；任务执行仍需接收方单独授权。</span>
                  <button type="button" className={`switch ${access.allowTasks ? 'on' : ''}`} role="switch" aria-checked={access.allowTasks} aria-label={`${access.allowTasks ? '关闭' : '开启'}允许 ${peer.name} 通过云端在本机执行任务`} disabled={togglingAccess} onClick={() => setAccess({ ...access, allowTasks: !access.allowTasks })}><span /></button>
                  <span className="device-link-peer-access-label">允许在本机执行任务</span>
                  <button type="button" className="button primary small" disabled={!peer.connected || action !== null} onClick={() => { setTaskPeer(peer); setTaskPrompt(''); setTaskResult(undefined) }}><Play size={14} />发送 Agent 任务</button>
                </> : <>
                <button type="button" className={`switch ${access.allowStatus ? 'on' : ''}`} role="switch" aria-checked={access.allowStatus} aria-label={`${access.allowStatus ? '关闭' : '开启'}允许 ${peer.name} 读取本机状态与内容`} disabled={togglingAccess} onClick={() => setAccess({ ...access, allowStatus: !access.allowStatus })}><span /></button>
                <span className="device-link-peer-access-label">读取状态 / Bot / 对话</span>
                <button type="button" className={`switch ${access.allowFiles ? 'on' : ''}`} role="switch" aria-checked={access.allowFiles} aria-label={`${access.allowFiles ? '关闭' : '开启'}允许 ${peer.name} 读取本机文件`} disabled={togglingAccess} onClick={() => setAccess({ ...access, allowFiles: !access.allowFiles })}><span /></button>
                <span className="device-link-peer-access-label" title="开启后对方可读取本机任意非凭据文件，请仅授权可信设备">读取本机文件</span>
                <button type="button" className={`switch ${access.allowTasks ? 'on' : ''}`} role="switch" aria-checked={access.allowTasks} aria-label={`${access.allowTasks ? '关闭' : '开启'}允许 ${peer.name} 在本机执行任务`} disabled={togglingAccess} onClick={() => setAccess({ ...access, allowTasks: !access.allowTasks })}><span /></button>
                <span className="device-link-peer-access-label">在本机执行远程任务</span>
                <div className="device-link-peer-access-actions">
                  <button type="button" className="button secondary small" disabled={!peer.online || action !== null} onClick={() => void loadRemoteStatus(peer)}>{checkingStatus ? <LoaderCircle className="spin" size={14} /> : <MonitorSmartphone size={14} />}查看对方状态</button>
                  <button type="button" className="button primary small" disabled={peer.connectionMode === 'offline' || action !== null} onClick={() => { setTaskPeer(peer); setTaskPrompt(''); setTaskResult(undefined) }}><Play size={14} />发送任务到对方</button>
                </div>
                </>}
              </div>
            </div>
          })}
          {!status.trustedPeers.length && <div className="device-link-empty"><ShieldCheck size={22} /><strong>还没有受信任设备</strong><small>两台设备分别验证同一邮箱后会自动出现在这里；也可用配对码手动连接。</small></div>}
        </div>
      </section>
    </div>}

    {remoteStatus && <div className="device-link-overlay" role="dialog" aria-label={`${remoteStatus.peer.name} 的运行状态`}>
      <div className="panel device-link-dialog">
        <div className="panel-header"><div><h2>{remoteStatus.peer.name} 的运行状态</h2></div><button type="button" className="icon-button compact" aria-label="关闭" onClick={() => setRemoteStatus(undefined)}><X size={16} /></button></div>
        <div className="device-link-status-grid">
          <div><small>系统</small><strong>{remoteStatus.status.device.platformLabel}</strong><span>ZSense v{remoteStatus.status.app.version}</span></div>
          <div><small>已运行</small><strong>{Math.max(0, Math.round(remoteStatus.status.app.uptimeMs / 60_000))} 分钟</strong><span>{new Date(remoteStatus.status.app.startedAt).toLocaleString('zh-CN')} 启动</span></div>
          <div><small>Bot</small><strong>{remoteStatus.status.activity.bots} 个</strong><span>{remoteStatus.status.activity.onlineBots} 个在线</span></div>
          <div><small>会话</small><strong>{remoteStatus.status.activity.conversations} 个</strong><span>记忆 {remoteStatus.status.activity.memories} 条</span></div>
          <div><small>定时任务</small><strong>{remoteStatus.status.activity.scheduledTasks} 个</strong><span>{remoteStatus.status.activity.runningTasks} 个运行中</span></div>
          <div><small>技能</small><strong>{remoteStatus.status.activity.skills} 个</strong><span>Agent Core {remoteStatus.status.capabilities.agentCore ? '可用' : '不可用'}</span></div>
        </div>
        <div className="device-link-permission-note"><ShieldCheck size={15} /><span>{remoteStatus.status.access?.allowStatus ? '对方已允许读取状态与内容' : '对方尚未允许读取内容'}；{remoteStatus.status.access?.allowTasks ? '可以在对方机器上执行远程任务' : '远程执行任务未获授权'}</span></div>
      </div>
    </div>}

    {taskPeer && <div className="device-link-overlay" role="dialog" aria-label={`发送任务到 ${taskPeer.name}`}>
      <div className="panel device-link-dialog">
        <div className="panel-header"><div><h2>发送任务到 {taskPeer.name}</h2></div><button type="button" className="icon-button compact" aria-label="关闭" disabled={taskBusy} onClick={() => setTaskPeer(undefined)}><X size={16} /></button></div>
        <div className="settings-form">
          <label><span>任务内容</span><textarea rows={4} maxLength={8_000} value={taskPrompt} placeholder="例如：整理下载目录里的 PDF，列出每份文件的标题和页数。" onChange={(event) => setTaskPrompt(event.target.value)} /><small>对方未开启“允许在本机执行任务”时会直接被拒绝；涉及审批的危险操作不会执行。</small></label>
        </div>
        <div className="runtime-actions">
          <button type="button" className="button secondary" disabled={taskBusy} onClick={() => setTaskPeer(undefined)}>取消</button>
          <button type="button" className="button primary" disabled={taskBusy || !taskPrompt.trim()} onClick={() => void sendRemoteTask()}>{taskBusy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{taskBusy ? '对方正在执行…' : '发送并等待结果'}</button>
        </div>
      </div>
    </div>}

    {taskResult && <div className="device-link-overlay" role="dialog" aria-label="远程任务结果">
      <div className="panel device-link-dialog">
        <div className="panel-header"><div><h2>{taskResult.peerName} 的远程任务结果</h2></div><button type="button" className="icon-button compact" aria-label="关闭" onClick={() => setTaskResult(undefined)}><X size={16} /></button></div>
        <pre className="device-link-task-output">{taskResult.result.output || '对方没有返回内容。'}</pre>
      </div>
    </div>}

    {/* 云端状态和高级身份操作不再形成第二个连接入口。 */}
    {status.enabled && <details className="device-link-cloud-details"><summary>云端连接状态与高级操作</summary><section className="device-link-subpanel">
      <div className="panel-header device-link-header">
        <div><strong>远程连接</strong></div>
        <div className="device-link-header-actions">
          <span className={`status-label ${remote.enabled ? (remote.running ? 'online' : 'paused') : 'offline'}`}><i />{remote.enabled ? (remote.running ? '已连接' : '启动中') : remote.deviceLockEnabled ? '随开关开启' : '需先开启安全锁'}</span>
        </div>
      </div>

      {remote.enabled && (
        <div className="device-link-remote-card">
          {remote.lastError && <small className="device-link-remote-error">{remote.lastError}</small>}
          {remote.identityPublicKey && <button type="button" className="button secondary small" onClick={() => void writeTextToClipboard(remote.identityPublicKey).then(() => setNotice(`设备公钥已复制（${remote.publicKeyFingerprint}）。`)).catch((reason) => setError(errorMessage(reason)))}><Copy size={14} />复制迁移公钥</button>}
          {remote.deviceId && <button type="button" className="button danger-outline small" disabled={action !== null} onClick={() => void revokeRemoteIdentity()}><Unlink2 size={14} />永久撤销公网设备号</button>}
        </div>
      )}

      <small className="device-link-same-email-hint">{remote.accountVerified ? '本机邮箱已在交换中心验证并绑定设备公钥；同账号设备会自动加入受信任列表。' : '尚未完成设备邮箱验证；请在“用户管理”中发送验证码并重新绑定。'} 自动信任不授予读取文件或执行任务权限。</small>
    </section></details>}
    </div>

  </div>
}
