import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const RPC_TIMEOUT_MS = 30_000

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temporary, filePath)
}

function safeJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function sanitizedEnvironment(extra = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key)))
  return { ...base, ...Object.fromEntries(Object.entries(extra || {}).map(([key, value]) => [String(key), String(value)])) }
}

function serverId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) throw new Error('MCP 服务器 ID 无效。')
  return id
}

function publicServer(server, status = {}) {
  const hideLocalCommand = Boolean(server.builtIn || server.locked)
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.transport === 'stdio' && !hideLocalCommand ? server.command : '',
    args: server.transport === 'stdio' && !hideLocalCommand ? server.args || [] : [],
    url: server.transport === 'http' ? server.url : '',
    enabled: server.enabled !== false,
    oauthConfigured: Boolean(server.oauthConfigured),
    builtIn: Boolean(server.builtIn),
    locked: Boolean(server.builtIn || server.locked),
    description: String(server.description || ''),
    ...status,
  }
}

function parseEventStream(text) {
  const payloads = String(text || '').split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data) return []
    try { return [JSON.parse(data)] } catch { return [] }
  })
  return payloads.findLast((item) => item && (item.result !== undefined || item.error || item.id !== undefined)) || payloads.at(-1)
}

class StdioMcpClient {
  constructor(server) {
    this.server = server
    this.child = null
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.nextId = 1
    this.initialized = false
    this.stderr = ''
  }

