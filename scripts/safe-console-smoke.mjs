// 主进程日志安全垫回归：管道断开时写日志不能再抛未捕获异常。
// 直接构造「写入即抛 EPIPE」的流来复现真实故障（dingtalk-stream 心跳就是这么触发的）。
import assert from 'node:assert/strict'
import { installSafeConsole } from '../electron/services/safe-console.mjs'

// ① 写入即抛 EPIPE 的流：没装安全垫时必抛，装了之后必须静默
const brokenStream = {
  writes: 0,
  write() {
    this.writes += 1
    const error = new Error('write EPIPE')
    error.code = 'EPIPE'
    throw error
  },
}
assert.throws(() => brokenStream.write(), /EPIPE/, '测试前提：直接写断开的管道应当抛 EPIPE')
const fakeConsole = { log: () => brokenStream.write(), info: () => brokenStream.write(), warn: () => brokenStream.write(), error: () => brokenStream.write() }
brokenStream.writes = 0
const guard = installSafeConsole({ target: fakeConsole, streams: [brokenStream] })
assert.doesNotThrow(() => fakeConsole.error('TERMINATE SOCKET: Ping Pong does not transfer heartbeat'), '装了安全垫后写日志不应再抛 EPIPE')
assert.doesNotThrow(() => fakeConsole.log('普通日志'), '普通日志同样不应抛')
assert.equal(brokenStream.writes, 2, '日志仍然尝试写出（只是失败被吞掉，不影响其它逻辑）')
assert.equal(guard.isBroken(), true, '管道断开后应标记为已断开')

// ② 其它错误不能被无声吞掉（避免掩盖真正的 bug）
const otherStream = { write() { const error = new Error('boom'); error.code = 'EACCES'; throw error } }
const strictConsole = { error: () => otherStream.write(), log: () => {} }
installSafeConsole({ target: strictConsole, streams: [otherStream] })
assert.throws(() => strictConsole.error('磁盘错误'), /boom/, '非管道类错误必须继续抛出')

// ③ 必须给 stdout / stderr 装上 error 监听，否则流上的 error 事件本身就是未捕获异常
const registered = []
const stubStream = { on: (event) => registered.push(event), write: () => {} }
installSafeConsole({ target: { log: () => {}, error: () => {} }, streams: [stubStream] })
assert(registered.includes('error'), '应当给输出流装上 error 监听器')

// ④ 真实 process 对象上验证：emit error 不再抛出
const realGuard = installSafeConsole()
assert.doesNotThrow(() => process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), '真实 stdout 上的管道错误不应变成未捕获异常')
assert.equal(realGuard.isBroken(), true, '真实管道出错后也应标记')
console.log(JSON.stringify({ ok: true, epipeSwallowed: true, otherErrorsStillThrow: true, streamErrorListener: true, realProcessGuarded: true }))
