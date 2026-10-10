import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const MAX_TASKS = 6
export const MAX_CONCURRENT_SUBAGENTS = 5
const FAILED_DEPENDENCY_STATUSES = new Set(['failed', 'blocked', 'cancelled'])
const FAILED_RESULT_STATUSES = new Set(['failed', 'blocked', 'interrupted'])

function boundedText(value, label, maximum, { optional = false } = {}) {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`)
  const result = value.trim()
  if (result.length > maximum || result.includes('\0')) throw new Error(`${label}长度或格式不合理。`)
  return result
}

function stringList(value, label, maximum, textMaximum, fallback = []) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label}必须是至多 ${maximum} 项的数组。`)
  return value.map((item) => boundedText(item, label, textMaximum))
}

// Resolve one component at a time: resolving '..' before symlinks would confuse
// alias/../file with workspace/../file and could miss a physical-file conflict.
function realPathWithMissingTail(absolutePath) {
  const root = path.parse(absolutePath).root
  let current = root
  for (const component of absolutePath.slice(root.length).split(path.sep)) {
    if (!component || component === '.') continue
    if (component === '..') { current = path.dirname(current); continue }
    const candidate = path.join(current, component)
    try {
      current = fs.realpathSync.native(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`无法规范化写资源路径：${error.code || 'unknown'}`)
      // A dangling symlink is not a safely canonicalizable missing file.
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('写资源包含无法解析的符号链接。')
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError
      }
      current = candidate
    }
  }
  return current
}

function comparablePath(value) {
  const normalized = value.normalize('NFC')
  // Conservatively serialize case-only aliases on the usual desktop volumes.
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized
}

function isWithinPath(parent, child) {
  const relative = path.relative(comparablePath(parent), comparablePath(child))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function workspaceDirectory(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || workspaceRoot.includes('\0')) {
    throw new Error('任务计划需要绝对路径的工作区目录。')
  }
  const root = realPathWithMissingTail(workspaceRoot)
  if (!fs.statSync(root).isDirectory()) throw new Error('任务计划工作区必须是已存在的目录。')
  return root
}

/** Canonicalize a declared/tool write path; this helper does not grant access. */
export function normalizeWriteResource(resource, workspaceRoot) {
  const value = boundedText(resource, '写资源', 4096)
  if (value === '*') return '*'
  if (/[\u0000-\u001f\u007f*?\[\]{}]/u.test(value) || /^[a-z][a-z\d+.-]*:\/\//iu.test(value) || value === '~' || value.startsWith('~/')) {
    throw new Error('写资源必须是明确的文件或目录路径；未知范围请使用 *。')
  }
  if (process.platform !== 'win32' && (value.includes('\\') || /^[a-z]:/iu.test(value))) {
    throw new Error('写资源路径不适用于当前平台。')
  }
  let absolutePath = value
  if (!path.isAbsolute(value)) {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) throw new Error('相对写资源需要绝对路径的工作区。')
    absolutePath = `${workspaceRoot}${path.sep}${value}`
  }
  return realPathWithMissingTail(absolutePath)
}

/** A '*' declaration excludes every other task, including read-only tasks. */
export function writeResourcesConflict(leftResources, rightResources) {
  if (!Array.isArray(leftResources) || !Array.isArray(rightResources)) throw new Error('写资源必须是数组。')
  if (leftResources.includes('*') || rightResources.includes('*')) return true
  const canonicalize = (resource) => {
    if (typeof resource !== 'string' || !path.isAbsolute(resource)) throw new Error('比较写资源前必须先规范化为绝对路径。')
    try {
      const resourcePath = normalizeWriteResource(resource)
      let identity = ''
      try {
        const stat = fs.statSync(resourcePath, { bigint: true })
        if (stat.isFile()) identity = `${stat.dev}:${stat.ino}`
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null
      }
      return { path: resourcePath, identity }
    } catch {
      // A concurrent mutation may make an already-valid declaration impossible
      // to resolve. Keep it exclusive instead of throwing during lock release.
      return null
    }
  }
  const left = leftResources.map(canonicalize)
  const right = rightResources.map(canonicalize)
  if (left.includes(null) || right.includes(null)) return true
  return left.some((a) => right.some((b) => (a.identity && a.identity === b.identity) || isWithinPath(a.path, b.path) || isWithinPath(b.path, a.path)))
}

