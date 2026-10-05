/**
 * 主进程日志安全垫。
 *
 * 从终端（或任何会退出的父进程）启动应用时，父进程结束后 stdout / stderr 的管道就断了。
 * 这时任何一次 console.log / console.error 都会抛 `write EPIPE`；第三方库的定时器里也在写日志
 * （例如 dingtalk-stream 心跳超时会 console.error），于是变成主进程未捕获异常，
 * Electron 会弹出「A JavaScript error occurred in the main process」对话框。
 *
 * 这里做两件事：
 * ① 给 stdout / stderr 挂上 error 监听（否则流上的 error 事件本身也会变成未捕获异常）；
 * ② 给 console 的各个方法包一层，写失败时静默忽略，绝不让日志把应用搞崩。
 */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace']

export function installSafeConsole({ target = console, streams = [process.stdout, process.stderr], onBroken = null } = {}) {
  let broken = false
  const markBroken = (error) => {
    if (broken) return
    broken = true
    if (typeof onBroken === 'function') {
      try { onBroken(error) } catch { /* 兜底回调自身出错也不影响 */ }
    }
  }

  for (const stream of streams) {
    if (!stream || typeof stream.on !== 'function') continue
    stream.on('error', (error) => markBroken(error))
  }

  for (const method of CONSOLE_METHODS) {
    const original = target[method]
    if (typeof original !== 'function') continue
    target[method] = function safeConsoleMethod(...args) {
      try {
        return original.apply(this, args)
      } catch (error) {
        if (error && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED' || error.code === 'ERR_STREAM_WRITE_AFTER_END')) {
          markBroken(error)
          return undefined
        }
        throw error
      }
    }
  }

  return { isBroken: () => broken }
}
