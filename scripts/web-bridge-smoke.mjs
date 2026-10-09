// 局域网 Web 访问：真实起一个桥接服务，验证静态页面、访问口令登录、通道调用、事件推送与局域网限制。
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { WebBridgeService, isLanAddress } from '../electron/services/web-bridge-service.mjs'
import { isGlobalIpv6Address } from '../electron/services/device-link-service.mjs'
import { connectTrustedRemote, createPinnedLanFetch, fastTrustDigest } from '../electron/services/remote-trust-connect.mjs'

// 服务默认用自签证书，测试进程内跳过证书校验即可
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const rootPath = mkdtempSync(path.join(os.tmpdir(), 'zsense-web-bridge-'))
const staticDirectory = path.join(rootPath, 'dist')
fs.mkdirSync(staticDirectory, { recursive: true })
fs.writeFileSync(path.join(staticDirectory, 'index.html'), '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'"><title>ZSense</title></head><body><div id="root"></div></body></html>', 'utf8')
const staticAsset = `console.log("asset")\n${'const value = "zsense";\n'.repeat(300)}`
fs.writeFileSync(path.join(staticDirectory, 'asset.js'), staticAsset, 'utf8')

// 伪造一批“已注册的 IPC 处理器”，与桌面端一样返回 { ok, data } 信封
const handled = []
const handlers = new Map([
  ['zsense:data:load', async (_event, payload) => { handled.push({ channel: 'zsense:data:load', payload }); return { ok: true, data: { bots: ['Atlas'], echo: payload, history: '历史消息'.repeat(12_000) } } }],
  ['zsense:data:load-summary', async () => ({ ok: true, data: { conversations: [{ id: 'conversation-1', messageCount: 1, messagesLoaded: false, messages: [] }] } })],
  ['zsense:data:conversation', async (_event, conversationId) => { handled.push({ channel: 'zsense:data:conversation', payload: conversationId }); return { ok: true, data: { id: conversationId, messagesLoaded: true, messages: [{ id: 'message-1', content: '历史消息' }] } } }],
  ['zsense:chat:list-workspace-directories', async (_event, payload) => {
    handled.push({ channel: 'zsense:chat:list-workspace-directories', payload })
    return { ok: true, data: { path: '/remote/workspace', parentPath: '/remote', roots: [], directories: [{ name: 'project', path: '/remote/workspace/project' }], truncated: false } }
  }],
  ['zsense:auth:users:list', async () => ({ ok: true, data: ['should-not-be-callable-from-web'] })],
  ['zsense:data:sync-messages', async (event) => {
    // 模拟主进程向窗口推送流式事件：网页端应该通过 SSE 收到
    event.sender.send('zsense:chat:event', { type: 'status', phase: 'web-bridge-test' })
    return { ok: true, data: { importedMessages: 0 } }
  }],
])

// 端口稳定性：先挑一个空闲端口写进状态，服务必须严格使用它（本机可能有应用占用默认端口）
const freePort = await new Promise((resolve) => {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port
    probe.close(() => resolve(port))
  })
})
fs.mkdirSync(path.join(rootPath, 'web-bridge'), { recursive: true })
fs.writeFileSync(path.join(rootPath, 'web-bridge', 'state.json'), JSON.stringify({ port: freePort }))
const service = new WebBridgeService({
  rootPath,
  staticDirectory,
  preloadPath: path.join(projectRoot, 'electron', 'preload.cjs'),
  handlers,
  hostname: '测试机',
  appVersion: '0.25.4',
})
const status = await service.setEnabled(true)
assert.equal(status.running, true, '开启后服务应在运行')
assert.equal(status.port, freePort, '服务应使用状态里记录的端口')
const bridgeSource = fs.readFileSync(path.join(projectRoot, 'electron', 'services', 'web-bridge-service.mjs'), 'utf8')
assert(bridgeSource.includes('DEFAULT_WEB_BRIDGE_PORT = 39073'), '缺少固定的默认 Web 访问端口')
assert.match(status.accessCode, /^\d{6}$/, '访问口令应为 6 位数字')
const base = `https://127.0.0.1:${status.port}`

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options)
  const payload = await response.json().catch(() => null)
  return { status: response.status, payload, headers: response.headers }
}