/** Cheap, deterministic gate: request structure, never prompt length alone. */
export function shouldPlanTask(message) {
  const raw = typeof message === 'string' ? message : message?.content ?? message?.text ?? ''
  if (typeof raw !== 'string') return false
  let text = raw.replace(/```[\s\S]*?(?:```|$)/gu, '').replace(/^\s*>.*$/gmu, '').trim()
  const pastedInput = /(?:以下|下面|这段|粘贴的|附上的|following|pasted).{0,16}(?:日志|代码|堆栈|报错|文档|内容|文本|logs?|code|stack|errors?|documents?|text)[^\n:：]*[:：]/iu.exec(text)
  if (pastedInput && pastedInput.index < 240) text = text.slice(0, pastedInput.index + pastedInput[0].length)
  text = text.replace(/“[^”]*”|‘[^’]*’|"(?:[^"\\]|\\.)*"|`[^`]*`/gu, '')
  if (!text) return false
  const statements = text.split(/[\n。！？!;；]/u).map((item) => item.trim())
  const explicitParallel = statements.some((statement) => /^(?:请|帮我|需要|要求|安排|启动|使用|让)(?:(?!解释|介绍|说明|比较|总结|翻译|如何|怎么|什么).){0,24}(?:(?:并行|并发)(?:执行|处理|完成|检查|实现|开发|分析|审查|排查|测试|运行|做)|多个\s*(?:子\s*)?agents?|多\s*agent|多代理)/iu.test(statement)
    || /^(?:(?:请|帮我)\s*)?(?:并行|并发)(?:执行|处理|完成|检查|实现|开发|分析|审查|排查|测试|运行)/u.test(statement)
    || /^(?:please\s+)?(?:run|work|execute|implement|check|analy[sz]e|review|test)\b.{0,100}\bin parallel\b/iu.test(statement)
    || /^(?:please\s+)?(?:use|launch|spawn)\s+(?:(?:up to\s+)?[2-9]\s+|multiple\s+|parallel\s+)(?:sub[- ]?agents?|agents?)\b/iu.test(statement))
  if (explicitParallel) return true
  const explanatory = /^(?:(?:请|帮我|麻烦)\s*)?(?:解释|介绍|说明|比较|总结|翻译|什么|为何|为什么|如何|怎么)|^(?:please\s+)?(?:explain|describe|compare|summari[sz]e|translate|what|why|how)\b/iu.test(text)
  const additionalAction = /[\n。；;，,]\s*(?:(?:还|同时|再|请)\s*)*(?:实现|修复|重构|修改|新增|构建|开发|补充|检查|排查|审查|测试|优化|迁移|部署|生成)|[\n.;,]\s*(?:and\s+)?(?:implement|fix|refactor|modify|build|develop|add|migrate|deploy|audit)\b/iu.test(text)
  if (explanatory && !additionalAction) return false
  const action = /(?:完成|实现|修复|重构|修改|新增|构建|开发|补充|检查|分析|排查|审查|测试|优化|迁移|部署|生成|检索|调研|整理|撰写|起草|设计|制作)|\b(?:implement|fix|refactor|modify|build|develop|add|migrate|deploy|audit|analy[sz]e|check|review|test|research|draft|design)\b/iu.test(text)
  const headerText = text.replace(/^\s*(?:\d+[.)、]|[-*])\s*/u, '')
  const actionableHeader = /^(?:(?:请|帮我|需要你|麻烦)\s*){0,2}(?:做|制作|构建|开发|实现|修复|检查|检索|分析|生成|撰写|写|创建|完成|设计)|^(?:需求|任务|目标|以下是(?:需求|任务))\s*(?:如下|清单|[:：])|^(?:please\s+)?(?:build|implement|create|make|complete|check|review|test|requirements?[:\s])/iu.test(headerText)
  if (!action && !actionableHeader) return false
  const independent = /(?:互不依赖|独立(?:目标|任务|完成|处理|检查)|分别(?:完成|处理|检查|实现|分析|审查)|拆(?:分|成).{0,24}(?:任务|目标))|\b(?:independent tasks?|separate tasks?|split.{0,24}tasks?)\b/iu.test(text)
  const objectiveLines = text.split(/\n/u).filter((line) => /^\s*(?:\d+[.)、]|[-*])\s*(?:请|帮我|实现|修复|修改|新增|生成|检查|分析|审查|构建|测试|优化|迁移|部署|implement\b|fix\b|add\b|build\b|review\b|test\b)/iu.test(line))
  if (actionableHeader && objectiveLines.length >= 2) return true
  const requirementLines = text.split(/\n/u).filter((line) => /^\s*\d+[.)、]\s*\S/u.test(line))
  if (actionableHeader && requirementLines.length >= 2) return true
  if (independent && /(?:和|及|与|以及|同时|；|;|\n)|\band\b/iu.test(text)) return true
  const officeDomains = [
    /(?:资料|信息|文献|市场|竞品).{0,12}(?:检索|研究|调研|搜索)|(?:检索|研究|调研|搜索).{0,12}(?:资料|信息|文献|市场|竞品)|\bresearch\b/iu,
    /(?:表格|数据|excel|csv).{0,12}(?:分析|统计|整理|处理)|(?:分析|统计|整理|处理).{0,12}(?:表格|数据|excel|csv)|\b(?:spreadsheet|data analysis)\b/iu,
    /(?:文档|报告|文章|方案).{0,12}(?:草稿|写作|撰写|起草)|(?:草稿|写作|撰写|起草|写).{0,12}(?:文档|报告|文章|方案)|\b(?:draft|document writing)\b/iu,
    /(?:设计|海报|视觉|插画)|\bdesign\b/iu,
    /(?:代码|程序|接口|应用|网站|前端|后端)|\b(?:code|implement|app)\b/iu,
  ]
  const officeActions = text.match(/(?:检索|搜索|研究|调研|分析|统计|整理|处理|草稿|写作|撰写|起草|设计|制作|实现|修复|构建|开发)|\b(?:research|analy[sz]e|draft|write|design|implement|build)\b/giu) || []
  if (officeDomains.filter((pattern) => pattern.test(text)).length >= 2 && officeActions.length >= 2 && /(?:、|和|及|与|以及|同时|然后|最后|再|分别|[;,；，\n])|\band\b/iu.test(text)) return true
  const domains = [/(?:前端|界面|\bfrontend\b|\bUI\b)/iu, /(?:后端|服务端|\bbackend\b|\bAPI\b)/iu, /(?:数据库|数据层|\bdatabase\b|\bschema\b)/iu, /(?:桌面端|客户端|\bdesktop\b|\bclient\b)/iu, /(?:部署|基础设施|\binfrastructure\b|\bdeployment\b)/iu]
  const domainCount = domains.filter((pattern) => pattern.test(text)).length
  return /(?:跨(?:模块|组件|服务|前后端)|前后端)|\bcross[- ](?:module|component|service)\b/iu.test(text)
    || (domainCount >= 2 && /(?:和|及|与|以及|同时|同步|联动|分别)|\b(?:and|both|across)\b/iu.test(text))
}

