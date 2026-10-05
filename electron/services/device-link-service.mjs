import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, randomUUID, sign, timingSafeEqual, X509Certificate, verify } from 'node:crypto'
import dgram from 'node:dgram'
import selfsigned from 'selfsigned'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

const PROTOCOL = 'zsense-device-link'
const PROTOCOL_VERSION = 2
const DISCOVERY_ADDRESS = '239.255.90.71'
const DISCOVERY_PORT = 39071
// 设备互联的 HTTPS 端口默认固定，便于组播被屏蔽时按 IP 手动配对。
const DEFAULT_HTTP_PORT = 39072
const ADVERTISEMENT_INTERVAL_MS = 4_000
const PEER_EXPIRY_MS = 16_000
const HEARTBEAT_INTERVAL_MS = 6_000
const PAIRING_CODE_TTL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 4_000
// 读取内容可能包含较大的对话或文件，给足时间但仍要有上限。
const DATA_TIMEOUT_MS = 20_000
// 主动扫描：路由器常隔离组播（访客网络、AP 隔离、跨网段），这时只能靠广播 + 单播逐点探测。
const SCAN_TIMEOUT_MS = 900
const SCAN_CONCURRENCY = 48
const SCAN_COOLDOWN_MS = 3_000
const PROBE_REPLY_COOLDOWN_MS = 1_500
const PAIR_ATTEMPT_WINDOW_MS = 60_000
const PAIR_ATTEMPT_LIMIT = 6
// 后台扫描只在用户启用互联时运行一次；之后由界面打开或手动刷新触发。
const AUTO_SCAN_BACKGROUND_TIMEOUT_MS = 450
const AUTO_SCAN_BACKGROUND_CONCURRENCY = 32
const MAX_BODY_BYTES = 64 * 1024
const MAX_TASK_PROMPT_LENGTH = 8_000
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000
const MIN_TASK_TIMEOUT_MS = 10_000
const MAX_TASK_TIMEOUT_MS = 10 * 60_000
const HUB_PROTOCOL_VERSION = 2
const HUB_HEARTBEAT_INTERVAL_MS = 25_000
const HUB_REQUEST_TIMEOUT_MS = 8_000
const HUB_LOCAL_UPSTREAM = 'local://web-bridge'

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function cleanText(value, maximum = 100) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum)
}

function normalizedAddress(value) {
  const address = cleanText(value, 128).replace(/^::ffff:/, '').split('%')[0]
  return address === '::1' ? '127.0.0.1' : address
}

export function isPrivateNetworkAddress(value) {
  const address = normalizedAddress(value)
  if (!address) return false
  if (address === '127.0.0.1' || address === 'localhost') return true
  if (/^10\./.test(address) || /^192\.168\./.test(address) || /^169\.254\./.test(address)) return true
  const match172 = address.match(/^172\.(\d+)\./)
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true
  const match100 = address.match(/^100\.(\d+)\./)
  if (match100 && Number(match100[1]) >= 64 && Number(match100[1]) <= 127) return true
  return /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*$/i.test(address)
}

function localAddresses() {
  const addresses = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const address = normalizedAddress(entry.address)
      if (entry.internal || entry.family !== 'IPv4' || !isPrivateNetworkAddress(address)) continue
      if (!addresses.includes(address)) addresses.push(address)
    }
  }
  return addresses
}

function platformLabel(platform) {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'android') return 'Android'
  return 'Linux'
}

function safeSecretEquals(expected, received) {
  const a = Buffer.from(String(expected || ''))
  const b = Buffer.from(String(received || ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function parsePairingCredential(value) {
  const match = cleanText(value, 32).toUpperCase().match(/^(\d{6})-([0-9A-F]{16})$/)
  if (!match) throw new Error('请输入对方屏幕显示的完整安全配对码（6 位数字-16 位身份码）。')
  return { code: match[1], identityCode: match[2] }
}

function secretScope(deviceId) {
  return `device-link:${deviceId}`
}

function validRemoteDeviceId(value) {
  const id = cleanText(value, 60).toLowerCase()
  // New ids are eight characters, but old 2-59 character ids remain valid so
  // an administrator can complete the explicit legacy-key migration flow.
  return /^[a-z0-9][a-z0-9-]{1,58}$/.test(id) ? id : ''
}

export function canonicalHubMessage({ action, challengeId, nonce, expiresAt, deviceId, publicKey, name = '', upstream = '' }) {
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('交换中心注册需要 Ed25519 设备公钥。')
  const publicKeyFingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
  return JSON.stringify({
    version: HUB_PROTOCOL_VERSION,
    action: cleanText(action, 40),
    challengeId: cleanText(challengeId, 80),
    nonce: cleanText(nonce, 120),
    expiresAt: cleanText(expiresAt, 40),
    deviceId: validRemoteDeviceId(deviceId),
    publicKeyFingerprint,
    name: cleanText(name, 60),
    upstream: cleanText(upstream, 500),
  })
}

export function normalizePeerAccess(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return { allowStatus: source.allowStatus === true, allowFiles: source.allowFiles === true, allowTasks: source.allowTasks === true }
}

function parseAuthorization(request) {
  const value = String(request.headers.authorization || '')
  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

async function readBody(request) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求内容过大。'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { reject(new Error('请求内容不是有效 JSON。')) }
    })
    request.on('error', reject)
  })
}

function jsonResponse(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(payload)
}

export class DeviceLinkService {
  constructor({ rootPath, secrets, onChanged = () => undefined, platform = process.platform, hostname = os.hostname(), discoveryPort = DISCOVERY_PORT, discoveryAddress = DISCOVERY_ADDRESS, remoteStatusProvider = null, remoteTaskRunner = null, remoteDataProvider = null,
  autoScan = true, autoScanPorts = null, spawnProcess = spawn, detectLocalHub = true } = {}) {
    if (!rootPath) throw new Error('设备互联缺少数据目录。')
    if (!secrets) throw new Error('设备互联缺少系统加密凭证库。')
    this.directory = path.join(rootPath, 'device-link')
    this.statePath = path.join(this.directory, 'state.json')
    this.secrets = secrets
    this.identity = null
    this.identityError = ''
    try {
      const identity = this.secrets.get('device-link:identity')
      if (identity.privateKey && identity.publicKey) this.identity = identity
      else {
        const keys = generateKeyPairSync('ed25519')
        this.identity = {
          privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
          publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
        }
        this.secrets.set('device-link:identity', this.identity)
      }
    } catch (error) { this.identityError = `系统安全存储不可用，设备互联无法启动：${error instanceof Error ? error.message : error}` }
    this.onChanged = onChanged
    this.platform = platform
    this.hostname = cleanText(hostname, 80) || 'ZSense 设备'
    this.discoveryPort = discoveryPort
    this.discoveryAddress = discoveryAddress
    this.remoteStatusProvider = typeof remoteStatusProvider === 'function' ? remoteStatusProvider : null
    this.remoteTaskRunner = remoteTaskRunner && typeof remoteTaskRunner.run === 'function' ? remoteTaskRunner : null
    // 读取本机内容由对方设备的显式权限控制；敏感配置字段会脱敏。
    this.remoteDataProvider = typeof remoteDataProvider === 'function' ? remoteDataProvider : null
    this.discoverySocket = null
    this.httpServer = null
    this.advertisementTimer = null
    this.heartbeatTimer = null
    this.started = false
    this.starting = null
    this.lastError = ''
    this.discovered = new Map()
    this.onlinePeers = new Set()
    this.scanning = null
    this.probeReplies = new Map()
    this.pairAttempts = new Map()
    this.lastScanAt = 0
    this.scanProgress = null
    this.lastPeerHeartbeatPersistAt = 0
    this.lastHeartbeatEmitAt = 0
    this.autoScan = autoScan !== false
    this.spawnProcess = typeof spawnProcess === 'function' ? spawnProcess : spawn
    this.detectLocalHub = detectLocalHub !== false
    this.autoScanPorts = Array.isArray(autoScanPorts) ? autoScanPorts.map((port) => Math.floor(Number(port) || 0)).filter((port) => port > 0 && port < 65_536) : null
    const stored = readJson(this.statePath)
    this.state = {
      deviceId: cleanText(stored.deviceId, 100) || randomUUID(),
      deviceName: cleanText(stored.deviceName, 80) || this.hostname,
      httpPort: Math.floor(Number(stored.httpPort) || 0),
      enabled: Boolean(stored.enabled),
      // 远程连接（公网）：与局域网直连完全独立，必须已开启设备锁才能启用
      remote: {
        enabled: Boolean(stored.remote?.enabled),
        hostname: cleanText(stored.remote?.hostname, 120) || 'app.zsense.space',
        tunnelName: cleanText(stored.remote?.tunnelName, 40) || 'zsense',
        // 方案 B：设备号 + 中心地址；upstreamMode=local 表示本机就是中心机器
        deviceId: cleanText(stored.remote?.deviceId, 60),
        hubBound: stored.remote?.hubBound === true,
        accountBound: stored.remote?.accountBound === true,
        hubUrl: cleanText(stored.remote?.hubUrl, 200) || 'https://hub.zsense.space',
        upstreamMode: stored.remote?.upstreamMode === 'local' ? 'local' : 'auto',
      },
      trustedPeers: Array.isArray(stored.trustedPeers) ? stored.trustedPeers.map((peer) => ({
        deviceId: cleanText(peer.deviceId, 100),
        name: cleanText(peer.name, 80) || '未命名设备',
        platform: ['darwin', 'win32', 'linux', 'android'].includes(peer.platform) ? peer.platform : 'linux',
        address: normalizedAddress(peer.address),
        port: Number(peer.port) || 0,
        connected: peer.connected !== false,
        pairedAt: cleanText(peer.pairedAt, 40) || new Date().toISOString(),
        lastSeenAt: cleanText(peer.lastSeenAt, 40),
        access: normalizePeerAccess(peer.access),
        identityPublicKey: String(peer.identityPublicKey || '').slice(0, 500),
        remoteDeviceId: cleanText(peer.remoteDeviceId, 60),
        source: peer.source === 'remote' ? 'remote' : 'lan',
        cloudPaired: peer.cloudPaired === true || peer.source === 'remote',
        tlsFingerprint: cleanText(peer.tlsFingerprint, 100),
        accountDiscovered: peer.accountDiscovered === true,
        hubOnline: peer.hubOnline === true,
      })).filter((peer) => peer.deviceId && (peer.source === 'remote' || (peer.port > 0 && isPrivateNetworkAddress(peer.address)))) : [],
      blockedAccountPeers: Array.isArray(stored.blockedAccountPeers) ? stored.blockedAccountPeers.map((id) => validRemoteDeviceId(id)).filter(Boolean).slice(0, 500) : [],
    }
    this.httpPort = 0
    this.pairingCode = ''
    this.pairingCodeExpiresAt = 0
    this.#persist()
  }

