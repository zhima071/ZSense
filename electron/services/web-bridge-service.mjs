// 局域网 Web 访问：把 ZSense 的整个界面通过 http://<局域网地址>:<端口> 提供给同一网络里的
// 浏览器（手机、平板、另一台电脑），效果与桌面窗口一致。
//
// 设计要点：
// - 静态资源直接复用构建产物 dist/，并在 index.html 里注入桥接脚本，让页面以为自己在桌面端；
// - 渲染层调用的 window.zsenseDesktop.* 由**真实的 preload 函数**在服务端沙箱里执行，
//   因此通道与参数映射永远不会和 preload 漂移；
// - 事件推送用 SSE（服务端 → 浏览器），调用用 POST（浏览器 → 服务端）；
// - 只接受局域网来源；必须先输入本机生成的访问口令，会话用 HttpOnly Cookie 维持；
// - 账号与安全类通道不允许从网页访问，避免远程改账号/密码。
import { execFileSync } from 'node:child_process'
import selfsigned from 'selfsigned'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { constants as zlibConstants, createBrotliCompress, createGzip } from 'node:zlib'
import { fastTrustDigest } from './remote-trust-connect.mjs'

export const DEFAULT_WEB_BRIDGE_PORT = 39073
const SESSION_TTL_MS = 12 * 60 * 60_000
// 已配对设备免密进入：一次性挑战和登录票据均短期有效。
const TRUST_WINDOW_MS = 120_000
const TRUST_TICKET_TTL_MS = 90_000
const MAX_DEVICE_CHALLENGES = 256
const MAX_DEVICE_CHALLENGES_PER_PEER = 8
const MAX_FAST_TRUST_NONCES = 256
const REMOTE_AGENT_JOB_TTL_MS = 15 * 60_000
const MAX_REMOTE_AGENT_JOBS = 32
const MAX_REMOTE_AGENT_RESULT_CHARS = 500_000
const LOGIN_WINDOW_MS = 60_000
const LOGIN_MAX_ATTEMPTS = 6
const MAX_BODY_BYTES = 8 * 1024 * 1024
// 单个调用的兜底超时：避免某个通道卡住时把网页请求一直挂着
const INVOKE_TIMEOUT_MS = 120_000
// 自签证书有效期（天）。浏览器会提示“不是私密连接”，接受一次即可；
// 给出 https 是为了让浏览器把它当成安全上下文（剪贴板、麦克风、PWA 等能力才可用）。
const CERTIFICATE_DAYS = 820
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.wasm', 'application/wasm'],
  ['.map', 'application/json; charset=utf-8'],
])
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map'])
// 网页端不允许触碰的通道：账号/密码安全相关的管理动作只在本机窗口里做。
const BLOCKED_CHANNELS = new Set([
  'zsense:auth:users:list',
  'zsense:auth:users:create',
  'zsense:auth:users:update',
  'zsense:auth:users:delete',
  'zsense:auth:set-lock-password',
])

function jsonResponse(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  response.end(body)
}

function cleanText(value, maximum = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum)
}

function normalizedAddress(value) {
  const address = cleanText(value, 128).replace(/^::ffff:/, '').split('%')[0]
  return address === '::1' ? '127.0.0.1' : address
}

export function isLanAddress(value) {
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

export function lanAddresses() {
  const addresses = new Set(['127.0.0.1'])
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4' || !isLanAddress(entry.address)) continue
      addresses.add(normalizedAddress(entry.address))
    }
  }
  return [...addresses]
}

// 在沙箱里加载真实的 preload：用它来发现可调用的接口路径，并在收到网页调用时构造出
// 与桌面端完全一致的 IPC 通道与参数。
export function createPreloadBridge(preloadPath, { platform = process.platform, appVersion = '' } = {}) {
  const source = fs.readFileSync(preloadPath, 'utf8')
  let exposed = null
  let lastInvoke = null
  let lastSubscription = null
  const electronStub = {
    contextBridge: { exposeInMainWorld: (key, value) => { if (key === 'zsenseDesktop') exposed = value } },
    ipcRenderer: {
      invoke: (channel, payload) => { lastInvoke = { channel, payload }; return Promise.resolve({ ok: true, data: null }) },
      on: (channel) => { lastSubscription = channel },
      removeListener: () => undefined,
      send: () => undefined,
    },
    webUtils: { getPathForFile: () => '' },
  }
  const moduleStub = { exports: {} }
  const context = vm.createContext({
    require: (id) => (id === 'electron' ? electronStub : moduleStub.exports),
    module: moduleStub,
    exports: moduleStub.exports,
    process: { platform, versions: { electron: 'web-bridge', node: process.versions.node }, env: {} },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
  })
  vm.runInContext(source, context, { filename: preloadPath })
  if (!exposed) throw new Error('无法从 preload 里读取桌面接口。')

  const paths = []
  const walk = (node, prefix, depth) => {
    if (depth > 4 || !node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      const next = [...prefix, key]
      if (typeof value === 'function') paths.push(next.join('.'))
      else if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, next, depth + 1)
    }
  }
  walk(exposed, [], 0)

  const resolve = (pathText) => {
    const segments = String(pathText || '').split('.').filter(Boolean)
    let node = exposed
    for (const segment of segments) {
      if (!node || typeof node !== 'object' || !(segment in node)) return null
      node = node[segment]
    }
    return typeof node === 'function' ? node : null
  }

  let eventPathsCache = null
  const eventPaths = () => {
    if (eventPathsCache) return eventPathsCache
    const found = []
    for (const pathText of paths) {
      lastSubscription = null
      try {
        const fn = resolve(pathText)
        if (!fn) continue
        const unsubscribe = fn(() => undefined)
        if (lastSubscription) found.push({ path: pathText, channel: lastSubscription })
        if (typeof unsubscribe === 'function') { try { unsubscribe() } catch { /* 取消订阅失败可忽略 */ } }
      } catch { /* 不是订阅函数 */ }
    }
    eventPathsCache = found
    return found
  }

  return {
    paths,
    eventPaths,
    constants: {
      isDesktop: exposed.isDesktop === true,
      platform: exposed.platform || platform,
      appVersion: appVersion || exposed.versions?.app || '',
    },
    // 执行真实的 preload 函数，捕获它要调用的通道与参数
    resolveCall(pathText, args) {
      const fn = resolve(pathText)
      if (!fn) return null
      lastInvoke = null
      fn(...(Array.isArray(args) ? args : []))
      return lastInvoke ? { channel: lastInvoke.channel, payload: lastInvoke.payload } : null
    },
    // 订阅事件：调用真实的订阅函数，捕获它监听的通道，并返回取消订阅函数
    subscribe(pathText, handler) {
      const fn = resolve(pathText)
      if (!fn) return null
      lastSubscription = null
      const unsubscribe = fn((payload) => handler(payload))
      if (!lastSubscription) return null
      return { channel: lastSubscription, unsubscribe: typeof unsubscribe === 'function' ? unsubscribe : () => undefined }
    },
  }
}

