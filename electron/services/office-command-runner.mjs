import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const queues = new Map()
const waiters = []
let active = 0
const MAX_PROCESSES = 3
const FILE_COMMANDS = new Set(['open', 'close', 'watch', 'unwatch', 'view', 'get', 'query', 'set', 'add', 'remove', 'move', 'swap', 'refresh', 'raw', 'raw-set', 'add-part', 'validate', 'save', 'batch', 'dump', 'import', 'create', 'merge'])

export function normalizeOfficeCommandArgs(args) {
  if (!Array.isArray(args) || !args.length || args.some((value) => typeof value !== 'string')) throw new Error('Office 命令参数无效。')
  const json = args.includes('--json')
  const values = args.filter((value) => value !== '--json')
  if (!values.length) return ['--json']
  const command = values[0].toLowerCase()
  if (command.startsWith('-') && !(values.length === 1 && ['--help', '-h', '-?', '--version'].includes(command))) throw new Error('Office 命令名称必须在参数开头；全局 --json 选项可放任意位置。')
  if (FILE_COMMANDS.has(command) && (!values[1] || values[1].startsWith('-'))) throw new Error('Office 文件路径必须紧跟命令名称，再填写其他选项。')
  return json ? [...values, '--json'] : values
}

function cancelled(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Office 操作已取消。')
}

async function acquire(signal) {
  cancelled(signal)
  if (active < MAX_PROCESSES) { active += 1; return }
  await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, abort: null }
    waiter.abort = () => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Office 操作已取消。'))
    }
    signal?.addEventListener('abort', waiter.abort, { once: true })
    waiters.push(waiter)
  })
  // release transfers its slot directly to the next waiter.
  if (signal?.aborted) { release(); cancelled(signal) }
}

function release() {
  const waiter = waiters.shift()
  if (waiter) {
    waiter.signal?.removeEventListener('abort', waiter.abort)
    waiter.resolve()
  } else active -= 1
}

export function officeCommandFile(args, cwd = process.cwd()) {
  args = normalizeOfficeCommandArgs(args)
  const candidate = String(args?.[0]).toLowerCase() === 'merge' ? args?.[2] : args?.[1]
  if (typeof candidate !== 'string' || !/\.(?:docx|xlsx|pptx|doc|xls|ppt|csv|tsv)$/i.test(candidate)) return ''
  return canonicalCommandPath(candidate, cwd)
}

function canonicalCommandPath(candidate, cwd) {
  const resolved = path.resolve(cwd, candidate)
  try { return fs.realpathSync.native(resolved) } catch { /* new export or document */ }
  // New files still inherit the real location of their nearest existing
  // directory. Otherwise `linked-folder/new.html` could hide an external write.
  let ancestor = path.dirname(resolved)
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor)
  try { return path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, resolved)) } catch { return resolved }
}

export function officeCommandInputFile(args, cwd = process.cwd()) {
  args = normalizeOfficeCommandArgs(args)
  return FILE_COMMANDS.has(args[0]?.toLowerCase()) && args[1] ? canonicalCommandPath(args[1], cwd) : ''
}

export function officeCommandOutputFiles(args, cwd = process.cwd()) {
  args = normalizeOfficeCommandArgs(args)
  const files = []
  for (let index = 1; index < args.length; index += 1) {
    const output = officeCommandOutputArgument(args[index])
    if (!output) continue
    const candidate = output.value ?? args[++index]
    if (!candidate || candidate.startsWith('-')) throw new Error('Office 导出文件路径无效。')
    files.push(canonicalCommandPath(candidate, cwd))
  }
  return [...new Set(files)]
}

export function officeCommandOutputArgument(argument) {
  if (['-o', '--out', '--output'].includes(argument)) return { value: null }
  // OfficeCLI's System.CommandLine parser accepts equals, colon and attached
  // short-option values. All forms must share the same write-path guards.
  const match = /^(?:--out|--output)[=:](.*)$/.exec(argument) || /^-o[=:]?(.*)$/.exec(argument)
  return match ? { value: match[1] } : null
}

export function isOfficeMutation(args) {
  args = normalizeOfficeCommandArgs(args)
  return /^(?:create|add|set|remove|move|swap|import|refresh|merge|batch|raw-set|add-part|save|close|open|undo|redo)$/i.test(String(args?.[0] || ''))
}

// One persistence contract for desktop, Agent and indexing: no hidden resident
// process; commands have completed disk writes before we expose their result.
export async function runOfficeCommand(executable, args, { cwd, timeout = 120_000, maxBuffer = 16 * 1024 * 1024, signal } = {}) {
  args = normalizeOfficeCommandArgs(args)
  const key = officeCommandFile(args, cwd)
  const previous = key ? queues.get(key) || Promise.resolve() : Promise.resolve()
  const task = previous.catch(() => undefined).then(async () => {
    await acquire(signal)
    try {
      cancelled(signal)
      return await execFileAsync(executable, args, {
        cwd, timeout, maxBuffer, signal, windowsHide: true,
        env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_RESIDENT_FLUSH: 'each' },
      })
    } finally { release() }
  })
  const tracked = task.finally(() => { if (key && queues.get(key) === tracked) queues.delete(key) })
  if (key) queues.set(key, tracked)
  if (!signal) return tracked
  // A cancelled caller need not wait behind another file command. Keep the
  // underlying queue entry until its predecessor finishes to preserve ordering.
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Office 操作已取消。'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    tracked.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function officeRunnerDiagnostics() {
  return { active, waiting: waiters.length, queuedFiles: queues.size, maxProcesses: MAX_PROCESSES }
}
