import fs from 'node:fs'
import path from 'node:path'

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export class SecretsVault {
  constructor(userDataDirectory, safeStorage) {
    this.filePath = path.join(userDataDirectory, 'zsense-secrets.json')
    this.safeStorage = safeStorage
    this.values = readJson(this.filePath)
  }

  #assertAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable()) {
      throw new Error('系统安全存储暂不可用，无法安全保存 API 密钥或机器人凭证。')
    }
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.values, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporaryPath, this.filePath)
    try { fs.chmodSync(this.filePath, 0o600) } catch { /* Windows ACLs are managed by the OS. */ }
  }

  get(scope) {
    const encrypted = this.values[scope]
    if (!encrypted) return {}
    this.#assertAvailable()
    try {
      const decrypted = this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      const parsed = JSON.parse(decrypted)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      throw new Error(`无法解密 ${scope} 的本地凭证，请重新填写并保存。`)
    }
  }

  set(scope, updates, clearKeys = []) {
    this.#assertAvailable()
    const current = this.get(scope)
    for (const key of clearKeys) delete current[key]
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value === 'string' && value.trim()) current[key] = value.trim()
    }
    if (Object.keys(current).length) {
      this.values[scope] = this.safeStorage.encryptString(JSON.stringify(current)).toString('base64')
    } else {
      delete this.values[scope]
    }
    this.#persist()
    return current
  }

  delete(scope) {
    if (!Object.prototype.hasOwnProperty.call(this.values, scope)) return
    delete this.values[scope]
    this.#persist()
  }

  has(scope, key) {
    try { return Boolean(this.get(scope)[key]) } catch { return false }
  }

  keys(scope) {
    try { return Object.keys(this.get(scope)) } catch { return [] }
  }

  status() {
    return {
      available: Boolean(this.safeStorage?.isEncryptionAvailable()),
      backend: process.platform === 'darwin' ? 'macOS Keychain' : process.platform === 'win32' ? 'Windows DPAPI' : '系统密钥环',
      filePath: this.filePath,
    }
  }
}
