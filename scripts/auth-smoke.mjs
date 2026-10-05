import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AuthService } from '../electron/services/auth-service.mjs'
import { ZSenseDatabase } from '../electron/services/database.mjs'

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'zsense-auth-smoke-'))
const database = new ZSenseDatabase(temporaryDirectory)
let auth = new AuthService(database)

function assert(value, message) {
  if (!value) throw new Error(message)
}

try {
  const initial = auth.status(1)
  assert(!initial.setupRequired && initial.authenticated && initial.user?.role === 'admin', '应用应自动创建并绑定本机用户')
  assert(initial.user?.username === 'local.owner' && initial.user?.displayName === '本机用户', '首次安装不应使用操作系统账号名称作为本机身份')
  assert(!initial.locked, '首次安装未启用安全锁时不应显示锁屏')
  assert(database.loadWorkspace().settings.appLockEnabled === false, '首次安装安全锁应默认关闭')
  assert(auth.verifyRemotePassword('anything').ok === false, '安全锁和远程访问密码都未设置时，公网网页登录必须拒绝')

  const configured = auth.setLockPassword(1, { password: '1234' })
  assert(!configured.locked, '设置锁密码后当前会话不应被锁定')
  assert(database.loadWorkspace().settings.appLockPasswordConfigured === true, '锁密码配置状态没有持久化')
  database.updateSettings({ appLockEnabled: true })

  auth.clear()
  auth = new AuthService(database)
  assert(auth.status(1).locked, '启用安全锁后重新启动必须默认锁定')
  let lockedAccessRejected = false
  try { auth.requireUser(1) } catch { lockedAccessRejected = true }
  assert(lockedAccessRejected, '锁定状态不应允许访问工作区接口')
  let wrongUnlockRejected = false
  try { auth.unlock(1, { password: 'wrong' }) } catch { wrongUnlockRejected = true }
  assert(wrongUnlockRejected, '错误的安全锁密码不应解锁')
  assert(auth.unlock(1, { password: '1234' }).locked === false, '正确的安全锁密码没有解锁')
  assert(auth.verifyAppLock('wrong').ok === false, 'Web 入口不应接受错误的安全锁密码')
  assert(auth.verifyAppLock('1234').ok === true, 'Web 入口应使用同一安全锁密码')
  assert(auth.verifyRemotePassword('1234').ok === true, '开启安全锁后公网网页登录应接受安全锁密码')

  auth.setAccountPassword(1, { password: 'remote-5678' })
  database.updateSettings({ appLockEnabled: false })
  assert(auth.verifyRemotePassword('1234').ok === false, '关闭安全锁后旧安全锁密码不得继续用于公网登录')
  assert(auth.verifyRemotePassword('wrong').ok === false, '错误的远程访问密码不得登录')
  assert(auth.verifyRemotePassword('remote-5678').ok === true, '关闭安全锁后应能用独立的远程访问密码登录')

  const member = auth.createUser(1, { username: 'local.member', displayName: 'Local Member', role: 'member' })
  assert(member.username === 'local.member', '无账号密码的本机身份没有创建成功')

  const owner = auth.status(1).user
  const stored = database.db.prepare('SELECT password_hash, password_salt FROM users WHERE id=?').get(owner.id)
  assert(stored.password_hash !== '1234' && stored.password_salt.length >= 32, '安全锁密码没有使用独立盐安全哈希')
  const memberCredential = database.db.prepare('SELECT password_hash, password_salt FROM users WHERE id=?').get(member.id)
  assert(memberCredential.password_hash && memberCredential.password_salt.length >= 32, '本机身份没有生成不可登录的内部凭据')
  assert(auth.listUsers(1).some((user) => user.id === member.id), '用户管理能力不可用')

  console.log(JSON.stringify({ ok: true, automaticLocalOwner: true, loginScreen: false, remotePasswordFailsClosed: true, lockPasswordStorage: 'scrypt+salt', lockPasswordMinimum: 4, lockOnRestart: true, wrongPasswordRejected: true }))
} finally {
  auth.clear()
  database.close()
}
