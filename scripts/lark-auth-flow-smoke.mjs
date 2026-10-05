import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LarkAuthFlow } from '../electron/services/lark-auth-flow.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-lark-auth-'))
const saved = new Map()
const secrets = {
  get: (scope) => saved.get(scope) || {},
  set: (scope, value) => { saved.set(scope, value) },
  delete: (scope) => { saved.delete(scope) },
}
const deviceCode = 'test-private-device-code'
let now = Date.now()
let ready = false
let failExchange = false
const calls = []
const runCommand = async (_cliPath, args, options) => {
  calls.push(args)
  if (args[0] === 'auth' && args[1] === 'qrcode') {
    fs.writeFileSync(path.join(options.cwd, args[args.indexOf('--output') + 1]), 'qr')
    return { stdout: 'ok', stderr: '' }
  }
  if (args[0] === 'auth' && args[1] === 'status') return { stdout: JSON.stringify({ identities: { user: { available: ready, status: ready ? 'ready' : 'missing' } } }), stderr: '' }
  if (args.includes('--device-code')) {
    if (failExchange) throw new Error(`Command failed: lark-cli auth login --device-code ${deviceCode}`)
    ready = true
    return { stdout: '{}', stderr: '' }
  }
  assert(args.includes('--no-wait') && args.includes('--json'))
  return { stdout: JSON.stringify({ device_code: deviceCode, expires_in: 600, verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=test' }), stderr: '' }
}

try {
  const first = new LarkAuthFlow({ runCommand, secrets, now: () => now })
  const started = JSON.parse(await first.start({ cliPath: '/fake/lark-cli', args: ['auth', 'login', '--scope', 'base:table:read'], cwd: root, conversationId: 'conversation-a', requestId: 'request-a' }))
  assert.equal(started.status, 'authorization_required')
  assert(started.qr_file && fs.existsSync(path.join(root, started.qr_file)))
  assert(!JSON.stringify(started).includes(deviceCode), '设备码不得进入模型输出')
  assert(saved.get('lark-pending-auth:conversation-a')?.pending.includes(deviceCode), '设备码应交给安全存储而非对话记录')
  const loginCount = calls.filter((args) => args.includes('--no-wait')).length
  const repeated = JSON.parse(await first.start({ cliPath: '/fake/lark-cli', args: ['auth', 'login', '--scope', 'base:table:read'], cwd: root, conversationId: 'conversation-a', requestId: 'request-a' }))
  assert.deepEqual(repeated, started, '重复请求应复用未过期的授权链接')
  assert.equal(calls.filter((args) => args.includes('--no-wait')).length, loginCount, '重复请求不应生成新的设备码')
  assert.match(await first.complete({ cliPath: '/fake/lark-cli', cwd: root, conversationId: 'conversation-a', requestId: 'request-a' }), /结束当前回复/)
  assert.equal(calls.some((args) => args.includes('--device-code')), false, '同一轮不应阻塞等待授权')
  assert.match(await first.status({ cliPath: '/fake/lark-cli', cwd: root, conversationId: 'conversation-a' }), /\["auth","complete"\]/)

  // Simulate an app restart: the next turn recovers the pending code from encrypted storage.
  const resumed = new LarkAuthFlow({ runCommand, secrets, now: () => now })
  assert.match(await resumed.complete({ cliPath: '/fake/lark-cli', cwd: root, conversationId: 'conversation-a', requestId: 'request-b' }), /身份已就绪/)
  assert.equal(saved.has('lark-pending-auth:conversation-a'), false)
  assert(calls.some((args) => args.includes('--device-code')))

  ready = false
  failExchange = true
  await resumed.start({ cliPath: '/fake/lark-cli', args: ['auth', 'login', '--scope', 'base:record:read'], cwd: root, conversationId: 'conversation-b', requestId: 'request-c' })
  await assert.rejects(
    resumed.complete({ cliPath: '/fake/lark-cli', cwd: root, conversationId: 'conversation-b', requestId: 'request-d' }),
    (error) => !error.message.includes(deviceCode) && /尚未确认授权|暂时失败/.test(error.message),
    '令牌交换错误不得泄露设备码',
  )
  now += 601_000
  await assert.rejects(resumed.complete({ cliPath: '/fake/lark-cli', cwd: root, conversationId: 'conversation-b', requestId: 'request-e' }), /没有待完成的飞书授权|已过期/)
  assert.equal(saved.has('lark-pending-auth:conversation-b'), false)
  console.log('飞书两阶段授权、跨重启恢复、过期清理与设备码脱敏检查通过。')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
