import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { McpService } from '../electron/services/mcp-service.mjs'

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-mcp-'))
const secretValues = new Map()
const secrets = {
  get: (key) => secretValues.get(key) || {},
  set: (key, value, clear = []) => {
    const next = { ...(secretValues.get(key) || {}), ...value }
    for (const name of clear) delete next[name]
    secretValues.set(key, next)
  },
}
const requests = []
const server = http.createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body)
  requests.push({ payload, headers: request.headers })
  if (payload.method === 'initialize') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'zsense-test-session' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }))
    return
  }
  assert.equal(request.headers['mcp-session-id'], 'zsense-test-session')
  if (payload.method === 'notifications/initialized') {
    response.writeHead(202)
    response.end()
    return
  }
  if (payload.method === 'tools/list') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [{ name: 'echo', description: '回显内容', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }))
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: payload.params.arguments.text }] } })}\n\n`)
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
const service = new McpService({ rootPath: temporaryDirectory, secrets })

try {
  service.configure({ id: 'test-http', name: 'Test HTTP', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, enabled: true, oauthToken: 'test-token' })
  const tools = await service.listTools('test-http', true)
  assert.equal(tools[0].name, 'echo')
  assert.equal(requests[0].headers.authorization, 'Bearer test-token')
  assert.deepEqual(requests.slice(0, 3).map((item) => item.payload.method), ['initialize', 'notifications/initialized', 'tools/list'])
  const result = await service.callTool('test-http', 'echo', { text: '你好 MCP' })
  assert.equal(result.content[0].text, '你好 MCP')
  assert.equal(service.inspect().connectedCount, 1)
  assert.equal(service.inspect().enabledCount, 1)
  assert.match(service.inspect().lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  const removed = service.remove('test-http')
  assert.deepEqual(removed, [])
  console.log(JSON.stringify({ ok: true, streamableHttp: true, initialize: true, sessionHeader: true, sse: true, oauth: true }))
} finally {
  service.shutdown()
  server.close()
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
