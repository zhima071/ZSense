import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DeviceLinkService, isPrivateNetworkAddress } from '../electron/services/device-link-service.mjs'
import { createDeviceDataProvider } from '../electron/services/device-data-service.mjs'
import { ZSenseDatabase } from '../electron/services/database.mjs'

// 测试进程连接临时实例的自签证书；产品代码按首次配对固定的指纹验证后续请求。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

class TestVault {
  constructor() { this.values = new Map() }
  get(scope) { return { ...(this.values.get(scope) || {}) } }
  set(scope, updates, clearKeys = []) {
    const next = this.get(scope)
    for (const key of clearKeys) delete next[key]
    Object.assign(next, updates)
    this.values.set(scope, next)
    return next
  }
  delete(scope) { this.values.delete(scope) }
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-device-link-'))
fs.writeFileSync(path.join(temporaryDirectory, 'peer-file.txt'), '对端文件内容：hello from peer')
// 对端用真实数据库：验证读到的确实是对端自己的会话与记忆，而不是桩数据
const peerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-device-link-db-'))
const peerDatabase = new ZSenseDatabase(peerRoot)
const peerConversationId = peerDatabase.createConversation('atlas', '对端会话')
peerDatabase.addMessage(peerConversationId, 'user', '对端的第一句：帮我看一下报表')
peerDatabase.addMessage(peerConversationId, 'assistant', '对端这一轮说了什么：报表里 9 月的数据已经补全。')
const vaultA = new TestVault()
const vaultB = new TestVault()
// 公网设备号从 v2 起由中心分配；这里预置两个已经绑定过的测试号，避免测试依赖真实公网中心。
for (const [folder, deviceId] of [['a', 'mac00001'], ['b', 'win00002']]) {
  const directory = path.join(temporaryDirectory, folder, 'device-link')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ remote: { deviceId, hubBound: true, enabled: false } }))
}
const remoteCalls = []
const remoteRunner = (label) => ({
  async run({ prompt, peer, timeoutMs }) {
    remoteCalls.push({ label, prompt, peer, timeoutMs })
    return {
      output: `${label} 收到：${prompt}`,
      conversationId: `conversation-${label}`,
      model: 'test-model',
      modelProvider: 'custom',
      reasoningEffort: 'high',
      durationMs: 1234,
      usage: { inputTokens: 10, outputTokens: 20 },
      toolCalls: 0,
      refusedOperations: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }
  },
})
const serviceA = new DeviceLinkService({
  rootPath: path.join(temporaryDirectory, 'a'), secrets: vaultA, platform: 'darwin', hostname: 'Mac-A', discoveryPort: 39171,
  remoteStatusProvider: ({ deviceId, name, platform }) => ({ device: { deviceId, name, platform, platformLabel: platform === 'win32' ? 'Windows' : 'macOS' }, app: { version: '0.24.0', platform, startedAt: new Date().toISOString(), uptimeMs: 1_000 }, activity: { bots: 2, onlineBots: 1, conversations: 4, scheduledTasks: 1, runningTasks: 0, skills: 3, memories: 5 }, capabilities: { agentCore: true, remoteTasks: true, voiceWake: false, gateway: true } }),
  remoteTaskRunner: remoteRunner('A'),
})
const serviceB = new DeviceLinkService({
  rootPath: path.join(temporaryDirectory, 'b'), secrets: vaultB, platform: 'win32', hostname: 'Windows-B', discoveryPort: 39171,
  remoteStatusProvider: ({ deviceId, name, platform }) => ({ device: { deviceId, name, platform, platformLabel: platform === 'darwin' ? 'macOS' : 'Windows' }, app: { version: '0.24.0', platform, startedAt: new Date().toISOString(), uptimeMs: 2_000 }, activity: { bots: 1, onlineBots: 1, conversations: 2, scheduledTasks: 0, runningTasks: 0, skills: 1, memories: 2 }, capabilities: { agentCore: true, remoteTasks: true, voiceWake: true, gateway: true } }),
  remoteTaskRunner: remoteRunner('B'),
  remoteDataProvider: createDeviceDataProvider({ database: peerDatabase, localStatusProvider: () => ({ device: { name: '对端机器' }, activity: { bots: 1 } }) }),
})
serviceA.appLockProvider = () => true
serviceB.appLockProvider = () => true