  start() {
    if (this.child && !this.child.killed) return
    this.child = spawn(this.server.command, this.server.args || [], {
      cwd: this.server.cwd || process.cwd(),
      env: sanitizedEnvironment(this.server.env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => this.#consume(chunk))
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-40_000) })
    this.child.on('error', (error) => this.#failAll(error))
    this.child.on('close', (code) => this.#failAll(new Error(`MCP 进程已退出，退出码 ${code}${this.stderr ? `：${this.stderr.slice(-2000)}` : ''}`)))
  }

  #failAll(error) {
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
    this.initialized = false
  }

  #deliver(message) {
    if (!message || message.id === undefined || message.id === null) return
    const item = this.pending.get(String(message.id))
    if (!item) return
    this.pending.delete(String(message.id)); clearTimeout(item.timer)
    if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)))
    else item.resolve(message.result)
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    while (this.buffer.length) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd >= 0 && /^content-length:/i.test(this.buffer.subarray(0, headerEnd).toString('utf8'))) {
        const header = this.buffer.subarray(0, headerEnd).toString('utf8')
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] || 0)
        if (!length || this.buffer.length < headerEnd + 4 + length) return
        const payload = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')
        this.buffer = this.buffer.subarray(headerEnd + 4 + length)
        try { this.#deliver(JSON.parse(payload)) } catch { /* ignore server log noise */ }
        continue
      }
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.subarray(0, newline).toString('utf8').trim()
      this.buffer = this.buffer.subarray(newline + 1)
      if (!line.startsWith('{')) continue
      try { this.#deliver(JSON.parse(line)) } catch { /* ignore malformed server logs */ }
    }
  }

  send(message) {
    this.start()
    const payload = `${JSON.stringify(message)}\n`
    this.child.stdin.write(payload)
  }

  request(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} 请求超时。`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async initialize() {
    if (this.initialized) return
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ZSense', version: '0.4.0' } })
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    this.initialized = true
  }

  close() {
    if (this.child && !this.child.killed) this.child.kill('SIGTERM')
    this.child = null; this.initialized = false
  }
}

export class McpService {
  constructor({ rootPath, secrets, builtInServers = [] }) {
    this.configPath = path.join(rootPath, 'mcp', 'servers.json')
    this.secrets = secrets
    this.builtInServers = new Map((builtInServers || []).map((server) => {
      const id = serverId(server.id || server.name)
      return [id, {
        ...server,
        id,
        name: String(server.name || id).slice(0, 120),
        transport: server.transport === 'http' ? 'http' : 'stdio',
        args: Array.isArray(server.args) ? server.args.map(String).slice(0, 40) : [],
        enabled: server.enabled !== false,
        builtIn: true,
        locked: true,
      }]
    }))
    this.clients = new Map()
    this.httpSessions = new Map()
    this.toolCache = new Map()
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
  }

  userServers() {
    const value = safeJson(fs.existsSync(this.configPath) ? fs.readFileSync(this.configPath, 'utf8') : '[]', [])
    return Array.isArray(value) ? value.filter((item) => item && item.id && ['stdio', 'http'].includes(item.transport) && !this.builtInServers.has(item.id)) : []
  }

  servers() { return [...this.builtInServers.values(), ...this.userServers()] }

  list() { return this.servers().map((server) => publicServer(server, { status: 'saved' })) }

  remove(value) {
    const id = serverId(value)
    if (this.builtInServers.has(id)) throw new Error('ZSense 内置 MCP 服务器不能删除。')
    const current = this.userServers()
    if (!current.some((item) => item.id === id)) throw new Error('MCP 服务器不存在。')
    this.clients.get(id)?.close(); this.clients.delete(id); this.httpSessions.delete(id); this.toolCache.delete(id)
    this.secrets?.set(`mcp:${id}`, {}, ['oauthToken'])
    this.save(current.filter((item) => item.id !== id))
    return this.list()
  }

  save(servers) { atomicJson(this.configPath, servers.filter((server) => !server.builtIn && !this.builtInServers.has(server.id))) }

  get(value) {
    const id = serverId(value)
    const server = this.servers().find((item) => item.id === id)
    if (!server || server.enabled === false) throw new Error('MCP 服务器不存在或已经停用。')
    return server
  }

  async #initializeHttp(server) {
    const current = this.httpSessions.get(server.id)
    if (current?.initialized) return current
    const state = current || { initialized: false, sessionId: '' }
    this.httpSessions.set(server.id, state)
    const result = await this.#httpRequest(server, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ZSense', version: '0.23.3' },
    }, { skipInitialize: true })
    state.initialized = true
    state.protocolVersion = result?.protocolVersion || '2025-06-18'
    await this.#httpRequest(server, 'notifications/initialized', {}, { notification: true, skipInitialize: true })
    return state
  }

  async #httpRequest(server, method, params = {}, options = {}) {
    if (!options.skipInitialize && method !== 'initialize') await this.#initializeHttp(server)
    let endpoint
    try { endpoint = new URL(server.url) } catch { throw new Error('MCP HTTP 地址无效。') }
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('MCP HTTP 只支持 http:// 或 https://。')
    const secret = this.secrets?.get(`mcp:${server.id}`) || {}
    const state = this.httpSessions.get(server.id)
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(server.headers || {}) }
    if (secret.oauthToken) headers.Authorization = `Bearer ${secret.oauthToken}`
    if (state?.sessionId) headers['Mcp-Session-Id'] = state.sessionId
    if (state?.protocolVersion) headers['MCP-Protocol-Version'] = state.protocolVersion
    const request = { jsonrpc: '2.0', ...(options.notification ? {} : { id: randomUUID() }), method, params }
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(request), signal: AbortSignal.timeout(RPC_TIMEOUT_MS), redirect: 'error' })
    const body = await response.text()
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}：${body.slice(0, 2000)}`)
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) {
      const next = this.httpSessions.get(server.id) || { initialized: false, sessionId: '' }
      next.sessionId = sessionId
      this.httpSessions.set(server.id, next)
    }
    if (options.notification || response.status === 202 || !body.trim()) return null
    let payload
    if (/text\/event-stream/i.test(response.headers.get('content-type') || '')) payload = parseEventStream(body)
    else payload = safeJson(body, null)
    if (!payload) throw new Error('MCP 服务器返回了无法识别的响应。')
    if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error))
    return payload.result
  }

  async #request(server, method, params = {}) {
    if (server.transport === 'http') return this.#httpRequest(server, method, params)
    let client = this.clients.get(server.id)
    if (!client) { client = new StdioMcpClient(server); this.clients.set(server.id, client) }
    await client.initialize()
    return client.request(method, params)
  }

  async listTools(value, force = false) {
    const server = this.get(value)
    const cached = this.toolCache.get(server.id)
    if (!force && cached && Date.now() - cached.storedAt < 5 * 60_000) return cached.tools
    const result = await this.#request(server, 'tools/list', {})
    const tools = Array.isArray(result?.tools) ? result.tools.map((entry) => ({ server: server.id, name: String(entry.name || ''), description: String(entry.description || ''), inputSchema: entry.inputSchema || { type: 'object' }, annotations: entry.annotations && typeof entry.annotations === 'object' ? entry.annotations : {} })).filter((entry) => entry.name) : []
    this.toolCache.set(server.id, { storedAt: Date.now(), tools })
    return tools
  }

  async callTool(serverValue, toolName, args) {
    const server = this.get(serverValue)
    const result = await this.#request(server, 'tools/call', { name: String(toolName || ''), arguments: args || {} })
    if (result?.isError) throw new Error((result.content || []).map((item) => item.text || '').filter(Boolean).join('\n') || 'MCP 工具执行失败。')
    return result
  }

  async searchTools(query) {
    const results = []
    for (const server of this.servers().filter((item) => item.enabled !== false)) {
      try {
        const tools = await this.listTools(server.id)
        for (const entry of tools) if (`${entry.name} ${entry.description} ${server.name}`.toLowerCase().includes(query)) results.push({ ...entry, source: 'mcp', toolset: `mcp-${server.id}` })
      } catch { /* one broken server must not hide healthy MCP tools */ }
    }
    return results
  }

  async manage(args) {
    const action = args.action
    if (action === 'list') return Promise.all(this.servers().map(async (server) => {
      try { const tools = await this.listTools(server.id); return publicServer(server, { status: 'connected', toolCount: tools.length }) }
      catch (error) { return publicServer(server, { status: 'error', toolCount: 0, error: error instanceof Error ? error.message : String(error) }) }
    }))
    if (action === 'add') {
      const id = serverId(args.id || args.name)
      if (this.builtInServers.has(id)) throw new Error('这个 ID 已由 ZSense 内置 MCP 使用。')
      const transport = args.transport === 'stdio' ? 'stdio' : 'http'
      if (transport === 'stdio' && !String(args.command || '').trim()) throw new Error('stdio MCP 必须填写可执行命令。')
      if (transport === 'http') {
        let url
        try { url = new URL(String(args.url || '').trim()) } catch { throw new Error('HTTP MCP 地址无效。') }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP MCP 地址必须使用 http:// 或 https://。')
      }
      const current = this.userServers()
      if (current.some((item) => item.id === id)) throw new Error('相同 ID 的 MCP 服务器已经存在。')
      const next = { id, name: String(args.name || id).slice(0, 120), transport, command: transport === 'stdio' ? String(args.command) : '', args: transport === 'stdio' && Array.isArray(args.args) ? args.args.map(String).slice(0, 40) : [], url: transport === 'http' ? String(args.url) : '', enabled: true, oauthConfigured: false }
      this.save([...current, next]); return publicServer(next, { status: 'saved' })
    }
    if (action === 'remove') {
      const id = serverId(args.id)
      this.remove(id); return { removed: id }
    }
    if (action === 'refresh' || action === 'test') {
      const tools = await this.listTools(args.id, true)
      return { server: args.id, connected: true, toolCount: tools.length, tools: action === 'refresh' ? tools : tools.slice(0, 10) }
    }
    throw new Error('不支持的 MCP 管理操作。')
  }

  configure(input) {
    const id = serverId(input.id || input.name)
    if (this.builtInServers.has(id)) throw new Error('ZSense 内置 MCP 服务器由应用管理，不能修改。')
    const current = this.userServers()
    const index = current.findIndex((item) => item.id === id)
    const transport = input.transport === 'stdio' ? 'stdio' : 'http'
    const next = {
      ...(index >= 0 ? current[index] : {}), id, name: String(input.name || id).slice(0, 120), transport,
      command: transport === 'stdio' ? String(input.command || '') : '', args: transport === 'stdio' && Array.isArray(input.args) ? input.args.map(String).slice(0, 40) : [],
      url: transport === 'http' ? String(input.url || '') : '', enabled: input.enabled !== false, oauthConfigured: Boolean(input.oauthToken || (index >= 0 && current[index].oauthConfigured && !input.clearOAuthToken)),
    }
    if (transport === 'stdio' && !next.command) throw new Error('stdio MCP 必须填写可执行命令。')
    if (transport === 'http') { const url = new URL(next.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP MCP 地址无效。') }
    if (index >= 0) current[index] = next; else current.push(next)
    this.save(current)
    this.clients.get(id)?.close(); this.clients.delete(id); this.httpSessions.delete(id); this.toolCache.delete(id)
    if (input.oauthToken || input.clearOAuthToken) this.secrets?.set(`mcp:${id}`, { oauthToken: String(input.oauthToken || '') }, input.clearOAuthToken ? ['oauthToken'] : [])
    return publicServer(next, { status: 'saved' })
  }

  inspect() {
    const servers = this.servers()
    const enabledIds = new Set(servers.filter((server) => server.enabled !== false).map((server) => server.id))
    const verified = [...this.toolCache.entries()].filter(([id]) => enabledIds.has(id))
    const latest = verified.reduce((value, [, entry]) => Math.max(value, Number(entry?.storedAt || 0)), 0)
    return {
      serverCount: servers.length,
      enabledCount: enabledIds.size,
      connectedCount: verified.length,
      lastVerifiedAt: latest ? new Date(latest).toISOString() : '',
    }
  }

  shutdown() {
    for (const client of this.clients.values()) client.close()
    this.clients.clear(); this.httpSessions.clear(); this.toolCache.clear()
  }
}
