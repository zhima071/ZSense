import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,40}$/
const MAX_ATTEMPTS = 5
const LOCK_DURATION_MS = 30_000
const LOCAL_OWNER_USERNAME = 'local.owner'

function normalizeUsername(value) {
  return String(value || '').trim()
}

function validateUsername(username) {
  const normalized = normalizeUsername(username)
  if (!USERNAME_PATTERN.test(normalized)) throw new Error('用户名需为 3–40 位，只能包含字母、数字、点、下划线或短横线。')
  return normalized
}

function validateDisplayName(value) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 80) throw new Error('显示名称需为 1–80 个字符。')
  return normalized
}

function validateLockPassword(value) {
  const password = String(value || '')
  if (password.length < 4 || password.length > 128) {
    throw new Error('安全锁密码至少 4 位，最多 128 位。')
  }
  return password
}

function passwordDigest(password, salt) {
  return scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

function createCredentials(password) {
  const passwordSalt = randomBytes(16).toString('hex')
  return { passwordSalt, passwordHash: passwordDigest(password, passwordSalt).toString('hex') }
}

function passwordMatches(password, passwordHash, passwordSalt) {
  try {
    const expected = Buffer.from(passwordHash, 'hex')
    const actual = passwordDigest(password, passwordSalt)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export class AuthService {
  constructor(database) {
    this.database = database
    this.sessions = new Map()
    this.unlockedSenders = new Set()
    this.failures = new Map()
    this.ownerId = this.#ensureLocalOwner()
  }

  #ensureLocalOwner() {
    const users = this.database.listUsers()
    let owner = users.find((user) => user.enabled && user.role === 'admin') || users.find((user) => user.enabled) || users[0]
    if (!owner) {
      const createdAt = new Date().toISOString()
      owner = this.database.createUser({
        id: randomUUID(), username: LOCAL_OWNER_USERNAME, displayName: '本机用户', role: 'admin', enabled: true, createdAt,
        ...createCredentials(randomBytes(32).toString('base64url')),
      })
      this.database.updateSettings({ appLockEnabled: false, appLockPasswordConfigured: false })
      return owner.id
    }
    if (!owner.enabled || owner.role !== 'admin') {
      owner = this.database.updateUser(owner.id, {
        username: owner.username,
        displayName: owner.displayName,
        role: 'admin',
        enabled: true,
        updatedAt: new Date().toISOString(),
      })
    }
    if (this.database.getSetting('appLockPasswordConfigured') === undefined) {
      this.database.updateSettings({ appLockPasswordConfigured: true })
    }
    return owner.id
  }

  status(senderId) {
    const user = this.database.getUserById(this.ownerId)
    if (!user?.enabled) throw new Error('本机用户不可用，请重新启动 ZSense。')
    this.sessions.set(senderId, user.id)
    const settings = this.database.loadSettings()
    if (!settings.appLockEnabled) this.unlockedSenders.add(senderId)
    const locked = Boolean(settings.appLockEnabled && !this.unlockedSenders.has(senderId))
    return { setupRequired: false, authenticated: true, locked, user }
  }

  lock(senderId) {
    const status = this.status(senderId)
    if (!status.user) throw new Error('本机用户不可用。')
    this.unlockedSenders.delete(senderId)
    return this.status(senderId)
  }

  /**
   * 远程入口用：只校验设备锁密码，不改变任何本机解锁状态。
   * 与 unlock 共用同一套失败限速（MAX_ATTEMPTS / LOCK_DURATION_MS）。
   */
  verifyAppLock(password) {
    const settings = this.database.loadSettings()
    if (!settings.appLockEnabled) return { ok: false, code: 'app-lock-disabled', error: '设备锁未开启，远程连接不可用。' }
    if (!settings.appLockPasswordConfigured) return { ok: false, code: 'app-lock-unconfigured', error: '设备锁还没有设置密码。' }
    const key = 'remote-unlock'
    const failure = this.failures.get(key)
    const now = Date.now()
    if (failure?.lockedUntil > now) {
      const seconds = Math.max(1, Math.ceil((failure.lockedUntil - now) / 1000))
      return { ok: false, code: 'rate-limited', error: `尝试次数过多，请在 ${seconds} 秒后重试。` }
    }
    // 远程入口接受本机任意一个用户（不止第一个）的密码，并记录是谁进来的
    const users = this.database.listUsers() || []
    const raw = String(password || '').slice(0, 128)
    let matched = null
    for (const candidate of users) {
      const stored = this.database.getUserByUsername(candidate.username, true)
      if (stored && passwordMatches(raw, stored.passwordHash || '', stored.passwordSalt || '')) { matched = stored; break }
    }
    const ok = Boolean(matched)
    if (!ok) {
      const attempts = (failure?.attempts || 0) + 1
      this.failures.set(key, { attempts: attempts >= MAX_ATTEMPTS ? 0 : attempts, lockedUntil: attempts >= MAX_ATTEMPTS ? now + LOCK_DURATION_MS : 0 })
      return { ok: false, code: 'bad-password', error: attempts >= MAX_ATTEMPTS ? '尝试次数过多，已暂时锁定 30 秒。' : '设备锁密码不正确。' }
    }
    this.failures.delete(key)
    return { ok: true, user: { id: matched.id, username: matched.username, displayName: matched.displayName || matched.username } }
  }

  unlock(senderId, input) {
    const status = this.status(senderId)
    if (!status.authenticated || !status.user) throw new Error('本机用户不可用。')
    if (!status.locked) return status
    const settings = this.database.loadSettings()
    if (!settings.appLockPasswordConfigured) throw new Error('安全锁尚未设置密码，请先关闭安全锁并重新启动。')
    const key = `unlock:${status.user.id}`
    const failure = this.failures.get(key)
    const now = Date.now()
    if (failure?.lockedUntil > now) {
      const seconds = Math.max(1, Math.ceil((failure.lockedUntil - now) / 1000))
      throw new Error(`解锁尝试过多，请在 ${seconds} 秒后重试。`)
    }
    const stored = this.database.getUserByUsername(status.user.username, true)
    if (!passwordMatches(String(input?.password || ''), stored?.passwordHash || '', stored?.passwordSalt || '')) {
      const attempts = (failure?.attempts || 0) + 1
      this.failures.set(key, { attempts: attempts >= MAX_ATTEMPTS ? 0 : attempts, lockedUntil: attempts >= MAX_ATTEMPTS ? now + LOCK_DURATION_MS : 0 })
      throw new Error(attempts >= MAX_ATTEMPTS ? '解锁尝试过多，安全锁已暂时锁定 30 秒。' : '密码不正确。')
    }
    this.failures.delete(key)
    this.unlockedSenders.add(senderId)
    return this.status(senderId)
  }

  /** 已绑定的邮箱（仅主进程内部使用，不下发给界面） */
  boundEmail() {
    return String(this.database.getUserById(this.ownerId)?.email || '')
  }

  /** 界面可见的邮箱状态：只给掩码，不暴露完整地址 */
  emailStatus() {
    const email = this.boundEmail()
    return { bound: Boolean(email), masked: maskEmail(email) }
  }

  /** 邮箱指纹：只用来判断"是不是同一个邮箱"，不暴露邮箱本身 */
  emailHash() {
    const email = normalizeEmail(this.boundEmail())
    if (!email) return ''
    return createHash('sha256').update(`zsense-email:${email}`).digest('hex').slice(0, 32)
  }

  setEmail(senderId, input) {
    const user = this.requireUser(senderId)
    const email = validateEmail(input?.email)
    this.database.updateUserEmail(user.id, email)
    return this.status(senderId)
  }

  /**
   * 用邮箱重置安全锁密码。前提：调用方（主进程 IPC）已经拿交换中心验证过邮箱验证码；
   * 这里再核对一次「必须是已绑定的那个邮箱」，避免绕过验证码直接改密码。
   */
  resetLockPassword(senderId, input) {
    const user = this.database.getUserById(this.ownerId)
    if (!user) throw new Error('本机用户不可用，请重新启动 ZSense。')
    const email = normalizeEmail(String(input?.email || ''))
    if (!user.email) throw new Error('还没有绑定邮箱，无法用邮箱重置。')
    if (!email || normalizeEmail(user.email) !== email) throw new Error('邮箱与已绑定的邮箱不一致。')
    const password = validateLockPassword(input?.password)
    const credentials = createCredentials(password)
    this.database.updateUserPassword(user.id, credentials.passwordHash, credentials.passwordSalt, new Date().toISOString())
    this.database.updateSettings({ appLockPasswordConfigured: true })
    this.failures.delete(`unlock:${user.id}`)
    this.unlockedSenders.add(senderId)
    return this.status(senderId)
  }

  /** 账号密码：专门用于「其它验证」（浏览器访问 / 远程登录），与安全锁密码互不影响 */
  accountPasswordConfigured() {
    return Boolean(this.database.getUserById(this.ownerId)?.accountPasswordConfigured)
  }

  setAccountPassword(senderId, input) {
    const user = this.requireUser(senderId)
    const password = validateLockPassword(input?.password)
    const credentials = createCredentials(password)
    this.database.updateUserAccountPassword(user.id, credentials.passwordHash, credentials.passwordSalt, new Date().toISOString())
    return { configured: true }
  }

  /**
   * 校验账号密码（不改变本机解锁状态）。
   * 没设过账号密码时返回 ok（等于不拦），与本机安全锁关掉时的放行逻辑保持一致。
   */
  verifyAccountPassword(password) {
    const provided = String(password || '')
    let configured = false
    for (const user of this.database.listUsers()) {
      const stored = this.database.getUserByUsername(user.username, true)
      if (!stored?.accountPasswordHash) continue
      configured = true
      if (passwordMatches(provided, stored.accountPasswordHash, stored.accountPasswordSalt)) {
        return { ok: true, user: { username: user.username, displayName: user.displayName } }
      }
    }
    if (!configured) return { ok: true, code: 'account-password-unconfigured', user: null }
    return { ok: false, code: 'bad-password', error: '账号密码不正确。' }
  }

  setLockPassword(senderId, input) {
    const user = this.requireUser(senderId)
    const password = validateLockPassword(input?.password)
    const credentials = createCredentials(password)
    this.database.updateUserPassword(user.id, credentials.passwordHash, credentials.passwordSalt, new Date().toISOString())
    this.database.updateSettings({ appLockPasswordConfigured: true })
    this.unlockedSenders.add(senderId)
    return this.status(senderId)
  }

  requireUser(senderId) {
    const status = this.status(senderId)
    if (!status.authenticated || !status.user) throw new Error('本机用户不可用。')
    if (status.locked) throw new Error('ZSense 已锁定，请先输入安全锁密码解锁。')
    return status.user
  }

  requireAdmin(senderId) {
    const user = this.requireUser(senderId)
    if (user.role !== 'admin') throw new Error('只有管理员可以管理用户。')
    return user
  }

  listUsers(senderId) {
    this.requireAdmin(senderId)
    return this.database.listUsers()
  }

  createUser(senderId, input) {
    this.requireAdmin(senderId)
    const username = validateUsername(input?.username)
    const displayName = validateDisplayName(input?.displayName)
    const role = input?.role === 'admin' ? 'admin' : 'member'
    const internalCredential = randomBytes(32).toString('base64url')
    return this.database.createUser({ id: randomUUID(), username, displayName, role, enabled: true, createdAt: new Date().toISOString(), ...createCredentials(internalCredential) })
  }

  updateUser(senderId, input) {
    const actor = this.requireAdmin(senderId)
    const userId = String(input?.id || '')
    if (!userId) throw new Error('用户 ID 无效。')
    const current = this.database.getUserById(userId)
    if (!current) throw new Error('用户不存在或已经被删除。')
    const enabled = input?.enabled === undefined ? current.enabled : Boolean(input.enabled)
    const role = input?.role === 'admin' ? 'admin' : 'member'
    if (actor.id === userId && (!enabled || role !== 'admin')) throw new Error('当前本机管理员不能停用自己或移除自己的管理员权限。')
    const updated = this.database.updateUser(userId, {
      username: validateUsername(input?.username ?? current.username),
      displayName: validateDisplayName(input?.displayName ?? current.displayName),
      role,
      enabled,
      updatedAt: new Date().toISOString(),
    })
    if (!updated.enabled) {
      for (const [sessionSenderId, sessionUserId] of this.sessions) {
        if (sessionUserId === updated.id) this.sessions.delete(sessionSenderId)
      }
    }
    return updated
  }

  deleteUser(senderId, userId) {
    const actor = this.requireAdmin(senderId)
    if (actor.id === userId) throw new Error('不能删除当前本机身份。')
    const users = this.database.deleteUser(userId)
    for (const [sessionSenderId, sessionUserId] of this.sessions) {
      if (sessionUserId === userId) this.sessions.delete(sessionSenderId)
    }
    return users
  }

  clear() {
    this.sessions.clear()
    this.unlockedSenders.clear()
    this.failures.clear()
  }
}


// 邮箱：绑定用（必须含 @ 与域名点号），以及展示用的掩码
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function validateEmail(value) {
  const email = String(value || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 160) throw new Error('邮箱格式看起来不对，请检查后重试。')
  return email
}

function maskEmail(value) {
  const email = String(value || '')
  const at = email.lastIndexOf('@')
  if (at <= 0) return ''
  const head = email.slice(0, 1)
  const name = email.slice(0, at)
  return `${head}${'*'.repeat(Math.max(2, Math.min(6, name.length - 1)))}${email.slice(at)}`
}
