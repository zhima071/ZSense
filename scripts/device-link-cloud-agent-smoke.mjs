import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DeviceLinkService } from '../electron/services/device-link-service.mjs'
import { WebBridgeService } from '../electron/services/web-bridge-service.mjs'

// 测试只连接本机的临时 HTTPS 服务；产品请求仍使用系统证书校验。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

class TestVault {
  values = new Map()
  get(scope) { return { ...(this.values.get(scope) || {}) } }
  set(scope, value) { this.values.set(scope, { ...this.get(scope), ...value }) }
  delete(scope) { this.values.delete(scope) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-cloud-agent-'))
const originalFetch = globalThis.fetch
let bridge
let deviceA
let deviceB
try {
  for (const [name, id] of [['a', 'mac00001'], ['b', 'win00002']]) {
    const folder = path.join(root, name, 'device-link')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify({ remote: { enabled: true, deviceId: id, hubBound: true } }))
  }
  let executed = 0
  deviceA = new DeviceLinkService({ rootPath: path.join(root, 'a'), secrets: new TestVault(), detectLocalHub: false })
  deviceB = new DeviceLinkService({
    rootPath: path.join(root, 'b'), secrets: new TestVault(), detectLocalHub: false,
    remoteTaskRunner: { run: async ({ prompt, peer }) => { executed += 1; return { output: `${peer.deviceId}: ${prompt}`, conversationId: 'agent-conversation' } } },
  })
  deviceA.appLockProvider = () => true
  deviceB.appLockProvider = () => true
  assert(deviceA.rememberRemotePeer('win00002', 'B', deviceB.identityPublicKey()))
  assert(deviceB.rememberRemotePeer('mac00001', 'A', deviceA.identityPublicKey()))

  const staticDirectory = path.join(root, 'dist')
  fs.mkdirSync(staticDirectory)
  fs.writeFileSync(path.join(staticDirectory, 'index.html'), '<html><head></head><body></body></html>')
  const port = await new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const number = probe.address().port
      probe.close(() => resolve(number))
    })
  })
  bridge = new WebBridgeService({ rootPath: path.join(root, 'b'), staticDirectory, preloadPath: path.resolve('electron/preload.cjs'), port, useHttps: false })
  bridge.deviceTrustVerifier = (id, nonce, signature) => deviceB.verifyRemoteChallenge(id, nonce, signature)
  bridge.remoteAgentTaskProvider = ({ deviceId, prompt, timeoutMs }) => deviceB.runTaskFromCloudPeer(deviceId, prompt, timeoutMs)
  await bridge.setEnabled(true)
  const localBase = `http://127.0.0.1:${bridge.inspect().port}`
  let loseSubmissionResponse = false
  globalThis.fetch = async (input, options) => {
    const url = String(input)
    const mapped = url.startsWith('https://win00002.zsense.space/bridge/') ? `${localBase}${new URL(url).pathname}` : input
    const response = await originalFetch(mapped, options)
    if (loseSubmissionResponse && new URL(String(mapped)).pathname === '/bridge/agent-task') {
      loseSubmissionResponse = false
      throw new TypeError('模拟提交成功但响应丢失')
    }
    return response
  }

  await assert.rejects(() => deviceA.runRemoteTask('win00002', '未授权任务', 10_000), /尚未获准/)
  assert.equal(executed, 0, '未授权任务绝不能到达 Agent 执行器')
  deviceB.setPeerAccess('mac00001', { allowStatus: false, allowFiles: false, allowTasks: true })
  const result = await deviceA.runRemoteTask('win00002', '整理资料', 10_000)
  assert.equal(result.output, 'mac00001: 整理资料')
  assert.equal(result.conversationId, 'agent-conversation')
  assert.equal(executed, 1, '云端任务必须仅执行一次')
  loseSubmissionResponse = true
  await assert.rejects(() => deviceA.runRemoteTask('win00002', '响应丢失的任务', 10_000), /提交结果不确定/)
  assert.equal(executed, 2, '提交响应丢失时不能自动重放任务')
  console.log(JSON.stringify({ ok: true, cloudAgentTask: true, receivingPermissionRequired: true, signedShortRequests: true, onceOnly: true }))
} finally {
  globalThis.fetch = originalFetch
  await bridge?.shutdown()
  if (deviceA) deviceA.state.remote.hubBound = false
  if (deviceB) deviceB.state.remote.hubBound = false
  await deviceA?.shutdown()
  await deviceB?.shutdown()
  fs.rmSync(root, { recursive: true, force: true })
}
process.exit(0)