export class WebBridgeService {
  constructor({ rootPath, staticDirectory, preloadPath, handlers, platform = process.platform, appVersion = '', port = DEFAULT_WEB_BRIDGE_PORT, hostname = os.hostname(), onChanged = () => undefined, enabled = false, useHttps = true } = {}) {
    if (!rootPath) throw new Error('Web 访问缺少数据目录。')
    if (!staticDirectory) throw new Error('Web 访问缺少界面资源目录。')
    if (!preloadPath) throw new Error('Web 访问缺少桌面接口定义。')
    this.rootPath = rootPath
    this.staticDirectory = staticDirectory
    this.bridge = createPreloadBridge(preloadPath, { platform, appVersion })
    this.handlers = handlers instanceof Map ? handlers : new Map()
    this.platform = platform
    this.appVersion = appVersion
    this.hostname = cleanText(hostname, 80) || 'ZSense'
    this.defaultPort = Math.max(1, Math.min(65_535, Number(port) || DEFAULT_WEB_BRIDGE_PORT))
    this.useHttps = useHttps !== false
    this.tlsDirectory = path.join(rootPath, 'web-bridge', 'tls')
    this.certificate = null
    this.redirectServer = null
    this.port = 0
    this.httpPort = 0
    this.onChanged = onChanged
    this.statePath = path.join(rootPath, 'web-bridge', 'state.json')
    this.server = null
    this.clients = new Set()
    this.loginAttempts = new Map()
    this.remoteAgentJobs = new Map()
    this.lastError = ''
    this.started = false
    this.starting = null
    const stored = this.#readState()
    this.state = {
      enabled: stored.enabled === true || enabled === true,
      port: Math.floor(Number(stored.port) || 0) || this.defaultPort,
      accessCode: cleanText(stored.accessCode, 12),
      // Remote sessions never survive an app restart: a crash or lost tunnel is an offline boundary.
      sessions: Array.isArray(stored.sessions) ? stored.sessions.filter((session) => session?.token && session.remote !== true && Date.parse(session.expiresAt) > Date.now()) : [],
      // 快速入场的随机数必须跨重启保留到时间窗结束，否则重启会重新接受同一份签名。
      fastTrustNonces: Array.isArray(stored.fastTrustNonces) ? stored.fastTrustNonces.filter((entry) =>
        entry && typeof entry.key === 'string' && typeof entry.deviceId === 'string' && Number(entry.expiresAt) > Date.now()
      ).slice(-MAX_FAST_TRUST_NONCES) : [],
    }
    this.fastTrustNonces = new Map(this.state.fastTrustNonces.map((entry) => [entry.key, { deviceId: entry.deviceId, expiresAt: entry.expiresAt }]))
    if (!this.state.accessCode) this.state.accessCode = this.#createAccessCode()
    this.#persist()
  }

  #readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  }

