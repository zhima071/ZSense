import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { canonicalHubMessage, DeviceLinkService } from '../electron/services/device-link-service.mjs'

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-client-hub-'))
const challenges = new Map()
const mutations = []
let registrationGate = null
let releaseRegistrationResponse
const assignedDeviceId = 'hub00001'
const otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })

const readBody = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
const send = (response, status, payload) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

const hub = http.createServer(async (request, response) => {
  try {
    const body = await readBody(request)
    if (request.url === '/__hub/challenge') {
      if (body.deviceId === 'legacyid') return send(response, 409, { ok: false, code: 'migration-required', error: '旧设备号需要绑定设备公钥。' })
      const challenge = {
        action: body.action,
        challengeId: randomUUID(),
        nonce: randomBytes(32).toString('base64url'),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        deviceId: body.deviceId || assignedDeviceId,
        publicKey: body.publicKey,
      }
      challenges.set(challenge.challengeId, challenge)
      return send(response, 200, { ok: true, data: challenge })
    }
    const action = new Map([
      ['/__hub/register', 'register'],
      ['/__hub/heartbeat', 'heartbeat'],
      ['/__hub/upstream', 'update-upstream'],
      ['/__hub/offline', 'offline'],
      ['/__hub/revoke', 'revoke'],
      ['/__hub/account/bind', 'account-bind'],
      ['/__hub/account/peers', 'account-peers'],
    ]).get(request.url)
    if (!action) return send(response, 404, { ok: false, error: 'missing' })
    const challenge = challenges.get(body.challengeId)
    challenges.delete(body.challengeId)
    assert(challenge, 'client used a missing/replayed hub challenge')
    assert.equal(body.action, action)
    assert.equal(body.deviceId, challenge.deviceId)
    assert.equal(body.nonce, challenge.nonce)
    assert.equal(body.expiresAt, challenge.expiresAt)
    assert(!Object.hasOwn(body, 'emailHash'), 'client must not send self-asserted emailHash')
    assert.equal(
      verify(null, Buffer.from(canonicalHubMessage(body)), createPublicKey(body.publicKey), Buffer.from(body.signature, 'base64url')),
      true,
      'client hub mutation must carry a valid Ed25519 signature',
    )
    if (action === 'account-bind') assert.equal(body.code, '123456')
    mutations.push({ action, deviceId: body.deviceId, upstream: body.upstream })
    if (action === 'register' && body.upstream === 'https://client-1.trycloudflare.com' && registrationGate) {
      registrationGate.received = true
      await registrationGate.response
    }
    return send(response, 200, { ok: true, data: { deviceId: body.deviceId, online: !['offline', 'revoke'].includes(action), peers: action === 'account-peers' ? [{ deviceId: 'hub00002', name: 'Windows', identityPublicKey: otherKey, online: true, lastSeenAt: new Date().toISOString() }] : [] } })
  } catch (error) {
    return send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve))
const hubPort = hub.address().port
const stateDirectory = path.join(root, 'device-link')
fs.mkdirSync(stateDirectory, { recursive: true })
fs.writeFileSync(path.join(stateDirectory, 'state.json'), JSON.stringify({ remote: { enabled: false, hubUrl: `http://127.0.0.1:${hubPort}`, upstreamMode: 'auto' } }))

const children = []
const spawnProcess = () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    if (child.killed) return
    child.killed = true
    queueMicrotask(() => child.emit('exit', 0))
  }
  children.push(child)
  const number = children.length
  setTimeout(() => child.stderr.write(`INF quick tunnel https://client-${number}.trycloudflare.com\n`), 20)
  return child
}

