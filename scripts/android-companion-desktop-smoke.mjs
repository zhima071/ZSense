import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { DeviceLinkService, canonicalLanEndpoint } from '../electron/services/device-link-service.mjs'

class Vault {
  values = new Map()
  get(key) { return { ...(this.values.get(key) || {}) } }
  set(key, next) { this.values.set(key, { ...this.get(key), ...next }) }
  delete(key) { this.values.delete(key) }
}

const post = (port, route, body, secret = '') => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body)
  const request = https.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', rejectUnauthorized: false,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  }, (response) => {
    let data = ''
    response.on('data', (part) => { data += part })
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }))
  })
  request.on('error', reject)
  request.end(payload)
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-android-companion-'))
fs.mkdirSync(path.join(root, 'device-link'), { recursive: true })
fs.writeFileSync(path.join(root, 'device-link', 'state.json'), JSON.stringify({ remote: { deviceId: 'desk1234', hubBound: true } }))
const desktop = new DeviceLinkService({ rootPath: root, secrets: new Vault(), platform: 'darwin', hostname: 'Desktop', discoveryPort: 39871,
  remoteTaskRunner: { async run({ prompt }) { return { output: `桌面收到：${prompt}` } } },
})
desktop.appLockProvider = () => true
try {
  await desktop.setEnabled(true)
  const local = desktop.inspect()
  const key = generateKeyPairSync('ed25519')
  const secret = 'android-companion-secret-32-bytes-long'
  const pair = await post(local.device.port, '/v1/pair', {
    code: local.pairingCode,
    sharedSecret: secret,
    peer: { deviceId: 'android-phone', remoteDeviceId: 'phone123', name: 'ZSense Android', platform: 'android', port: 39072,
      identityPublicKey: key.publicKey.export({ format: 'pem', type: 'spki' }) },
  })
  assert.equal(pair.status, 200)
  assert.equal(desktop.inspect().trustedPeers[0].platform, 'android')
  assert.equal(desktop.inspect().trustedPeers[0].online, true)
  desktop.webBridgeInfoProvider = () => ({ port: 39073, fingerprint: 'A'.repeat(64) })
  assert.equal((await post(local.device.port, '/v1/resolve', { nonce: 'bad' })).status, 400)
  const endpointNonce = randomBytes(32).toString('base64url')
  const endpoint = await post(local.device.port, '/v1/resolve', { nonce: endpointNonce })
  assert.equal(endpoint.status, 200)
  const endpointBody = endpoint.body
  assert.equal(endpointBody.device.remoteDeviceId, 'desk1234')
  assert.equal(verify(null, Buffer.from(canonicalLanEndpoint({ nonce: endpointNonce, remoteDeviceId: 'desk1234', deviceId: endpointBody.device.deviceId, webBridgePort: endpointBody.webBridge.port, webBridgeFingerprint: endpointBody.webBridge.fingerprint })),
    endpointBody.device.identityPublicKey, Buffer.from(endpointBody.signature, 'base64url')), true, '安卓端只能接受已绑定公钥签出的局域网证书指纹')
  assert.equal((await post(local.device.port, '/v1/ping', { deviceId: 'android-phone' }, 'wrong-secret')).status, 401)
  const ping = await post(local.device.port, '/v1/ping', { deviceId: 'android-phone' }, secret)
  assert.equal(ping.body.webBridge.fingerprint, 'A'.repeat(64), '仅授权设备可获取 Web 证书指纹')
  assert.equal((await post(local.device.port, '/v1/run', { deviceId: 'android-phone', prompt: '整理日程' }, 'wrong-secret')).status, 401)
  assert.equal((await post(local.device.port, '/v1/run', { deviceId: 'android-phone', prompt: '整理日程' }, secret)).status, 403,
    'mobile pairing must not grant remote task permission')
  desktop.setPeerAccess('android-phone', { allowTasks: true })
  const result = await post(local.device.port, '/v1/run', { deviceId: 'android-phone', prompt: '整理日程' }, secret)
  assert.equal(result.status, 200)
  assert.match(result.body.result.output, /整理日程/)
  await new Promise((resolve) => setTimeout(resolve, 6_500))
  assert.equal(desktop.inspect().trustedPeers[0].online, true, 'desktop must not ping the client-only mobile device')
  console.log(JSON.stringify({ ok: true, androidPairing: true, permissionIsolation: true, remoteTask: true, clientOnlyHeartbeat: true }))
} finally {
  await desktop.shutdown()
  fs.rmSync(root, { recursive: true, force: true })
}