try {
  const preloadSource = fs.readFileSync(path.resolve('electron/preload.cjs'), 'utf8')
  const ipcSource = fs.readFileSync(path.resolve('electron/ipc.mjs'), 'utf8')
  const settingsSource = fs.readFileSync(path.resolve('src/components/SystemPages.tsx'), 'utf8')
  const panelSource = fs.readFileSync(path.resolve('src/components/DeviceLinkSettingsPanel.tsx'), 'utf8')
  assert.match(preloadSource, /deviceLink: Object\.freeze/)
  assert.match(ipcSource, /zsense:device-link:pair/)
  assert.match(settingsSource, /DeviceLinkSettingsPanel/)
  // 搜不到设备时的兜底通道必须一路接通：IPC + preload + 面板
  assert.match(ipcSource, /zsense:device-link:pair-by-address/, 'IPC 缺少按 IP 直连入口')
  assert.match(preloadSource, /pairByAddress/, 'preload 缺少按 IP 直连方法')
  assert.match(panelSource, /pairByAddress/, '设备互联面板缺少按 IP 直连操作')
  assert.match(panelSource, /设备不在附近时可填写 IP:端口/, '设备互联统一入口没有提供搜不到设备时的 IP 直连提示')
  assert.match(panelSource, /connectUnified/, '局域网与云端连接没有走统一入口')
  // 触发条件：开启设备互联时扫一次；打开设备互联界面时自动扫一次；按钮只留图标
  assert.match(panelSource, /autoScannedRef/, '打开设备互联界面时没有自动扫描一次')
  assert(!/立即扫描<\/button>/.test(panelSource) && !panelSource.includes('扫描中…</>'), '扫描按钮不应带文字，只保留图标')
  assert.match(panelSource, /aria-label="立即扫描局域网"/, '纯图标按钮必须保留无障碍标签')
  assert.equal(isPrivateNetworkAddress('192.168.1.8'), true)
  assert.equal(isPrivateNetworkAddress('8.8.8.8'), false)
  await serviceA.setEnabled(true)
  await serviceB.setEnabled(true)

  const statusA = serviceA.inspect()
  const statusB = serviceB.inspect()
  assert.equal(statusA.running, true)
  assert.equal(statusB.running, true)
  assert.equal(statusB.device.platformLabel, 'Windows')

  // 被动发现：公告每 4 秒发一次，等一个周期确认双方互相发现（refresh 现在是主动扫描，单独在下面验证）
  await new Promise((resolve) => setTimeout(resolve, 4_600))
  assert.equal(serviceA.inspect().discoveredDevices.some((device) => device.deviceId === statusB.device.deviceId), true)
  assert.equal(serviceB.inspect().discoveredDevices.some((device) => device.deviceId === statusA.device.deviceId), true)

  await assert.rejects(() => serviceA.pair(statusB.device.deviceId, `000000-${statusB.pairingIdentityCode}`), /配对码错误|拒绝/)
  await assert.rejects(() => serviceA.pair(statusB.device.deviceId, `${statusB.pairingCode}-0000000000000000`), /身份码不一致/)
  await serviceA.pair(statusB.device.deviceId, `${statusB.pairingCode}-${statusB.pairingIdentityCode}`)
  assert.equal(serviceA.inspect().trustedPeers.length, 1)
  assert.equal(serviceB.inspect().trustedPeers.length, 1)
  assert.equal(serviceA.inspect().trustedPeers[0].online, true)
  assert.match(serviceA.inspect().trustedPeers[0].tlsFingerprint, /^[0-9A-F:]{95}$/)
  assert(serviceA.rememberRemotePeer('win00002', 'Windows-B', serviceB.identityPublicKey()))
  assert.equal(serviceA.inspect().trustedPeers.length, 1, '同一台设备的云端身份应合并到已有局域网记录')
  assert.equal(serviceA.inspect().trustedPeers[0].source, 'lan')
  assert.equal(serviceA.inspect().trustedPeers[0].cloudPaired, true)
  const forgedKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  assert.equal(serviceA.rememberRemotePeer('win00002', '冒名设备', forgedKey), false, '已绑定的设备公钥不得静默替换')
  const nonce = 'A'.repeat(32)
  assert.equal(serviceB.verifyRemoteChallenge(serviceA.inspect().remote.deviceId, nonce, serviceA.signRemoteChallenge(serviceB.inspect().remote.deviceId, nonce)), false, '远程连接关闭时不得接受设备挑战')
  // 本测试只验证签名门禁；直接置测试实例状态，避免连接真实公网交换中心。
  serviceB.state.remote.enabled = true
  assert.equal(serviceB.verifyRemoteChallenge(serviceA.inspect().remote.deviceId, nonce, serviceA.signRemoteChallenge(serviceB.inspect().remote.deviceId, nonce)), true)
  assert.equal(serviceB.verifyRemoteChallenge(serviceA.inspect().remote.deviceId, nonce, 'invalid'), false)
  // 未签名的发现公告即使冒充已配对设备，也不能把带凭证的请求重定向过去。
  serviceA.ingestAdvertisement({ protocol: 'zsense-device-link', version: 2, deviceId: statusB.device.deviceId, name: '冒名设备', platform: 'win32', port: statusA.device.port }, '127.0.0.1')
  await assert.rejects(() => serviceA.remoteStatus(statusB.device.deviceId), /证书已变化/)
  serviceA.ingestAdvertisement({ protocol: 'zsense-device-link', version: 2, deviceId: statusB.device.deviceId, name: 'Windows-B', platform: 'win32', port: statusB.device.port }, '127.0.0.1')

  const scopeB = `device-link:${statusB.device.deviceId}`
  const previousSecret = vaultA.get(scopeB).sharedSecret
  assert.ok(previousSecret.length >= 32)
  serviceA.disconnect(statusB.device.deviceId)
  assert.equal(serviceA.inspect().trustedPeers[0].connected, false)
  await serviceA.connect(statusB.device.deviceId)
  assert.equal(serviceA.inspect().trustedPeers[0].online, true)

  // 配对不自动授权读取或执行；接收方必须分别开启权限。
  assert.deepEqual(serviceB.inspect().trustedPeers[0].access, { allowStatus: false, allowFiles: false, allowTasks: false })
  assert.equal(serviceB.inspect().security.remoteAgentAccess, false)
  await assert.rejects(() => serviceA.remoteStatus(statusB.device.deviceId), /尚未允许你读取/)
  await assert.rejects(() => serviceA.readRemoteData(statusB.device.deviceId, 'bots'), /尚未允许你读取/)
  await assert.rejects(() => serviceA.runRemoteTask(statusB.device.deviceId, '整理下载目录'), /尚未允许你在这台设备上执行任务/)
  serviceB.setPeerAccess(statusA.device.deviceId, { allowStatus: false, allowFiles: true, allowTasks: false })
  const fileOnly = await serviceA.readRemoteData(statusB.device.deviceId, 'file', { path: path.join(temporaryDirectory, 'peer-file.txt') })
  assert.match(fileOnly.data.content, /对端文件内容/, '文件权限应与状态权限独立')
  await assert.rejects(() => serviceA.remoteStatus(statusB.device.deviceId), /尚未允许你读取/)
  serviceB.setPeerAccess(statusA.device.deviceId, { allowStatus: true, allowFiles: false, allowTasks: false })
  await assert.rejects(() => serviceA.readRemoteData(statusB.device.deviceId, 'file', { path: path.join(temporaryDirectory, 'peer-file.txt') }), /尚未允许你读取本机文件/)
  serviceB.setPeerAccess(statusA.device.deviceId, { allowStatus: true, allowFiles: true, allowTasks: false })

  const remoteStatus = await serviceA.remoteStatus(statusB.device.deviceId)
  assert.equal(remoteStatus.device.platformLabel, 'Windows')
  assert.equal(remoteStatus.activity.bots, 1)

  // 直接读取对方内容：会话列表 → 某个会话的完整对话
  const conversations = await serviceA.readRemoteData(statusB.device.deviceId, 'conversations', { limit: 5 })
  assert.equal(conversations.scope, 'conversations')
  assert.equal(conversations.data.conversations.length, 1, '应能读到对端的会话列表')
  assert.equal(conversations.data.conversations[0].title, '对端会话')
  const conversation = await serviceA.readRemoteData(statusB.device.deviceId, 'conversation', { conversationId: peerConversationId })
  assert.equal(conversation.data.messages.length, 2, '应能读到对端会话的完整消息')
  assert.match(conversation.data.messages[1].content, /报表里 9 月的数据已经补全/, '读到的必须是对端数据库里的真实内容')
  const peerFile = await serviceA.readRemoteData(statusB.device.deviceId, 'file', { path: path.join(temporaryDirectory, 'peer-file.txt') })
  assert.match(peerFile.data.content, /对端文件内容/)
  fs.writeFileSync(path.join(temporaryDirectory, '.env'), 'API_KEY=should-not-leak')
  await assert.rejects(() => serviceA.readRemoteData(statusB.device.deviceId, 'file', { path: path.join(temporaryDirectory, '.env') }), /禁止通过设备互联读取凭据/)
  const peerSettings = await serviceA.readRemoteData(statusB.device.deviceId, 'settings', {})
  const serializedSettings = JSON.stringify(peerSettings.data)
  assert(!/sk-[A-Za-z0-9]/.test(serializedSettings), '凭据类内容不能外发')
  assert.match(serializedSettings, /已隐藏：凭据不外发|apiKey/, '设置读取要保留字段但隐藏凭据值')
  const peerDirectory = await serviceA.readRemoteData(statusB.device.deviceId, 'directory', { path: temporaryDirectory })
  assert(peerDirectory.data.entries.some((entry) => entry.name === 'peer-file.txt'), '应能列出对端目录')
  await assert.rejects(() => serviceA.readRemoteData(statusB.device.deviceId, 'conversation', { conversationId: 'missing' }), /没有这个会话/)
  await assert.rejects(() => serviceA.readRemoteData(statusB.device.deviceId, 'nonsense'), /不支持的数据范围/)

  serviceB.setPeerAccess(statusA.device.deviceId, { allowStatus: true, allowFiles: true, allowTasks: true })
  assert.equal(serviceB.inspect().security.remoteTaskAccess, true)
  const remoteRun = await serviceA.runRemoteTask(statusB.device.deviceId, '整理下载目录里的 PDF')
  assert.equal(remoteRun.output, 'B 收到：整理下载目录里的 PDF')
  assert.equal(remoteCalls.length, 1)
  assert.equal(remoteCalls[0].label, 'B')
  assert.equal(remoteCalls[0].peer.deviceId, statusA.device.deviceId)
  assert.equal(remoteCalls[0].peer.name, 'Mac-A')
  assert.ok(remoteCalls[0].timeoutMs >= 10_000, '远程任务应带上合法的超时预算')
  await assert.rejects(() => serviceA.runRemoteTask(statusB.device.deviceId, '   '), /请输入要让对方设备执行的任务内容/)

  // 未配对设备即使拿到旧凭证也不能读取状态。
  const forgedStatus = await fetch(`https://127.0.0.1:${statusB.device.port}/v1/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer 0000' },
    body: JSON.stringify({ deviceId: statusA.device.deviceId }),
  })
  assert.equal(forgedStatus.status, 401)

  await serviceA.unpair(statusB.device.deviceId)
  assert.equal(serviceA.inspect().trustedPeers.length, 0)
  assert.equal(serviceB.inspect().trustedPeers.length, 0)
  assert.equal(vaultA.get(scopeB).sharedSecret, undefined)
  assert.equal(serviceB.inspect().security.remoteStatusAccess, false)

  const unauthorized = await fetch(`https://127.0.0.1:${statusB.device.port}/v1/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${previousSecret}` },
    body: JSON.stringify({ deviceId: statusA.device.deviceId }),
  })
  assert.equal(unauthorized.status, 401)

  // 组播被隔离时也能发现设备：主动扫描逐台探测 /v1/status
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-device-link-isolated-'))
  const isolatedVault = new TestVault()
  const isolatedService = new DeviceLinkService({
    rootPath: isolatedRoot,
    secrets: isolatedVault,
    hostname: '被隔离的扫描方',
    // 换一个组播组与端口：模拟“收不到任何组播广告”的网络
    discoveryAddress: '239.255.90.99',
    discoveryPort: 39999,
  })
  try {
    await isolatedService.start()
    assert.equal(isolatedService.inspect().discoveredDevices.length, 0, '换组播组后不应再通过广告发现设备')
    const scanStartedAt = Date.now()
    const scanned = await isolatedService.scan({ ports: [statusB.device.port] })
    const scanMs = Date.now() - scanStartedAt
    const foundPeer = scanned.discoveredDevices.find((device) => device.deviceId === statusB.device.deviceId)
    assert(foundPeer, '主动扫描没有发现同一局域网内的另一台设备')
    assert.equal(foundPeer.source, 'scan', '扫描发现的设备应标注来源')
    assert.equal(foundPeer.address, '127.0.0.1')
    assert(scanMs < 30_000, `扫描应在合理时间内完成（实际 ${scanMs}ms）`)
    // 扫描出来后可以直接配对，说明这条路真的能用
    // 配对码在每次成功配对后会轮换，这里重新取对端当前屏幕上的码
    const currentCodeB = `${serviceB.inspect().pairingCode}-${serviceB.inspect().pairingIdentityCode}`
    const pairedViaScan = await isolatedService.pair(statusB.device.deviceId, currentCodeB)
    assert(pairedViaScan.trustedPeers.some((peer) => peer.deviceId === statusB.device.deviceId), '扫描到的设备应能直接配对')
  } finally {
    await Promise.allSettled([isolatedService.shutdown()])
    fs.rmSync(isolatedRoot, { recursive: true, force: true })
  }

  // 开启设备互联时自动扫一次：用户不需要点任何按钮就能看到局域网里的设备
  const autoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-device-link-auto-'))
  const autoVault = new TestVault()
  const autoPeerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-device-link-auto-peer-'))
  const autoPeerVault = new TestVault()
  const autoPeer = new DeviceLinkService({ rootPath: autoPeerRoot, secrets: autoPeerVault, hostname: '自动发现对端' })
  const autoPeerStatus = await autoPeer.start()
  const autoScanner = new DeviceLinkService({
    rootPath: autoRoot,
    secrets: autoVault,
    hostname: '自动发现本机',
    // 换一个组播组：收不到对端公告，只能靠主动扫描
    discoveryAddress: '239.255.90.97',
    discoveryPort: 39997,
    autoScanPorts: [autoPeerStatus.device.port],
  })
  try {
    const autoStartedAt = Date.now()
    await autoScanner.setEnabled(true)
    let autoFound = null
    while (Date.now() - autoStartedAt < 20_000 && !autoFound) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      autoFound = autoScanner.inspect().discoveredDevices.find((device) => device.deviceId === autoPeerStatus.device.deviceId) || null
    }
    assert(autoFound, '开启设备互联后没有自动发现同一局域网内的设备（不该要求用户手动扫描）')
    assert.equal(autoFound.source, 'scan')
    // 应用启动恢复状态时不应触发扫描：initialize 走的 start() 不扫描
    const restoreScanner = new DeviceLinkService({ rootPath: path.join(autoRoot, 'restore'), secrets: new TestVault(), hostname: '恢复态本机', discoveryAddress: '239.255.90.96', discoveryPort: 39996, autoScanPorts: [autoPeerStatus.device.port] })
    await restoreScanner.setEnabled(true)
    await restoreScanner.shutdown()
    const restored = new DeviceLinkService({ rootPath: path.join(autoRoot, 'restore'), secrets: new TestVault(), hostname: '恢复态本机', discoveryAddress: '239.255.90.96', discoveryPort: 39996, autoScanPorts: [autoPeerStatus.device.port] })
    try {
      await restored.initialize()
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      assert.equal(restored.inspect().discoveredDevices.length, 0, '应用启动恢复状态时不应自动扫描')
    } finally { await restored.shutdown() }
  } finally {
    await Promise.allSettled([autoScanner.shutdown(), autoPeer.shutdown()])
    fs.rmSync(autoRoot, { recursive: true, force: true })
    fs.rmSync(autoPeerRoot, { recursive: true, force: true })
  }

  // 组播被隔离时的兜底：按 IP 直连配对（走单播 HTTPS，跨网段同样可用）
  const manualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-device-link-manual-'))
  const manualVaultPeer = new TestVault()
  const manualVaultLocal = new TestVault()
  // 端口稳定性：先挑一个空闲端口写进状态，服务应严格使用它（重启后也一样），这样对方才能按固定端口直连
  const freePort = await new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
  fs.mkdirSync(path.join(manualRoot, 'device-link'), { recursive: true })
  fs.writeFileSync(path.join(manualRoot, 'device-link', 'state.json'), JSON.stringify({ httpPort: freePort }))
  const manualPeer = new DeviceLinkService({ rootPath: manualRoot, secrets: manualVaultPeer, hostname: '手动对端', remoteStatusProvider: () => ({ summary: '手动对端运行正常', activeRuns: 0 }) })
  const manualLocal = new DeviceLinkService({ rootPath: path.join(manualRoot, 'local'), secrets: manualVaultLocal, hostname: '手动本机' })
  try {
    const manualPeerStatus = await manualPeer.start()
    assert.equal(manualPeerStatus.device.port, freePort, '设备互联应优先使用状态里记录的固定端口，便于按 IP 直连')
    assert(/^\d{6}$/.test(manualPeerStatus.pairingCode) && /^[0-9A-F]{16}$/.test(manualPeerStatus.pairingIdentityCode), '直连配对需要对方屏幕上的完整安全配对码')

    const manualLocalStatus = await manualLocal.start()
    assert.notEqual(manualLocalStatus.device.port, 0, '第二个实例应在默认端口被占用时回退到其他端口')

    // 默认端口常量必须存在（对方没有历史状态时也能按 39072 直连）
    const deviceLinkSource = fs.readFileSync(new URL('../electron/services/device-link-service.mjs', import.meta.url), 'utf8')
    assert(deviceLinkSource.includes('const DEFAULT_HTTP_PORT = 39072'), '缺少固定的默认设备互联端口')

    const manualConnected = await manualLocal.pairByAddress({ address: '127.0.0.1', port: manualPeerStatus.device.port, code: `${manualPeerStatus.pairingCode}-${manualPeerStatus.pairingIdentityCode}` })
    const manualTrusted = manualConnected.trustedPeers.find((peer) => peer.deviceId === manualPeerStatus.device.deviceId)
    assert(manualTrusted, '按 IP 直连后本机应记录为受信任设备')
    assert.equal(manualTrusted.manual, true, '按 IP 直连的设备应标记为手动添加')
    assert.equal(manualTrusted.address, '127.0.0.1')
    assert.equal(manualTrusted.port, manualPeerStatus.device.port)
    assert.equal(manualConnected.discoveredDevices.some((device) => device.deviceId === manualPeerStatus.device.deviceId && device.manual === true), true, '按 IP 直连的设备也应出现在发现列表里')

    // 重启后端口必须保持：否则对方记的地址会失效
    const restartStatus = await (async () => {
      await manualLocal.stop()
      await manualLocal.start()
      return manualLocal.inspect()
    })()
    assert.equal(restartStatus.device.port, manualLocalStatus.device.port, '设备互联重启后应保持同一个端口')

    const peerSideTrusted = manualPeer.inspect().trustedPeers.find((peer) => peer.deviceId === manualLocalStatus.device.deviceId)
    assert(peerSideTrusted, '对方也要把本机记录为受信任设备')
    assert.equal(peerSideTrusted.online, true, '配对完成后对方应显示本机在线')

    // 直连成功后可以正常走单播：授权读状态
    manualPeer.setPeerAccess(manualLocalStatus.device.deviceId, { allowStatus: true, allowFiles: false, allowTasks: false })
    const manualStatus = await manualLocal.remoteStatus(manualPeerStatus.device.deviceId)
    assert.equal(manualStatus.device.deviceId, manualPeerStatus.device.deviceId, '按 IP 直连后应能读取对方状态')

    // 错误配对码与非法地址都要被挡住
    await assert.rejects(() => manualLocal.pairByAddress({ address: '127.0.0.1', port: manualPeerStatus.device.port, code: `000000-${manualPeerStatus.pairingIdentityCode}` }), /配对码错误或已过期/)
    await assert.rejects(() => manualLocal.pairByAddress({ address: '8.8.8.8', port: 39072, code: '123456-A1B2C3D4E5F60718' }), /只能连接局域网地址/)
    await assert.rejects(() => manualLocal.pairByAddress({ address: '192.168.3.200', port: 1, code: '123456-A1B2C3D4E5F60718' }), /超时|ECONNREFUSED|EHOSTUNREACH|EHOSTDOWN|fetch failed/)
  } finally {
    await Promise.allSettled([manualPeer.shutdown(), manualLocal.shutdown()])
    fs.rmSync(manualRoot, { recursive: true, force: true })
  }

  console.log(JSON.stringify({ ok: true, discovery: true, wrongCodeRejected: true, paired: true, heartbeat: true, disconnect: true, reconnect: true, unpair: true, revokedTokenRejected: true, crossPlatform: true, remoteReadPairedOnly: true, remoteDataContent: true, remoteDataRedaction: true, remoteTaskShared: true, remoteTaskValidated: true, ipc: true, preload: true, settingsUi: true, manualPairByAddress: true, stableHttpPort: true, activeScanFindsDevices: true, scanOnEnableOnly: true }))
} finally {
  await Promise.allSettled([serviceA.shutdown(), serviceB.shutdown()])
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