  async initialize() {
    if (this.state.enabled) await this.start()
    if (this.state.remote?.enabled && this.appLockEnabled()) void this.#startRemoteAgent()
    if (this.state.remote?.accountBound) void this.refreshRemoteIdentity().then(() => this.syncAccountPeers()).catch(() => undefined)
    if (!this.accountPeerTimer) {
      this.accountPeerTimer = setInterval(() => void this.syncAccountPeers().catch(() => undefined), 30_000)
      this.accountPeerTimer.unref?.()
    }
    if (!this.remoteLockWatchdog) {
      this.remoteLockWatchdog = setInterval(() => {
        try { this.enforceRemoteLockGate() } catch { /* 守护失败不影响主流程 */ }
      }, 20_000)
      this.remoteLockWatchdog.unref?.()
    }
    return this.inspect()
  }

  async start({ scan = false } = {}) {
    if (!this.identity) { this.lastError = this.identityError || '设备身份密钥不可用。'; throw new Error(this.lastError) }
    if (this.started) return this.inspect()
    if (this.starting) return this.starting
    this.starting = this.#startInternal({ scan })
    try {
      const status = await this.starting
      this.lastError = ''
      return status
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : '设备互联启动失败。'
      await this.stop({ persist: false })
      throw error
    }
    finally { this.starting = null }
  }

  async #startInternal({ scan = false } = {}) {
    this.#ensurePairingCode()
    await this.#startHttpServer()
    await this.#startDiscovery()
    this.started = true
    this.state.enabled = true
    this.#persist()
    this.#advertise()
    this.advertisementTimer = setInterval(() => this.#advertise(), ADVERTISEMENT_INTERVAL_MS)
    this.heartbeatTimer = setInterval(() => void this.#heartbeat(), HEARTBEAT_INTERVAL_MS)
    if (scan) await this.#scanOnceOnStart()
    this.#emitChanged()
    return this.inspect()
  }

  async stop({ persist = true } = {}) {
    this.started = false
    clearInterval(this.advertisementTimer)
    clearInterval(this.heartbeatTimer)
    this.advertisementTimer = null
    this.heartbeatTimer = null
    const socket = this.discoverySocket
    const server = this.httpServer
    this.discoverySocket = null
    this.httpServer = null
    this.httpPort = 0
    this.discovered.clear()
    this.onlinePeers.clear()
    this.scanProgress = null
    await Promise.allSettled([
      socket ? new Promise((resolve) => { try { socket.close(resolve) } catch { resolve() } }) : Promise.resolve(),
      server ? new Promise((resolve) => { try { server.close(resolve) } catch { resolve() } }) : Promise.resolve(),
    ])
    if (persist) {
      this.state.enabled = false
      this.#persist()
    }
    this.#emitChanged()
    return this.inspect()
  }

  async shutdown() {
    this.shuttingDown = true
    try { this.onRemoteDisabled?.() } catch { /* 忽略会话清理错误 */ }
    this.#stopTunnel()
    this.#stopRemoteAgent()
    if (this.state.remote?.hubBound && this.state.remote?.deviceId) {
      try { await this.#setHubOffline() } catch { /* 退出时尽力通知，TTL 仍会兜底 */ }
    }
    await this.stop({ persist: false })
    if (this.remoteLockWatchdog) { clearInterval(this.remoteLockWatchdog); this.remoteLockWatchdog = null }
    if (this.accountPeerTimer) { clearInterval(this.accountPeerTimer); this.accountPeerTimer = null }
  }

  /** 邮箱只用于在 Hub 验证归属；免密授权必须由已绑定的设备公钥证明。 */
  signRemoteChallenge(targetDeviceId, nonce) {
    if (!this.identity) throw new Error(this.identityError || '设备身份密钥不可用。')
    const target = cleanText(targetDeviceId, 60)
    const challenge = cleanText(nonce, 100)
    if (!/^[a-z0-9][a-z0-9-]{1,58}$/.test(target) || !/^[A-Za-z0-9_-]{24,100}$/.test(challenge)) throw new Error('设备挑战无效。')
    if (!this.state.trustedPeers.some((peer) => peer.remoteDeviceId === target && peer.identityPublicKey && peer.connected)) throw new Error('这台设备尚未完成设备密钥配对，或设备授权已暂停。')
    const source = `${target}:${challenge}`
    return sign(null, Buffer.from(source), createPrivateKey(this.identity.privateKey)).toString('base64url')
  }

  verifyRemoteChallenge(remoteDeviceId, nonce, signature) {
    const id = cleanText(remoteDeviceId, 60)
    const candidates = this.state.trustedPeers.filter((item) => item.remoteDeviceId === id && item.identityPublicKey && item.connected)
    const peer = candidates.find((item) => item.source === 'remote') || candidates[0]
    if (!peer || !this.appLockEnabled()) return false
    if (!nonce && !signature) return true
    if (!/^[A-Za-z0-9_-]{24,100}$/.test(String(nonce || '')) || !/^[A-Za-z0-9_-]{64,200}$/.test(String(signature || ''))) return false
    try {
      return verify(null, Buffer.from(`${this.#ensureRemoteDeviceId()}:${nonce}`), createPublicKey(peer.identityPublicKey), Buffer.from(signature, 'base64url'))
    } catch { return false }
  }

  identityPublicKey() { return this.identity?.publicKey || '' }

  identityPublicKeyFingerprint() {
    try { return `sha256:${createHash('sha256').update(createPublicKey(this.identityPublicKey()).export({ type: 'spki', format: 'der' })).digest('hex')}` }
    catch { return '' }
  }

  /** 交换中心地址（独立服务）：设备开启远程后会把「设备号 → 出站地址」登记过去 */
  hubUrl() {
    return cleanText(this.state.remote?.hubUrl, 200) || 'https://hub.zsense.space'
  }

  /** 设备锁是否开启：由主进程注入（未注入按「未开启」处理，安全默认） */
  appLockEnabled() {
    try {
      return typeof this.appLockProvider === 'function' ? Boolean(this.appLockProvider()) : false
    } catch {
      return false
    }
  }

  #remoteSecret() {
    try {
      return this.secrets?.get?.('device-link:remote') || {}
    } catch {
      return {}
    }
  }

  #remoteStatus() {
    const secret = this.#remoteSecret()
    const remote = this.state.remote || {}
    const publicUrl = remote.deviceId ? `https://${remote.deviceId}.${this.#publicDeviceDomain()}` : ''
    return {
      enabled: Boolean(remote.enabled),
      // 隧道可能是外部（launchd / 手工）启动的，只判断"自己 spawn 的进程还在不在"会误报「启动中」；
      // 所以再加上一次对公网地址的真实探测结果。
      running: Boolean(remote.enabled && ((this.quickTunnelProcess && !this.quickTunnelProcess.killed) || this.remoteReachable === true || remote.upstreamMode === 'local')),
      hostname: remote.hostname || 'app.zsense.space',
      url: remote.enabled ? publicUrl : '',
      mode: secret.token ? 'token' : 'named',
      tunnelName: remote.tunnelName || 'zsense',
      tokenConfigured: Boolean(secret.token),
      deviceLockEnabled: this.appLockEnabled(),
      startedAt: this.remoteStartedAt || '',
      deviceId: this.state.remote?.deviceId || '',
      identityPublicKey: this.identityPublicKey(),
      publicKeyFingerprint: this.identityPublicKeyFingerprint(),
      publicUrl,
      hubUrl: this.#hubBase(),
      // 仅由 Hub 验证邮箱后绑定到设备公钥，不能使用客户端自报的邮箱或邮箱哈希。
      accountVerified: remote.accountBound === true,
      sameEmailPeers: this.state.trustedPeers.filter((peer) => peer.accountDiscovered).map((peer) => ({ deviceId: peer.remoteDeviceId, name: peer.name, url: `https://${peer.remoteDeviceId}.${this.#publicDeviceDomain()}`, seenAt: peer.lastSeenAt })),
      upstreamMode: this.state.remote?.upstreamMode || 'auto',
      upstream: this.state.remote?.upstreamMode === 'local' ? `https://127.0.0.1:${this.localBridgePort || 39073}` : (this.quickTunnelUrl || ''),
      registeredAt: this.remoteRegisteredAt || '',
      lastError: this.remoteLastError || '',
    }
  }

