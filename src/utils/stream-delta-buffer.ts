// 流式回答是逐 token 到达的。如果每个 token 都直接更新一次消息状态，渲染进程要为一次长回答
// 做上千次整棵消息列表的拷贝与重渲染（还有每次的滚动与 markdown 解析），长任务下界面会明显变卡。
// 这里把同一类增量合成 ~60ms 一批再应用：文字仍然连续出现，但渲染次数下降一个数量级。
export type StreamDeltaBuffer = {
  push: (delta: string, apply: (delta: string) => void, targetKey?: string) => void
  flush: () => void
  dispose: () => void
}

export function createStreamDeltaBuffer(intervalMs = 60): StreamDeltaBuffer {
  let pending = ''
  let applyPending: ((delta: string) => void) | null = null
  let pendingTargetKey = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flush = () => {
    clear()
    if (!pending || !applyPending) return
    const chunk = pending
    const apply = applyPending
    pending = ''
    applyPending = null
    pendingTargetKey = ''
    apply(chunk)
  }

  return {
    push(delta, apply, targetKey = '') {
      if (!delta) return
      // 调用端通常会为每个 token 创建一个新闭包，不能拿函数引用判断目标是否变化，
      // 否则每次 push 都会先 flush，60ms 合并会完全失效。真正切换目标时由调用端
      // 传稳定的 targetKey；同一目标始终使用最后一个闭包承载最新事件元数据。
      if (pending && pendingTargetKey !== targetKey) flush()
      pending += delta
      applyPending = apply
      pendingTargetKey = targetKey
      if (timer === null) timer = setTimeout(flush, intervalMs)
    },
    flush,
    dispose() {
      clear()
      pending = ''
      applyPending = null
      pendingTargetKey = ''
    },
  }
}
