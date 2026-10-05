import { AlertTriangle, ArrowRight, Bot as BotIcon, Check, CheckCircle2, ChevronRight, ExternalLink, KeyRound, LoaderCircle, Pencil, Plus, QrCode, Radio, RefreshCw, Save, Settings2, ShieldCheck, Smartphone, Trash2, UserRoundCheck, UsersRound, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Bot, Channel, ExternalChannelId, GatewayAuthorizedUser, GatewayConnection, GatewayConnectionConfigurationInput, GatewayPairingRequest, RuntimeStatus, WeixinQrLoginStatus } from '../types'
import { ChannelBadge } from './Overview'

type FieldDefinition = { key: string; label: string; placeholder: string; secret?: boolean; required?: boolean; type?: 'select'; options?: Array<{ value: string; label: string }> }

const fieldsByChannel: Record<ExternalChannelId, FieldDefinition[]> = {
  telegram: [
    { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', placeholder: '123456789:ABC...', secret: true, required: true },
    { key: 'TELEGRAM_ALLOWED_USERS', label: '允许的用户 ID', placeholder: '123456789,987654321' },
    { key: 'TELEGRAM_WEBHOOK_URL', label: 'Webhook URL（可选）', placeholder: 'https://example.com/telegram' },
    { key: 'TELEGRAM_WEBHOOK_SECRET', label: 'Webhook Secret（可选）', placeholder: '安全随机字符串', secret: true },
    { key: 'TELEGRAM_WEBHOOK_PORT', label: 'Webhook 本地端口', placeholder: '8443' },
  ],
  discord: [
    { key: 'DISCORD_BOT_TOKEN', label: 'Bot Token', placeholder: 'Discord Developer Portal Token', secret: true, required: true },
    { key: 'DISCORD_ALLOWED_USERS', label: '允许的用户 ID', placeholder: '123456789012345678' },
  ],
  slack: [
    { key: 'SLACK_BOT_TOKEN', label: 'Bot Token', placeholder: 'xoxb-...', secret: true, required: true },
    { key: 'SLACK_APP_TOKEN', label: 'App-Level Token', placeholder: 'xapp-...', secret: true, required: true },
    { key: 'SLACK_ALLOWED_USERS', label: '允许的成员 ID', placeholder: 'U0123,U0456' },
  ],
  wecom: [
    { key: 'WECOM_BOT_ID', label: '企业微信 Bot ID', placeholder: 'Bot 凭证页中的 ID', required: true },
    { key: 'WECOM_SECRET', label: 'Bot Secret', placeholder: '企业微信机器人 Secret', secret: true, required: true },
    { key: 'WECOM_ALLOWED_USERS', label: '允许的用户 ID', placeholder: 'zhangsan,lisi' },
    { key: 'WECOM_WEBSOCKET_URL', label: 'WebSocket URL（可选）', placeholder: '保持为空使用官方默认地址' },
  ],
  weixin: [
    { key: 'WEIXIN_ACCOUNT_ID', label: '微信 iLink Account ID', placeholder: '扫码成功后自动填写', required: true },
    { key: 'WEIXIN_TOKEN', label: '微信 iLink Token', placeholder: '扫码成功后自动安全保存', secret: true, required: true },
    { key: 'WEIXIN_BASE_URL', label: 'iLink API 地址（自动）', placeholder: '扫码成功后自动填写' },
    { key: 'WEIXIN_DM_POLICY', label: '私聊授权方式', placeholder: '', type: 'select', options: [{ value: 'pairing', label: '首次消息后手动授权（推荐）' }, { value: 'allowlist', label: '仅允许指定用户' }, { value: 'disabled', label: '关闭私聊' }] },
    { key: 'WEIXIN_ALLOWED_USERS', label: '允许私聊的用户 ID', placeholder: '多个 ID 用逗号分隔；pairing 模式可留空' },
    { key: 'WEIXIN_GROUP_POLICY', label: '群消息策略', placeholder: '', type: 'select', options: [{ value: 'disabled', label: '关闭群消息（推荐）' }, { value: 'allowlist', label: '仅允许指定群' }, { value: 'open', label: '接收 iLink 下发的全部群消息' }] },
    { key: 'WEIXIN_GROUP_ALLOWED_USERS', label: '允许的微信群 ID', placeholder: '多个群 ID 用逗号分隔' },
  ],
  dingtalk: [
    { key: 'DINGTALK_CLIENT_ID', label: 'Client ID / AppKey', placeholder: '钉钉开放平台 AppKey', required: true },
    { key: 'DINGTALK_CLIENT_SECRET', label: 'Client Secret / AppSecret', placeholder: '钉钉开放平台 AppSecret', secret: true, required: true },
    { key: 'DINGTALK_AI_CARD_TEMPLATE_ID', label: 'AI 卡片模板 ID（可选）', placeholder: '留空则使用 Markdown 消息，不启用 AI 卡片' },
    { key: 'DINGTALK_ALLOWED_USERS', label: '允许的用户 ID', placeholder: '用户 ID，多个用逗号分隔' },
  ],
  feishu: [
    { key: 'FEISHU_APP_ID', label: 'App ID', placeholder: 'cli_xxxxxxxxx', required: true },
    { key: 'FEISHU_APP_SECRET', label: 'App Secret', placeholder: '飞书应用凭证', secret: true, required: true },
    { key: 'FEISHU_ALLOWED_USERS', label: '允许的用户 Open ID', placeholder: 'ou_xxx,ou_yyy' },
    { key: 'FEISHU_CONNECTION_MODE', label: '连接方式', placeholder: '', type: 'select', options: [{ value: 'websocket', label: '长连接 WebSocket（推荐）' }, { value: 'webhook', label: 'Webhook' }] },
    { key: 'FEISHU_ENCRYPT_KEY', label: 'Encrypt Key（Webhook 可选）', placeholder: '事件订阅加密密钥', secret: true },
    { key: 'FEISHU_VERIFICATION_TOKEN', label: 'Verification Token（Webhook 可选）', placeholder: '事件订阅验证令牌', secret: true },
    { key: 'FEISHU_WEBHOOK_PORT', label: 'Webhook 端口', placeholder: '8765' },
  ],
  webhook: [
    { key: 'WEBHOOK_PATH', label: '接收路径', placeholder: '/hooks/zsense', required: true },
    { key: 'WEBHOOK_SIGNING_SECRET', label: '签名密钥', placeholder: '用于验证请求签名', secret: true, required: true },
    { key: 'WEBHOOK_ALLOWED_ORIGINS', label: '允许的来源', placeholder: 'https://example.com' },
  ],
}

const applicationPortals: Partial<Record<ExternalChannelId, { label: string; url: string; description: string }>> = {
  dingtalk: {
    label: '钉钉',
    url: 'https://open-dev.dingtalk.com/fe/app#/corp/app',
    description: '打开钉钉开放平台，在所属组织下新建应用并启用机器人能力。',
  },
  feishu: {
    label: '飞书',
    url: 'https://open.feishu.cn/app',
    description: '打开飞书开放平台，新建企业自建应用并添加机器人能力。',
  },
}

function defaultConfigFor(provider: ExternalChannelId): Record<string, string> {
  if (provider === 'feishu') return { FEISHU_CONNECTION_MODE: 'websocket' }
  if (provider === 'weixin') return { WEIXIN_DM_POLICY: 'pairing', WEIXIN_GROUP_POLICY: 'disabled' }
  return {}
}

interface GatewayPageProps {
  embedded?: boolean
  bots: Bot[]
  channels: Channel[]
  connections: GatewayConnection[]
  runtime: RuntimeStatus
  onSave: (configuration: GatewayConnectionConfigurationInput) => Promise<void>
  onDelete: (connectionId: string) => Promise<void>
  onLoadPairings: (connectionId: string) => Promise<GatewayPairingRequest[]>
  onLoadAuthorizedUsers: (connectionId: string) => Promise<GatewayAuthorizedUser[]>
  onApprovePairing: (connectionId: string, requestId: string) => Promise<GatewayPairingRequest[]>
  onStartWeixinLogin: (botId: string) => Promise<WeixinQrLoginStatus>
  onGetWeixinLoginStatus: (loginId: string) => Promise<WeixinQrLoginStatus>
  onCancelWeixinLogin: (loginId: string) => Promise<void>
  onOpenRuntime: () => void
  onRefreshRuntime: () => Promise<void>
}

export function GatewayPage({ embedded = false, bots, channels, connections, runtime, onSave, onDelete, onLoadPairings, onLoadAuthorizedUsers, onApprovePairing, onStartWeixinLogin, onGetWeixinLoginStatus, onCancelWeixinLogin, onOpenRuntime, onRefreshRuntime }: GatewayPageProps) {
  const externalChannels = useMemo(() => channels.filter((channel): channel is Channel & { id: ExternalChannelId } => channel.id !== 'web' && channel.id !== 'device-link'), [channels])
  const [editingId, setEditingId] = useState<string | 'new' | null>(() => connections[0]?.id || null)
  const selected = useMemo(() => connections.find((item) => item.id === editingId), [connections, editingId])
  const [provider, setProvider] = useState<ExternalChannelId>('dingtalk')
  const [name, setName] = useState('')
  const [botId, setBotId] = useState(bots[0]?.id || '')
  const [config, setConfig] = useState<Record<string, string>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [clearSecrets, setClearSecrets] = useState<string[]>([])
  const [enabled, setEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')
  const [pairings, setPairings] = useState<GatewayPairingRequest[]>([])
  const [pairingsLoading, setPairingsLoading] = useState(false)
  const [approvingPairing, setApprovingPairing] = useState('')
  const [authorizedUsers, setAuthorizedUsers] = useState<GatewayAuthorizedUser[]>([])
  const [authorizedUsersLoading, setAuthorizedUsersLoading] = useState(false)
  const [renamingUserId, setRenamingUserId] = useState('')
  const [authorizedUserName, setAuthorizedUserName] = useState('')
  const [authorizedUserSaving, setAuthorizedUserSaving] = useState(false)
  const [weixinLogin, setWeixinLogin] = useState<WeixinQrLoginStatus | null>(null)
  const [weixinLoginBusy, setWeixinLoginBusy] = useState(false)
  const weixinLoginIdRef = useRef('')

  const channel = externalChannels.find((item) => item.id === provider)
  const bot = bots.find((item) => item.id === botId)
  const scopedBot = embedded ? bots[0] : undefined
  const definitions = fieldsByChannel[provider]
  const applicationPortal = applicationPortals[provider]
  const lastHealthCheck = runtime.lastGatewayHealthCheckAt
    ? new Date(runtime.lastGatewayHealthCheckAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '等待首次检测'

  useEffect(() => {
    if (editingId !== 'new' && selected) {
      setProvider(selected.provider)
      setName(selected.name)
      setBotId(selected.botId)
      setConfig({ ...defaultConfigFor(selected.provider), ...selected.config })
      setEnabled(selected.status === 'connected')
    } else if (editingId === 'new') {
      const nextBot = bots[0]
      setProvider('dingtalk')
      setBotId(nextBot?.id || '')
      setName(nextBot ? `钉钉机器人 · ${nextBot.name}` : '钉钉机器人')
      setConfig(defaultConfigFor('dingtalk'))
      setEnabled(false)
    }
    setSecrets({})
    setClearSecrets([])
    setConfirmDelete(false)
    setError('')
  }, [bots, editingId, selected])

  useEffect(() => {
    const previousLoginId = weixinLoginIdRef.current
    if (previousLoginId) void onCancelWeixinLogin(previousLoginId)
    weixinLoginIdRef.current = ''
    setWeixinLogin(null)
    setWeixinLoginBusy(false)
  }, [editingId, onCancelWeixinLogin])

  useEffect(() => () => {
    if (weixinLoginIdRef.current) void onCancelWeixinLogin(weixinLoginIdRef.current)
  }, [onCancelWeixinLogin])

  useEffect(() => {
    const loginId = weixinLogin?.loginId
    if (!loginId || !['preparing', 'waiting', 'scanned'].includes(weixinLogin.state)) return
    let cancelled = false
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const status = await onGetWeixinLoginStatus(loginId)
        if (cancelled) return
        if (status.state === 'confirmed' && status.token) {
          setConfig((current) => ({
            ...defaultConfigFor('weixin'),
            ...current,
            WEIXIN_ACCOUNT_ID: status.accountId,
            WEIXIN_BASE_URL: status.baseUrl,
            WEIXIN_ALLOWED_USERS: current.WEIXIN_ALLOWED_USERS || status.userId,
          }))
          setSecrets((current) => ({ ...current, WEIXIN_TOKEN: status.token || '' }))
          setClearSecrets((current) => current.filter((key) => key !== 'WEIXIN_TOKEN'))
          setEnabled(true)
        }
        setWeixinLogin({ ...status, token: undefined })
      } catch (reason) {
        if (!cancelled) setWeixinLogin((current) => current ? { ...current, state: 'error', message: reason instanceof Error ? reason.message : '无法读取微信扫码状态。' } : current)
      } finally {
        polling = false
      }
    }
    const timer = window.setInterval(() => void poll(), 1_200)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [onGetWeixinLoginStatus, weixinLogin?.loginId, weixinLogin?.state])

  useEffect(() => {
    if (editingId && editingId !== 'new' && !connections.some((item) => item.id === editingId)) setEditingId(connections[0]?.id || null)
  }, [connections, editingId])

  useEffect(() => {
    let cancelled = false
    if (!selected || selected.provider === 'webhook' || !selected.configured) {
      setPairings([])
      return
    }
    setPairingsLoading(true)
    onLoadPairings(selected.id).then((items) => {
      if (!cancelled) setPairings(items)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取待授权用户。')
    }).finally(() => {
      if (!cancelled) setPairingsLoading(false)
    })
    return () => { cancelled = true }
  }, [onLoadPairings, selected])

  useEffect(() => {
    let cancelled = false
    if (!selected || selected.provider === 'webhook' || !selected.configured) {
      setAuthorizedUsers([])
      return
    }
    setAuthorizedUsersLoading(true)
    onLoadAuthorizedUsers(selected.id).then((items) => {
      if (!cancelled) setAuthorizedUsers(items)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取已授权用户。')
    }).finally(() => {
      if (!cancelled) setAuthorizedUsersLoading(false)
    })
    return () => { cancelled = true }
  }, [onLoadAuthorizedUsers, selected])

  const approvePairing = async (request: GatewayPairingRequest) => {
    if (!selected) return
    setApprovingPairing(request.requestId)
    setError('')
    try {
      setPairings(await onApprovePairing(selected.id, request.requestId))
      setAuthorizedUsers(await onLoadAuthorizedUsers(selected.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '用户授权失败。')
    } finally {
      setApprovingPairing('')
    }
  }

  const saveAuthorizedUserName = async () => {
    if (!selected || !renamingUserId || !authorizedUserName.trim()) return
    if (!window.zsenseDesktop) return setError('已授权用户重命名仅在桌面端可用。')
    setAuthorizedUserSaving(true)
    setError('')
    try {
      const result = await window.zsenseDesktop.gatewayConnections.renameAuthorizedUser(selected.id, renamingUserId, authorizedUserName.trim())
      if (!result.ok) throw new Error(result.error)
      setAuthorizedUsers(result.data || [])
      setRenamingUserId('')
      setAuthorizedUserName('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '已授权用户重命名失败。')
    } finally {
      setAuthorizedUserSaving(false)
    }
  }

  const chooseProvider = (nextProvider: ExternalChannelId) => {
    if (weixinLoginIdRef.current) void onCancelWeixinLogin(weixinLoginIdRef.current)
    weixinLoginIdRef.current = ''
    setWeixinLogin(null)
    setProvider(nextProvider)
    setConfig(defaultConfigFor(nextProvider))
    setSecrets({})
    setClearSecrets([])
    const nextChannel = externalChannels.find((item) => item.id === nextProvider)
    const nextBot = bots.find((item) => item.id === botId)
    setName(`${nextChannel?.name || '机器人'}${nextProvider === 'webhook' ? '' : '机器人'}${nextBot ? ` · ${nextBot.name}` : ''}`)
  }

  const chooseBot = (nextBotId: string) => {
    if (weixinLoginIdRef.current) void onCancelWeixinLogin(weixinLoginIdRef.current)
    weixinLoginIdRef.current = ''
    setWeixinLogin(null)
    setBotId(nextBotId)
    const nextBot = bots.find((item) => item.id === nextBotId)
    if (editingId === 'new' && nextBot) setName(`${channel?.name || '机器人'}${provider === 'webhook' ? '' : '机器人'} · ${nextBot.name}`)
  }

  const startWeixinLogin = async () => {
    if (!botId) return setError('请先选择微信机器人要交给哪个 Bot。')
    setWeixinLoginBusy(true)
    setError('')
    try {
      const status = await onStartWeixinLogin(botId)
      weixinLoginIdRef.current = status.loginId
      setWeixinLogin({ ...status, token: undefined })
      if (status.state === 'confirmed' && status.token) {
        setConfig((current) => ({ ...defaultConfigFor('weixin'), ...current, WEIXIN_ACCOUNT_ID: status.accountId, WEIXIN_BASE_URL: status.baseUrl, WEIXIN_ALLOWED_USERS: current.WEIXIN_ALLOWED_USERS || status.userId }))
        setSecrets((current) => ({ ...current, WEIXIN_TOKEN: status.token || '' }))
        setEnabled(true)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '微信扫码授权启动失败。')
    } finally {
      setWeixinLoginBusy(false)
    }
  }

  const cancelWeixinLogin = async () => {
    const loginId = weixinLoginIdRef.current
    weixinLoginIdRef.current = ''
    if (loginId) await onCancelWeixinLogin(loginId)
    setWeixinLogin(null)
    setWeixinLoginBusy(false)
  }

  const save = async () => {
    if (!name.trim()) return setError('请给这个机器人账号起一个名称。')
    if (!botId) return setError('请选择这个机器人账号要交给哪个 Bot。')
    if (provider === 'weixin' && config.WEIXIN_DM_POLICY === 'allowlist' && !config.WEIXIN_ALLOWED_USERS?.trim()) return setError('微信私聊选择了白名单模式，请填写允许的用户 ID。')
    if (provider === 'weixin' && config.WEIXIN_GROUP_POLICY === 'allowlist' && !config.WEIXIN_GROUP_ALLOWED_USERS?.trim()) return setError('微信群选择了白名单模式，请填写允许的群 ID。')
    setSaving(true)
    setError('')
    try {
      await onSave({ id: selected?.id, provider, name: name.trim(), botId, enabled, config, secrets, clearSecrets })
      setSecrets({})
      setClearSecrets([])
      if (editingId === 'new') setEditingId(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '机器人账号保存失败。')
    } finally {
      setSaving(false)
    }
  }

  const openApplicationPortal = async () => {
    if (!applicationPortal) return
    setError('')
    try {
      if (window.zsenseDesktop?.browser.openExternal) {
        const result = await window.zsenseDesktop.browser.openExternal(applicationPortal.url)
        if (!result.ok) throw new Error(result.error || `无法打开${applicationPortal.label}开放平台。`)
        return
      }
      const link = document.createElement('a')
      link.href = applicationPortal.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.click()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `无法打开${applicationPortal.label}开放平台。`)
    }
  }

  const remove = async () => {
    if (!selected) return
    setDeleting(true)
    setError('')
    try {
      await onDelete(selected.id)
      setEditingId(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '机器人账号删除失败。')
    } finally {
      setDeleting(false)
    }
  }

  const gatewayReady = runtime.agentCoreReady ?? runtime.runnable
  const healthyConnectionCount = connections.filter((connection) => connection.status === 'connected').length

  return (
    <div className={`${embedded ? 'bot-gateway-embedded' : 'page'} gateway-page`}>
      <section className={`page-heading ${embedded ? 'bot-gateway-page-heading' : ''}`}>
        <div><span className="eyebrow">MESSAGE GATEWAY</span>{embedded ? <h2>{scopedBot?.name || '当前 Bot'} 的消息网关</h2> : <h1>消息网关</h1>}<p>{embedded ? '此处的机器人账号、凭证、授权用户和消息路由仅属于当前 Bot。' : '每个机器人账号只绑定一个 Bot；同一种渠道可为不同 Bot 分别创建账号。'}</p></div>
        <button className="button primary" onClick={() => setEditingId('new')} disabled={!bots.length}><Plus size={16} />添加机器人账号</button>
      </section>

      <section className={`gateway-health-banner ${gatewayReady ? '' : 'offline'}`}>
        <span className="gateway-health-icon"><Radio size={22} /></span>
        <div><div><span className={`status-dot ${gatewayReady ? '' : 'warning'}`} /><strong>{gatewayReady && runtime.gatewayMonitorEnabled ? 'ZSense 消息网关自动守护已开启' : gatewayReady ? 'ZSense 网关路由已可用' : 'Agent Core 当前不可用'}</strong></div><p>{runtime.message}{runtime.gatewayMonitorEnabled ? ` · 最近巡检 ${lastHealthCheck} · 累计自动恢复 ${runtime.gatewayRecoveryCount} 次` : ''}</p></div>
        <span><small>机器人账号</small><strong>{connections.length}</strong></span>
        <span><small>{embedded ? '运行中账号' : '健康网关'}</small><strong>{embedded ? `${healthyConnectionCount}/${connections.length}` : runtime.lastGatewayHealthCheckAt ? `${runtime.gatewayHealthyCount}/${runtime.gatewayExpectedCount}` : runtime.managedGatewayCount}</strong></span>
        <span><small>自动检测</small><strong>{runtime.gatewayMonitorEnabled ? `${runtime.gatewayHealthCheckIntervalSeconds} 秒` : '未启用'}</strong></span>
        <button className="icon-button bordered" onClick={() => void onRefreshRuntime()} aria-label="刷新 ZSense 网关状态"><RefreshCw size={16} /></button>
      </section>

      <div className="gateway-config-layout">
        <section className="panel connections-panel">
          <div className="panel-header"><div><h2>机器人账号</h2><p>一个账号对应一条确定的 Bot 路由</p></div></div>
          <div className="gateway-account-list">
            {connections.map((connection) => {
              const targetBot = bots.find((item) => item.id === connection.botId)
              return <button key={connection.id} className={selected?.id === connection.id ? 'active' : ''} onClick={() => setEditingId(connection.id)}><ChannelBadge id={connection.provider} /><span><strong>{connection.name}</strong><small>{targetBot ? `交给 ${targetBot.name}` : '目标 Bot 已删除'} · {connection.profileName}</small></span><span className={`connection-state ${connection.status}`}>{connection.status === 'connected' ? '运行中' : connection.status === 'paused' ? '已暂停' : '待配置'}</span><ChevronRight size={16} /></button>
            })}
            {!connections.length && <div className="gateway-account-empty"><Radio size={24} /><strong>还没有外部机器人账号</strong><p>{embedded ? `添加钉钉、飞书等机器人后，它的消息会固定交给 ${scopedBot?.name || '当前 Bot'}。` : '添加钉钉、飞书等机器人后，它的消息会固定交给你指定的 Bot。'}</p><button className="button secondary" onClick={() => setEditingId('new')} disabled={!bots.length}><Plus size={15} />添加第一个账号</button></div>}
          </div>
          <div className="built-in-route"><ChannelBadge id="web" /><span><strong>ZSense 对话</strong><small>{embedded ? `${scopedBot?.name || '当前 Bot'} 可从应用内对话直接进入` : '所有 Bot 都可从 ZSense 对话进入'}</small></span><span className="channel-config-state configured">内置</span></div>
        </section>

        <section className="panel gateway-editor">
          {editingId ? <>
            <div className="panel-header"><div><h2>{editingId === 'new' ? '添加机器人账号' : '编辑机器人账号'}</h2><p>{selected ? `ZSense 隔离连接：${selected.profileName}` : '保存后创建 Bot 专属连接'}</p></div>{selected?.configured && <span className="credential-state saved"><CheckCircle2 size={13} />凭证已保存</span>}</div>
            <div className="gateway-form settings-form">
              <label><span>账号名称 *</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：钉钉机器人一" /></label>
              <label><span>渠道类型 *</span><select value={provider} disabled={Boolean(selected)} onChange={(event) => chooseProvider(event.target.value as ExternalChannelId)}>{externalChannels.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><small>{selected ? '已保存账号不可更换渠道类型' : channel?.description}</small></label>
              {embedded ? <div className="gateway-bot-lock full-field"><span className="mini-avatar" style={{ '--avatar': scopedBot?.color || '#64748b' } as React.CSSProperties}>{scopedBot?.initials || '?'}</span><span><small>固定路由到当前 Bot</small><strong>{scopedBot?.name || '当前 Bot'} · {scopedBot?.role || ''}</strong><em>该账号收到的全部消息只会进入此 Bot 的独立连接和私有记忆。</em></span><ShieldCheck size={18} /></div> : <label className="full-field"><span>交给哪个 Bot *</span><select value={botId} disabled={Boolean(selected)} onChange={(event) => chooseBot(event.target.value)}>{bots.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.role}</option>)}</select><small>该账号收到的全部消息只会进入这个 Bot 的 Profile 和私有记忆。</small></label>}
              <div className="gateway-route-preview full-field"><span><ChannelBadge id={provider} /><strong>{name || channel?.name}</strong></span><ArrowRight size={15} /><code>{selected?.profileName || `zsense-${botId || 'bot'}`}</code><ArrowRight size={15} /><span className="route-bot"><BotIcon size={15} /><strong>{bot?.name || '选择 Bot'}</strong><small>私有记忆</small></span></div>
              {editingId === 'new' && applicationPortal && <div className="gateway-app-create-card full-field">
                <span className="gateway-app-create-icon"><BotIcon size={17} /></span>
                <span><strong>还没有{applicationPortal.label}智能体应用？</strong><small>{applicationPortal.description}</small></span>
                <button type="button" className="button secondary" onClick={() => void openApplicationPortal()} title={`前往${applicationPortal.label}开放平台新建智能体应用`}><ExternalLink size={15} />一键新建智能体应用</button>
              </div>}
              {provider === 'weixin' && <div className="weixin-onboarding full-field">
                <div className="weixin-onboarding-heading"><span className="weixin-onboarding-icon"><Smartphone size={18} /></span><span><strong>微信扫码授权</strong><small>由 ZSense 直接连接腾讯 iLink 接口，不需要输入个人微信密码。</small></span>{weixinLogin?.state === 'confirmed' && <span className="credential-state saved"><CheckCircle2 size={13} />已授权</span>}</div>
                <div className={`weixin-login-state ${weixinLogin?.state || 'idle'}`}>
                  {weixinLogin?.qrImage ? <img src={weixinLogin.qrImage} alt="微信 iLink 登录二维码" /> : <span className="weixin-qr-placeholder">{weixinLoginBusy || weixinLogin?.state === 'preparing' ? <LoaderCircle className="spin" size={24} /> : weixinLogin?.state === 'confirmed' ? <CheckCircle2 size={25} /> : <QrCode size={25} />}</span>}
                  <span><strong>{weixinLogin?.state === 'confirmed' ? '微信已连接' : weixinLogin?.state === 'scanned' ? '等待手机确认' : weixinLogin?.state === 'waiting' ? '请用微信扫码' : weixinLogin?.state === 'error' || weixinLogin?.state === 'expired' ? '扫码授权未完成' : '连接一个微信机器人'}</strong><small>{weixinLogin?.message || '点击开始后，用微信扫描二维码并在手机上确认。授权成功后凭证会自动填入下方。'}</small>{weixinLogin?.accountId && <code>{weixinLogin.accountId}</code>}</span>
                  <span className="weixin-login-actions">{weixinLogin && ['preparing', 'waiting', 'scanned'].includes(weixinLogin.state) ? <button className="button secondary" type="button" onClick={() => void cancelWeixinLogin()}><X size={15} />取消扫码</button> : <button className="button secondary" type="button" disabled={weixinLoginBusy || !gatewayReady} onClick={() => void startWeixinLogin()}>{weixinLoginBusy ? <LoaderCircle className="spin" size={15} /> : <QrCode size={15} />}{weixinLogin?.state === 'confirmed' ? '重新授权' : '微信扫码授权'}</button>}</span>
                </div>
                {!gatewayReady && <div className="weixin-runtime-note"><AlertTriangle size={15} /><span>ZSense Agent Core 当前不可用，请先在设置中重新检测。</span></div>}
                <div className="weixin-group-notice"><UsersRound size={16} /><span><strong>关于微信群</strong><small>普通微信群通常无法邀请 iLink 机器人，腾讯也可能不下发普通群消息。下面的群策略仅在腾讯为该账号实际开放群事件时生效；这是平台限制，不是 ZSense 漏收。</small></span></div>
              </div>}
              {selected && selected.provider !== 'webhook' && selected.configured && <div className={`gateway-pairing-panel full-field ${pairings.length ? 'attention' : ''}`}><div className="gateway-pairing-heading"><span><UserRoundCheck size={17} /></span><div><strong>入站用户授权</strong><small>ZSense 默认拦截未知用户，授权后消息才会进入 {bot?.name || '目标 Bot'}。</small></div>{pairingsLoading && <LoaderCircle className="spin" size={15} />}</div>{pairings.map((request) => <div className="gateway-pairing-request" key={request.requestId}><span><strong>{request.userName}</strong><small>{request.userId.length > 18 ? `${request.userId.slice(0, 9)}…${request.userId.slice(-6)}` : request.userId}</small></span><button className="button secondary" disabled={Boolean(approvingPairing)} onClick={() => void approvePairing(request)}>{approvingPairing === request.requestId ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}允许接收</button></div>)}{!pairingsLoading && !pairings.length && <p className="gateway-pairing-empty">当前没有待授权用户。让新用户先给机器人发送一条消息，授权请求会显示在这里。</p>}</div>}
              {selected && selected.provider !== 'webhook' && selected.configured && <div className="gateway-authorized-panel full-field">
                <div className="authorized-users-heading"><span><UserRoundCheck size={15} />已授权用户</span><small>{authorizedUsersLoading ? <><LoaderCircle className="spin" size={12} />读取中</> : `${authorizedUsers.length} 人`}</small></div>
                <div className="authorized-user-list">{authorizedUsers.map((user) => <div key={user.userId}>
                  <span className="authorized-user-avatar"><UsersRound size={14} /></span>
                  <span>{renamingUserId === user.userId ? <input className="authorized-user-name-input" value={authorizedUserName} maxLength={80} autoFocus onChange={(event) => setAuthorizedUserName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveAuthorizedUserName(); if (event.key === 'Escape') setRenamingUserId('') }} aria-label={`重命名 ${user.userName}`} /> : <strong>{user.userName}</strong>}<code title={user.userId}>{user.userId}</code></span>
                  {renamingUserId === user.userId ? <span className="authorized-user-actions"><button type="button" className="icon-button" disabled={authorizedUserSaving || !authorizedUserName.trim()} onClick={() => void saveAuthorizedUserName()} aria-label="保存授权用户名称" title="保存"><Check size={14} /></button><button type="button" className="icon-button" disabled={authorizedUserSaving} onClick={() => setRenamingUserId('')} aria-label="取消重命名" title="取消"><X size={14} /></button></span> : <><time>{user.approvedAt ? `${new Date(user.approvedAt).toLocaleString('zh-CN')} 授权` : '已授权'}</time><button type="button" className="icon-button authorized-user-rename" onClick={() => { setRenamingUserId(user.userId); setAuthorizedUserName(user.userName) }} aria-label={`重命名已授权用户 ${user.userName}`} title="重命名"><Pencil size={13} /></button></>}
                </div>)}{!authorizedUsersLoading && !authorizedUsers.length && <p>暂时没有通过 ZSense 配对授权的用户。</p>}</div>
              </div>}
              {definitions.map((field) => {
                const saved = Boolean(field.secret && selected?.secretKeys.includes(field.key) && !clearSecrets.includes(field.key))
                const fullWidth = definitions.length <= 4 || (provider === 'weixin' && ['WEIXIN_ALLOWED_USERS', 'WEIXIN_GROUP_ALLOWED_USERS'].includes(field.key))
                return <label key={field.key} className={fullWidth ? 'full-field' : ''}><span>{field.label}{field.required ? ' *' : ''}</span>{field.type === 'select' ? <select value={config[field.key] || field.options?.[0]?.value || ''} onChange={(event) => setConfig((current) => ({ ...current, [field.key]: event.target.value }))}>{field.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : field.secret ? <span className="secret-input"><KeyRound size={15} /><input type="password" autoComplete="new-password" value={secrets[field.key] || ''} onChange={(event) => { setSecrets((current) => ({ ...current, [field.key]: event.target.value })); setClearSecrets((current) => current.filter((key) => key !== field.key)) }} placeholder={saved ? '•••••••• 已安全保存，留空保持不变' : field.placeholder} /></span> : <input value={config[field.key] || ''} onChange={(event) => setConfig((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} />}{field.secret && selected?.secretKeys.includes(field.key) && <span className="clear-secret compact"><input type="checkbox" checked={clearSecrets.includes(field.key)} onChange={(event) => setClearSecrets((current) => event.target.checked ? [...current, field.key] : current.filter((key) => key !== field.key))} /><span>清除已保存凭证</span></span>}{provider === 'weixin' && field.key === 'WEIXIN_ALLOWED_USERS' && <small>{config.WEIXIN_DM_POLICY === 'allowlist' ? '白名单模式必须填写用户 ID。' : 'pairing 模式下，新用户发来首条消息后会出现在上方授权列表。'}</small>}{provider === 'weixin' && field.key === 'WEIXIN_GROUP_ALLOWED_USERS' && <small>{config.WEIXIN_GROUP_POLICY === 'allowlist' ? '仅接收这些群 ID 的消息。' : '只有选择“仅允许指定群”时才会使用此项。'}</small>}</label>
              })}
              <div className="gateway-enable-row"><span><strong>启用这个机器人账号</strong><small>{gatewayReady ? '保存后启动对应 Bot 的消息网关' : 'Agent Core 恢复后会自动启动'}</small></span><button className={`switch ${enabled ? 'on' : ''}`} role="switch" aria-checked={enabled} aria-label={`${enabled ? '停用' : '启用'}这个机器人账号`} onClick={() => setEnabled((current) => !current)}><span /></button></div>
              {error && <div className="inline-error" role="alert"><AlertTriangle size={15} />{error}</div>}
            </div>
            <div className="gateway-editor-actions">
              <span>{selected && (confirmDelete ? <span className="delete-confirm"><small>确定删除账号和已保存凭证？</small><button onClick={() => setConfirmDelete(false)}>取消</button><button className="danger-text" disabled={deleting} onClick={() => void remove()}>{deleting ? '删除中…' : '确认删除'}</button></span> : <button className="text-button danger-text" onClick={() => setConfirmDelete(true)}><Trash2 size={15} />删除账号</button>)}</span>
              <span className="gateway-save-actions"><button className="text-button" onClick={onOpenRuntime}>核心服务设置 <Settings2 size={15} /></button><button className="button primary" disabled={saving || !bots.length} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? '正在保存…' : '保存账号与路由'}</button></span>
            </div>
          </> : <div className="gateway-editor-empty"><ShieldCheck size={28} /><strong>选择或添加一个机器人账号</strong><p>每条外部消息都沿着“机器人账号 → ZSense 隔离连接 → Bot”这条固定路由处理，不会随机进入其他 Bot。</p></div>}
        </section>
      </div>

      <section className="panel routing-rules-panel gateway-routing-full">
        <div className="panel-header"><div><h2>当前路由表</h2><p>相同渠道可以出现多次，但每个账号都有唯一目标</p></div><span className="private-badge"><ShieldCheck size={13} />一对一路由</span></div>
        <div className="gateway-route-table">{connections.map((connection) => {
          const targetBot = bots.find((item) => item.id === connection.botId)
          return <div className="gateway-route-row" key={connection.id}><span><ChannelBadge id={connection.provider} /><strong>{connection.name}</strong></span><ArrowRight size={14} /><code>{connection.profileName}</code><ArrowRight size={14} /><span className="route-target"><i className="mini-avatar" style={{ '--avatar': targetBot?.color || '#64748b' } as React.CSSProperties}>{targetBot?.initials || '?'}</i><strong>{targetBot?.name || 'Bot 已删除'}</strong><small>独立记忆</small></span><span className={`connection-state ${connection.status}`}>{connection.status === 'connected' ? '运行中' : connection.status === 'paused' ? '已暂停' : '待配置'}</span></div>
        })}{!connections.length && <div className="gateway-route-empty">添加机器人账号后，这里会显示完整的消息去向。</div>}</div>
      </section>
    </div>
  )
}