/** Validate every node and edge before any task is launched. */
export function normalizeTaskPlan(plan, { workspaceRoot } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > MAX_TASKS) {
    throw new Error(`任务计划必须包含 1–${MAX_TASKS} 个任务。`)
  }
  const root = workspaceDirectory(workspaceRoot ?? plan.workspaceRoot)
  const tasks = plan.tasks.map((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`任务 ${index + 1} 格式错误。`)
    const id = boundedText(node.id, '任务 ID', 80)
    if (!/^[a-z\d][a-z\d_.-]*$/iu.test(id)) throw new Error('任务 ID 只能包含字母、数字、点、横线和下划线。')
    const dependencies = stringList(node.dependencies, '任务依赖', MAX_TASKS - 1, 80)
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`任务 ${id} 有重复依赖。`)
    const writeResources = [...new Set(stringList(node.writeResources, '写资源', 40, 4096, ['*']).map((item) => normalizeWriteResource(item, root)))]
    if (writeResources.some((resource) => resource !== '*' && !isWithinPath(root, resource))) throw new Error(`任务 ${id} 的写资源越出工作区；未知或外部范围请声明 *。`)
    return {
      id,
      title: boundedText(node.title, '任务标题', 200),
      goal: boundedText(node.goal, '任务目标', 10000),
      task: boundedText(node.task, '任务指令', 20000),
      dependencies,
      expectedOutputs: [...new Set(stringList(node.expectedOutputs, '预期产出', 20, 2000))],
      writeResources,
    }
  })
  const byId = new Map(tasks.map((node) => [node.id, node]))
  if (byId.size !== tasks.length) throw new Error('任务计划包含重复 ID。')
  const visiting = new Set()
  const visited = new Set()
  const visit = (node) => {
    if (visiting.has(node.id)) throw new Error('任务计划存在循环依赖。')
    if (visited.has(node.id)) return
    visiting.add(node.id)
    for (const id of node.dependencies) {
      if (!byId.has(id)) throw new Error(`任务 ${node.id} 引用了未知依赖 ${id}。`)
      visit(byId.get(id))
    }
    visiting.delete(node.id)
    visited.add(node.id)
  }
  tasks.forEach(visit)
  return { workspaceRoot: root, tasks }
}