const waitFor = async (predicate, message, timeoutMs = 8_000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${message}; mutations=${JSON.stringify(mutations)}; remote=${JSON.stringify(service?.inspect?.().remote || {})}`)
}

const service = new DeviceLinkService({ rootPath: root, secrets: new TestVault(), hostname: 'Hub Client', discoveryPort: 39871, discoveryAddress: '239.255.90.98', spawnProcess, detectLocalHub: false })
service.appLockProvider = () => false
service.localBridgePort = 39073
let revokedRemoteSessions = 0
service.onRemoteDisabled = () => { revokedRemoteSessions += 1 }

try {
  const pendingTunnelRoot = path.join(root, 'pending-tunnel')
  const pendingTunnelState = path.join(pendingTunnelRoot, 'device-link')
  fs.mkdirSync(pendingTunnelState, { recursive: true })
  fs.writeFileSync(path.join(pendingTunnelState, 'state.json'), JSON.stringify({ remote: { enabled: true, hubUrl: `http://127.0.0.1:${hubPort}`, upstreamMode: 'auto' } }))
  const pendingTunnel = new DeviceLinkService({ rootPath: pendingTunnelRoot, secrets: new TestVault(), hostname: 'Pending Tunnel', detectLocalHub: false })
  pendingTunnel.appLockProvider = () => false
  try {
    const identity = await pendingTunnel.refreshRemoteIdentity({ requireRegistration: true })
    assert.equal(identity.remote.deviceId, assignedDeviceId, 'identity registration must succeed before the outbound tunnel is ready')
    assert(identity.remote.registeredAt, 'offline identity registration must be visible to email binding')
    assert(mutations.some((entry) => entry.action === 'register' && entry.upstream === ''), 'pending tunnel must register a signed offline device')
  } finally { await pendingTunnel.shutdown() }

  const legacyRoot = path.join(root, 'legacy-client')
  const legacyState = path.join(legacyRoot, 'device-link')
  fs.mkdirSync(legacyState, { recursive: true })
  fs.writeFileSync(path.join(legacyState, 'state.json'), JSON.stringify({ remote: { enabled: false, deviceId: 'legacyid', hubBound: true, hubUrl: `http://127.0.0.1:${hubPort}` } }))
  const legacyClient = new DeviceLinkService({ rootPath: legacyRoot, secrets: new TestVault(), hostname: 'Legacy Client', detectLocalHub: false })
  try {
    await assert.rejects(legacyClient.refreshRemoteIdentity({ requireRegistration: true }), /旧设备号需要绑定设备公钥/)
  } finally { await legacyClient.shutdown() }

  // A server-side mutation log is written before the HTTP reply. Hold that
  // reply deterministically: observing receipt alone must not be mistaken for
  // a completed client registration (the old assertion raced this boundary).
  registrationGate = { received: false, response: new Promise((resolve) => { releaseRegistrationResponse = resolve }) }
  await service.setRemoteEnabled(true)
  assert.equal(service.inspect().remote.deviceLockEnabled, false, '未开启安全锁时也应允许远程连接')
  await waitFor(() => mutations.some((entry) => entry.action === 'register' && entry.upstream === 'https://client-1.trycloudflare.com'), 'first signed registration did not reach hub')
  assert.equal(registrationGate.received, true)
  assert.equal(service.inspect().remote.deviceId, '', 'client must not accept an id before the signed registration response is received and checked')
  releaseRegistrationResponse()
  await waitFor(() => service.inspect().remote.deviceId === assignedDeviceId && Boolean(service.inspect().remote.registeredAt), 'client did not acknowledge and persist the completed hub registration')
  assert.equal(service.inspect().remote.deviceId, assignedDeviceId, 'client must persist the id allocated by the hub')
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDirectory, 'state.json'), 'utf8')).remote.deviceId, assignedDeviceId, 'allocated hub identity must also be persisted to disk')
  assert.equal(service.inspect().remote.publicUrl, `https://${assignedDeviceId}.zsense.space`, 'public device URL must be derived from the hub root domain')
  assert.equal(service.inspect().remote.url, `https://${assignedDeviceId}.zsense.space`, 'active remote URL must not use the legacy app.zsense.space bypass')
  await service.bindVerifiedEmail('owner@example.com', '123456')
  const autoPeer = service.inspect().trustedPeers.find((peer) => peer.remoteDeviceId === 'hub00002')
  assert(autoPeer, 'Hub-verified same-account device should become trusted automatically')
  assert.deepEqual(autoPeer.access, { allowStatus: false, allowFiles: false, allowTasks: false }, 'automatic trust must not grant remote read or execute permissions')
  assert.equal(service.inspect().remote.accountVerified, true)
  await service.unpair('hub00002')
  await service.syncAccountPeers()
  assert.equal(service.inspect().trustedPeers.some((peer) => peer.remoteDeviceId === 'hub00002'), false, 'local revocation must not be undone by the next sync')
  const heartbeatsBefore = mutations.filter((entry) => entry.action === 'heartbeat').length
  const peerSyncsBefore = mutations.filter((entry) => entry.action === 'account-peers').length
  await waitFor(() => mutations.filter((entry) => entry.action === 'heartbeat').length > heartbeatsBefore, '3-second public heartbeat did not reach the hub', 5_000)
  assert.equal(mutations.filter((entry) => entry.action === 'account-peers').length, peerSyncsBefore, 'faster heartbeat must not multiply account peer syncs')

  children[0].emit('exit', 1)
  await waitFor(() => mutations.some((entry) => entry.action === 'offline'), 'tunnel loss did not immediately send a signed offline mutation')
  assert(revokedRemoteSessions >= 1, 'tunnel loss must revoke remote web sessions')
  await waitFor(() => children.length >= 2, 'tunnel process was not restarted after disconnect')
  await waitFor(() => mutations.some((entry) => entry.action === 'update-upstream' && entry.upstream === 'https://client-2.trycloudflare.com'), 'reconnected tunnel did not update its upstream with a signature')

  await service.setRemoteEnabled(false)
  assert.equal(mutations.at(-1).action, 'offline', 'turning remote access off must stop hub routing')
  console.log(JSON.stringify({ ok: true, hubAssignedId: true, registrationResponseAcknowledged: true, ed25519SignedMutations: true, pendingTunnelRegistersOffline: true, registrationErrorSurfaced: true, verifiedAccountAutoTrust: true, revokedPeerStaysBlocked: true, tunnelDisconnectOffline: true, tunnelReconnectUpdatesUpstream: true }))
} finally {
  releaseRegistrationResponse?.()
  await service.shutdown()
  await new Promise((resolve) => hub.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
}
