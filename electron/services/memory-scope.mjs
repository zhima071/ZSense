import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const digest = (value) => createHash('sha256').update(value).digest('hex')

// Only trusted entry points build these keys. Model arguments never select an owner.
export function createMemoryScope({ channel = 'local', connectionId = '', userId = '', peerId = '', workspacePath = '' } = {}) {
  let ownerKey = 'local'
  if (channel === 'gateway') {
    if (!connectionId || !userId) throw new Error('渠道记忆缺少已验证的用户归属。')
    ownerKey = `gateway:${digest(JSON.stringify([connectionId, userId]))}`
  } else if (channel === 'peer') {
    if (!peerId) throw new Error('远程记忆缺少已验证的设备归属。')
    ownerKey = `peer:${digest(String(peerId))}`
  }
  let projectKey = ''
  if (workspacePath) {
    const resolved = path.resolve(workspacePath)
    let canonical = resolved
    try { canonical = fs.realpathSync.native(resolved) } catch { /* Stable absolute path until created. */ }
    projectKey = `project:${digest(process.platform === 'win32' ? canonical.toLowerCase() : canonical)}`
  }
  return { ownerKey, projectKey }
}

export function normalizeMemoryScope(options = {}) {
  const ownerKey = String(options.ownerKey || 'local')
  const projectKey = String(options.projectKey || '')
  if (!/^(?:local|legacy-unattributed|gateway:[a-f0-9]{64}|peer:[a-f0-9]{64})$/u.test(ownerKey)) throw new Error('记忆用户归属无效。')
  if (projectKey && !/^project:[a-f0-9]{64}$/u.test(projectKey)) throw new Error('记忆项目归属无效。')
  return { ownerKey, projectKey }
}
