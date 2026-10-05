import dns from 'node:dns/promises'
import net from 'node:net'

function privateIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

function privateAddress(address) {
  if (net.isIPv4(address)) return privateIpv4(address)
  if (!net.isIPv6(address)) return true
  const value = address.toLowerCase()
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.')
}

async function validatedPublicUrl(value, { allowPrivate = false } = {}) {
  let url
  try { url = new URL(String(value || '').trim()) }
  catch { throw new Error('请输入完整的 http:// 或 https:// 网页地址。') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('浏览器只允许打开 HTTP 或 HTTPS 网页。')
  if (!url.hostname) throw new Error('网页地址缺少主机名。')
  if (!allowPrivate && ['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) throw new Error('为保护本机数据，Agent 浏览器不能访问本机或局域网地址。')
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true })
  if (!addresses.length || (!allowPrivate && addresses.some((item) => privateAddress(item.address)))) throw new Error('为保护本机数据，Agent 浏览器不能访问本机、局域网或保留地址。')
  url.username = ''
  url.password = ''
  return url.toString()
}

export { privateAddress, validatedPublicUrl }
