// One visible question at a time; cancellation must release both queued and displayed requests.
export class AgentClarificationQueue {
  constructor() { this.pending = []; this.active = null }

  run(callback, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('询问已取消。'))
    return new Promise((resolve, reject) => {
      const entry = { callback, signal, resolve, reject, finished: false, abort: null }
      entry.abort = () => this.#finish(entry, signal.reason || new Error('询问已取消。'))
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.pending.push(entry)
      this.#drain()
    })
  }

  #finish(entry, error, value) {
    if (entry.finished) return
    entry.finished = true
    entry.signal?.removeEventListener('abort', entry.abort)
    this.pending = this.pending.filter((candidate) => candidate !== entry)
    if (this.active === entry) this.active = null
    if (error) entry.reject(error)
    else entry.resolve(value)
    this.#drain()
  }

  #drain() {
    if (this.active || !this.pending.length) return
    const entry = this.pending.shift()
    if (entry.signal?.aborted) { this.#finish(entry, entry.signal.reason || new Error('询问已取消。')); return }
    this.active = entry
    Promise.resolve().then(() => {
      if (entry.finished || entry.signal?.aborted) throw entry.signal?.reason || new Error('询问已取消。')
      return entry.callback(entry.signal)
    }).then((value) => this.#finish(entry, null, value), (error) => this.#finish(entry, error))
  }
}