try {
  // 1) 未登录：静态页面可以打开（先展示口令输入层），接口一律 401
  const page = await fetch(`${base}/`)
  const html = await page.text()
  assert.equal(page.status, 200)
  assert(html.includes('window.zsenseDesktop = makeNode([])'), '首页应内联桥接入口，节省一次公网请求')
  assert(!html.includes('src="/bridge-client.js"'), '首页不能再阻塞等待独立桥接脚本')
  const inlineBridge = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert(inlineBridge, '桥接脚本必须完整内联')
  assert(html.includes(`'sha256-${createHash('sha256').update(inlineBridge).digest('base64')}'`), '内联脚本必须受原有 CSP 哈希约束')
  assert(!html.includes("script-src 'unsafe-inline'"), '不能为了省时放开任意内联脚本')
  const compressedAsset = await fetch(`${base}/asset.js`, { headers: { 'Accept-Encoding': 'br' } })
  assert.equal(compressedAsset.headers.get('content-encoding'), 'br', '大体积文本静态资源应使用 Brotli 流式压缩')
  assert.equal(await compressedAsset.text(), staticAsset, '压缩静态资源解码后内容不一致')
  assert.equal((await fetchJson(`${base}/bridge/manifest`)).status, 401, '未登录不得读取接口清单')
  assert.equal((await fetchJson(`${base}/bridge/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'data.loadWorkspace', args: [] }) })).status, 401)

  // 公网入口无需本机安全锁，但不得退化为局域网访问口令或匿名登录。
  const remoteHost = { 'cf-worker': 'remote-test' }
  service.remoteAccessAllowed = () => false
  assert.equal((await fetchJson(`${base}/bridge/session`, { headers: remoteHost })).status, 403, '远程开关关闭时公网请求必须拒绝')
  const hostOnlyStatus = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: status.port, path: '/bridge/session', rejectUnauthorized: false, headers: { Host: 'remote-test.zsense.space' } }, (response) => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
  assert.equal(hostOnlyStatus, 403, '缺少代理头时也须按公网域名识别远程请求')
  service.remoteAccessAllowed = () => true
  service.remoteLoginVerifier = (password) => password === 'remote-5678'
    ? { ok: true, user: { username: 'local.owner', displayName: '本机用户' } }
    : { ok: false, code: 'bad-password', error: '远程访问密码不正确。' }
  const remoteWrong = await fetchJson(`${base}/bridge/login`, { method: 'POST', headers: { ...remoteHost, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: status.accessCode }) })
  assert.equal(remoteWrong.status, 403, '公网来源不能用局域网访问口令绕过独立验证')
  const remoteLogin = await fetchJson(`${base}/bridge/login`, { method: 'POST', headers: { ...remoteHost, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'remote-5678' }) })
  assert.equal(remoteLogin.status, 200, '安全锁关闭时仍应允许正确的远程访问密码登录')
  const remoteCookie = String(remoteLogin.headers.get('set-cookie') || '').split(';')[0]
  assert.match(remoteCookie, /^zsense_web=/)
  service.revokeRemoteSessions()
  assert.equal((await fetchJson(`${base}/bridge/manifest`, { headers: { Cookie: remoteCookie } })).status, 401, '远程会话撤销后不得继续使用')

  // 2) 口令错误被拒
  const wrong = await fetchJson(`${base}/bridge/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '000000' }) })
  assert.equal(wrong.status, 403)

  // 3) 正确口令登录并拿到会话 Cookie
  const login = await fetchJson(`${base}/bridge/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: status.accessCode }) })
  assert.equal(login.status, 200)
  assert.equal(login.payload.ok, true)
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0]
  assert.match(cookie, /^zsense_web=/)
  const authed = { 'Content-Type': 'application/json', Cookie: cookie }

  // 4) 清单：路径来自真实 preload，事件订阅映射可解析
  const manifest = await fetchJson(`${base}/bridge/manifest`, { headers: { Cookie: cookie } })
  assert.equal(manifest.payload.ok, true)
  assert(manifest.payload.data.paths.includes('chat.send') && manifest.payload.data.paths.includes('data.loadWorkspace'), '清单应包含真实的 preload 路径')
  assert(manifest.payload.data.paths.includes('chat.listWorkspaceDirectories'), '远程界面必须能浏览被控设备上的文件夹')
  assert(manifest.payload.data.paths.includes('data.loadWorkspaceSummary') && manifest.payload.data.paths.includes('data.loadConversation'), '远程按需加载接口必须暴露给 Web Bridge')
  assert(manifest.payload.data.paths.length > 100, `路径数量异常：${manifest.payload.data.paths.length}`)
  assert(manifest.payload.data.eventPaths.some((entry) => entry.channel === 'zsense:chat:event'), '事件清单应包含对话事件通道')
  assert.equal(manifest.payload.data.constants.isDesktop, true, '网页端应被识别为桌面接口')

  // 5) 调用通道：走真实 preload 映射（data.load → zsense:data:load），拿到 { ok, data } 信封
  const invoked = await fetchJson(`${base}/bridge/invoke`, { method: 'POST', headers: { ...authed, 'Accept-Encoding': 'gzip' }, body: JSON.stringify({ path: 'data.loadWorkspace', args: [] }) })
  assert.equal(invoked.status, 200)
  assert.equal(invoked.payload.ok, true)
  assert.deepEqual(invoked.payload.data.bots, ['Atlas'])
  assert.equal(invoked.headers.get('content-encoding'), 'gzip', '远程工作区大响应应压缩传输')
  assert.equal(invoked.payload.data.history.length, '历史消息'.repeat(12_000).length, '压缩后的工作区应完整还原')
  assert.equal(handled.at(-1).channel, 'zsense:data:load')

  const summary = await fetchJson(`${base}/bridge/invoke`, { method: 'POST', headers: authed, body: JSON.stringify({ path: 'data.loadWorkspaceSummary', args: [] }) })
  assert.equal(summary.payload.data.conversations[0].messagesLoaded, false)
  assert.deepEqual(summary.payload.data.conversations[0].messages, [])
  const singleHistory = await fetchJson(`${base}/bridge/invoke`, { method: 'POST', headers: authed, body: JSON.stringify({ path: 'data.loadConversation', args: ['conversation-1'] }) })
  assert.equal(singleHistory.payload.data.messages[0].content, '历史消息')
  assert.deepEqual(handled.at(-1), { channel: 'zsense:data:conversation', payload: 'conversation-1' })

  const remoteFolders = await fetchJson(`${base}/bridge/invoke`, { method: 'POST', headers: authed, body: JSON.stringify({ path: 'chat.listWorkspaceDirectories', args: ['/remote/workspace'] }) })
  assert.equal(remoteFolders.status, 200, '手机应能通过 Web Bridge 读取被控电脑的工作区目录')
  assert.equal(remoteFolders.payload.data.directories[0].name, 'project')
  assert.deepEqual(handled.at(-1), { channel: 'zsense:chat:list-workspace-directories', payload: '/remote/workspace' })

  // 6) 账号安全类通道被拦住
  const blocked = await fetchJson(`${base}/bridge/invoke`, { method: 'POST', headers: authed, body: JSON.stringify({ path: 'auth.users.list', args: [] }) })
  assert.equal(blocked.status, 403, '账号管理通道不允许从网页访问')

  // 7) 未知路径要给出明确错误
  const unknown = await fetchJson(`${base}/bridge/invoke`, { method: 'POST', headers: authed, body: JSON.stringify({ path: 'not.exists', args: [] }) })
  assert.equal(unknown.status, 400)

  // 8) SSE：事件能推给浏览器
  const sse = await new Promise((resolve, reject) => {
    let triggered = false
    const request = https.get(`${base}/bridge/events`, { headers: { Cookie: cookie }, rejectUnauthorized: false }, (response) => {
      assert.equal(response.statusCode, 200, 'SSE 应返回 200')
      assert.equal(response.headers['cache-control'], 'no-store', 'SSE 不得被浏览器或代理缓存')
      let buffer = ''
      response.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        if (!triggered) {
          triggered = true
          // 事件流建立后触发一次“窗口推送”，验证转发链路
          void fetchJson(`${base}/bridge/invoke`, { method: 'POST', headers: authed, body: JSON.stringify({ path: 'data.syncMessages', args: [] }) })
        }
        if (buffer.includes('web-bridge-test')) { response.destroy(); resolve(buffer) }
      })
    })
    request.on('error', (error) => { if (!triggered) reject(error) })
    setTimeout(() => reject(new Error('SSE 超时')), 8_000)
  })
  assert(sse.includes('zsense:chat:event'), 'SSE 应转发窗口事件')

  // 9) 换口令会让既有会话失效
  const rotated = service.rotateAccessCode()
  assert.notEqual(rotated.accessCode, status.accessCode)
  assert.equal((await fetchJson(`${base}/bridge/manifest`, { headers: { Cookie: cookie } })).status, 401, '换口令后旧会话必须失效')

  // 10) HTTPS：自签证书、https 会话、http 自动跳转
  const httpsStatus = service.inspect()
  assert.equal(httpsStatus.protocol, 'https', '默认应启用 https')
  assert(httpsStatus.certificate?.fingerprint, '缺少自签证书指纹')
  assert(fs.existsSync(path.join(rootPath, 'web-bridge', 'tls', 'cert.pem')), '证书文件应写入数据目录')
  const agent = new https.Agent({ rejectUnauthorized: false })
  const httpsPage = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: status.port, path: '/', agent }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body, cookie: response.headers['set-cookie'] }))
    }).on('error', reject)
  })
  assert.equal(httpsPage.status, 200, 'https 首页应可访问')
  assert(httpsPage.body.includes('window.zsenseDesktop = makeNode([])'), 'https 页面同样要注入桥接脚本')
  const secureCookie = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ code: service.inspect().accessCode })
    const request = https.request({ host: '127.0.0.1', port: status.port, path: '/bridge/login', method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (response) => {
      response.resume()
      resolve(String(response.headers['set-cookie'] || ''))
    })
    request.on('error', reject)
    request.end(payload)
  })
  assert(/Secure/.test(secureCookie), 'https 会话 Cookie 必须带 Secure')
  const redirect = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: service.inspect().httpPort, path: '/somewhere' }, (response) => {
      response.resume()
      resolve({ status: response.statusCode, location: response.headers.location })
    }).on('error', reject)
  })
  assert.equal(redirect.status, 308, 'http 端口应做跳转')
  assert(String(redirect.location).startsWith('https://'), '跳转目标必须是 https')

  // 11) 访问地址：主地址必须是局域网地址（127.0.0.1 在别的设备上打不开），本机地址单独提供
  const runningStatus = service.inspect()
  assert.equal(runningStatus.running, true)
  assert(!runningStatus.urls.some((url) => url.includes('127.0.0.1')), '主地址列表不应包含 127.0.0.1')
  assert(runningStatus.urls.every((url) => /^https:\/\//.test(url)), '主地址应为 https')
  assert(/^https:\/\/127\.0\.0\.1:\d+$/.test(String(runningStatus.localUrl)), '应单独提供本机地址 localUrl')

  // 邮箱不再是免密凭据：只有完成首次配对的设备能用一次性挑战换票据。
  const testIdentity = generateKeyPairSync('ed25519')
  const signTestChallenge = (target, digest) => sign(null, Buffer.from(`${target}:${digest}`), testIdentity.privateKey).toString('base64url')
  service.deviceTrustVerifier = (deviceId, nonce, signature) => deviceId === 'paired-device'
    && (!nonce || verify(null, Buffer.from(`remote-device:${nonce}`), testIdentity.publicKey, Buffer.from(signature, 'base64url')))
  let fastRequest
  let fastCalls = 0
  const fastConnection = await connectTrustedRemote({
    origin: base,
    ownId: 'paired-device',
    targetId: 'remote-device',
    signChallenge: signTestChallenge,
    fetchImpl: (url, options) => {
      fastCalls += 1
      if (url.endsWith('/bridge/trust-challenge')) fastRequest = { url, options }
      return fetch(url, options)
    },
  })
  assert.equal(fastCalls, 1, '新版设备应一次请求换得入场票据')
  assert.match(fastConnection.url, /\/bridge\/enter\?ticket=/)
  assert.equal((await fetchJson(fastRequest.url, fastRequest.options)).status, 403, '快速入场签名不能重放')
  const persistedFastNonces = JSON.parse(fs.readFileSync(path.join(rootPath, 'web-bridge', 'state.json'), 'utf8')).fastTrustNonces
  assert.equal(persistedFastNonces.length, 1, '已使用随机数必须持久化以防应用重启后重放')
  const pinnedConnection = await connectTrustedRemote({
    origin: base, ownId: 'paired-device', targetId: 'remote-device', signChallenge: signTestChallenge,
    fetchImpl: createPinnedLanFetch(status.certificate.fingerprint),
  })
  assert.match(pinnedConnection.url, /\/bridge\/enter\?ticket=/, '验证证书指纹后应能使用局域网短时票据')
  if (process.env.ZSENSE_CHECK_PUBLIC_IPV6 === '1') {
    const publicAddress = Object.values(os.networkInterfaces()).flat()
      .find((item) => item && !item.internal && item.family === 'IPv6' && isGlobalIpv6Address(item.address))?.address
    if (!publicAddress) throw new Error('这台电脑没有可用于本机直连验证的公网 IPv6 地址。')
    const ipv6Origin = `https://[${publicAddress}]:${status.port}`
    const pinnedIpv6Fetch = createPinnedLanFetch(status.certificate.fingerprint)
    service.remoteAccessAllowed = () => false
    const disabled = await pinnedIpv6Fetch(`${ipv6Origin}/bridge/session`, { method: 'GET', signal: AbortSignal.timeout(2_000) })
    assert.equal(disabled.status, 403, '关闭远程连接时公网 IPv6 入站必须被拒绝')
    service.remoteAccessAllowed = () => true
    const ipv6Ticket = await connectTrustedRemote({
      origin: ipv6Origin, ownId: 'paired-device', targetId: 'remote-device', signChallenge: signTestChallenge,
      fetchImpl: pinnedIpv6Fetch, timeoutMs: 2_000,
    })
    assert.match(ipv6Ticket.url, /\/bridge\/enter\?ticket=/, '本机公网 IPv6 地址应通过证书固定和设备签名换得票据')
    console.log(JSON.stringify({ publicIpv6SelfTest: true, boundAddress: publicAddress, remoteOffRejected: true, pinnedSignedEntry: true }))
  }
  await assert.rejects(() => connectTrustedRemote({
    origin: base, ownId: 'paired-device', targetId: 'remote-device', signChallenge: signTestChallenge,
    fetchImpl: createPinnedLanFetch('A'.repeat(64)),
  }), /证书与已验证身份不一致/, '证书指纹不符时不得发送设备签名')
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-web-replay-'))
  const replayPort = await new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
  })
  fs.mkdirSync(path.join(replayRoot, 'web-bridge'), { recursive: true })
  fs.writeFileSync(path.join(replayRoot, 'web-bridge', 'state.json'), JSON.stringify({ port: replayPort, fastTrustNonces: persistedFastNonces }))
  const replayService = new WebBridgeService({ rootPath: replayRoot, staticDirectory, preloadPath: path.join(projectRoot, 'electron', 'preload.cjs'), handlers })
  replayService.deviceTrustVerifier = service.deviceTrustVerifier
  try {
    await replayService.setEnabled(true)
    const replayStatus = await new Promise((resolve, reject) => {
      const request = https.request({ host: '127.0.0.1', port: replayService.inspect().port, path: '/bridge/trust-challenge', method: 'POST', rejectUnauthorized: false, agent: false, headers: { ...fastRequest.options.headers, Connection: 'close' } }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      request.on('error', reject)
      request.end()
    })
    assert.equal(replayStatus, 403, '重启后的服务也不得接受已用签名')
  } finally {
    await replayService.setEnabled(false)
    fs.rmSync(replayRoot, { recursive: true, force: true })
  }
  const fastHeaders = fastRequest.options.headers
  assert.equal((await fetchJson(fastRequest.url, { method: 'POST', headers: { ...fastHeaders, 'x-zsense-nonce': 'B'.repeat(43) } })).status, 403, '签名不得被换成另一个随机数')
  const staleTime = Date.now() - 180_000
  const staleNonce = 'C'.repeat(43)
  const stale = await fetchJson(`${base}/bridge/trust-challenge`, { method: 'POST', headers: {
    'x-zsense-device': 'paired-device', 'x-zsense-nonce': staleNonce, 'x-zsense-issued-at': String(staleTime),
    'x-zsense-signature': signTestChallenge('remote-device', fastTrustDigest('paired-device', staleTime, staleNonce)),
  } })
  assert.match(stale.payload?.data?.nonce || '', /^[A-Za-z0-9_-]{24,100}$/, '时钟偏差时只能回退到服务端挑战，不得直接放行')
  const fastEntered = await fetch(fastConnection.url, { redirect: 'manual' })
  const fastCookie = String(fastEntered.headers.get('set-cookie') || '').split(';')[0]
  assert.match(fastCookie, /^zsense_web=/)

  let legacyCalls = 0
  const legacyConnection = await connectTrustedRemote({
    origin: base, ownId: 'paired-device', targetId: 'remote-device',
    signChallenge: signTestChallenge,
    fetchImpl: (url, options) => {
      legacyCalls += 1
      if (url.endsWith('/bridge/trust-challenge')) return fetch(url, { ...options, headers: { 'x-zsense-device': options.headers['x-zsense-device'] } })
      return fetch(url, options)
    },
  })
  assert.equal(legacyCalls, 2, '旧版设备仍只需原有的两次请求')
  assert.match(legacyConnection.url, /\/bridge\/enter\?ticket=/)

  service.deviceTrustVerifier = (deviceId, nonce, signature) => deviceId === 'paired-device' && (!nonce || signature === `signed:${nonce}`)

  const unknownChallenge = await fetchJson(`${base}/bridge/trust-challenge`, { method: 'POST', headers: { 'x-zsense-device': 'unknown' } })
  assert.equal(unknownChallenge.status, 403)
  const challenge = await fetchJson(`${base}/bridge/trust-challenge`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device' } })
  assert.equal(challenge.status, 200)
  const nonce = challenge.payload.data.nonce
  const badSignature = await fetchJson(`${base}/bridge/trust-ticket`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device', 'x-zsense-nonce': nonce, 'x-zsense-signature': 'email-derived-forgery' } })
  assert.equal(badSignature.status, 403)
  const replay = await fetchJson(`${base}/bridge/trust-ticket`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device', 'x-zsense-nonce': nonce, 'x-zsense-signature': `signed:${nonce}` } })
  assert.equal(replay.status, 403, '验证失败后挑战必须失效')
  const nextChallenge = await fetchJson(`${base}/bridge/trust-challenge`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device' } })
  const nextNonce = nextChallenge.payload.data.nonce
  const trusted = await fetchJson(`${base}/bridge/trust-ticket`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device', 'x-zsense-nonce': nextNonce, 'x-zsense-signature': `signed:${nextNonce}` } })
  assert.equal(trusted.status, 200)
  assert.match(trusted.payload.data.entryPath, /^\/bridge\/enter\?ticket=/)
  const entered = await fetch(`${base}${trusted.payload.data.entryPath}`, { redirect: 'manual' })
  assert.equal(entered.headers.get('cache-control'), 'no-store', '一次性入口响应不得被缓存')
  const trustedCookie = String(entered.headers.get('set-cookie') || '').split(';')[0]
  assert.match(trustedCookie, /^zsense_web=/)
  // Agent-to-Agent 公网任务：只接受已配对设备的单次签名，且签名覆盖任务正文。
  let agentCalls = 0
  service.remoteAgentTaskProvider = async ({ deviceId, prompt }) => {
    agentCalls += 1
    return { output: `${deviceId}: ${prompt}`, conversationId: 'remote-conversation' }
  }
  const signedAgentRequest = async (route, body, override = null) => {
    const challengeResult = await fetchJson(`${base}/bridge/trust-challenge`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device' } })
    const agentNonce = challengeResult.payload.data.nonce
    const digest = createHash('sha256').update(`zsense-agent-v1\nPOST\n${route}\n${agentNonce}\n${JSON.stringify(body)}`).digest('base64url')
    return fetchJson(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zsense-device': 'paired-device', 'x-zsense-nonce': agentNonce, 'x-zsense-signature': `signed:${digest}` },
      body: JSON.stringify(override || body),
    })
  }
  const tamperedTask = await signedAgentRequest('/bridge/agent-task', { prompt: '安全任务' }, { prompt: '被篡改的任务' })
  assert.equal(tamperedTask.status, 403, '签名必须绑定完整请求体')
  const submittedTask = await signedAgentRequest('/bridge/agent-task', { prompt: '整理资料', timeoutMs: 10_000 })
  assert.equal(submittedTask.status, 202)
  assert.equal(agentCalls, 1, '一次提交只能启动一次任务')
  const taskId = submittedTask.payload.data.taskId
  let cloudResult
  for (let attempt = 0; attempt < 10; attempt += 1) {
    cloudResult = await signedAgentRequest('/bridge/agent-task-result', { taskId })
    if (cloudResult.payload.data.status === 'complete') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(cloudResult.payload.data.result.output, 'paired-device: 整理资料')
  // 同一设备的并发查询必须拿到不同挑战，并且互不误耗；签名还需绑定路由。
  const parallelChallenges = await Promise.all([0, 1].map(() => fetchJson(`${base}/bridge/trust-challenge`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device' } })))
  const parallelNonces = parallelChallenges.map((item) => item.payload.data.nonce)
  assert.notEqual(parallelNonces[0], parallelNonces[1], '并发请求不能共用同一个一次性挑战')
  const parallelResults = await Promise.all(parallelNonces.map((parallelNonce) => {
    const body = { taskId }
    const digest = createHash('sha256').update(`zsense-agent-v1\nPOST\n/bridge/agent-task-result\n${parallelNonce}\n${JSON.stringify(body)}`).digest('base64url')
    return fetchJson(`${base}/bridge/agent-task-result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zsense-device': 'paired-device', 'x-zsense-nonce': parallelNonce, 'x-zsense-signature': `signed:${digest}` },
      body: JSON.stringify(body),
    })
  }))
  assert(parallelResults.every((item) => item.status === 200), '并发签名请求应分别成功')
  const routeChallenge = await fetchJson(`${base}/bridge/trust-challenge`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device' } })
  const routeNonce = routeChallenge.payload.data.nonce
  const routeBody = { taskId }
  const wrongRouteDigest = createHash('sha256').update(`zsense-agent-v1\nPOST\n/bridge/agent-task\n${routeNonce}\n${JSON.stringify(routeBody)}`).digest('base64url')
  const wrongRoute = await fetchJson(`${base}/bridge/agent-task-result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zsense-device': 'paired-device', 'x-zsense-nonce': routeNonce, 'x-zsense-signature': `signed:${wrongRouteDigest}` },
    body: JSON.stringify(routeBody),
  })
  assert.equal(wrongRoute.status, 403, '任务签名不能跨路由使用')
  const cancelledPeers = []
  service.remoteAgentTaskCanceler = (deviceId) => cancelledPeers.push(deviceId || 'all')
  service.revokeTrustedDevice('paired-device')
  assert.deepEqual(cancelledPeers, ['paired-device'], '撤销设备时应主动取消该设备正在执行的 Agent 任务')
  const revokedAccess = await fetchJson(`${base}/bridge/manifest`, { headers: { Cookie: trustedCookie } })
  assert.equal(revokedAccess.status, 401, '撤销设备授权应使既有远程会话立即失效')
  assert.equal((await fetchJson(`${base}/bridge/manifest`, { headers: { Cookie: fastCookie } })).status, 401, '撤销设备授权也必须清理快速入场会话')
  const identity = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  let enrolled = null
  service.pairingCodeProvider = () => '654321'
  service.deviceIdentityProvider = () => identity
  service.onRemotePeerConnected = (...args) => { enrolled = args }
  const firstPair = await fetchJson(`${base}/bridge/pair-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-zsense-device': 'a1b2c3d4' }, body: JSON.stringify({ code: '654321', name: '测试设备', identityPublicKey: identity }) })
  assert.equal(firstPair.status, 200)
  assert.equal(firstPair.payload.data.identityPublicKey, identity)
  assert.equal(enrolled[0], 'a1b2c3d4')
  assert.equal(enrolled[2], identity)
  service.onRemotePeerConnected = () => false
  const rejectedRebind = await fetchJson(`${base}/bridge/pair-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-zsense-device': 'a1b2c3d4' }, body: JSON.stringify({ code: '654321', name: '冒名设备', identityPublicKey: identity }) })
  assert.equal(rejectedRebind.status, 409, '接收端拒绝旧身份重新绑定时不能发放登录票据')
  service.revokeRemoteSessions()
  const invalidatedPairTicket = await fetch(`${base}${firstPair.payload.data.entryPath}`, { redirect: 'manual' })
  assert.equal(invalidatedPairTicket.headers.get('location'), '/?trust=failed', '设备离线/关闭远程时未使用的一次性票据也必须失效')
  assert.equal(invalidatedPairTicket.headers.get('cache-control'), 'no-store', '失效的一次性入口响应不得被缓存')
  const pendingChallenge = await fetchJson(`${base}/bridge/trust-challenge`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device' } })
  service.revokeRemoteSessions()
  const invalidatedChallenge = await fetchJson(`${base}/bridge/trust-ticket`, { method: 'POST', headers: { 'x-zsense-device': 'paired-device', 'x-zsense-nonce': pendingChallenge.payload.data.nonce, 'x-zsense-signature': `signed:${pendingChallenge.payload.data.nonce}` } })
  assert.equal(invalidatedChallenge.status, 403, '设备离线/关闭远程时未使用的签名挑战必须失效')

  // 12) 局域网地址判定与关闭
  assert.equal(isLanAddress('192.168.3.15'), true)
  assert.equal(isLanAddress('10.0.0.8'), true)
  assert.equal(isLanAddress('8.8.8.8'), false)
  const stopped = await service.setEnabled(false)
  assert.equal(stopped.running, false)
  assert.equal(stopped.enabled, false)
  assert.equal(stopped.accessCode, '', '关闭后不再显示口令')

  const panelSource = fs.readFileSync(path.join(projectRoot, 'src/components/WebAccessPanel.tsx'), 'utf8')
  assert(panelSource.includes("from '../services/clipboard'") && panelSource.includes('writeTextToClipboard('), '面板复制必须走应用内剪贴板通道（navigator.clipboard 在桌面窗口会被拒绝）')
  assert(
    panelSource.includes("const lanUrl = (status?.urls || [])[0] || status?.localUrl || ''")
      && panelSource.includes("copy(lanUrl, '地址已复制')"),
    '复制按钮应优先复制局域网地址',
  )
  assert(!/navigator\.clipboard\.writeText\(/.test(panelSource), '面板不应直接调用 navigator.clipboard.writeText')

  console.log(JSON.stringify({
    ok: true,
    staticServed: true,
    loginRequired: true,
    wrongCodeRejected: true,
    manifestFromPreload: true,
    channelInvoke: true,
    blockedChannelGuarded: true,
    sseEvents: true,
    rotateInvalidatesSessions: true,
    lanOnlyAddressCheck: true, lanUrlPreferred: true, httpsWithSelfSignedCert: true, httpRedirectsToHttps: true,
    deviceKeyTrust: true, signedAgentTask: true, toggleOff: true,
  }))
} finally {
  await service.shutdown()
  fs.rmSync(rootPath, { recursive: true, force: true })
}