  /** 设置远程入口域名（默认 app.zsense.space） */
  setRemoteHostname(value) {
    const hostname = cleanText(value, 120).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) throw new Error('请填写完整域名，例如 app.zsense.space。')
    this.state.remote = { ...(this.state.remote || {}), hostname }
    this.#persist()
    this.#emitChanged()
    return this.inspect()
  }

  /** 保存 Cloudflare 隧道令牌（写入系统密钥库，不落明文） */
  setRemoteToken(token) {
    const value = cleanText(token, 2_000)
    if (value && value.length < 20) throw new Error('隧道令牌看起来不完整，请重新复制。')
    try {
      this.secrets.set('device-link:remote', value ? { token: value } : {})
    } catch (error) {
      throw new Error(`令牌保存失败：${error instanceof Error ? error.message : error}`)
    }
    this.#emitChanged()
    return this.inspect()
  }

  #stopTunnel() {
    if (!this.tunnelProcess) return
    try { this.tunnelProcess.kill('SIGTERM') } catch { /* 进程可能已退出 */ }
    this.tunnelProcess = null
    this.remoteStartedAt = ''
  }

  #startTunnel() {
    if (this.tunnelProcess) return
    const secret = this.#remoteSecret()
    const binary = this.#cloudflaredPath()
    const name = this.state.remote?.tunnelName || 'zsense'
    const args = secret.token
      ? ['tunnel', '--no-autoupdate', 'run', '--token', secret.token]
      : ['tunnel', '--no-autoupdate', '--config', this.remoteConfigPath || `${this.rootPath}/remote-tunnel.yml`, 'run', name]
    this.remoteLastError = ''
    try {
      const child = this.spawnProcess(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.tunnelProcess = child
      this.remoteStartedAt = new Date().toISOString()
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', (chunk) => {
        const line = String(chunk).split('\n').map((item) => item.trim()).filter(Boolean).pop()
        if (line) this.remoteLastError = line.slice(0, 240)
      })
      child.on('error', (error) => {
        this.remoteLastError = `无法启动隧道进程：${error.message}`
        this.tunnelProcess = null
        this.#emitChanged()
      })
      child.on('exit', (code) => {
        this.tunnelProcess = null
        this.remoteStartedAt = ''
        if (this.state.remote?.enabled && code !== 0 && code !== null) this.remoteLastError = `隧道进程已退出（退出码 ${code}）`
        this.#emitChanged()
      })
    } catch (error) {
      this.remoteLastError = error instanceof Error ? error.message : String(error)
      this.tunnelProcess = null
    }
  }

  /** 设备号只能由交换中心分配；本地不再生成可抢注的路由标识。 */
  #ensureRemoteDeviceId() {
    return validRemoteDeviceId(this.state.remote?.deviceId)
  }

  /** 设备名永远跟随账号名：全局只用这一个名称，不再单独维护设备名 */
  syncDeviceNameFromOwner() {
    const owner = cleanText(this.ownerNameProvider?.() || '', 60)
    if (owner && owner !== this.state.deviceName) {
      this.state.deviceName = owner
      this.#persist()
      if (this.started) this.#advertise()
      this.#emitChanged()
    }
    return this.state.deviceName
  }

  /** 账号名或中心状态变化时，刷新设备号与接入方式（不要求远程已开启） */
  async refreshRemoteIdentity({ requireRegistration = false } = {}) {
    this.syncDeviceNameFromOwner()
    try {
      if (!this.detectLocalHub) throw new Error('local hub detection disabled')
      const response = await fetch('http://127.0.0.1:39080/__hub/devices')
      if (response.ok && this.state.remote?.upstreamMode !== 'local') {
        this.state.remote = { ...(this.state.remote || {}), upstreamMode: 'local' }
        this.#persist()
      }
    } catch { /* 不是中心机，保持默认出站通道 */ }
    // 即使尚未打开远程连接，也先用设备公钥向中心申请/确认设备号；无上游时保持离线。
    try { await this.#registerWithHub({ allowOffline: true }) }
    catch (error) {
      if (requireRegistration) throw error
      // 后台刷新保持离线可用；交互式邮箱验证则应显示实际注册错误。
    }
    this.#emitChanged()
    return this.inspect()
  }

  /**
   * 出站通道组件（cloudflared）的位置。
   * 优先用应用随包携带的二进制：非中心机的设备也要能开一条出站通道，
   * 不该要求用户额外安装（Windows 的 PATH 里没有它 → spawn ENOENT）。
   */
  #cloudflaredPath() {
    if (this.tunnelBinaryPath) return this.tunnelBinaryPath
    const names = process.platform === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared']
    const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
    const bases = [
      ...(process.resourcesPath ? [path.join(process.resourcesPath, 'bundled-tools')] : []),
      path.join(projectRoot, 'bundled-tools', `${process.platform}-${process.arch}`),
    ]
    for (const base of bases) {
      for (const name of names) {
        const candidate = path.join(base, name)
        try { if (fs.existsSync(candidate)) return candidate } catch { /* 忽略 */ }
      }
    }
    for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared']) {
      try { if (fs.existsSync(candidate)) return candidate } catch { /* 忽略 */ }
    }
    return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  }

  setRemoteDeviceId(value) {
    void value
    throw new Error('设备号由交换中心首次注册时自动分配，客户端不能手动指定或覆盖。')
  }

  setRemoteUpstreamMode(mode) {
    const value = mode === 'local' ? 'local' : 'auto'
    this.state.remote = { ...(this.state.remote || {}), upstreamMode: value }
    this.#persist()
    this.#emitChanged()
    if (this.state.remote?.enabled) this.#startRemoteAgent()
    return this.inspect()
  }

  #hubBase() {
    const raw = this.hubUrl().replace(/\/+$/, '')
    let parsed
    try { parsed = new URL(raw) } catch { throw new Error('交换中心地址无效。') }
    const loopbackTest = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    if ((parsed.protocol !== 'https:' && !loopbackTest) || parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
      throw new Error('交换中心必须使用无凭据、无路径的 HTTPS 地址（本机测试可用 HTTP 回环地址）。')
    }
    return parsed.origin
  }

  #publicDeviceDomain() {
    try {
      const hostname = new URL(this.#hubBase()).hostname.toLowerCase().replace(/^\[|\]$/g, '')
      if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return hostname.startsWith('hub.') ? hostname.slice(4) : hostname
    } catch { /* fall back to the legacy configured entry domain below */ }
    const configured = cleanText(this.state.remote?.hostname, 160).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    const labels = configured.split('.').filter(Boolean)
    return labels.length >= 3 ? labels.slice(1).join('.') : (configured || 'zsense.space')
  }

  async #hubFetch(route, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HUB_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.#hubBase()}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.error || `交换中心返回 HTTP ${response.status}。`)
        error.status = response.status
        error.code = payload?.code || 'hub-error'
        throw error
      }
      return payload?.data || {}
    } finally { clearTimeout(timer) }
  }

  async #hubChallenge(action) {
    const publicKey = this.identityPublicKey()
    const currentId = this.#ensureRemoteDeviceId()
    try {
      return await this.#hubFetch('/__hub/challenge', { action, deviceId: currentId, publicKey })
    } catch (error) {
      // A locally generated pre-v2 id that never existed at this hub is not migrated or claimed:
      // discard it and ask the hub to allocate a fresh id. Existing legacy mappings return
      // migration-required instead and remain frozen until an administrator binds the public key.
      if (action === 'register' && currentId && this.state.remote?.hubBound !== true && error?.code === 'unknown-device') {
        return await this.#hubFetch('/__hub/challenge', { action, deviceId: '', publicKey })
      }
      throw error
    }
  }

  async #hubMutation(action, { name = '', upstream = '', email = '', code = '' } = {}) {
    if (!this.identity) throw new Error(this.identityError || '设备身份密钥不可用。')
    const challenge = await this.#hubChallenge(action)
    const deviceId = validRemoteDeviceId(challenge.deviceId)
    if (!deviceId || !/^[A-Za-z0-9_-]{24,120}$/.test(String(challenge.nonce || '')) || !challenge.challengeId || !challenge.expiresAt) throw new Error('交换中心返回了无效挑战。')
    if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('交换中心挑战已过期，请重试。')
    const publicKey = this.identityPublicKey()
    const fields = { action, challengeId: challenge.challengeId, nonce: challenge.nonce, expiresAt: challenge.expiresAt, deviceId, publicKey, name: cleanText(name, 60), upstream: cleanText(upstream, 500) }
    const signature = sign(null, Buffer.from(canonicalHubMessage(fields)), createPrivateKey(this.identity.privateKey)).toString('base64url')
    const routes = { register: '/__hub/register', heartbeat: '/__hub/heartbeat', 'update-upstream': '/__hub/upstream', offline: '/__hub/offline', revoke: '/__hub/revoke', 'account-bind': '/__hub/account/bind', 'account-peers': '/__hub/account/peers' }
    const result = await this.#hubFetch(routes[action], { ...fields, signature, ...(action === 'account-bind' ? { email, code } : {}) })
    const assignedId = validRemoteDeviceId(result.deviceId)
    if (assignedId !== deviceId) throw new Error('交换中心返回的设备号与签名挑战不一致。')
    if (action !== 'account-peers' && action !== 'heartbeat') {
      this.state.remote = { ...(this.state.remote || {}), deviceId: assignedId, hubBound: action !== 'revoke' }
      this.#persist()
    }
    return result
  }

  /** 验证码必须在 Hub 消费，随后才允许本机保存邮箱。 */
  async bindVerifiedEmail(email, code) {
    await this.refreshRemoteIdentity({ requireRegistration: true })
    if (!this.state.remote?.hubBound) throw new Error('设备尚未在交换中心注册，暂时无法绑定邮箱。')
    await this.#hubMutation('account-bind', { email, code })
    this.state.remote = { ...this.state.remote, accountBound: true }
    this.#persist()
    // 验证码已经被中心消费；后续列表查询失败不能让用户误以为邮箱绑定失败。
    await this.syncAccountPeers().catch(() => undefined)
    this.#emitChanged()
    return this.inspect()
  }

  /** 双向自动发现：只有 Hub 返回的同一已验证账号设备才进入信任列表；远程权限默认全关。 */
  async syncAccountPeers() {
    if (!this.state.remote?.accountBound || !this.state.remote?.hubBound || !this.identity) return this.inspect()
    let result
    try { result = await this.#hubMutation('account-peers') }
    catch (error) {
      if (error?.code === 'account-not-bound' || error?.code === 'unknown-device' || error?.code === 'device-revoked') {
        this.state.remote = { ...this.state.remote, accountBound: false }
        this.#persist(); this.#emitChanged()
      }
      throw error
    }
    const seen = new Set()
    let changed = false
    const now = new Date().toISOString()
    for (const entry of Array.isArray(result.peers) ? result.peers : []) {
      const id = validRemoteDeviceId(entry?.deviceId)
      if (!id || id === this.#ensureRemoteDeviceId() || this.state.blockedAccountPeers.includes(id)) continue
      let publicKey
      try {
        const key = createPublicKey(String(entry.identityPublicKey || ''))
        if (key.asymmetricKeyType !== 'ed25519') continue
        publicKey = key.export({ type: 'spki', format: 'pem' })
      } catch { continue }
      seen.add(id)
      const existing = this.state.trustedPeers.find((peer) => peer.remoteDeviceId === id || peer.deviceId === id)
      if (existing) {
        // 同一设备号出现不同公钥必须拒绝，不能用发现结果静默替换旧身份。
        try {
          if (existing.identityPublicKey && createPublicKey(existing.identityPublicKey).export({ type: 'spki', format: 'der' }).compare(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })) !== 0) continue
        } catch { continue }
        if (existing.source !== 'remote') continue
        const nextOnline = entry.online === true
        if (existing.hubOnline !== nextOnline || existing.identityPublicKey !== publicKey || existing.name !== cleanText(entry.name, 60)) {
          existing.hubOnline = nextOnline; existing.identityPublicKey = publicKey; existing.name = cleanText(entry.name, 60) || id; existing.lastSeenAt = cleanText(entry.lastSeenAt, 40) || existing.lastSeenAt; changed = true
        }
      } else {
        this.state.trustedPeers.push({ deviceId: id, remoteDeviceId: id, identityPublicKey: publicKey, name: cleanText(entry.name, 60) || id,
          platform: 'linux', address: '', port: 0, access: { allowStatus: false, allowFiles: false, allowTasks: false },
          connected: true, cloudPaired: true, accountDiscovered: true, hubOnline: entry.online === true, pairedAt: now,
          lastSeenAt: cleanText(entry.lastSeenAt, 40), source: 'remote' })
        changed = true
      }
    }
    for (const peer of [...this.state.trustedPeers]) if (peer.accountDiscovered && !seen.has(peer.remoteDeviceId)) {
      this.#removeTrustedPeer(peer.deviceId)
      changed = true
    }
    if (changed) { this.#persist(); this.#emitChanged() }
    return this.inspect()
  }

  #currentUpstream() {
    if (this.state.remote?.upstreamMode === 'local') return HUB_LOCAL_UPSTREAM
    const configured = cleanText(process.env.ZSENSE_DEVICE_UPSTREAM_URL, 500)
    return configured || this.quickTunnelUrl || ''
  }

  async #registerWithHub({ allowOffline = false } = {}) {
    if (this.hubRegistrationPromise) {
      const result = await this.hubRegistrationPromise
      if (result || !allowOffline) return result
    }
    const run = async () => {
      const enabled = Boolean(this.state.remote?.enabled && this.appLockEnabled())
      if (!enabled && !allowOffline) return false
      const upstream = enabled ? this.#currentUpstream() : ''
      // 邮箱绑定只需要已签名的设备身份，不应被尚未就绪的出站隧道阻断。
      if (enabled && !upstream && !allowOffline) return false
      try {
        const result = await this.#hubMutation('register', { upstream, name: cleanText(this.state.deviceName, 60) })
        this.remoteRegisteredAt = new Date().toISOString()
        this.remoteLastError = ''
        this.sameEmailPeers = []
        if (this.state.remote?.accountBound) void this.syncAccountPeers().catch(() => undefined)
        this.#emitChanged()
        return result
      } catch (error) {
        const prefix = error?.code === 'migration-required' ? '旧设备号需要中心管理员绑定设备公钥：' : '注册到交换中心失败：'
        this.remoteLastError = `${prefix}${error instanceof Error ? error.message : error}`
        this.#emitChanged()
        throw error
      }
    }
    this.hubRegistrationPromise = run().finally(() => { this.hubRegistrationPromise = null })
    return await this.hubRegistrationPromise
  }

  async #heartbeatHub() {
    if (!this.state.remote?.enabled || !this.appLockEnabled() || !this.state.remote?.hubBound || !this.#currentUpstream()) return false
    try {
      await this.#hubMutation('heartbeat')
      this.remoteRegisteredAt = new Date().toISOString()
      this.remoteLastError = ''
      if (this.state.remote?.accountBound) void this.syncAccountPeers().catch(() => undefined)
      this.#emitChanged()
      return true
    } catch (error) {
      if (error?.code === 'upstream-missing' || error?.code === 'unknown-device') {
        // The hub has crossed an offline boundary (transport failure, TTL or
        // restart). Revoke old browser sessions before any route is restored,
        // otherwise a pre-offline Cookie could become valid again.
        try { this.onRemoteDisabled?.() } catch { /* 会话清理失败不影响重新注册 */ }
        return await this.#registerWithHub()
      }
      try { this.onRemoteDisabled?.() } catch { /* 会话清理失败不影响下一轮重连 */ }
      this.remoteLastError = `交换中心心跳失败：${error instanceof Error ? error.message : error}`
      this.#emitChanged()
      return false
    }
  }

  async #updateHubUpstream() {
    const upstream = this.#currentUpstream()
    if (!upstream || !this.state.remote?.enabled) return false
    if (!this.state.remote?.hubBound) return await this.#registerWithHub()
    try {
      await this.#hubMutation('update-upstream', { upstream, name: cleanText(this.state.deviceName, 60) })
      this.remoteRegisteredAt = new Date().toISOString()
      this.remoteLastError = ''
      this.#emitChanged()
      return true
    } catch (error) {
      if (error?.code === 'unknown-device') {
        try { this.onRemoteDisabled?.() } catch { /* 中心重启边界先撤销旧会话 */ }
        return await this.#registerWithHub()
      }
      try { this.onRemoteDisabled?.() } catch { /* 会话清理失败不影响下一轮重连 */ }
      this.remoteLastError = `更新交换中心上游失败：${error instanceof Error ? error.message : error}`
      this.#emitChanged()
      return false
    }
  }

  async #setHubOffline() {
    if (!this.state.remote?.hubBound || !this.#ensureRemoteDeviceId()) return false
    try { await this.#hubMutation('offline'); return true }
    catch (error) {
      this.remoteLastError = `通知交换中心下线失败（中心 TTL 会继续兜底）：${error instanceof Error ? error.message : error}`
      return false
    }
  }

  async revokeRemoteIdentity() {
    if (!this.state.remote?.hubBound || !this.#ensureRemoteDeviceId()) return this.inspect()
    this.state.remote = { ...(this.state.remote || {}), enabled: false }
    this.#persist()
    try { this.onRemoteDisabled?.() } catch { /* 会话清理失败不影响撤销 */ }
    this.#stopTunnel()
    this.#stopRemoteAgent()
    await this.#hubMutation('revoke')
    this.state.remote = { ...(this.state.remote || {}), deviceId: '', hubBound: false, accountBound: false }
    this.#persist()
    this.#emitChanged()
    return this.inspect()
  }

  /** 设备端自动化：本机模式直接注册；否则自动建立一条出站通道再注册（零手动） */
  async #startRemoteAgent() {
    if (!this.state.remote?.enabled || !this.appLockEnabled()) return
    if (this.detectLocalHub && this.state.remote?.upstreamMode !== 'local') {
      try {
        const response = await fetch('http://127.0.0.1:39080/__hub/devices')
        if (response.ok) {
          this.state.remote = { ...(this.state.remote || {}), upstreamMode: 'local' }
          this.#persist()
        }
      } catch { /* 不是中心机，走默认出站通道 */ }
    }
    if (this.state.remote?.upstreamMode === 'local') {
      await this.#registerWithHub().catch(() => false)
    } else if (cleanText(process.env.ZSENSE_DEVICE_UPSTREAM_URL, 500)) {
      await this.#registerWithHub().catch(() => false)
    } else if (!this.quickTunnelProcess) {
      try {
        const child = this.spawnProcess(this.#cloudflaredPath(), ['tunnel', '--no-autoupdate', '--url', `https://127.0.0.1:${this.localBridgePort || 39073}`, '--no-tls-verify'], { stdio: ['ignore', 'pipe', 'pipe'] })
        this.quickTunnelProcess = child
        child.stderr?.on('data', (chunk) => {
          const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
          if (match && match[0] !== this.quickTunnelUrl) {
            this.quickTunnelUrl = match[0]
            this.remoteReconnectDelayMs = 2_000
            void this.#updateHubUpstream()
          }
        })
        child.on('exit', () => {
          this.quickTunnelProcess = null
          this.quickTunnelUrl = ''
          this.remoteReachable = false
          if (!this.shuttingDown && this.state.remote?.enabled) {
            try { this.onRemoteDisabled?.() } catch { /* 隧道离线必须尽力撤销会话 */ }
            void this.#setHubOffline()
            this.#scheduleRemoteReconnect()
          }
        })
        child.on('error', (error) => {
          // 缺组件时给可操作的提示，而不是甩一句 ENOENT
          this.remoteLastError = String(error?.code) === 'ENOENT'
            ? '这台设备缺少出站组件，远程连接暂时不可用；可以先用局域网「附近设备 + 配对码」连接。'
            : `出站通道启动失败：${error.message}`
          this.quickTunnelProcess = null
          this.quickTunnelUrl = ''
          if (!this.shuttingDown && this.state.remote?.enabled) {
            try { this.onRemoteDisabled?.() } catch { /* 隧道离线必须尽力撤销会话 */ }
            void this.#setHubOffline()
            this.#scheduleRemoteReconnect()
          }
          this.#emitChanged()
        })
      } catch (error) {
        this.remoteLastError = error instanceof Error ? error.message : String(error)
      }
    } else {
      void this.#updateHubUpstream()
    }
    if (!this.remoteKeepalive) {
      this.remoteKeepalive = setInterval(() => {
        void this.#heartbeatHub()
      }, HUB_HEARTBEAT_INTERVAL_MS)
      this.remoteKeepalive.unref?.()
    }
  }

  #scheduleRemoteReconnect() {
    if (this.shuttingDown || !this.state.remote?.enabled || !this.appLockEnabled() || this.state.remote?.upstreamMode === 'local' || cleanText(process.env.ZSENSE_DEVICE_UPSTREAM_URL, 500) || this.remoteReconnectTimer) return
    const delay = Math.max(1_000, Math.min(30_000, Number(this.remoteReconnectDelayMs) || 2_000))
    this.remoteReconnectDelayMs = Math.min(30_000, delay * 2)
    this.remoteReconnectTimer = setTimeout(() => {
      this.remoteReconnectTimer = null
      void this.#startRemoteAgent()
    }, delay)
    this.remoteReconnectTimer.unref?.()
  }

  #stopRemoteAgent() {
    if (this.quickTunnelProcess) { try { this.quickTunnelProcess.kill('SIGTERM') } catch { /* 已退出 */ } this.quickTunnelProcess = null }
    this.quickTunnelUrl = ''
    if (this.remoteKeepalive) { clearInterval(this.remoteKeepalive); this.remoteKeepalive = null }
    if (this.remoteReconnectTimer) { clearTimeout(this.remoteReconnectTimer); this.remoteReconnectTimer = null }
  }

  /** 开启/关闭远程连接：前置条件是已开启设备锁 */
  async setRemoteEnabled(enabled) {
    const want = Boolean(enabled)
    if (want && !this.appLockEnabled()) {
      const error = new Error('远程连接需要先开启设备锁：请到「设置 → 安全」里设置锁屏密码并开启设备锁，再回来打开远程连接。')
      error.code = 'app-lock-required'
      throw error
    }
    this.state.remote = { ...(this.state.remote || {}), enabled: want }
    this.#persist()
    if (want) {
      await this.start()
      await this.#startRemoteAgent()
      void this.probeRemoteReachability()
    } else {
      this.remoteReachable = false
      try { this.onRemoteDisabled?.() } catch { /* 会话清理失败不影响关停 */ }
      this.#stopTunnel()
      this.#stopRemoteAgent()
      await this.#setHubOffline()
    }
    this.#emitChanged()
    return this.inspect()
  }

  /**
   * 探测公网地址是否真的通（隧道可能不是本应用起的）。
   * 用 /bridge/session 做探针：200/401 都说明路由通了，只认「拿到 HTTP 响应」。
   */
  async probeRemoteReachability() {
    const enabled = Boolean(this.state.remote?.enabled)
    const deviceId = cleanText(this.state.remote?.deviceId, 60)
    if (!enabled || !deviceId) {
      if (this.remoteReachable) { this.remoteReachable = false; this.#emitChanged() }
      return false
    }
    const origin = `https://${deviceId}.${this.#publicDeviceDomain()}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4_000)
    let reachable = false
    try {
      const response = await fetch(`${origin}/bridge/session`, { signal: controller.signal })
      reachable = response.status < 500
    } catch { reachable = false } finally { clearTimeout(timer) }
    if (reachable !== this.remoteReachable) {
      if (this.remoteReachable === true && !reachable) {
        try { this.onRemoteDisabled?.() } catch { /* 公网入口离线时尽力撤销远程会话 */ }
      }
      this.remoteReachable = reachable
      this.#emitChanged()
    }
    return reachable
  }

  /** 设备锁被关掉时自动断开远程连接（20 秒兜底一次） */
  enforceRemoteLockGate() {
    if (this.state.remote?.enabled && !this.appLockEnabled()) {
      this.state.remote.enabled = false
      void this.#setHubOffline()
      this.#stopTunnel()
      this.#stopRemoteAgent()
      this.remoteReachable = false
      try { this.onRemoteDisabled?.() } catch { /* 会话清理失败不影响关停 */ }
      this.remoteLastError = '设备锁已关闭，远程连接已自动断开。'
      this.#persist()
      this.#emitChanged()
      return true
    }
    return false
  }

  async setEnabled(enabled) {
    if (enabled) {
      this.state.enabled = true
      this.#persist()
      // 用户开启设备互联时立刻扫一次局域网；应用重启恢复状态时不做扫描（由打开界面时触发）。
      return this.start({ scan: true })
    }
    this.lastError = ''
    // 关闭总开关时远程连接必须立刻收敛：以前这里只停局域网，remote.enabled 仍留着 true，
    // 界面上就会残留一个「启动中」的远程分区，要等隧道自己超时才消失。
    if (this.state.remote?.enabled) {
      this.state.remote = { ...this.state.remote, enabled: false }
      this.#persist()
      try { this.onRemoteDisabled?.() } catch { /* 会话清理失败不影响关停 */ }
      this.#stopTunnel()
      this.#stopRemoteAgent()
      await this.#setHubOffline()
      this.remoteLastError = ''
      this.#persist()
      this.#emitChanged()
    }
    return this.stop()
  }

  setDeviceName(name) {
    const normalized = cleanText(name, 80)
    if (!normalized) throw new Error('设备名称不能为空。')
    this.state.deviceName = normalized
    this.#persist()
    if (this.started) this.#advertise()
    this.#emitChanged()
    return this.inspect()
  }

  /** 记录从公网用「设备号 + 配对码」连进来的设备，用于区分局域网/远程 */
  rememberRemotePeer(deviceId, name = '', identityPublicKey = '') {
    const id = cleanText(deviceId, 100)
    const publicKey = String(identityPublicKey || '').slice(0, 500)
    if (!validRemoteDeviceId(id)) return false
    try { if (createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') return false } catch { return false }
    const existing = this.state.trustedPeers.find((peer) => peer.deviceId === id || peer.remoteDeviceId === id)
    const now = new Date().toISOString()
    if (existing) {
      // 已绑定的设备密钥不可凭再次输入 6 位码静默替换；先在两端撤销旧授权。
      if (existing.identityPublicKey && createPublicKey(existing.identityPublicKey).export({ type: 'spki', format: 'der' }).compare(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })) !== 0) return false
      existing.connected = true; existing.cloudPaired = true; existing.lastSeenAt = now; existing.identityPublicKey = publicKey; existing.remoteDeviceId = id
      if (name) existing.name = cleanText(name, 60)
    } else {
      this.state.trustedPeers = [...this.state.trustedPeers, {
        deviceId: id, remoteDeviceId: id, identityPublicKey: publicKey, name: cleanText(name, 60) || id, address: '', port: 0, platformLabel: '远程连接',
        access: { allowStatus: false, allowFiles: false, allowTasks: false }, online: true, connected: true, cloudPaired: true, lastSeenAt: now, source: 'remote',
      }]
    }
    this.state.blockedAccountPeers = this.state.blockedAccountPeers.filter((blocked) => blocked !== id)
    this.#persist(); this.#emitChanged()
    return true
  }

  /** 当前有效的配对码（过期返回空串）：异邮箱设备凭「设备号 + 配对码」连接时校验用 */
  currentPairingCode() {
    if (!this.pairingCode) return ''
    if (this.pairingCodeExpiresAt && this.pairingCodeExpiresAt < Date.now()) return ''
    return String(this.pairingCode)
  }

  refreshPairingCode() {
    this.pairingCode = String(randomInt(100_000, 1_000_000))
    this.pairingCodeExpiresAt = Date.now() + PAIRING_CODE_TTL_MS
    this.#emitChanged()
    return this.inspect()
  }

  // 界面上的“刷新”现在是一次真正的主动扫描（组播 + 广播 + 单播逐点），而不只是重发自己的公告。
  async refresh() {
    if (!this.started) return this.inspect()
    void this.#heartbeat()
    return this.scan()
  }

  // 登记一台发现到的设备（广告与扫描共用）：顺便把已配对设备变化过的地址/端口写回。
  #registerDiscovered(descriptor) {
    const deviceId = cleanText(descriptor?.deviceId, 100)
    const address = normalizedAddress(descriptor?.address)
    const port = Number(descriptor?.port)
    if (!deviceId || deviceId === this.state.deviceId || !isPrivateNetworkAddress(address) || !Number.isInteger(port) || port < 1 || port > 65_535) return false
    const previous = this.discovered.get(deviceId)
    const next = {
      deviceId,
      name: cleanText(descriptor.name, 80) || '未命名设备',
      platform: ['darwin', 'win32', 'linux', 'android'].includes(descriptor.platform) ? descriptor.platform : 'linux',
      platformLabel: platformLabel(descriptor.platform),
      address,
      port,
      lastSeenAt: new Date().toISOString(),
      paired: this.state.trustedPeers.some((peer) => peer.deviceId === deviceId),
      ...(descriptor.manual ? { manual: true } : {}),
      ...(descriptor.source ? { source: descriptor.source } : {}),
    }
    this.discovered.set(deviceId, next)
    const trusted = this.state.trustedPeers.find((peer) => peer.deviceId === deviceId)
    const trustedChanged = Boolean(trusted && (trusted.name !== next.name || trusted.platform !== next.platform || trusted.address !== next.address || trusted.port !== next.port))
    if (trustedChanged && trusted) {
      Object.assign(trusted, { name: next.name, platform: next.platform, address: next.address, port: next.port })
      this.#persist()
    }
    if (!previous || previous.name !== next.name || previous.address !== next.address || previous.port !== next.port || trustedChanged) this.#emitChanged()
    return true
  }

  ingestAdvertisement(payload, remoteAddress) {
    if (!payload || payload.protocol !== PROTOCOL || payload.version !== PROTOCOL_VERSION) return false
    const deviceId = cleanText(payload.deviceId, 100)
    const registered = this.#registerDiscovered({
      deviceId,
      name: payload.name,
      platform: payload.platform,
      address: normalizedAddress(remoteAddress),
      port: Number(payload.port),
    })
    // 收到“别的设备”的公告才说明组播这条路是通的（组播回环会把自己的公告也收回来，不能算）。
    if (registered && deviceId !== this.state.deviceId) {
      this.lastAdvertisementAt = Date.now()
      this.emptyScanStreak = 0
    }
    return registered
  }

  async pair(deviceId, code) {
    if (!this.started) throw new Error('请先启用设备互联。')
    const peer = this.discovered.get(cleanText(deviceId, 100))
    if (!peer) throw new Error('目标设备已离线，请刷新后重试。')
    const { code: pairingCode, identityCode } = parsePairingCredential(code)
    const sharedSecret = randomBytes(32).toString('base64url')
    const result = await this.#request({ ...peer, expectedIdentityCode: identityCode }, '/v1/pair', {
      code: pairingCode,
      sharedSecret,
      peer: this.#localDescriptor(),
    })
    if (!result?.ok) throw new Error(cleanText(result?.error, 300) || '目标设备拒绝了配对。')
    this.secrets.set(secretScope(peer.deviceId), { sharedSecret })
    const remote = this.#validatedPeerDescriptor(result.device, peer.address)
    this.#upsertTrustedPeer({ ...peer, ...remote, tlsFingerprint: result._tlsFingerprint, connected: true, pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
    this.onlinePeers.add(peer.deviceId)
    this.#persist()
    this.#emitChanged()
    return this.inspect()
  }

  // 手动按 IP 配对：局域网上组播常被路由器的访客网络、AP 隔离或跨网段挡掉，
  // 这时发现列表会一直是空的。只要两台设备能互相 ping 通，就可以直接按 IP + 端口 + 配对码建立连接。
  async pairByAddress({ address, port, code } = {}) {
    if (!this.started) throw new Error('请先启用设备互联。')
    const host = cleanText(address, 128).replace(/^https?:\/\//i, '').split('/')[0]
    const targetPort = Math.floor(Number(port) || 0) || DEFAULT_HTTP_PORT
    const { code: pairingCode, identityCode } = parsePairingCredential(code)
    if (!host) throw new Error('请输入对方设备的局域网地址（例如 192.168.3.15）。')
    if (!isPrivateNetworkAddress(host)) throw new Error('只能连接局域网地址；请填写对方设备的 192.168.x.x 或 10.x 地址。')
    if (!(targetPort > 0 && targetPort < 65_536)) throw new Error('端口无效，请填写 1-65535 之间的数字。')
    const sharedSecret = randomBytes(32).toString('base64url')
    const result = await this.#request({ address: host, port: targetPort, expectedIdentityCode: identityCode }, '/v1/pair', {
      code: pairingCode,
      sharedSecret,
      peer: this.#localDescriptor(),
    })
    if (!result?.ok) throw new Error(cleanText(result?.error, 300) || '目标设备拒绝了配对。')
    const remote = this.#validatedPeerDescriptor(result.device, host)
    const descriptor = { ...remote, port: targetPort, tlsFingerprint: result._tlsFingerprint, connected: true, pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), manual: true }
    this.secrets.set(secretScope(descriptor.deviceId), { sharedSecret })
    this.#upsertTrustedPeer(descriptor)
    this.onlinePeers.add(descriptor.deviceId)
    this.#registerDiscovered({
      deviceId: descriptor.deviceId,
      name: descriptor.name,
      platform: descriptor.platform,
      address: host,
      port: targetPort,
      paired: true,
      manual: true,
      source: 'manual',
    })
    this.#persist()
    this.#emitChanged()
    return this.inspect()
  }

  async connect(deviceId) {
    const peer = this.#trustedPeer(deviceId)
    peer.connected = true
    this.#persist()
    if (peer.source === 'remote') { this.#emitChanged(); return this.inspect() }
    await this.#pingPeer(peer)
    this.#emitChanged()
    return this.inspect()
  }

  disconnect(deviceId) {
    const peer = this.#trustedPeer(deviceId)
    peer.connected = false
    this.remoteTaskRunner?.cancelPeer?.(peer.deviceId)
    this.onlinePeers.delete(peer.deviceId)
    this.#persist()
    this.#emitChanged()
    return this.inspect()
  }

  async unpair(deviceId) {
    const peer = this.#trustedPeer(deviceId)
    const remoteId = validRemoteDeviceId(peer.remoteDeviceId || peer.deviceId)
    const secret = this.secrets.get(secretScope(peer.deviceId)).sharedSecret
    if (secret) {
      try { await this.#request(peer, '/v1/unpair', { deviceId: this.state.deviceId }, secret) }
      catch { /* Local revocation must still succeed when the peer is offline. */ }
    }
    this.#removeTrustedPeer(peer.deviceId)
    if (remoteId && !this.state.blockedAccountPeers.includes(remoteId)) {
      this.state.blockedAccountPeers.push(remoteId)
      this.#persist()
    }
    return this.inspect()
  }

  inspect() {
    if (this.started) this.#ensurePairingCode()
    const now = Date.now()
    for (const [deviceId, peer] of this.discovered) {
      if (now - Date.parse(peer.lastSeenAt) > PEER_EXPIRY_MS) this.discovered.delete(deviceId)
    }
    const pairedIds = new Set(this.state.trustedPeers.map((peer) => peer.deviceId))
    return {
      remote: this.#remoteStatus(),
      supported: ['darwin', 'win32', 'linux'].includes(this.platform),
      enabled: this.state.enabled,
      running: this.started,
      error: this.lastError,
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      device: {
        deviceId: this.state.deviceId,
        name: this.state.deviceName,
        platform: this.platform,
        platformLabel: platformLabel(this.platform),
        addresses: localAddresses(),
        port: this.httpPort,
      },
      pairingCode: this.started ? this.pairingCode : '',
      pairingIdentityCode: this.started ? this.tlsIdentityCode || '' : '',
      pairingCodeExpiresAt: this.started ? new Date(this.pairingCodeExpiresAt).toISOString() : '',
      discoveredDevices: [...this.discovered.values()].map((peer) => ({ ...peer, paired: pairedIds.has(peer.deviceId) })).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
      scanProgress: this.scanProgress ? { ...this.scanProgress } : null,
      trustedPeers: this.state.trustedPeers.map((peer) => ({
        source: peer.source === 'remote' ? 'remote' : 'lan',
        ...peer,
        platformLabel: peer.accountDiscovered ? '云端设备' : platformLabel(peer.platform),
        online: peer.connected && (this.onlinePeers.has(peer.deviceId) || (peer.source === 'remote' && peer.hubOnline === true)),
        connectionMode: !peer.connected ? 'offline' : peer.source !== 'remote' && this.onlinePeers.has(peer.deviceId) ? 'lan' : peer.cloudPaired && peer.remoteDeviceId && peer.identityPublicKey && peer.hubOnline === true && this.state.remote?.enabled ? 'cloud' : 'offline',
      })).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))),
      security: {
        scope: 'private-network-only',
        encryptedCredentials: true,
        remoteAgentAccess: this.state.trustedPeers.some((peer) => peer.access.allowStatus || peer.access.allowFiles || peer.access.allowTasks),
        remoteStatusAccess: this.state.trustedPeers.some((peer) => peer.access.allowStatus),
        remoteFileAccess: this.state.trustedPeers.some((peer) => peer.access.allowFiles),
        remoteTaskAccess: this.state.trustedPeers.some((peer) => peer.access.allowTasks),
      },
    }
  }

  setPeerAccess(deviceId, access) {
    const peer = this.#trustedPeer(deviceId)
    peer.access = normalizePeerAccess(access)
    if (!peer.access.allowTasks) this.remoteTaskRunner?.cancelPeer?.(peer.deviceId)
    this.#persist()
    this.#emitChanged()
    return this.inspect()
  }

  async remoteStatus(deviceId) {
    const peer = this.#trustedPeer(deviceId)
    if (!peer.connected) throw new Error('请先重新连接该设备。')
    const secret = this.secrets.get(secretScope(peer.deviceId)).sharedSecret
    if (!secret) throw new Error('设备授权已失效，请重新配对。')
    const result = await this.#request(peer, '/v1/inspect', { deviceId: this.state.deviceId }, secret, REQUEST_TIMEOUT_MS)
    if (!result?.ok) throw new Error(cleanText(result?.error, 300) || '对方设备拒绝了状态读取请求。')
    return result.status
  }

  // 读取对端内容：由接收端分别授权结构化数据和文件范围。
  async readRemoteData(deviceId, scope, query = {}) {
    const peer = this.#trustedPeer(deviceId)
    if (!peer.connected) throw new Error('请先重新连接该设备。')
    const secret = this.secrets.get(secretScope(peer.deviceId)).sharedSecret
    if (!secret) throw new Error('设备授权已失效，请重新配对。')
    const normalizedScope = cleanText(scope, 40) || 'overview'
    const result = await this.#request(peer, '/v1/data', {
      deviceId: this.state.deviceId,
      scope: normalizedScope,
      query: query && typeof query === 'object' && !Array.isArray(query) ? query : {},
    }, secret, DATA_TIMEOUT_MS)
    if (!result?.ok) throw new Error(cleanText(result?.error, 300) || '对方设备拒绝了数据读取请求。')
    peer.lastSeenAt = new Date().toISOString()
    this.onlinePeers.add(peer.deviceId)
    return { scope: normalizedScope, data: result.data, device: { deviceId: peer.deviceId, name: peer.name, platform: peer.platform, address: peer.address, port: peer.port } }
  }

  async runRemoteTask(deviceId, prompt, timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {
    const peer = this.#trustedPeer(deviceId)
    if (!peer.connected) throw new Error('请先连接该设备后再发送任务。')
    const message = cleanText(prompt, MAX_TASK_PROMPT_LENGTH)
    if (!message) throw new Error('请输入要让对方设备执行的任务内容。')
    const budget = Math.max(MIN_TASK_TIMEOUT_MS, Math.min(MAX_TASK_TIMEOUT_MS, Math.floor(Number(timeoutMs) || DEFAULT_TASK_TIMEOUT_MS)))
    if (peer.source === 'remote' || (peer.cloudPaired && !this.onlinePeers.has(peer.deviceId))) return this.#runCloudTask(peer, message, budget)
    const secret = this.secrets.get(secretScope(peer.deviceId)).sharedSecret
    if (!secret) throw new Error('设备授权已失效，请重新配对。')
    const result = await this.#request(peer, '/v1/run', { deviceId: this.state.deviceId, prompt: message, timeoutMs: budget }, secret, budget + 15_000)
    if (!result?.ok) throw new Error(cleanText(result?.error, 300) || '对方设备执行任务失败。')
    return result.result
  }

  // 公网任务不占用交换中心的长连接：签名提交，随后用短请求查询状态。
  // 每个请求都消耗一次挑战，签名绑定请求体，中心不能悄悄替换任务内容。
  async #cloudTaskRequest(peer, route, body) {
    const target = validRemoteDeviceId(peer.remoteDeviceId || peer.deviceId)
    const ownId = validRemoteDeviceId(this.state.remote?.deviceId)
    if (!target || !ownId || !peer.identityPublicKey) throw new Error('云端设备身份尚未完成配对，请重新连接。')
    if (!this.state.remote?.enabled || !this.appLockEnabled()) throw new Error('云端 Agent 通信需要本机开启设备互联与安全锁。')
    const origin = `https://${target}.${this.#publicDeviceDomain()}`
    const fetchShort = async (url, options) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HUB_REQUEST_TIMEOUT_MS)
      timer.unref?.()
      try {
        const response = await fetch(url, { ...options, signal: controller.signal })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok === false) {
          const error = new Error(cleanText(payload?.error, 300) || `云端设备返回 HTTP ${response.status}。`)
          error.status = response.status
          throw error
        }
        return payload
      } finally { clearTimeout(timer) }
    }
    const challenge = await fetchShort(`${origin}/bridge/trust-challenge`, { method: 'POST', headers: { 'x-zsense-device': ownId } })
    const nonce = String(challenge?.data?.nonce || '')
    if (!/^[A-Za-z0-9_-]{24,100}$/.test(nonce)) throw new Error('云端设备没有返回有效的身份挑战。')
    const signedPayload = createHash('sha256').update(`zsense-agent-v1\nPOST\n${route}\n${nonce}\n${JSON.stringify(body)}`).digest('base64url')
    const signature = this.signRemoteChallenge(target, signedPayload)
    return fetchShort(`${origin}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zsense-device': ownId, 'x-zsense-nonce': nonce, 'x-zsense-signature': signature },
      body: JSON.stringify(body),
    })
  }

  async #runCloudTask(peer, prompt, budget) {
    let submitted
    try {
      submitted = await this.#cloudTaskRequest(peer, '/bridge/agent-task', { prompt, timeoutMs: budget })
    } catch (error) {
      if (error?.name === 'AbortError' || error instanceof TypeError || Number(error?.status) >= 500) {
        throw new Error('云端任务提交结果不确定：对方可能已经收到任务。本机不会自动重发，请先查看对方设备的运行记录。')
      }
      throw error
    }
    const taskId = String(submitted?.data?.taskId || '')
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error('对方未确认云端任务已收到。')
    const deadline = Date.now() + budget + 15_000
    let failures = 0
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      let result
      try {
        result = await this.#cloudTaskRequest(peer, '/bridge/agent-task-result', { taskId })
      } catch (error) {
        // 查询失败可安全重试；任务提交永不自动重试，避免重复执行。
        if (++failures >= 3 || /任务不存在|已过期|身份|签名|授权/.test(String(error?.message || ''))) throw error
        continue
      }
      failures = 0
      if (result?.data?.status === 'complete') return result.data.result
      if (result?.data?.status === 'failed') throw new Error(cleanText(result.data.error, 300) || '对方设备执行失败。')
      if (result?.data?.status !== 'running') throw new Error('对方返回了未知的任务状态。')
    }
    throw new Error('等待云端设备执行结果超时；任务可能仍在对方设备运行，请查看对方运行记录。')
  }

  runTaskFromCloudPeer(deviceId, prompt, timeoutMs) {
    const peer = this.state.trustedPeers.find((item) => item.deviceId === deviceId || item.remoteDeviceId === deviceId)
    if (!peer || !peer.cloudPaired || !peer.connected || !peer.identityPublicKey) throw new Error('云端设备尚未完成双向密钥配对。')
    if (!this.state.remote?.enabled || !this.appLockEnabled()) throw new Error('本机云端连接或安全锁已关闭。')
    if (!peer.access.allowTasks) throw new Error('这台设备尚未获准在本机执行 Agent 任务。')
    if (!this.remoteTaskRunner) throw new Error('本机 Agent 任务执行器尚未就绪。')
    const message = cleanText(prompt, MAX_TASK_PROMPT_LENGTH)
    if (!message) throw new Error('远程任务内容不能为空。')
    const budget = Math.max(MIN_TASK_TIMEOUT_MS, Math.min(MAX_TASK_TIMEOUT_MS, Math.floor(Number(timeoutMs) || DEFAULT_TASK_TIMEOUT_MS)))
    return this.remoteTaskRunner.run({ prompt: message, peer: { deviceId: peer.deviceId, name: peer.name, platform: peer.platform }, timeoutMs: budget })
  }

  cancelRemoteTaskFromPeer(deviceId) {
    const peer = this.state.trustedPeers.find((item) => item.deviceId === deviceId || item.remoteDeviceId === deviceId)
    return peer ? this.remoteTaskRunner?.cancelPeer?.(peer.deviceId) : false
  }

  cancelAllRemoteTasks() {
    this.remoteTaskRunner?.cancelAll?.()
  }

  async #startHttpServer() {
    const tls = this.#tlsCertificate()
    this.tlsIdentityCode = new X509Certificate(tls.cert).fingerprint256.replace(/:/g, '').slice(0, 16)
    const preferredPort = Math.floor(Number(this.state.httpPort) || 0) || DEFAULT_HTTP_PORT
    const listen = async (port) => {
      const server = https.createServer(tls, (request, response) => void this.#handleRequest(request, response))
      server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject)
          resolve()
        })
      })
      return server
    }
    let server
    try {
      server = await listen(preferredPort)
    } catch (error) {
      // 端口被占用（例如应用开了两份）时退回随机端口，配对仍然可用，只是手动连接需要以界面显示的端口为准。
      if (preferredPort === 0) throw error
      server = await listen(0)
    }
    this.httpServer = server
    this.httpPort = Number(server.address()?.port) || 0
    if (this.state.httpPort !== this.httpPort) {
      this.state.httpPort = this.httpPort
      this.#persist()
    }
  }

  #tlsCertificate() {
    const certPath = path.join(this.directory, 'tls-cert.pem')
    const keyPath = path.join(this.directory, 'tls-key.pem')
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      fs.mkdirSync(this.directory, { recursive: true })
      const certificate = selfsigned.generate([{ name: 'commonName', value: 'ZSense Device Link' }], { days: 820, keySize: 2048, algorithm: 'sha256' })
      fs.writeFileSync(certPath, certificate.cert, { mode: 0o600 })
      fs.writeFileSync(keyPath, certificate.private, { mode: 0o600 })
    }
    const cert = fs.readFileSync(certPath)
    return { cert, key: fs.readFileSync(keyPath) }
  }

  async #startDiscovery() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', (message, remote) => {
      try {
        const payload = JSON.parse(message.toString('utf8'))
        // 探测请求：对方在主动找设备（多半因为组播被网络挡掉了）。只回私有地址并做频率限制。
        if (payload?.protocol === PROTOCOL && payload.type === 'probe') {
          this.#answerProbe(remote)
          return
        }
        this.ingestAdvertisement(payload, remote.address)
      } catch { /* Ignore malformed LAN advertisements. */ }
    })
    socket.on('error', (error) => {
      console.warn('ZSense 设备发现服务异常：', error instanceof Error ? error.message : error)
    })
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(this.discoveryPort, '0.0.0.0', () => {
          socket.off('error', reject)
          try {
            socket.addMembership(this.discoveryAddress)
            socket.setMulticastTTL(1)
            socket.setMulticastLoopback(true)
            resolve()
          } catch (error) { reject(error) }
        })
      })
    } catch (error) {
      try { socket.close() } catch { /* Ignore cleanup after a failed bind. */ }
      throw error
    }
    this.discoverySocket = socket
  }

  // 收到探测后立即单播回一条公告：即使组播被隔离，发起方也能发现自己。
  #answerProbe(remote) {
    if (!this.discoverySocket || !this.httpPort) return
    if (!isPrivateNetworkAddress(remote?.address)) return
    const key = `${remote.address}:${remote.port}`
    const now = Date.now()
    if ((this.probeReplies.get(key) || 0) + PROBE_REPLY_COOLDOWN_MS > now) return
    this.probeReplies.set(key, now)
    if (this.probeReplies.size > 200) {
      for (const [entry, at] of this.probeReplies) if (now - at > 60_000) this.probeReplies.delete(entry)
    }
    const payload = Buffer.from(JSON.stringify({
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      deviceId: this.state.deviceId,
      name: this.state.deviceName,
      platform: this.platform,
      port: this.httpPort,
      timestamp: Date.now(),
    }))
    this.discoverySocket.send(payload, remote.port, remote.address, () => undefined)
  }

  #sendProbe() {
    if (!this.discoverySocket || !this.httpPort) return
    const payload = Buffer.from(JSON.stringify({
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      type: 'probe',
      deviceId: this.state.deviceId,
      name: this.state.deviceName,
      platform: this.platform,
      port: this.httpPort,
      timestamp: Date.now(),
    }))
    try { this.discoverySocket.setBroadcast(true) } catch { /* 个别平台不允许时忽略 */ }
    for (const target of [this.discoveryAddress, '255.255.255.255', ...this.#broadcastAddresses()]) {
      try { this.discoverySocket.send(payload, this.discoveryPort, target, () => undefined) } catch { /* 忽略单个目标失败 */ }
    }
  }

  #broadcastAddresses() {
    const addresses = new Set()
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.internal || entry.family !== 'IPv4' || !entry.netmask) continue
        const address = normalizedAddress(entry.address)
        if (!isPrivateNetworkAddress(address)) continue
        const parts = address.split('.').map(Number)
        const mask = entry.netmask.split('.').map(Number)
        if (parts.length !== 4 || mask.length !== 4) continue
        addresses.add(parts.map((value, index) => ((value & mask[index]) | (~mask[index] & 255))).join('.'))
      }
    }
    return [...addresses]
  }

  #scanTargets() {
    // 始终包含回环地址：同机双实例（测试、调试）也能互相发现。
    const targets = new Set(['127.0.0.1'])
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.internal || entry.family !== 'IPv4' || entry.netmask !== '255.255.255.0') continue
        const address = normalizedAddress(entry.address)
        if (!isPrivateNetworkAddress(address)) continue
        const prefix = address.split('.').slice(0, 3).join('.')
        for (let host = 1; host <= 254; host += 1) {
          const candidate = `${prefix}.${host}`
          if (candidate !== address) targets.add(candidate)
        }
      }
    }
    return [...targets]
  }

  // 主动扫描：先发组播/广播探测，再逐个主机单播探一次 /v1/status。
  // 只要两台设备之间能互通（哪怕路由器挡掉了组播），这一步就能发现对方。
  #scanPorts() {
    return [...new Set([
      ...(this.autoScanPorts || [DEFAULT_HTTP_PORT]),
      ...this.state.trustedPeers.map((peer) => Math.floor(Number(peer.port) || 0)),
    ].filter((port) => port > 0 && port < 65_536))]
  }

  async scan({ ports = null, timeoutMs = SCAN_TIMEOUT_MS, deep = true, concurrency = SCAN_CONCURRENCY, background = false } = {}) {
    if (!this.started) throw new Error('请先启用设备互联。')
    if (this.scanning) return this.scanning
    if (Date.now() - this.lastScanAt < SCAN_COOLDOWN_MS) return this.inspect()
    this.lastScanAt = Date.now()
    const candidatePorts = [...new Set((Array.isArray(ports) ? ports : this.#scanPorts())
      .map((port) => Math.floor(Number(port) || 0))
      .filter((port) => port > 0 && port < 65_536))]
    this.scanning = (async () => {
      this.#sendProbe()
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (!deep) return this.inspect()
      const hosts = this.#scanTargets()
      this.scanProgress = { scanned: 0, total: hosts.length }
      this.#emitChanged()
      const budget = Math.max(200, Math.min(3_000, Number(timeoutMs) || SCAN_TIMEOUT_MS))
      let index = 0
      let scanned = 0
      let lastProgressAt = 0
      const worker = async () => {
        while (index < hosts.length) {
          const host = hosts[index]
          index += 1
          for (const port of candidatePorts) {
            try {
              const payload = await this.#request({ address: host, port }, '/v1/status', null, '', budget)
              const descriptor = payload?.device
              if (!payload?.ok || !descriptor?.deviceId || descriptor.deviceId === this.state.deviceId) continue
              this.#registerDiscovered({
                deviceId: cleanText(descriptor.deviceId, 100),
                name: cleanText(descriptor.name, 80) || '未命名设备',
                platform: descriptor.platform,
                address: host,
                port: Number(descriptor.port) || port,
                lastSeenAt: new Date().toISOString(),
                source: 'scan',
              })
            } catch { /* 大多数主机不会响应，属正常 */ }
          }
          scanned += 1
          if (this.scanProgress) this.scanProgress.scanned = scanned
          if (Date.now() - lastProgressAt > 300) { lastProgressAt = Date.now(); this.#emitChanged() }
        }
      }
      await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(concurrency) || SCAN_CONCURRENCY), Math.max(1, hosts.length)) }, () => worker()))
      return this.inspect()
    })()
    try {
      const result = await this.scanning
      if (background) {
        // 连续没找到新设备就退避，避免在安静的网络里一直做无用探测。
        if ((result?.discoveredDevices?.length || 0) > 0) this.emptyScanStreak = 0
        else this.emptyScanStreak = Math.min(6, this.emptyScanStreak + 1)
      }
    } finally {
      this.scanning = null
      this.scanProgress = null
      this.#emitChanged()
    }
    return this.inspect()
  }

  #networkSignature() {
    const addresses = []
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.internal || entry.family !== 'IPv4') continue
        const address = normalizedAddress(entry.address)
        if (isPrivateNetworkAddress(address)) addresses.push(address)
      }
    }
    return addresses.sort().join(',')
  }

  // 开启设备互联时扫一次：不用用户手动点也能看到局域网里的设备。
  // 之后只在用户打开设备互联界面（界面会调 refresh）或主动要求（list_devices scan）时再扫，不做后台轮询。
  async #scanOnceOnStart() {
    if (!this.autoScan) return
    setTimeout(() => {
      void this.scan({ deep: true, background: true, timeoutMs: AUTO_SCAN_BACKGROUND_TIMEOUT_MS, concurrency: AUTO_SCAN_BACKGROUND_CONCURRENCY }).catch(() => undefined)
    }, 1_200).unref?.()
  }

  #advertise() {
    if (!this.discoverySocket || !this.httpPort) return
    const payload = Buffer.from(JSON.stringify({
      protocol: PROTOCOL,
      version: PROTOCOL_VERSION,
      deviceId: this.state.deviceId,
      name: this.state.deviceName,
      platform: this.platform,
      port: this.httpPort,
      timestamp: Date.now(),
    }))
    this.discoverySocket.send(payload, this.discoveryPort, this.discoveryAddress, () => undefined)
  }

  async #handleRequest(request, response) {
    const remoteAddress = normalizedAddress(request.socket.remoteAddress)
    if (!isPrivateNetworkAddress(remoteAddress)) return jsonResponse(response, 403, { ok: false, error: '仅允许局域网设备连接。' })
    if (request.method === 'GET' && request.url === '/v1/status') {
      return jsonResponse(response, 200, { ok: true, device: this.#localDescriptor() })
    }
    if (request.method !== 'POST') return jsonResponse(response, 404, { ok: false, error: '接口不存在。' })
    try {
      const body = await readBody(request)
      if (request.url === '/v1/pair') {
        const attempts = (this.pairAttempts.get(remoteAddress) || []).filter((at) => Date.now() - at < PAIR_ATTEMPT_WINDOW_MS)
        if (attempts.length >= PAIR_ATTEMPT_LIMIT) return jsonResponse(response, 429, { ok: false, error: '配对尝试过多，请稍后再试。' })
        this.#ensurePairingCode()
        if (!safeSecretEquals(this.pairingCode, cleanText(body.code, 6)) || Date.now() > this.pairingCodeExpiresAt) {
          attempts.push(Date.now())
          this.pairAttempts.set(remoteAddress, attempts)
          return jsonResponse(response, 403, { ok: false, error: '配对码错误或已过期。' })
        }
        this.pairAttempts.delete(remoteAddress)
        const peer = this.#validatedPeerDescriptor(body.peer, remoteAddress)
        const sharedSecret = cleanText(body.sharedSecret, 200)
        if (sharedSecret.length < 32) return jsonResponse(response, 400, { ok: false, error: '配对凭证无效。' })
        this.secrets.set(secretScope(peer.deviceId), { sharedSecret })
        this.#upsertTrustedPeer({ ...peer, connected: true, pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
        this.onlinePeers.add(peer.deviceId)
        this.#persist()
        this.refreshPairingCode()
        this.#emitChanged()
        return jsonResponse(response, 200, { ok: true, device: this.#localDescriptor(), webBridge: this.webBridgeInfoProvider?.() || null })
      }
      const deviceId = cleanText(body.deviceId, 100)
      const peer = this.state.trustedPeers.find((item) => item.deviceId === deviceId)
      const expectedSecret = peer ? this.secrets.get(secretScope(peer.deviceId)).sharedSecret : ''
      if (!peer || !safeSecretEquals(expectedSecret, parseAuthorization(request))) return jsonResponse(response, 401, { ok: false, error: '设备授权已失效。' })
      if (!peer.connected && request.url !== '/v1/unpair') return jsonResponse(response, 403, { ok: false, error: '这台设备的连接已暂停。' })
      if (request.url === '/v1/ping') {
        peer.address = remoteAddress
        peer.lastSeenAt = new Date().toISOString()
        this.onlinePeers.add(peer.deviceId)
        this.#persistHeartbeatIfDue()
        this.#emitChanged()
        return jsonResponse(response, 200, { ok: true, device: this.#localDescriptor(), webBridge: this.webBridgeInfoProvider?.() || null })
      }
      if (request.url === '/v1/unpair') {
        this.#removeTrustedPeer(peer.deviceId)
        return jsonResponse(response, 200, { ok: true })
      }
      if (request.url === '/v1/inspect') {
        if (!peer.access.allowStatus) return jsonResponse(response, 403, { ok: false, error: '对方尚未允许你读取本机状态与内容。' })
        if (!this.remoteStatusProvider) return jsonResponse(response, 503, { ok: false, error: '本机暂时无法读取运行状态。' })
        const provided = await this.remoteStatusProvider({ deviceId: peer.deviceId, name: peer.name, platform: peer.platform })
        return jsonResponse(response, 200, {
          ok: true,
          status: {
            ...(provided && typeof provided === 'object' ? provided : {}),
            device: { deviceId: this.state.deviceId, name: this.state.deviceName, platform: this.platform, platformLabel: platformLabel(this.platform) },
            access: { ...peer.access },
            receivedAt: new Date().toISOString(),
          },
        })
      }
      if (request.url === '/v1/data') {
        if (!this.remoteDataProvider) return jsonResponse(response, 503, { ok: false, error: '本机暂时不支持远程数据读取。' })
        const scope = cleanText(body.scope, 40) || 'overview'
        if (scope === 'file' || scope === 'directory') {
          if (!peer.access.allowFiles) return jsonResponse(response, 403, { ok: false, error: '对方尚未允许你读取本机文件。' })
        } else if (!peer.access.allowStatus) return jsonResponse(response, 403, { ok: false, error: '对方尚未允许你读取本机状态与内容。' })
        try {
          const data = await this.remoteDataProvider({ scope, query: body.query && typeof body.query === 'object' ? body.query : {}, peer: { deviceId: peer.deviceId, name: peer.name, platform: peer.platform } })
          return jsonResponse(response, 200, { ok: true, scope, data })
        } catch (error) {
          return jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : '读取本机数据失败。' })
        }
      }
      if (request.url === '/v1/run') {
        if (!peer.access.allowTasks) return jsonResponse(response, 403, { ok: false, error: '对方设备尚未允许你在这台设备上执行任务；请在对方设备的“设置 → 设备互联”里开启“允许对方在本机执行任务”。' })
        if (!this.remoteTaskRunner) return jsonResponse(response, 503, { ok: false, error: '本机暂时不支持远程任务。' })
        const prompt = cleanText(body.prompt, MAX_TASK_PROMPT_LENGTH)
        if (!prompt) return jsonResponse(response, 400, { ok: false, error: '远程任务内容不能为空。' })
        const timeoutMs = Math.max(MIN_TASK_TIMEOUT_MS, Math.min(MAX_TASK_TIMEOUT_MS, Math.floor(Number(body.timeoutMs) || DEFAULT_TASK_TIMEOUT_MS)))
        const result = await this.remoteTaskRunner.run({ prompt, peer: { deviceId: peer.deviceId, name: peer.name, platform: peer.platform }, timeoutMs })
        return jsonResponse(response, 200, { ok: true, result })
      }
      return jsonResponse(response, 404, { ok: false, error: '接口不存在。' })
    } catch (error) {
      return jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : '请求处理失败。' })
    }
  }

  #validatedPeerDescriptor(value, remoteAddress) {
    const peer = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const deviceId = cleanText(peer.deviceId, 100)
    const port = Number(peer.port)
    if (!deviceId || deviceId === this.state.deviceId) throw new Error('设备身份无效。')
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('设备端口无效。')
    const identityPublicKey = String(peer.identityPublicKey || '')
    const remoteDeviceId = cleanText(peer.remoteDeviceId, 60)
    try {
      if (createPublicKey(identityPublicKey).asymmetricKeyType !== 'ed25519') throw new Error('key type')
    } catch { throw new Error('对方设备缺少有效的身份公钥，请更新应用后重新配对。') }
    if (remoteDeviceId && !validRemoteDeviceId(remoteDeviceId)) throw new Error('对方设备号无效。')
    return {
      deviceId,
      name: cleanText(peer.name, 80) || '未命名设备',
      platform: ['darwin', 'win32', 'linux', 'android'].includes(peer.platform) ? peer.platform : 'linux',
      address: normalizedAddress(remoteAddress),
      port,
      identityPublicKey,
      remoteDeviceId,
    }
  }

  #localDescriptor() {
    return {
      deviceId: this.state.deviceId,
      name: this.state.deviceName,
      platform: this.platform,
      port: this.httpPort,
      identityPublicKey: this.identity.publicKey,
      remoteDeviceId: this.#ensureRemoteDeviceId(),
    }
  }

  #trustedPeer(deviceId) {
    const peer = this.state.trustedPeers.find((item) => item.deviceId === cleanText(deviceId, 100))
    if (!peer) throw new Error('设备尚未配对或授权已撤销。')
    return peer
  }

  #upsertTrustedPeer(peer) {
    const existing = this.state.trustedPeers.find((item) => item.deviceId === peer.deviceId)
    const access = normalizePeerAccess(peer.access || existing?.access)
    if (existing) Object.assign(existing, peer, { access })
    else this.state.trustedPeers.push({ ...peer, access })
  }

  #removeTrustedPeer(deviceId) {
    const target = this.state.trustedPeers.find((peer) => peer.deviceId === deviceId)
    const group = this.state.trustedPeers.filter((peer) => peer.deviceId === deviceId || (target?.remoteDeviceId && peer.remoteDeviceId === target.remoteDeviceId))
    for (const peer of group) this.remoteTaskRunner?.cancelPeer?.(peer.deviceId)
    this.state.trustedPeers = this.state.trustedPeers.filter((peer) => !group.includes(peer))
    for (const peer of group) {
      this.onlinePeers.delete(peer.deviceId)
      this.secrets.delete(secretScope(peer.deviceId))
    }
    if (target?.remoteDeviceId) { try { this.onPeerRevoked?.(target.remoteDeviceId) } catch { /* 不影响本地撤销 */ } }
    this.#persist()
    this.#emitChanged()
  }

  #ensurePairingCode() {
    if (!this.pairingCode || Date.now() >= this.pairingCodeExpiresAt) this.refreshPairingCode()
  }

  async #heartbeat() {
    const previouslyOnline = [...this.onlinePeers].sort().join(',')
    // 公网设备通过交换中心和签名请求确认状态，不能拿局域网心跳去探空地址。
    // Android companion is client-only: it sends authenticated pings while in the foreground.
    // Do not probe a phone's nonexistent LAN listener or mark a live mobile client offline.
    const peers = this.state.trustedPeers.filter((peer) => peer.connected && peer.source !== 'remote' && peer.platform !== 'android')
    await Promise.allSettled(peers.map((peer) => this.#pingPeer(peer)))
    const cutoff = Date.now() - PEER_EXPIRY_MS
    for (const peer of this.state.trustedPeers) {
      if (peer.platform === 'android' && (!peer.connected || Date.parse(peer.lastSeenAt) < cutoff)) this.onlinePeers.delete(peer.deviceId)
    }
    for (const [deviceId, peer] of this.discovered) {
      if (Date.parse(peer.lastSeenAt) < cutoff) this.discovered.delete(deviceId)
    }
    if (previouslyOnline !== [...this.onlinePeers].sort().join(',') || Date.now() - this.lastHeartbeatEmitAt > 15_000) {
      this.lastHeartbeatEmitAt = Date.now()
      this.#emitChanged()
    }
  }

  async #pingPeer(peer) {
    const secret = this.secrets.get(secretScope(peer.deviceId)).sharedSecret
    if (!secret) throw new Error('设备凭证不存在，请重新配对。')
    try {
      const result = await this.#request(peer, '/v1/ping', { deviceId: this.state.deviceId }, secret)
      if (!result?.ok) throw new Error(result?.error || '心跳失败。')
      peer.lastSeenAt = new Date().toISOString()
      this.onlinePeers.add(peer.deviceId)
      this.#persistHeartbeatIfDue()
      return true
    } catch (error) {
      this.onlinePeers.delete(peer.deviceId)
      throw error
    }
  }

  async #request(peer, route, body, secret = '', timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!isPrivateNetworkAddress(peer.address)) throw new Error('目标地址不是受支持的局域网地址。')
    const budget = Math.max(1_000, Math.floor(Number(timeoutMs) || REQUEST_TIMEOUT_MS))
    if (secret && !peer.tlsFingerprint) throw new Error('旧版设备授权缺少证书校验，请撤销并重新配对。')
    return await new Promise((resolve, reject) => {
      const payload = body === null ? '' : JSON.stringify(body)
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const request = https.request({ hostname: peer.address, port: peer.port, path: route, method: body === null ? 'GET' : 'POST', rejectUnauthorized: false, agent: false,
        headers: { ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      }, (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 12 * 1024 * 1024) { request.destroy(new Error('设备响应内容过大。')); return }
          chunks.push(chunk)
        })
        response.on('end', () => {
          let result
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { result = {} }
          if (response.statusCode < 200 || response.statusCode >= 300) return finish(new Error(cleanText(result.error, 300) || `设备返回 HTTP ${response.statusCode}`))
          finish(null, { ...result, _tlsFingerprint: fingerprint })
        })
      })
      let fingerprint = ''
      const timer = setTimeout(() => request.destroy(new Error('连接目标设备超时，请确认两台设备位于同一局域网。')), budget)
      request.on('socket', (socket) => socket.once('secureConnect', () => {
        fingerprint = String(socket.getPeerCertificate()?.fingerprint256 || '')
        if (!fingerprint || (peer.tlsFingerprint && fingerprint !== peer.tlsFingerprint) || (peer.expectedIdentityCode && fingerprint.replace(/:/g, '').slice(0, 16) !== peer.expectedIdentityCode)) {
          request.destroy(new Error(peer.expectedIdentityCode ? '安全配对身份码不一致，已阻止连接；请核对对方屏幕上的完整配对码。' : '对方设备证书已变化，连接已阻止；请确认设备身份后重新配对。'))
          return
        }
        request.end(payload)
      }))
      request.on('error', (error) => finish(error))
    })
  }

  #persist() {
    fs.mkdirSync(this.directory, { recursive: true })
    const temporaryPath = `${this.statePath}.${createHash('sha256').update(String(process.pid)).digest('hex').slice(0, 8)}.tmp`
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporaryPath, this.statePath)
    try { fs.chmodSync(this.statePath, 0o600) } catch { /* Windows uses per-user ACLs. */ }
  }

  #persistHeartbeatIfDue() {
    if (Date.now() - this.lastPeerHeartbeatPersistAt < 60_000) return
    this.lastPeerHeartbeatPersistAt = Date.now()
    this.#persist()
  }

  #emitChanged() {
    try { this.onChanged(this.inspect()) } catch { /* UI listeners must not interrupt networking. */ }
  }
}

export const deviceLinkProtocol = Object.freeze({
  name: PROTOCOL,
  version: PROTOCOL_VERSION,
  discoveryAddress: DISCOVERY_ADDRESS,
  discoveryPort: DISCOVERY_PORT,
})
