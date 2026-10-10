import { normalizeWriteResource, writeResourcesConflict } from './agent-task-scheduler.mjs'

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('文件写入等待已取消。')
}

// 声明用于调度优化；此进程级共享锁保护真正的工具执行，即使模型漏报写路径也不能并发覆盖。
export class AgentWriteLockService {
  constructor() {
    this.active = new Set()
    this.pending = []
  }

  acquire(resources = [], { signal, workspaceRoot = '.' } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    const canonicalize = (raw) => {
      try { return normalizeWriteResource(raw, workspaceRoot) }
      catch { return '*' } // Locking must not reduce legitimate filename permissions; uncertain aliases fail closed.
    }
    const normalized = [...new Set(resources.map(canonicalize))]
    if (!normalized.length) return Promise.resolve(() => {})
    return new Promise((resolve, reject) => {
      const entry = { resources: normalized, rawResources: [...resources], canonicalize, signal, resolve, reject, onAbort: null }
      entry.onAbort = () => {
        this.pending = this.pending.filter((candidate) => candidate !== entry)
        reject(abortError(signal))
        this.#drain()
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      this.pending.push(entry)
      this.#drain()
    })
  }

  #drain() {
    for (const entry of this.pending) entry.resources = [...new Set(entry.rawResources.map(entry.canonicalize))]
    for (let index = 0; index < this.pending.length;) {
      const entry = this.pending[index]
      const blocked = [...this.active].some((active) => writeResourcesConflict(active.resources, entry.resources))
        || this.pending.slice(0, index).some((earlier) => writeResourcesConflict(earlier.resources, entry.resources))
      if (blocked) { index += 1; continue }
      this.pending.splice(index, 1)
      entry.signal?.removeEventListener('abort', entry.onAbort)
      if (entry.signal?.aborted) { entry.reject(abortError(entry.signal)); continue }
      this.active.add(entry)
      let released = false
      entry.resolve(() => {
        if (released) return
        released = true
        this.active.delete(entry)
        this.#drain()
      })
    }
  }

  async run(resources, options, callback) {
    const release = await this.acquire(resources, options)
    try {
      if (options?.signal?.aborted) throw abortError(options.signal)
      return await callback()
    } finally { release() }
  }

  inspect() { return { active: this.active.size, pending: this.pending.length } }
}

// All sessions and all Agent Core instances in this process participate in the same mutation boundary.
export const agentWriteLocks = new AgentWriteLockService()