  #persist() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      fs.writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
      return true
    } catch { return false }
  }

  #createAccessCode() {
    // 6 位数字，与设备互联的配对码风格一致，方便在手机上输入
    return String(crypto.randomInt(100000, 999999))
  }

  #ensureCertificate() {
    if (!this.useHttps) return null
    const addresses = lanAddresses().filter((address) => address !== '127.0.0.1')
    const signature = [...addresses, '127.0.0.1', 'localhost'].sort().join(',')
    const certPath = path.join(this.tlsDirectory, 'cert.pem')
    const keyPath = path.join(this.tlsDirectory, 'key.pem')
    const metaPath = path.join(this.tlsDirectory, 'meta.json')
    let stored = {}
    try { stored = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch { stored = {} }
    // 局域网地址变了（换了网络）就重新签发，保证证书覆盖当前地址
    if (stored.signature === signature && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      try { return this.#readCertificate(certPath, keyPath) } catch { /* 证书损坏则重签 */ }
    }
    fs.mkdirSync(this.tlsDirectory, { recursive: true })
    // 纯 JS 签发，不依赖系统 openssl：Windows 默认没有 openssl 命令，
    // 之前 execFileSync('openssl') 会直接 ENOENT，导致 HTTPS 只能退回 http。
    // CN 只保留 ASCII：中文机器名（例如 Windows 上的「李焕芝」）会让证书 PEM 无法被 Node 解析
    // （crypto.X509Certificate 报 PEM routines::bad base64 decode）。浏览器校验的是 SAN 里的 IP，CN 只是显示用。
    const commonName = (cleanText(this.hostname, 60) || 'ZSense').replace(/[^\x20-\x7E]/g, '').trim() || 'ZSense'
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: commonName }],
      {
        days: CERTIFICATE_DAYS,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: false, critical: true },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
          { name: 'extKeyUsage', serverAuth: true },
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              { type: 7, ip: '127.0.0.1' },
              ...addresses.map((address) => ({ type: 7, ip: address })),
            ],
          },
        ],
      },
    )
    fs.writeFileSync(keyPath, pems.private)
    fs.writeFileSync(certPath, pems.cert)
    fs.writeFileSync(metaPath, `${JSON.stringify({ signature, createdAt: new Date().toISOString() }, null, 2)}\n`)
    return this.#readCertificate(certPath, keyPath)
  }

  #readCertificate(certPath, keyPath) {
    const key = fs.readFileSync(keyPath)
    const cert = fs.readFileSync(certPath)
    const parsed = new crypto.X509Certificate(cert)
    return {
      key,
      cert,
      info: {
        subject: parsed.subject.replace(/\n/g, ', '),
        fingerprint: parsed.fingerprint256,
        validFrom: parsed.validFrom,
        validTo: parsed.validTo,
        path: certPath,
      },
    }
  }

  inspect() {
    // 自愈：设置里是开启状态但服务没在监听时（例如端口冲突后退出、异常中断），顺手把它拉起来。
    if (this.state.enabled === true && this.started !== true && !this.starting) {
      this.starting = this.start().catch((error) => {
        this.lastError = error instanceof Error ? error.message : '局域网 Web 访问启动失败。'
        return null
      }).finally(() => { this.starting = null })
    }
    const running = this.started === true
    const port = running ? this.port : this.state.port
    return {
      supported: true,
      enabled: this.state.enabled === true,
      running,
      port,
      httpPort: this.httpPort || 0,
      protocol: this.useHttps ? 'https' : 'http',
      accessCode: this.state.enabled ? this.state.accessCode : '',
      remoteUnlockAvailable: typeof this.remoteLoginVerifier === 'function',
      remoteSessions: this.state.sessions.filter((session) => session.remote).map((session) => ({ user: session.remoteUser?.displayName || '未知', at: session.createdAt, from: session.remoteAddress })).slice(0, 10),

      // 局域网地址优先：手机/其它设备要用的是它们；127.0.0.1 单独作为本机地址返回，
      // 否则界面会把回环地址排在第一行，复制出来的地址在别的设备上根本打不开。
      urls: running ? lanAddresses().filter((address) => address !== '127.0.0.1').map((address) => `${this.useHttps ? 'https' : 'http'}://${address}:${port}`) : [],
      localUrl: running ? `${this.useHttps ? 'https' : 'http'}://127.0.0.1:${port}` : '',
      certificate: this.useHttps && this.certificate ? this.certificate.info : null,
      sessions: this.state.sessions.map((session) => ({
        token: session.token.slice(0, 8),
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        remoteAddress: session.remoteAddress,
        userAgent: session.userAgent,
        lastSeenAt: session.lastSeenAt,
      })),
      error: this.lastError,
      blockedChannels: [...BLOCKED_CHANNELS],
    }
  }

  async setEnabled(enabled) {
    this.state.enabled = enabled === true
    this.#persist()
    if (this.state.enabled) await this.start()
    else await this.stop()
    return this.inspect()
  }

  rotateAccessCode() {
    this.state.accessCode = this.#createAccessCode()
    // 换口令即让既有网页会话失效
    this.state.sessions = []
    this.#persist()
    this.#emitChanged()
    return this.inspect()
  }

  revokeSession(token) {
    const prefix = cleanText(token, 40)
    this.state.sessions = this.state.sessions.filter((session) => session.token.slice(0, 8) !== prefix)
    this.#persist()
    for (const client of this.clients) if (client.token.slice(0, 8) === prefix) this.#closeClient(client)
    this.#emitChanged()
    return this.inspect()
  }

  revokeTrustedDevice(deviceId) {
    const id = cleanText(deviceId, 60)
    try { this.remoteAgentTaskCanceler?.(id) } catch { /* 撤销必须继续完成 */ }
    const revoked = new Set(this.state.sessions.filter((session) => session.trustedDevice === id).map((session) => session.token))
    this.state.sessions = this.state.sessions.filter((session) => !revoked.has(session.token))
    for (const client of this.clients) if (revoked.has(client.token)) this.#closeClient(client)
    if (this.deviceChallenges) for (const [nonce, challenge] of this.deviceChallenges) if (challenge.deviceId === id) this.deviceChallenges.delete(nonce)
    if (this.fastTrustNonces) for (const [nonce, entry] of this.fastTrustNonces) if (entry.deviceId === id) this.fastTrustNonces.delete(nonce)
    this.state.fastTrustNonces = [...this.fastTrustNonces].map(([key, entry]) => ({ key, ...entry }))
    for (const [taskId, task] of this.remoteAgentJobs) if (task.deviceId === id) { task.cancelled = true; this.remoteAgentJobs.delete(taskId) }
    this.trustTickets = (this.trustTickets || []).filter((ticket) => ticket.deviceId !== id)
    this.#persist()
    this.#emitChanged()
  }

  revokeRemoteSessions() {
    try { this.remoteAgentTaskCanceler?.() } catch { /* 会话撤销必须继续完成 */ }
    const revoked = new Set(this.state.sessions.filter((session) => session.remote).map((session) => session.token))
    this.state.sessions = this.state.sessions.filter((session) => !revoked.has(session.token))
    for (const client of this.clients) if (revoked.has(client.token)) this.#closeClient(client)
    this.deviceChallenges?.clear()
    this.fastTrustNonces?.clear()
    this.state.fastTrustNonces = []
    for (const task of this.remoteAgentJobs.values()) task.cancelled = true
    this.remoteAgentJobs.clear()
    this.trustTickets = []
    this.#persist()
    this.#emitChanged()
  }

  async start() {
    if (this.started) return this.inspect()
    try { this.certificate = this.#ensureCertificate() } catch (error) {
      this.lastError = `HTTPS 证书生成失败，局域网与远程网页入口未启动：${error instanceof Error ? error.message : error}`
      console.error('[web-bridge]', this.lastError)
      throw new Error(this.lastError)
    }
    const handler = (request, response) => void this.#handleHttp(request, response)
    const listen = (port) => new Promise((resolve, reject) => {
      const server = this.certificate
        ? https.createServer({ key: this.certificate.key, cert: this.certificate.cert }, handler)
        : http.createServer(handler)
      server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
      server.once('error', reject)
      server.listen(port, '0.0.0.0', () => { server.off('error', reject); resolve(server) })
    })
    try {
      this.server = await listen(this.state.port)
    } catch (error) {
      if (this.state.port === 0) throw error
      this.server = await listen(0)
    }
    this.port = Number(this.server.address()?.port) || this.state.port
    if (this.state.port !== this.port) { this.state.port = this.port; this.#persist() }
    // HTTPS 模式下再开一个 http 端口，只做跳转，避免老地址打不开
    if (this.certificate) {
      const redirectPort = this.port + 1
      try {
        this.redirectServer = await new Promise((resolve, reject) => {
          const server = http.createServer((request, response) => {
            const host = String(request.headers.host || '').split(':')[0] || 'localhost'
            response.writeHead(308, { Location: `https://${host}:${this.port}${request.url || '/'}`, 'Cache-Control': 'no-store' })
            response.end()
          })
          server.once('error', reject)
          server.listen(redirectPort, '0.0.0.0', () => { server.off('error', reject); resolve(server) })
        })
        this.httpPort = redirectPort
      } catch { this.httpPort = 0; this.redirectServer = null }
    }
    this.started = true
    this.lastError = ''
    this.#emitChanged()
    return this.inspect()
  }

  async stop() {
    for (const task of this.remoteAgentJobs.values()) task.cancelled = true
    this.remoteAgentJobs.clear()
    try { this.remoteAgentTaskCanceler?.() } catch { /* 关闭服务不能留下正在执行的远程任务 */ }
    for (const client of [...this.clients]) this.#closeClient(client)
    const server = this.server
    const redirectServer = this.redirectServer
    this.server = null
    this.redirectServer = null
    this.httpPort = 0
    this.started = false
    // 关闭时不能被长期存活的浏览器 / fetch keep-alive 连接阻塞。
    server?.closeAllConnections?.()
    redirectServer?.closeAllConnections?.()
    await Promise.all([
      server ? new Promise((resolve) => { try { server.close(resolve) } catch { resolve() } }) : Promise.resolve(),
      redirectServer ? new Promise((resolve) => { try { redirectServer.close(resolve) } catch { resolve() } }) : Promise.resolve(),
    ])
    this.#emitChanged()
    return this.inspect()
  }

  async shutdown() { await this.stop() }

  initialize() {
    return this.state.enabled ? this.start() : this.inspect()
  }

  #emitChanged() {
    try { this.onChanged(this.inspect()) } catch { /* 通知失败不影响服务 */ }
  }

  #closeClient(client) {
    this.clients.delete(client)
    try { client.response.end() } catch { /* 已断开 */ }
  }

  #deviceTrustAllowed(deviceId, nonce, signature) {
    try { return typeof this.deviceTrustVerifier === 'function' && this.deviceTrustVerifier(deviceId, nonce, signature) === true }
    catch { return false }
  }

  #consumeDeviceChallenge(deviceId, nonce) {
    const challenge = this.deviceChallenges?.get(nonce)
    if (!challenge || challenge.deviceId !== deviceId) return false
    this.deviceChallenges.delete(nonce) // 单次尝试即消耗，包括签名错误的尝试。
    return challenge.expiresAt >= Date.now()
  }

  #issueTrustTicket(deviceId) {
    this.trustTickets = (this.trustTickets || []).filter((item) => item.expiresAt > Date.now())
    const ticket = crypto.randomBytes(24).toString('base64url')
    this.trustTickets.push({ ticket, deviceId, expiresAt: Date.now() + TRUST_TICKET_TTL_MS })
    this.trustTickets = this.trustTickets.slice(-20)
    return { ok: true, data: { ticket, expiresInSeconds: Math.round(TRUST_TICKET_TTL_MS / 1000), entryPath: `/bridge/enter?ticket=${encodeURIComponent(ticket)}` } }
  }

  #consumeSignedDeviceRequest(request, route, body) {
    const deviceId = cleanText(request.headers['x-zsense-device'], 60)
    const nonce = cleanText(request.headers['x-zsense-nonce'], 100)
    const signature = cleanText(request.headers['x-zsense-signature'], 200)
    if (!this.#consumeDeviceChallenge(deviceId, nonce)) return ''
    const signedPayload = crypto.createHash('sha256').update(`zsense-agent-v1\nPOST\n${route}\n${nonce}\n${JSON.stringify(body)}`).digest('base64url')
    return this.#deviceTrustAllowed(deviceId, signedPayload, signature) ? deviceId : ''
  }

  #pruneRemoteAgentJobs() {
    const now = Date.now()
    for (const [taskId, task] of this.remoteAgentJobs) if (task.expiresAt <= now) this.remoteAgentJobs.delete(taskId)
  }

  #sessionFromRequest(request) {
    const cookie = String(request.headers.cookie || '')
    const match = cookie.match(/(?:^|;\s*)zsense_web=([^;]+)/)
    const token = match ? decodeURIComponent(match[1]) : ''
    if (!token) return null
    const session = this.state.sessions.find((item) => item.token === token)
    if (!session) return null
    if (Date.parse(session.expiresAt) < Date.now()) {
      this.state.sessions = this.state.sessions.filter((item) => item.token !== token)
      this.#persist()
      return null
    }
    session.lastSeenAt = new Date().toISOString()
    return session
  }

  #allowRemote(request) {
    const address = normalizedAddress(request.socket.remoteAddress)
    return isLanAddress(address) ? address : ''
  }

  async #readBody(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('请求内容过大。')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('请求内容不是合法 JSON。') }
  }

  #serveStatic(request, response, pathname) {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
    const candidate = path.join(this.staticDirectory, relative)
    const resolved = path.resolve(candidate)
    const staticRoot = path.resolve(this.staticDirectory)
    const relativeToRoot = path.relative(staticRoot, resolved)
    if (relativeToRoot.startsWith(`..${path.sep}`) || relativeToRoot === '..' || path.isAbsolute(relativeToRoot)) return jsonResponse(response, 403, { ok: false, error: '路径不合法。' })
    let filePath = resolved
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA 回退：未知路径交给前端路由
      if (path.extname(relative)) return jsonResponse(response, 404, { ok: false, error: '资源不存在。' })
      filePath = path.join(this.staticDirectory, 'index.html')
    }
    if (path.basename(filePath) === 'index.html') {
      const html = fs.readFileSync(filePath, 'utf8')
      const injected = html.replace('<head>', `<head>\n    <script src="/bridge-client.js"></script>\n    <meta name="zsense-web-bridge" content="1" />`)
      const body = Buffer.from(injected)
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
      response.end(body)
      return
    }
    const stats = fs.statSync(filePath)
    const extension = path.extname(filePath).toLowerCase()
    const headers = {
      'Content-Type': CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      // Vite 产物文件名带内容 hash，可长期缓存；其它静态资源仍按一小时刷新。
      'Cache-Control': /^assets[\\/].+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path.relative(staticRoot, filePath))
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    }
    const acceptedEncoding = String(request.headers['accept-encoding'] || '')
    const compressible = stats.size >= 1_024 && COMPRESSIBLE_EXTENSIONS.has(extension)
    const encoding = compressible && /(?:^|,)\s*br\s*(?:;|,|$)/i.test(acceptedEncoding) ? 'br'
      : compressible && /(?:^|,)\s*gzip\s*(?:;|,|$)/i.test(acceptedEncoding) ? 'gzip'
        : ''
    if (encoding) {
      headers['Content-Encoding'] = encoding
      headers.Vary = 'Accept-Encoding'
    } else headers['Content-Length'] = stats.size
    response.writeHead(200, headers)
    const source = fs.createReadStream(filePath)
    const fail = () => response.destroy()
    source.once('error', fail)
    if (encoding === 'br') {
      const compressor = createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
      compressor.once('error', fail)
      source.pipe(compressor).pipe(response)
    } else if (encoding === 'gzip') {
      const compressor = createGzip({ level: 6 })
      compressor.once('error', fail)
      source.pipe(compressor).pipe(response)
    } else source.pipe(response)
  }

  async #handleHttp(request, response) {
    const address = this.#allowRemote(request)
    if (!address) return jsonResponse(response, 403, { ok: false, error: '只允许局域网设备访问。' })
    const fromTunnel = Boolean(request.headers['cf-ray'] || request.headers['cf-connecting-ip'] || request.headers['cf-worker'] || /(?:^|\.)zsense\.space(?::\d+)?$/i.test(String(request.headers.host || '')))
    if (fromTunnel && typeof this.remoteAccessAllowed === 'function' && !this.remoteAccessAllowed()) {
      return jsonResponse(response, 403, { ok: false, error: '远程连接已关闭。' })
    }
    const url = new URL(request.url || '/', 'http://localhost')
    const pathname = url.pathname
    try {
      if (pathname === '/bridge/session' && request.method === 'GET') {
        const session = this.#sessionFromRequest(request)
        return jsonResponse(response, 200, { ok: true, data: { authenticated: Boolean(session), expiresAt: session?.expiresAt || '' } })
      }
      if (pathname === '/bridge/login' && request.method === 'POST') {
        const key = address
        const attempts = (this.loginAttempts.get(key) || []).filter((at) => Date.now() - at < LOGIN_WINDOW_MS)
        if (attempts.length >= LOGIN_MAX_ATTEMPTS) return jsonResponse(response, 429, { ok: false, error: '尝试次数过多，请稍后再试。' })
        const body = await this.#readBody(request)
        // 公网网页登录独立验密；不能把缺少代理头的公网请求误判成局域网口令登录。
        const isRemote = fromTunnel
        let remoteUnlockUser = null
        if (isRemote) {
          const verify = typeof this.remoteLoginVerifier === 'function' ? this.remoteLoginVerifier : null
          if (!verify) return jsonResponse(response, 503, { ok: false, error: '本机暂时无法校验远程访问密码，请稍后重试。' })
          const result = verify(cleanText(body.password, 128)) || {}
          remoteUnlockUser = result.ok && result.user ? result.user : null
          if (!result.ok) {
            attempts.push(Date.now())
            this.loginAttempts.set(key, attempts)
            return jsonResponse(response, 403, { ok: false, remote: true, code: result.code || 'bad-password', error: result.error || '远程访问密码不正确。' })
          }
        } else {
          // 局域网访问：有安全锁就用安全锁密码；没有安全锁则退回本机访问口令，绝不无条件放行
          const verifyLocal = typeof this.remoteUnlockVerifier === 'function' ? this.remoteUnlockVerifier : null
          const submitted = cleanText(body.password, 128) || cleanText(body.code, 128)
          let lockMissing = !verifyLocal
          if (verifyLocal) {
            const local = verifyLocal(submitted) || {}
            lockMissing = local.code === 'app-lock-disabled' || local.code === 'app-lock-unconfigured'
            if (!local.ok && !lockMissing) {
              attempts.push(Date.now())
              this.loginAttempts.set(key, attempts)
              return jsonResponse(response, 403, { ok: false, error: local.error || '安全锁密码不正确。' })
            }
          }
          if (lockMissing) {
            if (!this.state.accessCode || submitted !== this.state.accessCode) {
              attempts.push(Date.now())
              this.loginAttempts.set(key, attempts)
              return jsonResponse(response, 403, { ok: false, code: 'bad-access-code', error: '访问口令不正确。' })
            }
          }
        }
        const token = crypto.randomBytes(32).toString('base64url')
        const session = {
          token,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
          remoteAddress: address,
          remote: isRemote,
          remoteUser: remoteUnlockUser ? { username: remoteUnlockUser.username, displayName: remoteUnlockUser.displayName } : null,
          userAgent: cleanText(request.headers['user-agent'], 200),
          lastSeenAt: new Date().toISOString(),
        }
        this.state.sessions = [session, ...this.state.sessions].slice(0, 20)
        this.#persist()
        this.#emitChanged()
        response.setHeader('Set-Cookie', `zsense_web=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${this.certificate ? '; Secure' : ''}`)
        return jsonResponse(response, 200, { ok: true, data: { authenticated: true, expiresAt: session.expiresAt } })
      }
      if (pathname === '/bridge/logout' && request.method === 'POST') {
        const session = this.#sessionFromRequest(request)
        if (session) this.revokeSession(session.token.slice(0, 8))
        response.setHeader('Set-Cookie', 'zsense_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        return jsonResponse(response, 200, { ok: true, data: { authenticated: false } })
      }
      // 邮箱只帮助发现设备；真正的免密登录必须证明首次配对时保存的设备私钥。
      if (pathname === '/bridge/trust-challenge' && request.method === 'POST') {
        const deviceId = cleanText(request.headers['x-zsense-device'], 60)
        if (!deviceId || !this.#deviceTrustAllowed(deviceId, '', '')) return jsonResponse(response, 403, { ok: false, error: '设备尚未完成密钥配对，请先配对或使用远程访问密码。' })
        // 新版发起端随原挑战请求提交短时签名：通过后直接发票据，只用一次公网往返。
        // 旧版发起端不带这些头，仍收到服务端随机挑战并走原有第二次请求。
        if (request.headers['x-zsense-issued-at'] !== undefined || request.headers['x-zsense-signature'] !== undefined) {
          const fastNonce = cleanText(request.headers['x-zsense-nonce'], 100)
          const issuedAtText = String(request.headers['x-zsense-issued-at'] || '')
          const signature = cleanText(request.headers['x-zsense-signature'], 200)
          const issuedAt = Number(issuedAtText)
          if (!/^[A-Za-z0-9_-]{32,100}$/.test(fastNonce) || !/^\d{13}$/.test(issuedAtText) || !signature) return jsonResponse(response, 403, { ok: false, error: '设备签名格式无效。' })
          if (Math.abs(Date.now() - issuedAt) <= TRUST_WINDOW_MS) {
            if (!this.#deviceTrustAllowed(deviceId, fastTrustDigest(deviceId, issuedAt, fastNonce), signature)) {
              return jsonResponse(response, 403, { ok: false, error: '设备密钥验证失败，请重新连接或重新配对。' })
            }
            for (const [key, entry] of this.fastTrustNonces) if (entry.expiresAt <= Date.now()) this.fastTrustNonces.delete(key)
            const replayKey = `${deviceId}:${fastNonce}`
            if (this.fastTrustNonces.has(replayKey)) return jsonResponse(response, 403, { ok: false, error: '设备签名已使用，请重新连接。' })
            if (this.fastTrustNonces.size >= MAX_FAST_TRUST_NONCES) return jsonResponse(response, 429, { ok: false, error: '短时设备请求过多，请稍后再试。' })
            this.fastTrustNonces.set(replayKey, { deviceId, expiresAt: Date.now() + TRUST_WINDOW_MS })
            this.state.fastTrustNonces = [...this.fastTrustNonces].map(([key, entry]) => ({ key, ...entry }))
            if (!this.#persist()) {
              this.fastTrustNonces.delete(replayKey)
              this.state.fastTrustNonces = [...this.fastTrustNonces].map(([key, entry]) => ({ key, ...entry }))
              return jsonResponse(response, 503, { ok: false, error: '本机暂时无法保存设备签名状态，请稍后重试。' })
            }
            return jsonResponse(response, 200, this.#issueTrustTicket(deviceId))
          }
          // 两台设备时钟不一致时回退到服务端挑战，仍须再做一次有效 Ed25519 签名。
        }
        this.deviceChallenges ||= new Map()
        for (const [nonce, entry] of this.deviceChallenges) if (entry.expiresAt < Date.now()) this.deviceChallenges.delete(nonce)
        if (this.deviceChallenges.size >= MAX_DEVICE_CHALLENGES || [...this.deviceChallenges.values()].filter((entry) => entry.deviceId === deviceId).length >= MAX_DEVICE_CHALLENGES_PER_PEER) {
          return jsonResponse(response, 429, { ok: false, error: '待验证的设备请求过多，请稍后重试。' })
        }
        const nonce = crypto.randomBytes(32).toString('base64url')
        this.deviceChallenges.set(nonce, { deviceId, expiresAt: Date.now() + TRUST_WINDOW_MS })
        return jsonResponse(response, 200, { ok: true, data: { nonce } })
      }
      if (pathname === '/bridge/trust-ticket' && request.method === 'POST') {
        const deviceId = cleanText(request.headers['x-zsense-device'], 60)
        const nonce = cleanText(request.headers['x-zsense-nonce'], 100)
        const signature = cleanText(request.headers['x-zsense-signature'], 200)
        if (!this.#consumeDeviceChallenge(deviceId, nonce) || !this.#deviceTrustAllowed(deviceId, nonce, signature)) {
          return jsonResponse(response, 403, { ok: false, error: '设备密钥验证失败，请重新连接或重新配对。' })
        }
        return jsonResponse(response, 200, this.#issueTrustTicket(deviceId))
      }
      if (pathname === '/bridge/agent-task' && request.method === 'POST') {
        const body = await this.#readBody(request)
        const deviceId = this.#consumeSignedDeviceRequest(request, pathname, body)
        if (!deviceId) return jsonResponse(response, 403, { ok: false, error: '设备签名无效或一次性挑战已过期。' })
        if (typeof this.remoteAgentTaskProvider !== 'function') return jsonResponse(response, 503, { ok: false, error: '本机 Agent 任务通道不可用。' })
        this.#pruneRemoteAgentJobs()
        if (this.remoteAgentJobs.size >= MAX_REMOTE_AGENT_JOBS) return jsonResponse(response, 429, { ok: false, error: '远程任务队列已满，请稍后再试。' })
        const prompt = cleanText(body?.prompt, 8_000)
        if (!prompt) return jsonResponse(response, 400, { ok: false, error: '远程任务内容不能为空。' })
        const timeoutMs = Math.max(10_000, Math.min(600_000, Math.floor(Number(body?.timeoutMs) || 300_000)))
        // 权限由接收端再核一次；不允许前端、交换中心或发送方自行声明权限。
        const taskId = crypto.randomUUID()
        const task = { deviceId, status: 'running', result: null, error: '', expiresAt: Date.now() + Math.max(REMOTE_AGENT_JOB_TTL_MS, timeoutMs + 60_000) }
        this.remoteAgentJobs.set(taskId, task)
        void Promise.resolve().then(() => {
          if (task.cancelled) throw new Error('设备授权已撤销，远程任务已取消。')
          return this.remoteAgentTaskProvider({ deviceId, prompt, timeoutMs })
        }).then(
          (result) => {
            if (task.cancelled) return
            task.status = 'complete'
            const output = String(result?.output || '')
            task.result = output.length > MAX_REMOTE_AGENT_RESULT_CHARS
              ? { ...result, output: `${output.slice(0, MAX_REMOTE_AGENT_RESULT_CHARS)}\n…（输出过长，完整内容保存在对方设备的会话记录中）`, truncated: true }
              : result
          },
          (error) => { task.status = 'failed'; task.error = cleanText(error instanceof Error ? error.message : error, 300) || '远程任务执行失败。' },
        )
        return jsonResponse(response, 202, { ok: true, data: { taskId, status: 'running' } })
      }
      if (pathname === '/bridge/agent-task-result' && request.method === 'POST') {
        const body = await this.#readBody(request)
        const deviceId = this.#consumeSignedDeviceRequest(request, pathname, body)
        if (!deviceId) return jsonResponse(response, 403, { ok: false, error: '设备签名无效或一次性挑战已过期。' })
        this.#pruneRemoteAgentJobs()
        const task = this.remoteAgentJobs.get(cleanText(body?.taskId, 60))
        if (!task || task.deviceId !== deviceId) return jsonResponse(response, 404, { ok: false, error: '任务不存在或已过期。' })
        return jsonResponse(response, task.status === 'running' ? 202 : 200, { ok: true, data: { status: task.status, result: task.result, error: task.error } })
      }
      // 首次公网配对：凭「设备号 + 面板上显示的配对码」换一次性票据；
      // 后续免密进入才走 /bridge/trust-ticket 的已配对公钥签名校验。
      if (pathname === '/bridge/pair-ticket' && request.method === 'POST') {
        const attempts = (this.loginAttempts.get(address) || []).filter((at) => Date.now() - at < LOGIN_WINDOW_MS)
        if (attempts.length >= LOGIN_MAX_ATTEMPTS) return jsonResponse(response, 429, { ok: false, error: '尝试次数过多，请稍后再试。' })
        const body = await this.#readBody(request)
        const provided = cleanText(body?.code, 12)
        const expected = typeof this.pairingCodeProvider === 'function' ? String(this.pairingCodeProvider() || '') : ''
        if (!expected) return jsonResponse(response, 403, { ok: false, code: 'no-code', error: '这台设备当前没有可用的配对码，请让对方在设备互联面板刷新一次。' })
        if (!provided || provided !== expected) {
          attempts.push(Date.now())
          this.loginAttempts.set(address, attempts)
          return jsonResponse(response, 403, { ok: false, code: 'bad-code', error: '配对码不正确或已过期。' })
        }
        const remoteDeviceId = cleanText(request.headers['x-zsense-device'], 60)
        const publicKey = String(body?.identityPublicKey || '').slice(0, 500)
        try {
          if (!/^[a-z0-9][a-z0-9-]{1,58}$/.test(remoteDeviceId) || crypto.createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') throw new Error('invalid key')
        } catch { return jsonResponse(response, 400, { ok: false, error: '对方设备缺少有效身份公钥，请更新应用后重试。' }) }
        try {
          if (this.onRemotePeerConnected?.(remoteDeviceId, cleanText(body?.name, 60), publicKey) === false) return jsonResponse(response, 409, { ok: false, error: '设备公钥与已保存的授权不一致；请先在两端撤销旧授权再重新配对。' })
        } catch { return jsonResponse(response, 409, { ok: false, error: '设备身份校验失败，请检查旧授权。' }) }
        this.trustTickets = (this.trustTickets || []).filter((item) => item.expiresAt > Date.now())
        const ticket = crypto.randomBytes(24).toString('base64url')
        this.trustTickets.push({ ticket, deviceId: remoteDeviceId, expiresAt: Date.now() + TRUST_TICKET_TTL_MS })
        this.trustTickets = this.trustTickets.slice(-20)
        return jsonResponse(response, 200, { ok: true, data: { ticket, identityPublicKey: this.deviceIdentityProvider?.() || '', deviceName: cleanText(this.hostname, 60), expiresInSeconds: Math.round(TRUST_TICKET_TTL_MS / 1000), entryPath: `/bridge/enter?ticket=${encodeURIComponent(ticket)}` } })
      }
      if (pathname === '/bridge/enter' && request.method === 'GET') {
        const ticket = cleanText(url.searchParams.get('ticket'), 160)
        const index = (this.trustTickets || []).findIndex((item) => item.ticket === ticket && item.expiresAt > Date.now())
        if (index < 0) {
          response.writeHead(302, { Location: '/?trust=failed', 'Cache-Control': 'no-store' })
          response.end()
          return undefined
        }
        const [entry] = this.trustTickets.splice(index, 1) // 一次性：换过即作废
        const token = crypto.randomBytes(32).toString('base64url')
        const session = {
          token,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
          remoteAddress: address,
          remote: true,
          trusted: true,
          trustedDevice: entry.deviceId,
          remoteUser: null,
          userAgent: cleanText(request.headers['user-agent'], 200),
          lastSeenAt: new Date().toISOString(),
        }
        this.state.sessions = [session, ...this.state.sessions].slice(0, 20)
        this.#persist()
        this.#emitChanged()
        response.setHeader('Set-Cookie', `zsense_web=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${this.certificate ? '; Secure' : ''}`)
        response.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' })
        response.end()
        return undefined
      }
      if (pathname === '/bridge-client.js' && request.method === 'GET') {
        const body = fs.readFileSync(new URL('../web-bridge-client.js', import.meta.url))
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
        response.end(body)
        return
      }
      const session = this.#sessionFromRequest(request)
      if (!session) {
        if (pathname.startsWith('/bridge/')) return jsonResponse(response, 401, { ok: false, error: '需要先输入访问口令。' })
      }
      if (pathname === '/bridge/manifest' && request.method === 'GET') {
        if (!session) return jsonResponse(response, 401, { ok: false, error: '需要先输入访问口令。' })
        return jsonResponse(response, 200, { ok: true, data: { paths: this.bridge.paths, eventPaths: this.bridge.eventPaths(), constants: this.bridge.constants, appVersion: this.appVersion } })
      }
      if (pathname === '/bridge/invoke' && request.method === 'POST') {
        if (!session) return jsonResponse(response, 401, { ok: false, error: '需要先输入访问口令。' })
        const body = await this.#readBody(request)
        const call = this.bridge.resolveCall(cleanText(body.path, 120), Array.isArray(body.args) ? body.args : [])
        if (!call) return jsonResponse(response, 400, { ok: false, error: `不支持的调用：${cleanText(body.path, 120)}` })
        if (BLOCKED_CHANNELS.has(call.channel)) return jsonResponse(response, 403, { ok: false, error: '该操作只能在 ZSense 桌面窗口里进行。' })
        const handler = this.handlers.get(call.channel)
        if (typeof handler !== 'function') return jsonResponse(response, 404, { ok: false, error: `通道未注册：${call.channel}` })
        const fakeEvent = { sender: { id: session.senderId || 1, send: (channel, payload) => this.#pushEvent(channel, payload), isDestroyed: () => false } }
        const result = await Promise.race([
          handler(fakeEvent, call.payload),
          new Promise((resolve) => { const timer = setTimeout(() => resolve({ ok: false, error: `调用超时（${call.channel}）：操作超过 ${Math.round(INVOKE_TIMEOUT_MS / 1000)} 秒没有返回。` }), INVOKE_TIMEOUT_MS); timer.unref?.() }),
        ])
        return jsonResponse(response, 200, result && typeof result === 'object' && 'ok' in result ? result : { ok: true, data: result })
      }
      if (pathname === '/bridge/events' && request.method === 'GET') {
        if (!session) return jsonResponse(response, 401, { ok: false, error: '需要先输入访问口令。' })
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        response.write(': connected\n\n')
        const client = { response, token: session.token, senderId: session.senderId || 1 }
        this.clients.add(client)
        const keepAlive = setInterval(() => { try { response.write(': ping\n\n') } catch { this.#closeClient(client) } }, 20_000)
        keepAlive.unref?.()
        request.on('close', () => { clearInterval(keepAlive); this.clients.delete(client) })
        return
      }
      if (pathname.startsWith('/bridge/')) return jsonResponse(response, 404, { ok: false, error: '接口不存在。' })
      return this.#serveStatic(request, response, pathname)
    } catch (error) {
      return jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : '请求处理失败。' })
    }
  }

  #pushEvent(channel, payload) {
    if (!channel) return
    let body
    try { body = `data: ${JSON.stringify({ channel, payload })}\n\n` } catch { return }
    for (const client of [...this.clients]) {
      try { client.response.write(body) } catch { this.#closeClient(client) }
    }
  }
}
