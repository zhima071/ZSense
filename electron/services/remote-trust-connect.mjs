import { createHash, randomBytes } from 'node:crypto'
import https from 'node:https'
import tls from 'node:tls'
import { isGlobalIpv6Address, isPrivateNetworkAddress } from './device-link-service.mjs'

const REQUEST_TIMEOUT_MS = 8_000
const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,58}$/

/** 只在已验签的直连端点上使用；先固定证书指纹，再发送设备签名。 */
export function createPinnedLanFetch(fingerprint, { maxResponseBytes = 64 * 1024 } = {}) {
  const expected = String(fingerprint || '').replace(/:/g, '').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(expected)) throw new Error('设备直连证书指纹无效。')
  return async (url, options = {}) => {
    const target = new URL(url)
    const host = target.hostname.replace(/^\[|\]$/g, '')
    if (target.protocol !== 'https:' || !(isPrivateNetworkAddress(host) || isGlobalIpv6Address(host)) || !Number.isInteger(Number(target.port)) || !target.port) throw new Error('设备直连地址无效。')
    const signal = options.signal
    const socket = tls.connect({ host, port: Number(target.port), rejectUnauthorized: false })
    try {
      await new Promise((resolve, reject) => {
        const abort = () => { socket.destroy(); reject(signal?.reason || new Error('设备直连已取消。')) }
        if (signal?.aborted) return abort()
        signal?.addEventListener('abort', abort, { once: true })
        socket.once('error', reject)
        socket.once('secureConnect', () => {
          signal?.removeEventListener('abort', abort)
          socket.removeListener('error', reject)
          const actual = String(socket.getPeerCertificate()?.fingerprint256 || '').replace(/:/g, '').toUpperCase()
          if (actual !== expected) return reject(new Error('设备直连证书与已验证身份不一致。'))
          resolve()
        })
      })
      return await new Promise((resolve, reject) => {
        const request = https.request({
          hostname: host, port: Number(target.port), path: `${target.pathname}${target.search}`,
          method: options.method || 'POST', headers: { ...options.headers, host: target.host,
            ...(options.body ? { 'content-length': Buffer.byteLength(options.body) } : {}) },
          agent: false, createConnection: () => socket,
        }, (response) => {
          const chunks = []
          let bytes = 0
          response.on('data', (chunk) => {
            bytes += chunk.length
            if (bytes > maxResponseBytes) request.destroy(new Error('设备直连响应过大。'))
            else chunks.push(chunk)
          })
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => JSON.parse(body) })
          })
        })
        const abort = () => request.destroy(signal?.reason || new Error('局域网连接已取消。'))
        if (signal?.aborted) return abort()
        signal?.addEventListener('abort', abort, { once: true })
        request.once('close', () => signal?.removeEventListener('abort', abort))
        request.once('error', reject)
        request.end(options.body || '')
      })
    } catch (error) {
      socket.destroy()
      throw error
    }
  }
}

export function fastTrustDigest(deviceId, issuedAt, nonce) {
  return createHash('sha256')
    .update(`zsense-trust-v2\nPOST\n/bridge/trust-challenge\n${deviceId}\n${issuedAt}\n${nonce}`)
    .digest('base64url')
}

export async function connectTrustedRemote({ origin, ownId, targetId, signChallenge, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!DEVICE_ID_PATTERN.test(ownId) || !DEVICE_ID_PATTERN.test(targetId)) throw new Error('设备号格式不正确。')
  if (typeof signChallenge !== 'function') throw new Error('本机设备签名不可用。')
  const endpoint = new URL(origin)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('远程设备地址无效。')

  const request = async (route, headers) => {
    const response = await fetchImpl(`${endpoint.origin}${route}`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const result = await response.json().catch(() => null)
    return { response, result }
  }
  const accepted = ({ response, result }) => {
    if (!response.ok || result?.ok === false) throw new Error(result?.error || `对方设备返回 HTTP ${response.status}。`)
    const entryPath = String(result?.data?.entryPath || '')
    if (!/^\/bridge\/enter\?ticket=[A-Za-z0-9_-]{20,160}$/.test(entryPath)) throw new Error('对方没有返回有效的一次性入场票据。')
    return { url: `${endpoint.origin}${entryPath}`, deviceId: targetId, directCandidates: result?.data?.directCandidates || null }
  }

  const issuedAt = Date.now()
  const nonce = randomBytes(32).toString('base64url')
  const signature = signChallenge(targetId, fastTrustDigest(ownId, issuedAt, nonce))
  // 新设备在原挑战接口直接返回票据；旧设备忽略额外签名头并返回挑战，
  // 因而旧版也始终只需原来的两次请求，不会多花一次公网往返。
  const first = await request('/bridge/trust-challenge', {
    'x-zsense-device': ownId,
    'x-zsense-nonce': nonce,
    'x-zsense-issued-at': String(issuedAt),
    'x-zsense-signature': signature,
  })
  if (!first.response.ok || first.result?.ok === false) throw new Error(first.result?.error || '对方拒绝了设备密钥验证。')
  if (first.result?.data?.entryPath) return accepted(first)
  const challengeNonce = String(first.result?.data?.nonce || '')
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(challengeNonce)) throw new Error('对方没有返回有效的身份挑战。')
  return accepted(await request('/bridge/trust-ticket', {
    'x-zsense-device': ownId,
    'x-zsense-nonce': challengeNonce,
    'x-zsense-signature': signChallenge(targetId, challengeNonce),
  }))
}