function cloneRecord(record) {
  return { ...record, dependencies: [...record.dependencies], expectedOutputs: [...record.expectedOutputs], writeResources: [...record.writeResources], ...(record.usage ? { usage: { ...record.usage } } : {}) }
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function taskUsage(value) {
  if (!value || typeof value !== 'object') return undefined
  const usage = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    const count = safeCount(value[key])
    if (count !== undefined) usage[key] = count
  }
  return Object.keys(usage).length ? usage : undefined
}

/** Run an isolated DAG. Real tool-layer write locks must still enforce access. */
export async function runTaskPlan(plan, { runTask, signal, onUpdate, maxConcurrent = MAX_CONCURRENT_SUBAGENTS } = {}) {
  if (typeof runTask !== 'function') throw new Error('任务调度需要 runTask 执行函数。')
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('任务并发数必须是正整数。')
  if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new Error('取消信号格式错误。')
  const normalized = normalizeTaskPlan(plan)
  const limit = Math.min(MAX_CONCURRENT_SUBAGENTS, maxConcurrent)
  const taskSignal = signal ?? new AbortController().signal
  const startedAt = new Date().toISOString()
  const startedClock = performance.now()
  let finishedAt = ''
  let status = 'running'
  const tasks = normalized.tasks.map((node) => ({ ...node, status: 'pending', phase: '', output: '', error: '', toolCallCount: 0, durationMs: 0, startedAt: '', finishedAt: '' }))
  const byId = new Map(tasks.map((record) => [record.id, record]))
  const active = new Map()
  const snapshot = () => ({ tasks: tasks.map(cloneRecord), status, startedAt, finishedAt, durationMs: Math.max(0, Math.round(performance.now() - startedClock)) })
  const emit = () => {
    if (typeof onUpdate !== 'function') return
    try {
      const result = onUpdate(snapshot())
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {})
    } catch { /* A view observer must not interrupt a running write task. */ }
  }
  const cancelPending = () => {
    let changed = false
    for (const record of tasks) {
      if (record.status !== 'pending') continue
      record.status = 'cancelled'
      record.error = '任务已取消，未启动。'
      record.finishedAt = new Date().toISOString()
      changed = true
    }
    if (changed) emit()
  }
  const abort = () => cancelPending()
  const start = (record) => {
    record.status = 'running'
    record.phase = 'running'
    record.startedAt = new Date().toISOString()
    const taskClock = performance.now()
    const node = { ...normalized.tasks.find((item) => item.id === record.id), writeResources: [...record.writeResources] }
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await runTask(cloneRecord(node), {
          signal: taskSignal,
          dependencies: record.dependencies.map((id) => cloneRecord(byId.get(id))),
          reportProgress: (patch) => {
            if (record.status !== 'running' || !patch || typeof patch !== 'object') return
            const count = safeCount(patch.toolCallCount)
            if (count !== undefined) record.toolCallCount = Math.max(record.toolCallCount, count)
            if (typeof patch.phase === 'string') record.phase = patch.phase.slice(0, 200)
            emit()
          },
        })
        const value = result && typeof result === 'object' ? result : {}
        record.output = typeof result === 'string' ? result : typeof value.output === 'string' ? value.output : ''
        record.toolCallCount = Math.max(record.toolCallCount, safeCount(value.toolCallCount) ?? 0)
        const usage = taskUsage(value.usage)
        if (usage) record.usage = usage
        if (taskSignal.aborted || value.status === 'cancelled') {
          record.status = 'cancelled'
          record.error = typeof value.error === 'string' && value.error ? value.error : '任务已取消。'
        } else if (value.ok === false || FAILED_RESULT_STATUSES.has(value.status)) {
          record.status = 'failed'
          record.error = typeof value.error === 'string' && value.error ? value.error : '任务执行失败。'
        } else {
          record.status = 'completed'
        }
      } catch (error) {
        record.status = taskSignal.aborted ? 'cancelled' : 'failed'
        record.error = error instanceof Error ? error.message : String(error)
      } finally {
        record.durationMs = Math.max(0, Math.round(performance.now() - taskClock))
        record.finishedAt = new Date().toISOString()
        active.delete(record.id)
        emit()
      }
    })
    active.set(record.id, operation)
    emit()
  }
  taskSignal.addEventListener('abort', abort, { once: true })
  emit()
  try {
    while (tasks.some((record) => record.status === 'pending') || active.size) {
      if (taskSignal.aborted) cancelPending()
      let changed = true
      while (changed) {
        changed = false
        for (const record of tasks) {
          if (record.status !== 'pending') continue
          const failed = record.dependencies.find((id) => FAILED_DEPENDENCY_STATUSES.has(byId.get(id).status))
          if (!failed) continue
          record.status = 'blocked'
          record.error = `前置任务 ${failed} 未完成，已阻断。`
          record.finishedAt = new Date().toISOString()
          changed = true
          emit()
        }
      }
      for (const record of tasks) {
        if (taskSignal.aborted) break
        if (record.status !== 'pending') continue
        const setPhase = (phase) => {
          if (record.phase === phase) return
          record.phase = phase
          emit()
        }
        if (!record.dependencies.every((id) => byId.get(id).status === 'completed')) { setPhase('waiting_dependencies'); continue }
        try {
          // Re-resolve immediately before launch: preceding tasks can create or
          // replace a declared directory with a symlink after normalization.
          record.writeResources = [...new Set(record.writeResources.map((resource) => normalizeWriteResource(resource, normalized.workspaceRoot)))]
          if (record.writeResources.some((resource) => resource !== '*' && !isWithinPath(normalized.workspaceRoot, resource))) throw new Error('任务写资源在运行前已越出工作区。')
        } catch (error) {
          record.status = 'failed'
          record.error = error instanceof Error ? error.message : String(error)
          record.finishedAt = new Date().toISOString()
          emit()
          continue
        }
        if (tasks.some((running) => running.status === 'running' && writeResourcesConflict(record.writeResources, running.writeResources))) { setPhase('waiting_resources'); continue }
        setPhase('')
        if (active.size >= limit) continue
        start(record)
      }
      if (active.size) await Promise.race(active.values())
      else if (tasks.some((record) => record.status === 'pending')) {
        // A just-failed resource revalidation propagates on the next iteration.
        if (tasks.some((record) => record.status === 'pending' && record.dependencies.some((id) => FAILED_DEPENDENCY_STATUSES.has(byId.get(id).status)))) continue
        throw new Error('任务调度无法推进。')
      }
    }
    status = taskSignal.aborted || tasks.some((record) => record.status === 'cancelled') ? 'cancelled' : tasks.some((record) => record.status === 'failed' || record.status === 'blocked') ? 'failed' : 'completed'
    finishedAt = new Date().toISOString()
    emit()
    return snapshot()
  } finally {
    taskSignal.removeEventListener('abort', abort)
  }
}
