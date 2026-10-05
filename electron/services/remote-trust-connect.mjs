import { createHash, randomBytes } from 'node:crypto'

const REQUEST_TIMEOUT_MS = 8_000
const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,58}$/

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
    return { url: `${endpoint.origin}${entryPath}`, deviceId: targetId }
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
