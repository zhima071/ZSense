import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { extractPdfText, formatPdfExtraction } from './pdf-parser.mjs'
import { runOfficeCommand } from './office-command-runner.mjs'

const STATES = new Set(['running', 'review', 'delivering', 'completed', 'failed', 'interrupted'])
const MAX_INDEX_BYTES = 512 * 1024
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.log'])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])
const iso = () => new Date().toISOString()
const json = (value, fallback) => { try { return JSON.parse(value) } catch { return fallback } }
const bounded = (value, limit) => String(value ?? '').slice(0, limit)

export function classifyOfficeTaskError(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  if (/授权|认证|登录|token|unauthorized|forbidden|401|403/i.test(message)) return 'authentication'
  if (/ENOENT|不存在|找不到|missing file|not found/i.test(message)) return 'missing_source'
  if (/超时|timeout|ECONN|NETWORK|HTTP 5\d\d/i.test(message)) return 'transient_network'
  if (/格式|无效|不安全|validation|invalid/i.test(message)) return 'validation'
  return 'execution_failed'
}

function rowToTask(row) {
  if (!row) return null
  return {
    id: row.id, botId: row.bot_id, conversationId: row.conversation_id,
    sourceChannel: row.source_channel, sourceConnectionId: row.source_connection_id,
    sourceThreadId: row.source_thread_id, sourceMessageId: row.source_message_id,
    title: row.title, request: row.request, status: row.status,
    steps: json(row.steps_json, []), evidence: json(row.evidence_json, []),
    artifacts: json(row.artifacts_json, []), output: row.output,
    deliveryStatus: row.delivery_status, deliveryReceipt: row.delivery_receipt,
    errorCode: row.error_code, error: row.error, attempts: row.attempts,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export class OfficeTaskService {
  constructor({ database, officeWorkspace = null, onChanged = () => {} }) {
    this.database = database
    this.officeWorkspace = officeWorkspace
    this.db = database.db
    this.onChanged = onChanged
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS office_work_items (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_channel TEXT NOT NULL,
        source_connection_id TEXT NOT NULL DEFAULT '',
        source_thread_id TEXT NOT NULL DEFAULT '',
        source_message_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        request TEXT NOT NULL,
        status TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        output TEXT NOT NULL DEFAULT '',
        delivery_status TEXT NOT NULL DEFAULT 'not_required',
        delivery_receipt TEXT NOT NULL DEFAULT '',
        error_code TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS office_work_items_bot ON office_work_items(bot_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS office_work_items_conversation ON office_work_items(conversation_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS office_work_items_source ON office_work_items(source_connection_id, source_message_id)
        WHERE source_connection_id<>'' AND source_message_id<>'';
      CREATE TABLE IF NOT EXISTS office_search_documents (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES office_work_items(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS office_search_documents_bot ON office_search_documents(bot_id, task_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS office_search_fts USING fts5(document_id UNINDEXED, title, body, tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS office_search_documents_delete AFTER DELETE ON office_search_documents BEGIN
        DELETE FROM office_search_fts WHERE document_id=old.id;
      END;
    `)
    const ftsSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='office_search_fts'").get()?.sql || ''
    if (ftsSchema.includes("tokenize='unicode61'")) {
      const indexed = this.db.prepare('SELECT document_id, title, body FROM office_search_fts').all()
      this.db.exec('DROP TABLE office_search_fts')
      this.db.exec("CREATE VIRTUAL TABLE office_search_fts USING fts5(document_id UNINDEXED, title, body, tokenize='trigram')")
      const insert = this.db.prepare('INSERT INTO office_search_fts (document_id,title,body) VALUES (?,?,?)')
      for (const row of indexed) insert.run(row.document_id, row.title, row.body)
    }
    // A process exit cannot safely resume an in-flight model/tool call. Keep it visible and actionable.
    this.db.prepare("UPDATE office_work_items SET status='interrupted', error_code='process_restart', error='应用退出时任务仍在运行；不会自动重放工具或外发消息。', updated_at=? WHERE status IN ('running', 'delivering')").run(iso())
    this.db.prepare("UPDATE office_work_items SET status='interrupted', delivery_status='manual_required', error_code='delivery_context_lost', error='应用重启后原消息回复通道已失效；处理结果仍保留，请从原平台重新发起。', updated_at=? WHERE status='review'").run(iso())
  }

  notify() { this.onChanged() }

  list({ botId = '', conversationId = '', limit = 100 } = {}) {
    const rows = this.db.prepare(`SELECT * FROM office_work_items
      WHERE (?='' OR bot_id=?) AND (?='' OR conversation_id=?)
      ORDER BY updated_at DESC LIMIT ?`).all(botId, botId, conversationId, conversationId, Math.min(300, Math.max(1, Number(limit) || 100)))
    return rows.map(rowToTask)
  }

  get(id) { return rowToTask(this.db.prepare('SELECT * FROM office_work_items WHERE id=?').get(id)) }

  create({ botId, conversationId, sourceChannel = 'web', sourceConnectionId = '', sourceThreadId = '', sourceMessageId = '', title, request, evidence = [], reviewRequired = false }) {
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND bot_id=?').get(conversationId, botId)) throw new Error('任务会话不存在或不属于此 Bot。')
    if (sourceConnectionId && sourceMessageId) {
      const existing = this.db.prepare('SELECT * FROM office_work_items WHERE source_connection_id=? AND source_message_id=?').get(sourceConnectionId, sourceMessageId)
      if (existing) return rowToTask(existing)
    }
    const id = `office-task-${randomUUID()}`
    const timestamp = iso()
    const steps = [
      { id: 'receive', label: '接收并确认来源', status: 'completed' },
      { id: 'process', label: '分析与处理', status: 'in_progress' },
      { id: 'verify', label: '核查文件与结果', status: 'pending' },
      { id: 'deliver', label: reviewRequired ? '人工审核后回传' : '完成交付', status: 'pending' },
    ]
    this.db.prepare(`INSERT INTO office_work_items
      (id,bot_id,conversation_id,source_channel,source_connection_id,source_thread_id,source_message_id,title,request,status,steps_json,evidence_json,delivery_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, botId, conversationId, sourceChannel, sourceConnectionId, sourceThreadId, sourceMessageId,
      bounded(title || request, 120), bounded(request, 8000), 'running', JSON.stringify(steps), JSON.stringify(evidence),
      reviewRequired ? 'review_required' : sourceChannel === 'web' ? 'not_required' : 'pending', timestamp, timestamp,
    )
    this.notify()
    return this.get(id)
  }

  patch(id, changes = {}) {
    const current = this.get(id)
    if (!current) throw new Error('任务不存在。')
    const status = changes.status || current.status
    if (!STATES.has(status)) throw new Error('任务状态无效。')
    const steps = Array.isArray(changes.steps) ? changes.steps : current.steps
    this.db.prepare(`UPDATE office_work_items SET status=?, steps_json=?, evidence_json=?, artifacts_json=?, output=?,
      delivery_status=?, delivery_receipt=?, error_code=?, error=?, attempts=?, updated_at=? WHERE id=?`).run(
      status, JSON.stringify(steps), JSON.stringify(changes.evidence ?? current.evidence), JSON.stringify(changes.artifacts ?? current.artifacts),
      bounded(changes.output ?? current.output, 100_000), changes.deliveryStatus ?? current.deliveryStatus,
      bounded(changes.deliveryReceipt ?? current.deliveryReceipt, 500), changes.errorCode ?? current.errorCode,
      bounded(changes.error ?? current.error, 4000), changes.attempts ?? current.attempts, iso(), id,
    )
    this.notify()
    return this.get(id)
  }

  advance(id, stepId, status) {
    const task = this.get(id)
    if (!task) return null
    const steps = task.steps.map((step) => ({ ...step, status: step.id === stepId ? status : step.status === 'in_progress' ? 'completed' : step.status }))
    return this.patch(id, { steps })
  }

  recordTool(id, event) {
    const task = this.get(id)
    if (!task || task.status !== 'running' || event.type !== 'tool') return
    const key = bounded(event.toolId || event.name, 100)
    if (!key) return
    const existing = task.steps.find((step) => step.id === `tool:${key}`)
    const status = event.status === 'complete' ? 'completed' : event.status === 'error' ? 'failed' : 'in_progress'
    if (existing?.status === status) return
    const step = { id: `tool:${key}`, label: bounded(event.name || '工具调用', 120), status, detail: bounded(event.detail, 300) }
    const steps = existing ? task.steps.map((item) => item.id === step.id ? step : item) : [...task.steps.slice(0, -2), step, ...task.steps.slice(-2)]
    const evidence = [...task.evidence]
    if (event.status === 'complete' && ['read_pdf', 'read_spreadsheet'].includes(event.name)) {
      const input = typeof event.input === 'string' ? json(event.input, {}) : event.input || {}
      const file = bounded(input.path, 500)
      if (file) {
        const location = event.name === 'read_pdf'
          ? `第 ${Math.max(1, Number(input.startPage) || 1)}-${Math.max(1, Number(input.endPage) || 80)} 页`
          : `${bounded(input.sheet || '工作表', 100)} ${bounded(input.range || (Array.isArray(input.cells) ? input.cells.join(', ') : '已用区域'), 300)}`
        const reference = { type: event.name === 'read_pdf' ? 'pdf_pages' : 'spreadsheet_cells', label: `${file} · ${location}`, sourceId: key, path: file, ...(event.name === 'read_pdf' ? { page: Math.max(1, Number(input.startPage) || 1) } : { cell: bounded(input.range || input.cells?.[0], 100) }) }
        if (!evidence.some((item) => item.type === reference.type && item.sourceId === key)) evidence.push(reference)
      }
    }
    this.patch(id, { steps: steps.slice(0, 80), evidence: evidence.slice(0, 80) })
  }

  fail(id, error, code = classifyOfficeTaskError(error)) {
    const task = this.get(id)
    if (!task) return null
    return this.patch(id, { status: 'failed', errorCode: code, error: error instanceof Error ? error.message : String(error), attempts: task.attempts + 1 })
  }

  addSearchDocument({ botId, taskId, sourceType, sourceId, title, body, filePath = '', fingerprint = '' }) {
    const task = this.get(taskId)
    if (!task || task.botId !== botId) throw new Error('不能向其他 Bot 的知识索引写入内容。')
    const id = createHash('sha256').update(`${botId}\0${sourceType}\0${sourceId}`).digest('hex')
    const prior = this.db.prepare('SELECT fingerprint FROM office_search_documents WHERE id=?').get(id)
    if (prior?.fingerprint === fingerprint && fingerprint) return id
    this.db.prepare('DELETE FROM office_search_fts WHERE document_id=?').run(id)
    this.db.prepare(`INSERT INTO office_search_documents (id,bot_id,task_id,source_type,source_id,title,file_path,fingerprint,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,title=excluded.title,file_path=excluded.file_path,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`).run(
      id, botId, taskId, sourceType, sourceId, bounded(title, 240), filePath, fingerprint, iso(),
    )
    this.db.prepare('INSERT INTO office_search_fts (document_id,title,body) VALUES (?,?,?)').run(id, bounded(title, 240), bounded(body, 120_000))
    return id
  }

  async indexFile({ botId, taskId, filePath, workspacePath, title = '' }) {
    const resolved = fs.realpathSync.native(path.resolve(filePath))
    const workspace = fs.realpathSync.native(path.resolve(workspacePath))
    if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) throw new Error('只能索引所属工作区内的文件。')
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('知识索引目标不是文件。')
    const extension = path.extname(resolved).toLowerCase()
    let body = ''
    if (TEXT_EXTENSIONS.has(extension) && stat.size <= MAX_INDEX_BYTES) body = fs.readFileSync(resolved, 'utf8')
    else if (extension === '.pdf') body = formatPdfExtraction(await extractPdfText(resolved, { endPage: 80, maxCharacters: 80_000 })).text
    else if (OFFICE_EXTENSIONS.has(extension)) {
      const tool = this.officeWorkspace?.toolPaths?.find((candidate) => {
        try { return fs.statSync(candidate).isFile() } catch { return false }
      })
      if (!tool) return null
      const result = await runOfficeCommand(tool, ['view', resolved, 'text'], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })
      body = String(result.stdout || '').slice(0, 120_000)
    }
    else return null
    const fingerprint = `${stat.size}:${stat.mtimeMs}`
    return this.addSearchDocument({ botId, taskId, sourceType: 'file', sourceId: resolved, title: title || path.basename(resolved), body, filePath: resolved, fingerprint })
  }

  search({ botId, query, limit = 20 }) {
    if (!botId) throw new Error('知识检索必须指定 Bot。')
    const terms = String(query || '').trim().split(/\s+/).filter(Boolean).slice(0, 12)
    if (!terms.length) return []
    if (terms.some((term) => [...term].length < 3)) {
      const needle = `%${String(query).trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`
      return this.db.prepare(`SELECT d.id, d.task_id AS taskId, d.source_type AS sourceType, d.source_id AS sourceId,
        d.title, d.file_path AS filePath, d.updated_at AS updatedAt,
        substr(f.body, 1, 250) AS snippet
        FROM office_search_fts f JOIN office_search_documents d ON d.id=f.document_id
        WHERE d.bot_id=? AND (f.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\')
        ORDER BY d.updated_at DESC LIMIT ?`).all(botId, needle, needle, Math.min(50, Math.max(1, Number(limit) || 20)))
    }
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ')
    return this.db.prepare(`SELECT d.id, d.task_id AS taskId, d.source_type AS sourceType, d.source_id AS sourceId,
      d.title, d.file_path AS filePath, d.updated_at AS updatedAt,
      snippet(office_search_fts, 2, '【', '】', '…', 32) AS snippet
      FROM office_search_fts JOIN office_search_documents d ON d.id=office_search_fts.document_id
      WHERE office_search_fts MATCH ? AND d.bot_id=? ORDER BY bm25(office_search_fts) LIMIT ?`).all(expression, botId, Math.min(50, Math.max(1, Number(limit) || 20)))
  }

  close() { /* Database owner closes the shared connection. */ }
}
