import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { redactSensitiveText } from './redaction.mjs'
import { classifyOfficeTaskError } from './office-task-service.mjs'

const execFileAsync = promisify(execFile)

export const GATEWAY_HEALTH_CHECK_INTERVAL_MS = 30_000

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = 131584
const ILINK_CHANNEL_VERSION = '2.2.0'
const DINGTALK_ATTACHMENT_LIMIT = 8
const DINGTALK_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const DINGTALK_MEDIA_INDEX_MAX_ENTRIES = 2_000
const DINGTALK_MEDIA_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const DINGTALK_DOWNLOAD_ENDPOINT = 'https://api.dingtalk.com/v1.0/robot/messageFiles/download'
const DINGTALK_CARD_API_BASE = 'https://api.dingtalk.com'
const GATEWAY_ATTACHMENT_LIMIT = 8
const GATEWAY_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const DWS_AUTH_CACHE_MS = 30_000
const DWS_OUTPUT_MAX_BYTES = 8 * 1024 * 1024

function now() { return new Date().toISOString() }
function string(value) { return String(value ?? '').trim() }
function safeJson(value, fallback = {}) {
  try { return typeof value === 'string' ? JSON.parse(value) : value || fallback }
  catch { return fallback }
}
function list(value) {
  return [...new Set(string(value).split(/[\s,;，；]+/).map((item) => item.trim()).filter(Boolean))]
}
function titleFor(connection, userName) {
  return `${connection.name} · ${userName || '外部用户'}`.slice(0, 80)
}

function safeAttachmentName(value, fallback = '附件') {
  const name = path.basename(string(value) || fallback)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .trim()
  return (name || fallback).slice(0, 180)
}

function extensionForMimeType(mimeType) {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt' })[string(mimeType).toLowerCase()] || ''
}

function executableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.F_OK | fs.constants.X_OK)
    return true
  } catch { return false }
}

function runStreamingProcess(executable, args, { cwd, timeoutMs = 300_000, onOutput = () => undefined } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (error, code = null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else if (code !== 0) reject(new Error((stderr || stdout || `dws 退出码 ${code}`).trim()))
      else resolve({ stdout, stderr })
    }
    const append = (kind, chunk) => {
      const value = chunk.toString('utf8')
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') + Buffer.byteLength(value, 'utf8') > DWS_OUTPUT_MAX_BYTES) {
        child.kill('SIGTERM')
        finish(new Error('dws 输出超过安全上限。'))
        return
      }
      if (kind === 'stdout') stdout += value
      else stderr += value
      try { onOutput(`${stdout}\n${stderr}`) } catch { /* UI callback cannot interrupt auth */ }
    }
    child.stdout.on('data', (chunk) => append('stdout', chunk))
    child.stderr.on('data', (chunk) => append('stderr', chunk))
    child.once('error', (error) => finish(error))
    child.once('close', (code) => finish(null, code))
    timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('钉钉登录等待超时，请重新发起授权。')) }, timeoutMs)
    timer.unref?.()
  })
}

export function parseDwsAuthStatus(payload, { available = true, checkedAt = now() } = {}) {
  if (!available) return { available: false, authenticated: false, state: 'missing', message: '内置 dws 不可用，钉钉文件读取已停用。', checkedAt }
  const data = safeJson(payload, {})
  const profiles = Array.isArray(data?.profiles) ? data.profiles : []
  const currentProfileName = string(data?.currentProfile)
  const current = profiles.find((item) => item?.isCurrent === true)
    || profiles.find((item) => currentProfileName && string(item?.profile) === currentProfileName)
  const active = current && string(current.status).toLowerCase() === 'active' && (!current.expiresAt || Number(new Date(current.expiresAt)) > Date.now())
  if (active) {
    const accountLabel = [string(current.corpName), string(current.userName)].filter(Boolean).join(' · ') || '当前钉钉账号'
    return {
      available: true, authenticated: true, state: 'active',
      accountLabel, expiresAt: string(current.expiresAt), message: `${accountLabel} 已登录，dws 文件读取可用。`, checkedAt,
    }
  }
  const expired = Boolean(current || profiles.some((item) => string(item?.status).toLowerCase() === 'expired'))
  return {
    available: true, authenticated: false, state: expired ? 'expired' : 'missing',
    accountLabel: current ? [string(current.corpName), string(current.userName)].filter(Boolean).join(' · ') : '',
    expiresAt: string(current?.expiresAt),
    message: expired ? '钉钉登录已过期，请重新授权后再读取钉钉文件。' : '尚未登录钉钉，请先完成 dws 授权。', checkedAt,
  }
}

function resourceArgumentMap(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    const parsed = safeJson(value, null)
    if (parsed) return resourceArgumentMap(parsed)
    const tokens = value.match(/(?:[^\s"]+|"[^"]*")+/g) || []
    const result = {}
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index].replace(/^--/, '').replace(/^"|"$/g, '')
      if (!token) continue
      if (token.includes('=')) {
        const [key, ...rest] = token.split('=')
        result[key] = rest.join('=').replace(/^"|"$/g, '')
      } else if (tokens[index].startsWith('--') && tokens[index + 1] && !tokens[index + 1].startsWith('--')) result[token] = tokens[++index].replace(/^"|"$/g, '')
    }
    return result
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'object' && item)) return Object.fromEntries(value.map((item) => [string(item.name || item.key).replace(/^--/, ''), item.value]))
    return resourceArgumentMap(value.map(String).join(' '))
  }
  if (typeof value === 'object') return value
  return {}
}

export function collectDwsDingTalkResources(payload) {
  const resources = []
  const seen = new Set()
  const scan = (node, context = {}, depth = 0) => {
    if (depth > 10 || node === null || node === undefined) return
    if (typeof node === 'string') {
      const parsed = safeJson(node, null)
      if (parsed) scan(parsed, context, depth + 1)
      return
    }
    if (Array.isArray(node)) { node.forEach((item) => scan(item, context, depth + 1)); return }
    if (typeof node !== 'object') return
    const nodeMessageId = string(node.openMessageId || node.openMsgId || node.messageId || node.msgId || node.message_id || context.messageId)
    const nodeConversationId = string(node.openConversationId || node.conversationId || node.open_conversation_id || context.conversationId)
    const name = safeAttachmentName(node.fileName || node.filename || node.name || node.title || context.name, '钉钉附件')
    const add = (resourceId, type, argumentsValue = {}) => {
      const id = string(resourceId)
      const normalizedType = /file/i.test(string(type)) ? 'fileId' : 'mediaId'
      if (!id) return
      const args = resourceArgumentMap(argumentsValue)
      const messageId = string(args['message-id'] || args.messageId || args.openMessageId || nodeMessageId)
      const conversationId = string(args['open-conversation-id'] || args.openConversationId || nodeConversationId)
      const resourceName = safeAttachmentName(args['file-name'] || args.fileName || name, normalizedType === 'mediaId' ? '钉钉媒体' : '钉钉文件')
      const key = `${normalizedType}:${id}:${messageId}`
      if (seen.has(key)) return
      seen.add(key)
      resources.push({ resourceId: id, type: normalizedType, name: resourceName, mimeType: mimeTypeForAttachment(resourceName, node.mimeType || node.contentType), messageId, conversationId, quoted: Boolean(context.quoted) })
    }
    const directFileId = string(node.fileId || node.file_id)
    const directMediaId = string(node.mediaId || node.media_id || node.pictureDownloadCode)
    if (directFileId) add(directFileId, 'fileId')
    if (directMediaId) add(directMediaId, 'mediaId')
    if (node.download) {
      const args = resourceArgumentMap(node.download.arguments || node.download.args || node.download)
      add(args['resource-id'] || args.resourceId || args.fileId || args.mediaId, args.type || (args.fileId ? 'fileId' : 'mediaId'), args)
    }
    if (Array.isArray(node.resourceRefs)) node.resourceRefs.forEach((item) => scan(item, { ...context, messageId: nodeMessageId, conversationId: nodeConversationId, name, quoted: context.quoted }, depth + 1))
    for (const [key, value] of Object.entries(node)) {
      if (key === 'resourceRefs' || key === 'download') continue
      scan(value, { ...context, messageId: nodeMessageId, conversationId: nodeConversationId, name, quoted: context.quoted || /quoted|replied|reference|originalMessage/i.test(key) }, depth + 1)
    }
  }
  scan(payload)
  return resources.slice(0, DINGTALK_ATTACHMENT_LIMIT)
}

function localDwsTime(value) {
  const date = new Date(value || Date.now())
  const valid = Number.isFinite(date.getTime()) ? date : new Date()
  valid.setHours(valid.getHours() - 24)
  const part = (number) => String(number).padStart(2, '0')
  return `${valid.getFullYear()}-${part(valid.getMonth() + 1)}-${part(valid.getDate())} ${part(valid.getHours())}:${part(valid.getMinutes())}:${part(valid.getSeconds())}`
}

function dwsAttachmentFromPath(filePath, name, workspacePath) {
  const size = fs.statSync(filePath).size
  if (size > DINGTALK_ATTACHMENT_MAX_BYTES) { fs.unlinkSync(filePath); throw new Error('文件超过 50 MB 安全上限') }
  const mimeType = mimeTypeForAttachment(name)
  return { id: `dingtalk-dws-${randomUUID()}`, name, path: filePath, workspaceRelativePath: path.relative(path.resolve(workspacePath), filePath), size, mimeType, kind: mimeType.startsWith('image/') ? 'image' : 'file' }
}

function dwsDownloadedPath(result, workspacePath, outputDirectory) {
  const candidates = []
  const visit = (value, depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return
    if (typeof value === 'string') {
      if (/[/\\]|\.[a-z\d]{1,8}$/i.test(value)) candidates.push(value)
      return
    }
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1))
    if (typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:localPath|local_path|path|filePath|file_path)$/i.test(key) && typeof child === 'string') candidates.unshift(child)
      else visit(child, depth + 1)
    }
  }
  visit(result)
  const root = path.resolve(workspacePath)
  const safeOutputDirectory = path.resolve(root, outputDirectory)
  for (const candidate of candidates) {
    const resolved = path.resolve(root, candidate)
    if (resolved !== safeOutputDirectory && !resolved.startsWith(`${safeOutputDirectory}${path.sep}`)) continue
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
  }
  if (!fs.existsSync(safeOutputDirectory)) return ''
  const files = fs.readdirSync(safeOutputDirectory, { withFileTypes: true }).filter((entry) => entry.isFile())
  return files.length === 1 ? path.join(safeOutputDirectory, files[0].name) : ''
}

export async function resolveDingTalkAttachmentsViaDws({ runDws, workspacePath, chatId, messageId, createdAt, quotedMessageIds = [], rawMessage = {} }) {
  const resolvedWorkspacePath = path.resolve(workspacePath)
  const targetRoot = path.join(resolvedWorkspacePath, '.zsense', 'attachments')
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
  const notes = []
  const payloads = [rawMessage]
  const targetIds = [...new Set([messageId, ...quotedMessageIds].map(string).filter(Boolean))].slice(0, 20)
  if (targetIds.length) {
    try { payloads.push(await runDws(['chat', '+messages-mget', '--msg-ids', targetIds.join(','), '--format', 'json'])) }
    catch (error) { notes.push(`dws 按消息 ID 定位失败：${error instanceof Error ? error.message : '未知错误'}`) }
  }
  let resources = payloads.flatMap(collectDwsDingTalkResources)
  const targetSet = new Set(targetIds)
  if (targetSet.size) resources = resources.filter((item) => !item.messageId || targetSet.has(item.messageId) || item.quoted)
  if (!resources.length && string(chatId)) {
    try {
      const history = await runDws(['chat', '+messages-list', '--group', string(chatId), '--time', localDwsTime(createdAt), '--forward', '--limit', '60', '--format', 'json'])
      resources = collectDwsDingTalkResources(history).filter((item) => !item.messageId || targetSet.has(item.messageId) || item.quoted)
      if (!resources.length) notes.push('dws 已读取原始消息，但没有在当前消息或引用消息中找到可下载资源。')
    } catch (error) { notes.push(`dws 拉取原始消息失败：${error instanceof Error ? error.message : '未知错误'}`) }
  }
  const attachments = []
  const resolvedResourceIds = []
  const errors = []
  for (const resource of resources.slice(0, DINGTALK_ATTACHMENT_LIMIT)) {
    const fallbackExtension = resource.type === 'mediaId' ? extensionForMimeType(resource.mimeType) : ''
    const name = safeAttachmentName(resource.name, `${resource.type === 'mediaId' ? '钉钉媒体' : '钉钉文件'}${fallbackExtension}`)
    const outputDirectory = path.join('.zsense', 'attachments', `dws-${Date.now()}-${randomUUID()}`)
    const absoluteOutputDirectory = path.resolve(resolvedWorkspacePath, outputDirectory)
    fs.mkdirSync(absoluteOutputDirectory, { recursive: true, mode: 0o700 })
    const args = resource.type === 'fileId'
      ? ['chat', '+messages-resource-download', '--type', 'fileId', '--resource-id', resource.resourceId, '--output', outputDirectory, '-y', '--format', 'json']
      : ['chat', '+messages-resource-download', '--type', 'mediaId', '--resource-id', resource.resourceId, '--message-id', resource.messageId || string(messageId), '--open-conversation-id', resource.conversationId || string(chatId), '--output', outputDirectory, '-y', '--format', 'json']
    try {
      const result = await runDws(args, { cwd: resolvedWorkspacePath })
      const downloadedPath = dwsDownloadedPath(result, resolvedWorkspacePath, outputDirectory)
      if (!downloadedPath) throw new Error('dws 未返回可验证的本地文件路径')
      attachments.push(dwsAttachmentFromPath(downloadedPath, name, workspacePath))
      resolvedResourceIds.push(resource.resourceId)
      notes.push(`${resource.quoted ? '钉钉引用附件' : '钉钉附件'}：${name}（dws 已保存到工作区 ${path.relative(path.resolve(workspacePath), downloadedPath)}）`)
    } catch (error) {
      try { fs.rmSync(absoluteOutputDirectory, { recursive: true, force: true }) } catch { /* incomplete download cleanup */ }
      errors.push({ name, resourceId: resource.resourceId, message: error instanceof Error ? error.message : '未知错误' })
    }
  }
  return { attachments, notes, errors, resolvedResourceIds, resourceCount: resources.length }
}

export function normalizeDingTalkMarkdown(value) {
  const raw = String(value || '').replace(/\r\n?/g, '\n').replace(/<br\s*\/?\s*>/gi, '\n')
  const lines = raw.split('\n')
  const normalized = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) continue
    if (line.includes('|') && !/^\s*```/.test(line)) {
      const cells = line.split('|').map((item) => item.trim()).filter(Boolean)
      if (cells.length > 1) { normalized.push(cells.join(' · ')); continue }
    }
    normalized.push(line.replace(/<\/?(?:table|thead|tbody|tr|td|th)[^>]*>/gi, ' ').replace(/<(?!https?:\/\/)[^>]+>/g, ''))
  }
  const text = normalized.join('\n').replace(/\n{4,}/g, '\n\n\n').trim()
  return [...text].slice(0, 19_000).join('') || '（无文本内容）'
}

function dingTalkMarkdownTitle(text, fallback = 'ZSense Agent') {
  const first = normalizeDingTalkMarkdown(text).split('\n').map((line) => line.replace(/^\s*#{1,6}\s*/, '').replace(/[*_`>#-]/g, '').trim()).find(Boolean)
  return [...(first || fallback)].slice(0, 40).join('')
}

async function postDingTalkWebhook(sessionWebhook, text, { fetchImpl = fetch, title = '' } = {}) {
  if (!sessionWebhook) throw new Error('钉钉消息缺少临时回复地址。')
  const markdown = normalizeDingTalkMarkdown(text)
  const response = await fetchImpl(sessionWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title: title || dingTalkMarkdownTitle(markdown), text: markdown } }),
  })
  if (!response.ok) throw new Error(`钉钉回复失败（HTTP ${response.status}）。`)
  const body = safeJson(await response.text(), null)
  if (body && (body.success === false || (body.errcode !== undefined && Number(body.errcode) !== 0) || (body.code !== undefined && Number(body.code) !== 0))) {
    throw new Error(`钉钉未接受回复：${string(body.errmsg || body.message || body.code).slice(0, 200)}`)
  }
}

async function dingTalkAccessToken(client) {
  let token = await client.getAccessToken()
  if (token && typeof token === 'object') token = token.accessToken || token.access_token || token.token
  if (!string(token)) throw new Error('钉钉没有返回可用的访问令牌。')
  return string(token)
}

export const DINGTALK_EMOTION_NAMES = { thinking: '🤔Thinking', done: '🥳Done' }
const DINGTALK_EMOTION_ID = '2659900'
const DINGTALK_EMOTION_BACKGROUND_ID = 'im_bg_1'

/**
 * 钉钉没有“正在输入”接口，Hermes 的处理方式是给用户那条消息贴表情当已读回执：
 * 开始处理时贴 🤔Thinking，回复完成后撤回它再贴 🥳Done（单聊、群聊都生效）。
 * 这里用同一套参数，钉钉侧看到的效果就和 Hermes 一致，也不再需要发“已接收，正在思考”的消息。
 */
export function createDingTalkEmotionController({ client, robotCode, message, fetchImpl = fetch }) {
  const openMsgId = string(message?.msgId || message?.openMsgId)
  const openConversationId = string(message?.conversationId || message?.openConversationId)
  const code = string(robotCode)
  const send = async (action, emotionName) => {
    if (!code || !openMsgId || !openConversationId) return false
    const response = await fetchImpl(`${DINGTALK_CARD_API_BASE}/v1.0/robot/emotion/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': await dingTalkAccessToken(client) },
      body: JSON.stringify({
        robotCode: code,
        openMsgId,
        openConversationId,
        emotionType: 2,
        emotionName,
        textEmotion: { emotionId: DINGTALK_EMOTION_ID, emotionName, text: emotionName, backgroundId: DINGTALK_EMOTION_BACKGROUND_ID },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const responseText = await response.text()
    if (!response.ok || /"success"\s*:\s*false/i.test(responseText)) throw new Error(`钉钉表情请求失败（HTTP ${response.status}）：${responseText.slice(0, 200)}`)
    return true
  }
  // 表情失败（未开权限等）不影响对话本身，只打印一次警告
  const guard = async (operation, label) => {
    try { return await operation() }
    catch (error) {
      console.warn(`钉钉${label}未生效：`, error instanceof Error ? error.message : error)
      return false
    }
  }
  return {
    available: Boolean(code && openMsgId && openConversationId),
    thinking: () => guard(() => send('reply', DINGTALK_EMOTION_NAMES.thinking), '贴 🤔Thinking'),
    done: async () => {
      await guard(() => send('recall', DINGTALK_EMOTION_NAMES.thinking), '撤回 🤔Thinking')
      return guard(() => send('reply', DINGTALK_EMOTION_NAMES.done), '贴 🥳Done')
    },
    settle: () => guard(() => send('recall', DINGTALK_EMOTION_NAMES.thinking), '撤回 🤔Thinking'),
  }
}

export function createDingTalkReplyController({ client, robotCode, message, templateId = '', fetchImpl = fetch, emotions = null }) {
  const resolvedTemplateId = string(templateId)
  let card = null
  let cardUnavailable = false
  let lastCardStatusAt = 0
  const accessToken = () => dingTalkAccessToken(client)
  const call = async (method, endpoint, body) => {
    const response = await fetchImpl(`${DINGTALK_CARD_API_BASE}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': await accessToken() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const responseText = await response.text()
    if (!response.ok || /"success"\s*:\s*false/i.test(responseText)) throw new Error(`钉钉 AI 卡片请求失败（HTTP ${response.status}）：${responseText.slice(0, 240)}`)
    return responseText
  }
  const cardParams = (flowStatus, content) => ({ flowStatus, msgContent: normalizeDingTalkMarkdown(content), staticMsgContent: '', sys_full_json_obj: '{"order":["msgContent"]}', config: '{"autoLayout":true}' })
  const ensureCard = async () => {
    if (!resolvedTemplateId || cardUnavailable) return null
    if (card) return card
    const outTrackId = `zsense_${randomUUID()}`
    await call('POST', '/v1.0/card/instances', {
      cardTemplateId: resolvedTemplateId,
      outTrackId,
      cardData: { cardParamMap: { config: '{"autoLayout":true}' } },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    })
    const group = String(message.conversationType || '') === '2'
    const deliver = { outTrackId, userIdType: 1 }
    if (group) {
      deliver.openSpaceId = `dtv1.card//IM_GROUP.${message.conversationId}`
      deliver.imGroupOpenDeliverModel = { robotCode }
    } else {
      if (!message.senderStaffId) throw new Error('单聊 AI 卡片缺少 senderStaffId。')
      deliver.openSpaceId = `dtv1.card//IM_ROBOT.${message.senderStaffId}`
      deliver.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT', robotCode, extension: { dynamicSummary: 'true' } }
    }
    await call('POST', '/v1.0/card/instances/deliver', deliver)
    card = { outTrackId, createdAt: Date.now() }
    return card
  }
  const updateCard = async (text, { final = false, failed = false } = {}) => {
    const instance = await ensureCard()
    if (!instance) return false
    const now = Date.now()
    if (!final && !failed && lastCardStatusAt && now - lastCardStatusAt < 800) return true
    if (!final && !failed) lastCardStatusAt = now
    const content = normalizeDingTalkMarkdown(text)
    if (!final && !failed) await call('PUT', '/v1.0/card/instances', { outTrackId: instance.outTrackId, cardData: { cardParamMap: cardParams('2', content) } })
    await call('PUT', '/v1.0/card/streaming', { outTrackId: instance.outTrackId, guid: randomUUID(), key: 'msgContent', content, isFull: true, isFinalize: final || failed, isError: failed })
    if (final || failed) await call('PUT', '/v1.0/card/instances', { outTrackId: instance.outTrackId, cardData: { cardParamMap: cardParams(failed ? '5' : '3', content) }, cardUpdateOptions: { updateCardDataByKey: true } })
    return true
  }
  const withCardFallback = async (operation) => {
    try { return await operation() }
    catch (error) { cardUnavailable = true; console.warn('钉钉 AI 卡片不可用，已回退 Markdown：', error instanceof Error ? error.message : error); return false }
  }
  return {
    status: async (phase, statusText) => {
      // 配了 AI 卡片就把状态写进卡片；没有卡片则什么都不发：
      // 钉钉侧的“已读 / 处理中”由 🤔Thinking 表情承担（见 createDingTalkEmotionController），
      // 不再额外发一条“已接收，正在思考”的消息。
      await withCardFallback(() => updateCard(statusText))
    },
    reply: async (text) => {
      try {
        if (card && !cardUnavailable && await withCardFallback(() => updateCard(text, { final: true }))) return
        await postDingTalkWebhook(message.sessionWebhook, text, { fetchImpl })
      }
      finally {
        await emotions?.done?.()
      }
    },
    fail: async (text) => {
      try {
        if (card && !cardUnavailable && await withCardFallback(() => updateCard(text, { failed: true }))) return
        await postDingTalkWebhook(message.sessionWebhook, `> ❌ ${text}`, { fetchImpl, title: 'ZSense 处理失败' })
      }
      finally {
        await emotions?.settle?.()
      }
    },
  }
}

function mimeTypeForAttachment(name, declared = '') {
  if (string(declared)) return string(declared).split(';')[0].trim().toLowerCase()
  const types = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return types[path.extname(name).toLowerCase()] || 'application/octet-stream'
}

function dingTalkText(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  return string(value.content || value.text || value.title || value.markdown?.text)
}

export function collectDingTalkContent(message = {}) {
  const textParts = []
  const quotedTextParts = []
  const descriptors = []
  const seenCodes = new Set()
  const quotedMessageIds = new Set()
  const addText = (value, quoted = false) => {
    const normalized = dingTalkText(value)
    if (normalized && !(quoted ? quotedTextParts : textParts).includes(normalized)) (quoted ? quotedTextParts : textParts).push(normalized)
  }
  const scan = (node, { quoted = false, label = '钉钉消息' } = {}, depth = 0) => {
    if (depth > 4 || node === null || node === undefined) return
    if (typeof node === 'string') {
      const trimmed = node.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        const parsed = safeJson(trimmed, null)
        if (parsed) return scan(parsed, { quoted, label }, depth + 1)
      }
      return addText(node, quoted)
    }
    if (Array.isArray(node)) return node.forEach((item) => scan(item, { quoted, label }, depth + 1))
    if (typeof node !== 'object') return
    if (quoted) {
      const referencedMessageId = string(
        node.msgId || node.messageId || node.message_id || node.openMessageId || node.open_message_id
        || node.refMsgId || node.ref_msg_id || node.referenceMessageId || node.id,
      )
      if (referencedMessageId) quotedMessageIds.add(referencedMessageId)
    }
    addText(node.text, quoted)
    if (typeof node.content === 'string') addText(node.content, quoted)
    if (node.markdown) addText(node.markdown, quoted)
    const pictureDownloadCode = string(node.pictureDownloadCode || node.picture_download_code)
    const downloadCode = string(node.downloadCode || node.download_code || pictureDownloadCode)
    if (downloadCode && !seenCodes.has(downloadCode)) {
      seenCodes.add(downloadCode)
      const declaredName = string(node.fileName || node.filename || node.name || node.title)
      const mimeType = mimeTypeForAttachment(declaredName, node.contentType || node.mimeType || node.mime_type || (pictureDownloadCode ? 'image/png' : ''))
      descriptors.push({
        downloadCode,
        name: safeAttachmentName(declaredName, mimeType.startsWith('image/') ? '钉钉图片' : '钉钉附件'),
        mimeType,
        fileId: string(node.fileId || node.file_id || node.resourceId || node.resource_id),
        spaceId: string(node.spaceId || node.space_id),
        quoted,
        sourceLabel: label,
      })
    }
    for (const key of ['content', 'richText', 'rich_text', 'attachments', 'files', 'items', 'file', 'picture', 'image']) {
      if (node[key] !== undefined && typeof node[key] !== 'string') scan(node[key], { quoted, label }, depth + 1)
    }
  }

  addText(message.text)
  if (typeof message.content === 'string') addText(message.content)
  if (message.downloadCode || message.download_code || message.pictureDownloadCode || message.picture_download_code) scan({
    downloadCode: message.downloadCode || message.download_code,
    pictureDownloadCode: message.pictureDownloadCode || message.picture_download_code,
    fileName: message.fileName || message.filename || message.name,
    contentType: message.contentType || message.mimeType,
  }, { label: '当前钉钉消息' })
  scan(message.content, { label: '当前钉钉消息' })
  for (const key of ['file', 'picture', 'image', 'attachments', 'richText', 'rich_text']) scan(message[key], { label: '当前钉钉消息' })
  for (const key of ['quote', 'quoteMessage', 'quotedMessage', 'quoted_message', 'repliedMsg', 'repliedMessage', 'parentMessage', 'originalMessage', 'reference']) {
    if (message[key] !== undefined) scan(message[key], { quoted: true, label: '引用消息' })
  }
  if (message.text && typeof message.text === 'object') {
    for (const key of ['repliedMsg', 'repliedMessage', 'quoteMessage', 'quotedMessage', 'reference']) {
      if (message.text[key] !== undefined) scan(message.text[key], { quoted: true, label: '引用消息' })
    }
  }
  if (message.content && typeof message.content === 'object') {
    for (const key of ['quote', 'quoteMessage', 'quotedMessage', 'repliedMsg', 'repliedMessage', 'parentMessage', 'originalMessage', 'reference']) {
      if (message.content[key] !== undefined) scan(message.content[key], { quoted: true, label: '引用消息' })
    }
    if (message.content.quoteContent !== undefined) scan(message.content.quoteContent, { quoted: true, label: '引用消息' })
  }
  for (const referencedMessageId of [message.originalMsgId, message.original_msg_id, message.refMsgId, message.ref_msg_id]) {
    if (string(referencedMessageId)) quotedMessageIds.add(string(referencedMessageId))
  }
  return {
    text: textParts.join('\n').trim(),
    quotedText: quotedTextParts.join('\n').trim(),
    descriptors: descriptors.slice(0, DINGTALK_ATTACHMENT_LIMIT),
    quotedMessageIds: [...quotedMessageIds].slice(0, DINGTALK_ATTACHMENT_LIMIT),
  }
}

export async function downloadDingTalkAttachments(client, robotCode, descriptors, workspacePath, { fetchImpl = fetch } = {}) {
  const attachments = []
  const notes = []
  const targetRoot = path.join(path.resolve(workspacePath), '.zsense', 'attachments')
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
  let tokenValue = await client.getAccessToken()
  if (tokenValue && typeof tokenValue === 'object') tokenValue = tokenValue.accessToken || tokenValue.access_token || tokenValue.token
  const accessToken = string(tokenValue)
  if (!accessToken) throw new Error('钉钉没有返回可用的访问令牌，无法读取附件。')

  for (const descriptor of (descriptors || []).slice(0, DINGTALK_ATTACHMENT_LIMIT)) {
    try {
      const metadataResponse = await fetchImpl(DINGTALK_DOWNLOAD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
        body: JSON.stringify({ downloadCode: descriptor.downloadCode, robotCode }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!metadataResponse.ok) throw new Error(`获取下载地址失败（HTTP ${metadataResponse.status}）`)
      const metadata = safeJson(await metadataResponse.text(), {})
      const downloadUrl = string(metadata.downloadUrl || metadata.download_url || metadata.result?.downloadUrl)
      if (!downloadUrl) throw new Error('钉钉没有返回附件下载地址')
      const parsedUrl = new URL(downloadUrl)
      if (parsedUrl.protocol !== 'https:') throw new Error('钉钉返回了不安全的附件地址')
      const fileResponse = await fetchImpl(downloadUrl, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (!fileResponse.ok) throw new Error(`下载文件失败（HTTP ${fileResponse.status}）`)
      const declaredSize = Number(fileResponse.headers.get('content-length') || 0)
      if (declaredSize > DINGTALK_ATTACHMENT_MAX_BYTES) throw new Error('文件超过 50 MB 安全上限')
      const bytes = Buffer.from(await fileResponse.arrayBuffer())
      if (bytes.length > DINGTALK_ATTACHMENT_MAX_BYTES) throw new Error('文件超过 50 MB 安全上限')
      const responseType = fileResponse.headers.get('content-type') || ''
      const mimeType = mimeTypeForAttachment(descriptor.name, descriptor.mimeType === 'application/octet-stream' ? responseType : descriptor.mimeType)
      const extension = path.extname(descriptor.name)
      const defaultName = mimeType.startsWith('image/') ? `钉钉图片${extension}` : `钉钉附件${extension}`
      const name = safeAttachmentName(descriptor.name, defaultName)
      const fileName = `${Date.now()}-${randomUUID()}-${name}`
      const filePath = path.resolve(targetRoot, fileName)
      if (path.dirname(filePath) !== path.resolve(targetRoot)) throw new Error('附件名称不安全')
      fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: 'wx' })
      const workspaceRelativePath = path.relative(path.resolve(workspacePath), filePath)
      attachments.push({ id: `dingtalk-${randomUUID()}`, name, path: filePath, workspaceRelativePath, size: bytes.length, mimeType, kind: mimeType.startsWith('image/') ? 'image' : 'file' })
      notes.push(`${descriptor.quoted ? '钉钉引用附件' : '钉钉附件'}：${name}（已保存到工作区 ${workspaceRelativePath}）`)
    } catch (error) {
      notes.push(`${descriptor.quoted ? '钉钉引用附件' : '钉钉附件'} ${descriptor.name} 下载失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
  return { attachments, notes }
}

export async function downloadFeishuAttachments(client, message, workspacePath) {
  const resources = Array.isArray(message?.resources) ? message.resources.slice(0, GATEWAY_ATTACHMENT_LIMIT) : []
  const attachments = []
  const notes = []
  const targetRoot = path.join(path.resolve(workspacePath), '.zsense', 'attachments')
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
  for (const resource of resources) {
    try {
      const resourceType = resource.type === 'image' ? 'image' : 'file'
      let payload
      if (client.rawClient?.im?.v1?.messageResource?.get) {
        payload = await client.rawClient.im.v1.messageResource.get({
          path: { message_id: message.messageId, file_key: resource.fileKey },
          params: { type: resourceType },
        })
      }
      const declaredType = string(payload?.headers?.['content-type'] || payload?.headers?.get?.('content-type'))
      const mimeType = mimeTypeForAttachment(resource.fileName || '', declaredType || (resourceType === 'image' ? 'image/png' : 'application/octet-stream'))
      const fallbackName = resourceType === 'image' ? `飞书图片${extensionForMimeType(mimeType) || '.png'}` : `飞书附件${extensionForMimeType(mimeType)}`
      const name = safeAttachmentName(resource.fileName, fallbackName)
      const filePath = path.resolve(targetRoot, `${Date.now()}-${randomUUID()}-${name}`)
      if (path.dirname(filePath) !== path.resolve(targetRoot)) throw new Error('附件名称不安全')
      if (payload?.writeFile) {
        await payload.writeFile(filePath)
        fs.chmodSync(filePath, 0o600)
      }
      else if (typeof client.downloadResource === 'function') fs.writeFileSync(filePath, await client.downloadResource(resource.fileKey, resourceType), { mode: 0o600, flag: 'wx' })
      else throw new Error('当前飞书 SDK 不支持下载消息资源')
      const size = fs.statSync(filePath).size
      if (size > GATEWAY_ATTACHMENT_MAX_BYTES) {
        fs.unlinkSync(filePath)
        throw new Error('文件超过 50 MB 安全上限')
      }
      const workspaceRelativePath = path.relative(path.resolve(workspacePath), filePath)
      attachments.push({ id: `feishu-${randomUUID()}`, name, path: filePath, workspaceRelativePath, size, mimeType, kind: mimeType.startsWith('image/') ? 'image' : 'file' })
      notes.push(`飞书${resourceType === 'image' ? '图片' : '附件'}：${name}（已保存到工作区 ${workspaceRelativePath}）`)
    } catch (error) {
      notes.push(`飞书附件 ${resource.fileName || resource.fileKey || '未命名'} 下载失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
  return { attachments, notes }
}

export function stopDingTalkClient(client) {
  if (!client) return
  client.userDisconnect = true
  if (client.reconnectTimerId) clearTimeout(client.reconnectTimerId)
  if (client.heartbeatIntervallId !== undefined) clearInterval(client.heartbeatIntervallId)
  client.reconnectTimerId = undefined
  client.heartbeatIntervallId = undefined
  client.reconnecting = false
  client.reconnectAttempts = 0
  client.connected = false
  client.registered = false

  const socket = client.socket
  if (!socket) return
  const release = () => {
    if (client.socket !== socket) return
    socket.removeAllListeners?.()
    client.socket = undefined
  }
  if (socket.readyState >= 3) return release()
  socket.once?.('close', release)
  try { socket.terminate() }
  catch { release() }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

function ilinkHeaders(token = '') {
  const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64')
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function ilinkRequest(baseUrl, endpoint, { token = '', payload, signal } = {}) {
  const url = `${string(baseUrl || ILINK_BASE_URL).replace(/\/$/, '')}/${endpoint}`
  const response = await fetch(url, payload === undefined
    ? { headers: ilinkHeaders(token), signal }
    : {
        method: 'POST',
        headers: ilinkHeaders(token),
        body: JSON.stringify({ ...payload, base_info: { channel_version: ILINK_CHANNEL_VERSION } }),
        signal,
      })
  const body = await response.text()
  if (!response.ok) throw new Error(`微信 iLink 请求失败（HTTP ${response.status}）：${body.slice(0, 240)}`)
  const result = safeJson(body, null)
  if (!result) throw new Error('微信 iLink 返回了无法解析的数据。')
  return result
}

export class ZSenseGatewayService {
  constructor({ database, officeTaskService = null, officeWorkspace = null, agentCore, secrets, userDataDirectory, browserService = null, dwsToolPaths = [], onChanged = () => {}, notify = () => {} }) {
    this.database = database
    this.officeTaskService = officeTaskService
    this.officeWorkspace = officeWorkspace
    this.pendingOfficeDeliveries = new Map()
    this.agentCore = agentCore
    this.secrets = secrets
    this.browserService = browserService
    this.dwsToolPaths = dwsToolPaths
    this.onChanged = onChanged
    this.notify = notify
    this.root = path.join(userDataDirectory, 'agent-core', 'gateway')
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.authorizationPath = path.join(this.root, 'authorization.json')
    this.statePath = path.join(this.root, 'state.json')
    this.dingTalkMediaIndexPath = path.join(this.root, 'dingtalk-media-index.json')
    this.authorization = this.#loadAuthorization()
    this.dingTalkMediaIndex = this.#loadDingTalkMediaIndex()
    this.instances = new Map()
    this.qrLogins = new Map()
    this.contextTokens = new Map()
    this.monitorEnabled = false
    this.lastHealthCheckAt = null
    this.recoveryCount = 0
    this.lastError = null
    this.webhookServer = null
    this.webhookPort = null
    this.dwsAuthStatus = null
    this.dwsAuthCheckedAt = 0
    this.dwsAuthLoginPromise = null
  }

  #dwsToolPath() { return this.dwsToolPaths.find(executableFile) || '' }

  async #runDws(args, { timeout = 120_000, cwd = this.root } = {}) {
    const executable = this.#dwsToolPath()
    if (!executable) throw new Error('当前安装没有可用的内置 dws。')
    const values = Array.isArray(args) ? args.map(string).filter(Boolean) : []
    if (!values.length || values.length > 100) throw new Error('dws 参数无效。')
    if (!values.includes('--format')) values.push('--format', 'json')
    const executionDirectory = path.resolve(cwd || this.root)
    if (!fs.existsSync(executionDirectory) || !fs.statSync(executionDirectory).isDirectory()) throw new Error('dws 工作目录不存在或无法访问。')
    const result = await execFileAsync(executable, values, { cwd: executionDirectory, timeout, maxBuffer: DWS_OUTPUT_MAX_BYTES, windowsHide: true })
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    const parsed = safeJson(result.stdout, null)
    if (parsed?.error) throw new Error(string(parsed.error.message || parsed.error.reason || 'dws 执行失败。'))
    return parsed || output
  }

  async inspectDwsAuth({ force = false } = {}) {
    const checkedAt = now()
    const executable = this.#dwsToolPath()
    if (!executable) {
      this.dwsAuthStatus = parseDwsAuthStatus({}, { available: false, checkedAt })
      this.dwsAuthCheckedAt = Date.now()
      return this.dwsAuthStatus
    }
    if (!force && this.dwsAuthStatus && Date.now() - this.dwsAuthCheckedAt < DWS_AUTH_CACHE_MS) return { ...this.dwsAuthStatus }
    try {
      const payload = await this.#runDws(['profile', 'list', '--format', 'json'], { timeout: 20_000 })
      this.dwsAuthStatus = parseDwsAuthStatus(payload, { checkedAt })
    } catch (error) {
      this.dwsAuthStatus = { available: true, authenticated: false, state: 'error', message: `检查钉钉登录状态失败：${error instanceof Error ? error.message : '未知错误'}`, checkedAt }
    }
    this.dwsAuthCheckedAt = Date.now()
    return { ...this.dwsAuthStatus }
  }

  async startDwsAuthLogin() {
    if (this.dwsAuthLoginPromise) return this.dwsAuthLoginPromise
    const executable = this.#dwsToolPath()
    if (!executable) throw new Error('当前安装没有可用的内置 dws。')
    if (!this.browserService?.openTransient) throw new Error('ZSense 临时授权浏览器不可用。')
    this.dwsAuthStatus = { available: true, authenticated: false, state: 'authorizing', message: '等待你在钉钉授权页完成登录…', checkedAt: now() }
    this.dwsAuthCheckedAt = Date.now()
    const authBrowserKey = 'zsense-on-demand-dws-auth'
    this.dwsAuthLoginPromise = (async () => {
      let openedAuthorizationUrl = ''
      let browserOpenPromise = null
      try {
        await runStreamingProcess(executable, ['auth', 'login', '--no-browser', '--format', 'json'], {
          cwd: this.root,
          timeoutMs: 5 * 60_000,
          onOutput: (combined) => {
            if (openedAuthorizationUrl) return
            const urls = combined.match(/https?:\/\/[^\s"'<>\\]+/g) || []
            const authorizationUrl = urls.find((candidate) => {
              try {
                const normalized = candidate.replace(/[),.;]+$/, '')
                return !['127.0.0.1', 'localhost', '::1'].includes(new URL(normalized).hostname.toLowerCase())
              } catch { return false }
            })?.replace(/[),.;]+$/, '')
            if (!authorizationUrl) return
            openedAuthorizationUrl = authorizationUrl
            browserOpenPromise = this.browserService.openTransient(authBrowserKey, authorizationUrl, '钉钉授权 · ZSense').catch(() => { openedAuthorizationUrl = '' })
          },
        })
        const status = await this.inspectDwsAuth({ force: true })
        if (!status.authenticated) throw new Error(status.message || '钉钉授权尚未完成。')
        return status
      } finally {
        await browserOpenPromise?.catch?.(() => undefined)
        await this.browserService.close(authBrowserKey).catch(() => undefined)
      }
    })().catch((error) => {
      this.dwsAuthStatus = { available: true, authenticated: false, state: 'error', message: error instanceof Error ? error.message : '钉钉授权失败。', checkedAt: now() }
      this.dwsAuthCheckedAt = Date.now()
      throw error
    }).finally(() => { this.dwsAuthLoginPromise = null })
    return this.dwsAuthLoginPromise
  }

  async #resolveDingTalkAttachmentsWithDws(context, fallback) {
    let auth = await this.inspectDwsAuth()
    let primary = { attachments: [], notes: [], errors: [], resolvedResourceIds: [], resourceCount: 0 }
    if (!auth.authenticated && auth.available) {
      try { auth = await this.startDwsAuthLogin() }
      catch (error) { primary.notes.push(`dws 按需登录未完成：${error instanceof Error ? error.message : '未知错误'}`) }
    }
    if (auth.authenticated) {
      primary = await resolveDingTalkAttachmentsViaDws({
        ...context,
        runDws: (args, options) => this.#runDws(args, options),
      })
    } else {
      primary.notes.push(`dws 文件读取未启用：${auth.message}`)
    }
    const descriptors = Array.isArray(context.descriptors) ? context.descriptors : []
    const resolvedIds = new Set(primary.resolvedResourceIds || [])
    const resolvedNames = new Set((primary.attachments || []).map((item) => string(item.name).toLowerCase()))
    const unresolvedDescriptors = descriptors.filter((item) => string(item.downloadCode) && !resolvedIds.has(string(item.fileId || item.resourceId)) && !resolvedNames.has(string(item.name).toLowerCase()))
    if (!unresolvedDescriptors.length || typeof fallback !== 'function') {
      if (!primary.attachments.length && primary.errors?.length) {
        const names = [...new Set(primary.errors.map((item) => item.name).filter(Boolean))]
        primary.notes.push(`钉钉附件${names.length ? `“${names.join('、')}”` : ''}暂时无法下载，请稍后重试。`)
      }
      return primary
    }
    const secondary = await fallback(context.workspacePath, unresolvedDescriptors)
    const attachments = [...(primary.attachments || []), ...(secondary?.attachments || [])].slice(0, DINGTALK_ATTACHMENT_LIMIT)
    const secondaryNotes = (secondary?.notes || []).filter((note) => !/下载失败/.test(note))
    const failedNames = [...new Set([
      ...(primary.errors || []).map((item) => item.name),
      ...unresolvedDescriptors.map((item) => string(item.name)),
    ].filter(Boolean))]
    if (primary.errors?.length || (secondary?.notes || []).some((note) => /下载失败/.test(note))) {
      console.warn('钉钉附件下载候选失败，已在用户消息中合并错误：', JSON.stringify({ dws: primary.errors, fallback: (secondary?.notes || []).filter((note) => /下载失败/.test(note)) }))
    }
    return {
      attachments,
      notes: [
        ...(primary.notes || []),
        ...secondaryNotes,
        ...(attachments.length
          ? [primary.attachments?.length ? '部分附件已由机器人回调下载通道补全。' : '附件已由机器人回调下载通道取得。']
          : [`钉钉附件${failedNames.length ? `“${failedNames.join('、')}”` : ''}下载失败，dws 与机器人回调通道均未能取得文件。`]),
      ],
      errors: primary.errors || [],
      resolvedResourceIds: primary.resolvedResourceIds || [],
      resourceCount: primary.resourceCount || 0,
    }
  }

  #loadAuthorization() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.authorizationPath, 'utf8'))
      return { version: 1, pending: parsed.pending || {}, approved: parsed.approved || {} }
    } catch {
      return { version: 1, pending: {}, approved: {} }
    }
  }

  #saveAuthorization() { atomicWriteJson(this.authorizationPath, this.authorization) }

  #loadDingTalkMediaIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dingTalkMediaIndexPath, 'utf8'))
      return { version: 1, entries: parsed && typeof parsed.entries === 'object' ? parsed.entries : {} }
    } catch {
      return { version: 1, entries: {} }
    }
  }

  #dingTalkMediaKey(connectionId, chatId, messageId) {
    return JSON.stringify([string(connectionId), string(chatId), string(messageId)])
  }

  #pruneDingTalkMediaIndex() {
    const cutoff = Date.now() - DINGTALK_MEDIA_INDEX_TTL_MS
    const entries = Object.entries(this.dingTalkMediaIndex.entries || {})
      .filter(([, entry]) => Number(new Date(entry?.updatedAt || entry?.createdAt || 0)) >= cutoff)
      .sort((left, right) => Number(new Date(right[1]?.updatedAt || 0)) - Number(new Date(left[1]?.updatedAt || 0)))
      .slice(0, DINGTALK_MEDIA_INDEX_MAX_ENTRIES)
    this.dingTalkMediaIndex.entries = Object.fromEntries(entries)
  }

  #saveDingTalkMediaIndex() {
    this.#pruneDingTalkMediaIndex()
    atomicWriteJson(this.dingTalkMediaIndexPath, this.dingTalkMediaIndex)
  }

  #rememberDingTalkMedia(connectionId, chatId, messageId, descriptors) {
    const directDescriptors = (Array.isArray(descriptors) ? descriptors : [])
      .filter((item) => item && !item.quoted && string(item.downloadCode))
      .slice(0, DINGTALK_ATTACHMENT_LIMIT)
      .map((item) => ({
        downloadCode: string(item.downloadCode),
        name: safeAttachmentName(item.name),
        mimeType: mimeTypeForAttachment(item.name, item.mimeType),
        fileId: string(item.fileId),
        spaceId: string(item.spaceId),
        sourceLabel: string(item.sourceLabel) || '当前钉钉消息',
      }))
    if (!directDescriptors.length || !string(messageId)) return
    const timestamp = now()
    this.dingTalkMediaIndex.entries[this.#dingTalkMediaKey(connectionId, chatId, messageId)] = {
      connectionId: string(connectionId), chatId: string(chatId), messageId: string(messageId),
      descriptors: directDescriptors, createdAt: timestamp, updatedAt: timestamp,
    }
    this.#saveDingTalkMediaIndex()
  }

  #recallDingTalkMedia(connectionId, chatId, messageIds) {
    this.#pruneDingTalkMediaIndex()
    const recalled = []
    const seenCodes = new Set()
    for (const messageId of (Array.isArray(messageIds) ? messageIds : []).map(string).filter(Boolean)) {
      const entry = this.dingTalkMediaIndex.entries[this.#dingTalkMediaKey(connectionId, chatId, messageId)]
      for (const descriptor of (Array.isArray(entry?.descriptors) ? entry.descriptors : [])) {
        const downloadCode = string(descriptor.downloadCode)
        if (!downloadCode || seenCodes.has(downloadCode)) continue
        seenCodes.add(downloadCode)
        recalled.push({ ...descriptor, downloadCode, quoted: true, sourceLabel: '引用消息（本地索引）' })
      }
    }
    return recalled.slice(0, DINGTALK_ATTACHMENT_LIMIT)
  }

  #connection(connectionId) {
    const connection = this.database.getGatewayConnection(connectionId)
    if (!connection) throw new Error('机器人账号不存在或已被删除。')
    return connection
  }

  #configuredAllowedUsers(connection) {
    const key = `${connection.provider.toUpperCase()}_ALLOWED_USERS`
    return list(connection.config?.[key])
  }

  listPendingPairings(connectionId) {
    const connection = this.#connection(connectionId)
    return (this.authorization.pending[connectionId] || []).map((item) => ({ ...item, provider: connection.provider }))
  }

  listApprovedPairings(connectionId) {
    const connection = this.#connection(connectionId)
    return (this.authorization.approved[connectionId] || []).map((item) => ({ ...item, provider: connection.provider }))
  }

  renameApprovedPairing(connectionId, userId, userName) {
    const connection = this.#connection(connectionId)
    const approved = this.authorization.approved[connectionId] || []
    const user = approved.find((item) => item.userId === string(userId))
    if (!user) throw new Error('已授权用户不存在或已经被移除。')
    const nextName = string(userName).slice(0, 80)
    if (!nextName) throw new Error('用户名称不能为空。')
    user.userName = nextName
    user.renamedAt = now()
    this.authorization.approved[connectionId] = approved
    this.#saveAuthorization()
    return { ok: true, users: this.listApprovedPairings(connectionId), connection }
  }

  approvePairing(connectionId, requestId) {
    const connection = this.#connection(connectionId)
    const pending = this.authorization.pending[connectionId] || []
    const request = pending.find((item) => item.requestId === requestId)
    if (!request) throw new Error('待授权用户不存在或已经处理。')
    this.authorization.pending[connectionId] = pending.filter((item) => item.requestId !== requestId)
    const approved = this.authorization.approved[connectionId] || []
    if (!approved.some((item) => item.userId === request.userId)) {
      approved.push({ userId: request.userId, userName: request.userName, approvedAt: now() })
    }
    this.authorization.approved[connectionId] = approved
    this.#saveAuthorization()
    return { ok: true, pairings: this.listPendingPairings(connectionId), connection }
  }

  #authorize(connection, userId, userName) {
    const approved = this.authorization.approved[connection.id] || []
    const configured = this.#configuredAllowedUsers(connection)
    if (approved.some((item) => item.userId === userId) || configured.includes('*') || configured.includes(userId)) {
      if (!approved.some((item) => item.userId === userId)) {
        approved.push({ userId, userName, approvedAt: now() })
        this.authorization.approved[connection.id] = approved
        this.#saveAuthorization()
      }
      return true
    }
    const pending = this.authorization.pending[connection.id] || []
    if (!pending.some((item) => item.userId === userId)) {
      pending.push({ requestId: randomUUID(), userId, userName: userName || userId, createdAt: now() })
      this.authorization.pending[connection.id] = pending
      this.#saveAuthorization()
      this.notify('approval', 'ZSense 有新的网关授权请求', `${connection.name} 收到来自 ${userName || userId} 的消息，请在消息网关中确认授权。`)
      this.onChanged(this.database.loadWorkspace())
    }
    return false
  }

  #modelForBot(workspace, bot) {
    if (!bot.model) return workspace.modelConfiguration
    return workspace.availableModelConfigurations.find((item) => item.provider === bot.modelProvider && item.model === bot.model)
      || (workspace.modelConfiguration.provider === bot.modelProvider && workspace.modelConfiguration.model === bot.model ? workspace.modelConfiguration : null)
  }

  #modelSecret(configuration, workspace) {
    const scoped = this.secrets.get(`model:${configuration.provider}`)
    if (scoped.apiKey) return scoped
    return workspace.modelConfiguration.provider === configuration.provider ? this.secrets.get('model:default') : scoped
  }

  async receive({ connectionId, userId, userName = '', chatId = '', messageId = '', text = '', quotedText = '', attachments = [], attachmentDescriptors = [], quotedMessageIds = [], resolveAttachments = null, attachmentSourceLabel = '附件', createdAt = '', status = async () => {}, reply = async () => {}, sendFile = null, replyError = null }) {
    const connection = this.#connection(connectionId)
    const senderId = string(userId)
    const initialContent = string(text)
    const initialQuotedText = string(quotedText)
    if (!senderId || (!initialContent && !initialQuotedText && !attachments.length && !attachmentDescriptors.length && !quotedMessageIds.length)) return { accepted: false, reason: 'empty' }
    if (!this.#authorize(connection, senderId, string(userName) || senderId)) {
      await reply('消息已到达 ZSense，但该用户尚未授权。请在 ZSense 的“消息网关 → 入站用户授权”中确认。').catch(() => undefined)
      return { accepted: false, reason: 'authorization-pending' }
    }
    const workspace = this.database.loadWorkspace()
    const bot = workspace.bots.find((item) => item.id === connection.botId)
    if (!bot || bot.status !== 'online') return { accepted: false, reason: 'bot-offline' }
    const externalSessionId = `${connection.id}:${string(chatId) || senderId}`
    const externalMessageId = string(messageId) || randomUUID()
    const normalizedChatId = string(chatId) || senderId
    if (connection.provider === 'dingtalk') this.#rememberDingTalkMedia(connection.id, normalizedChatId, externalMessageId, attachmentDescriptors)
    const existingConversation = workspace.conversations.find((item) => item.botId === bot.id && item.channelId === connection.provider && item.externalThreadId === externalSessionId)
    if (existingConversation?.messages.some((item) => item.externalMessageId === externalMessageId)) return { accepted: false, reason: 'duplicate' }
    const workspacePath = existingConversation?.workspacePath || workspace.settings.defaultWorkspacePath || path.join(this.root, 'workspaces', bot.id)
    fs.mkdirSync(workspacePath, { recursive: true })
    const referencedIds = new Set((quotedMessageIds || []).map(string).filter(Boolean))
    const cachedQuotedDescriptors = connection.provider === 'dingtalk'
      ? this.#recallDingTalkMedia(connection.id, normalizedChatId, [...referencedIds])
      : []
    const restoredQuotedAttachments = referencedIds.size && existingConversation
      ? existingConversation.messages
        .filter((item) => referencedIds.has(string(item.externalMessageId)))
        .flatMap((item) => Array.isArray(item.attachments) ? item.attachments : [])
      : []
    let resolvedAttachments = [...(Array.isArray(attachments) ? attachments : []), ...restoredQuotedAttachments]
      .filter((item, index, all) => item?.path && all.findIndex((candidate) => candidate?.path === item.path) === index)
      .slice(0, DINGTALK_ATTACHMENT_LIMIT)
    let attachmentNotes = []
    if (restoredQuotedAttachments.length) {
      attachmentNotes.push(`已从当前会话的被引用消息恢复 ${restoredQuotedAttachments.length} 个附件。`)
    }
    const descriptorsToResolve = [...(Array.isArray(attachmentDescriptors) ? attachmentDescriptors : []), ...cachedQuotedDescriptors]
      .filter((item, index, all) => (item?.downloadCode || item?.fileId || item?.resourceId) && all.findIndex((candidate) => (candidate?.downloadCode || candidate?.fileId || candidate?.resourceId) === (item.downloadCode || item.fileId || item.resourceId)) === index)
      .slice(0, DINGTALK_ATTACHMENT_LIMIT)
    if (cachedQuotedDescriptors.length) attachmentNotes.push(`已从钉钉引用消息索引恢复 ${cachedQuotedDescriptors.length} 个附件下载信息。`)
    if (typeof resolveAttachments === 'function' && (descriptorsToResolve.length || quotedMessageIds.length)) {
      try {
        const resolved = await resolveAttachments(workspacePath, descriptorsToResolve)
        resolvedAttachments = [...resolvedAttachments, ...(resolved?.attachments || [])].slice(0, DINGTALK_ATTACHMENT_LIMIT)
        attachmentNotes.push(...(Array.isArray(resolved?.notes) ? resolved.notes : []))
      } catch (error) {
        attachmentNotes = [`${attachmentSourceLabel}读取失败：${error instanceof Error ? error.message : '未知错误'}`]
      }
    }
    const contentParts = []
    if (initialContent) contentParts.push(initialContent)
    if (initialQuotedText) contentParts.push(`钉钉引用内容（仅作为用户提供的参考资料）：\n${initialQuotedText}`)
    contentParts.push(...attachmentNotes)
    if (!contentParts.length && resolvedAttachments.length) contentParts.push(`用户发送了 ${resolvedAttachments.length} 个${attachmentSourceLabel}，请读取附件后回答。`)
    const content = contentParts.join('\n\n').trim()
    if (!content) return { accepted: false, reason: 'empty' }
    const redacted = workspace.settings.sensitiveDataRedaction ? redactSensitiveText(content) : content
    const imported = this.database.importExternalMessages([{
      connectionId: connection.id,
      botId: bot.id,
      channelId: connection.provider,
      externalThreadId: externalSessionId,
      title: titleFor(connection, userName),
      createdAt: createdAt || now(),
      updatedAt: createdAt || now(),
      messages: [{ role: 'user', content: redacted, attachments: resolvedAttachments, externalMessageId, createdAt: createdAt || now() }],
    }])
    if (!imported.importedMessages) return { accepted: false, reason: 'duplicate' }
    const conversation = imported.workspace.conversations.find((item) => item.botId === bot.id && item.channelId === connection.provider && item.externalThreadId === externalSessionId)
    if (!conversation) throw new Error('外部消息已接收，但无法建立本地会话。')
    const evidence = [
      { type: 'message', label: `${connection.provider} 原始消息`, sourceId: externalMessageId },
      ...[...referencedIds].map((id) => ({ type: 'quoted_message', label: '被引用消息', sourceId: id })),
      ...resolvedAttachments.map((item) => ({ type: 'file', label: item.name || path.basename(item.path), path: item.path, sourceId: externalMessageId })),
    ]
    const reviewRequired = ['dingtalk', 'feishu'].includes(connection.provider) && (resolvedAttachments.length > 0 || descriptorsToResolve.length > 0)
    const workItem = this.officeTaskService?.create({
      botId: bot.id, conversationId: conversation.id, sourceChannel: connection.provider,
      sourceConnectionId: connection.id, sourceThreadId: normalizedChatId, sourceMessageId: externalMessageId,
      title: initialContent || resolvedAttachments[0]?.name || `${connection.provider} 文件任务`, request: redacted,
      evidence, reviewRequired,
    })
    if (workItem) this.officeTaskService.addSearchDocument({ botId: bot.id, taskId: workItem.id, sourceType: 'message', sourceId: externalMessageId, title: initialContent || '外部消息', body: redacted })
    if (this.officeTaskService && descriptorsToResolve.length && !resolvedAttachments.length) {
      const error = new Error('引用文件未能下载并验证，任务已停止；请检查钉钉/飞书文件权限或重新授权后重发。')
      if (workItem) this.officeTaskService.fail(workItem.id, error, 'missing_source')
      await (typeof replyError === 'function' ? replyError(error.message) : reply(error.message)).catch(() => undefined)
      this.onChanged(this.database.loadWorkspace())
      return { accepted: false, reason: 'attachment-unavailable', conversationId: conversation.id }
    }
    // 索引与 Agent 执行并行；只索引这个 Bot 已接收且位于本次工作区的文件。
    if (workItem) void Promise.allSettled(resolvedAttachments.map((item) => this.officeTaskService.indexFile({
      botId: bot.id, taskId: workItem.id, filePath: item.path, workspacePath, title: item.name,
    }))).then(() => this.officeTaskService.notify())
    const configuration = this.#modelForBot(imported.workspace, bot)
    if (!configuration?.model) {
      if (workItem) this.officeTaskService.fail(workItem.id, 'Bot 尚未配置可用模型。', 'configuration')
      throw new Error(`${bot.name} 尚未配置可用模型。`)
    }
    const credential = this.#modelSecret(configuration, imported.workspace)
    if (this.agentCore.requiresApiKey(configuration.provider) && !credential.apiKey) {
      if (workItem) this.officeTaskService.fail(workItem.id, '当前模型缺少 API Key。', 'configuration')
      throw new Error(`${bot.name} 当前模型缺少 API Key。`)
    }
    const requestId = `gateway:${connection.id}:${randomUUID()}`
    await status('thinking', '已接收，ZSense Agent 正在思考…\n\n正在处理请求，需要时将调用工具。').catch(() => undefined)
    const memories = (await this.database.memoryService.recallMemories(bot.id, redacted, {
      limit: imported.workspace.settings.memoryRecallLimit,
      characterBudget: Math.max(8_000, Math.min(24_000, Number(imported.workspace.settings.memoryRecallLimit || 24) * 600)),
    })).memories
    const skills = imported.workspace.skills.filter((skill) => skill.assignedBotIds.includes(bot.id))
    const legacyMessages = conversation.messages.slice(0, -1)
    const toolEvents = []
    const startedAt = Date.now()
    try {
      const result = await this.agentCore.chatStream({
        requestId,
        bot,
        message: redacted,
        model: configuration.model,
        modelProvider: configuration.provider,
        contextWindow: configuration.contextWindow || 0,
        apiKey: credential.apiKey || '',
        baseUrl: configuration.baseUrl || '',
        reasoningEffort: conversation.reasoningEffort || 'high',
        workspacePath,
        attachments: resolvedAttachments,
        runtimeSessionId: conversation.runtimeEngine === 'zsense-core' ? conversation.runtimeSessionId : '',
        legacyMessages,
        skills,
        memories,
        settings: imported.workspace.settings,
        appContext: {
          currentBot: { id: bot.id, name: bot.name, status: bot.status, modelProvider: configuration.provider, model: configuration.model },
          gatewayConnections: imported.workspace.gatewayConnections.filter((item) => item.botId === bot.id).map((item) => ({ id: item.id, name: item.name, provider: item.provider, status: item.status, configured: item.configured })),
          currentConversation: { id: conversation.id, botId: bot.id, kind: 'bot', workspacePath, modelProvider: configuration.provider, model: configuration.model },
          isolation: '当前上下文只属于本 Bot；不得查询、推断、转换或披露其他 Bot 的内容、状态、记忆、会话或网关。',
        },
        onEvent: (event) => {
          if (workItem && event.type === 'tool') this.officeTaskService.recordTool(workItem.id, event)
          if (event.type === 'started' && event.sessionId) this.database.setConversationRuntimeSession(conversation.id, 'zsense-core', event.sessionId)
          if (event.type === 'tool') {
            const previous = toolEvents.find((item) => item.toolId === event.toolId)
            if (previous) Object.assign(previous, event)
            else toolEvents.push({ ...event })
            if (event.status === 'running' && toolEvents.filter((item) => item.status === 'running').length === 1) void status('working', '已接收，ZSense Agent 正在思考…\n\n正在使用工具处理请求…').catch(() => undefined)
          }
        },
      })
      const output = imported.workspace.settings.sensitiveDataRedaction ? redactSensitiveText(result.output) : result.output
      const redactStepText = (value) => imported.workspace.settings.sensitiveDataRedaction ? redactSensitiveText(String(value || '')) : String(value || '')
      const agentSteps = Array.isArray(result.agentSteps) ? result.agentSteps.map((step) => ({
        ...step,
        reasoning: redactStepText(step.reasoning),
        content: redactStepText(step.content),
        error: redactStepText(step.error),
        tools: Array.isArray(step.tools) ? step.tools.map((tool) => ({ ...tool, detail: redactStepText(tool.detail), input: redactStepText(tool.input), output: redactStepText(tool.output) })) : [],
      })) : []
      this.database.setConversationRuntimeSession(conversation.id, 'zsense-core', result.sessionId)
      if (result.usage) this.database.updateConversationOptions(conversation.id, bot.id, { usage: result.usage, workspacePath })
      this.database.addMessage(conversation.id, 'assistant', output, {
        reasoning: imported.workspace.settings.sensitiveDataRedaction ? redactSensitiveText(result.reasoning || '') : result.reasoning || '',
        agentSteps,
        toolEvents,
        modelProvider: configuration.provider,
        model: configuration.model,
        durationMs: result.durationMs || Date.now() - startedAt,
        outputTokens: result.usage?.outputTokens,
      })
      this.database.completeConversation(bot.id, conversation.id, toolEvents)
      const discoveredArtifacts = this.officeWorkspace?.discoverArtifacts({ workspacePath, content: output, toolEvents, since: startedAt }) || []
      const verifiedArtifacts = discoveredArtifacts.map((artifact) => {
        try {
          const contents = fs.readFileSync(artifact.path)
          return { name: artifact.name, path: artifact.path, verified: true, size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') }
        } catch (error) {
          return { name: artifact.name, path: artifact.path, verified: false, error: error instanceof Error ? error.message : String(error) }
        }
      })
      if (verifiedArtifacts.some((item) => !item.verified)) throw new Error('生成文件重新读取失败，已暂停回传。')
      if (workItem && verifiedArtifacts.length) {
        this.officeTaskService.patch(workItem.id, { artifacts: verifiedArtifacts })
        for (const artifact of verifiedArtifacts) void this.officeTaskService.indexFile({ botId: bot.id, taskId: workItem.id, filePath: artifact.path, workspacePath, title: artifact.name }).catch(() => undefined)
      }
      if (workItem) this.officeTaskService.addSearchDocument({ botId: bot.id, taskId: workItem.id, sourceType: 'answer', sourceId: externalMessageId, title: initialContent || '外部消息处理结果', body: output })
      if (workItem) {
        const checkedEvidence = evidence.map((item) => {
          if (item.type !== 'file') return item
          try {
            const bytes = fs.readFileSync(item.path)
            return { ...item, verified: true, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
          } catch (error) {
            return { ...item, verified: false, error: error instanceof Error ? error.message : String(error) }
          }
        })
        if (checkedEvidence.some((item) => item.type === 'file' && !item.verified)) throw new Error('处理后复核来源文件失败，已暂停回传。')
        this.officeTaskService.advance(workItem.id, 'verify', 'completed')
        this.officeTaskService.patch(workItem.id, { evidence: checkedEvidence, output })
      }
      const shouldReview = reviewRequired || (workItem && verifiedArtifacts.length > 0 && ['dingtalk', 'feishu'].includes(connection.provider))
      if (shouldReview && workItem) {
        this.officeTaskService.patch(workItem.id, { status: 'review', deliveryStatus: 'review_required' })
        this.pendingOfficeDeliveries.set(workItem.id, { reply, sendFile, connectionId: connection.id, sourceMessageId: externalMessageId })
        await status('review', '处理结果已生成，等待你在 ZSense「任务工作台」审核并发送。').catch(() => undefined)
      } else {
        if (workItem) this.officeTaskService.patch(workItem.id, { status: 'delivering', deliveryStatus: 'sending' })
        await reply(output)
        if (workItem) this.officeTaskService.patch(workItem.id, {
          status: 'completed', deliveryStatus: 'accepted', deliveryReceipt: `${connection.provider}:${externalMessageId}`,
          steps: this.officeTaskService.get(workItem.id).steps.map((step) => step.id === 'deliver' ? { ...step, status: 'completed' } : step),
        })
      }
      if (imported.workspace.settings.autoExtractMemory) {
        void this.database.memoryService.retainUserMessage(bot.id, redacted, {
          conversationId: conversation.id, messageId: externalMessageId,
        }).then((result) => {
          if (result.stored) this.onChanged(this.database.loadWorkspace())
        }).catch((error) => console.warn('消息网关自动记忆整理失败：', error instanceof Error ? error.message : error))
      }
      this.onChanged(this.database.loadWorkspace())
      this.notify('completion', shouldReview ? `${bot.name} 的结果等待审核` : `${bot.name} 已回复外部消息`, `${connection.name} · ${userName || senderId}`)
      return { accepted: true, conversationId: conversation.id, output }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ZSense 消息网关处理失败。'
      if (workItem) this.officeTaskService.fail(workItem.id, error, classifyOfficeTaskError(error))
      this.database.addMessage(conversation.id, 'system', message)
      await (typeof replyError === 'function' ? replyError(`ZSense 处理失败：${message}`) : reply(`ZSense 处理失败：${message}`)).catch(() => undefined)
      this.onChanged(this.database.loadWorkspace())
      throw error
    }
  }

  async deliverOfficeTask(taskId) {
    if (!this.officeTaskService) throw new Error('任务工作台不可用。')
    const task = this.officeTaskService.get(taskId)
    if (!task || task.status !== 'review' || task.deliveryStatus !== 'review_required') throw new Error('这项任务当前不在待审核状态。')
    const pending = this.pendingOfficeDeliveries.get(taskId)
    if (!pending || pending.connectionId !== task.sourceConnectionId || pending.sourceMessageId !== task.sourceMessageId) {
      this.officeTaskService.patch(taskId, { status: 'interrupted', deliveryStatus: 'manual_required', errorCode: 'delivery_context_lost', error: '应用重启或网关重连后，原消息的安全回复通道已失效。请从原平台重新发起，不会盲目重发。' })
      throw new Error('原消息回复通道已失效，请从原平台重新发起；结果仍保留在任务工作台。')
    }
    this.officeTaskService.patch(taskId, { status: 'delivering', deliveryStatus: 'sending' })
    const receipt = safeJson(task.deliveryReceipt, { files: {}, text: '' })
    if (!receipt.files || typeof receipt.files !== 'object') receipt.files = {}
    try {
      for (const artifact of task.artifacts.filter((item) => item.verified)) {
        if (receipt.files[artifact.path]) continue
        if (typeof pending.sendFile !== 'function') break
        const sent = await pending.sendFile(artifact.path, artifact.name)
        receipt.files[artifact.path] = string(sent?.messageId || sent?.id) || 'accepted'
        this.officeTaskService.patch(taskId, { deliveryReceipt: JSON.stringify(receipt) })
      }
      if (!receipt.text) {
        const sent = await pending.reply(task.output)
        receipt.text = string(sent?.messageId || sent?.id) || 'accepted'
        this.officeTaskService.patch(taskId, { deliveryReceipt: JSON.stringify(receipt) })
      }
      this.pendingOfficeDeliveries.delete(taskId)
      const missingFiles = task.artifacts.filter((item) => item.verified && !receipt.files[item.path])
      const steps = task.steps.map((step) => step.id === 'deliver' ? { ...step, status: missingFiles.length ? 'failed' : 'completed' } : step)
      return this.officeTaskService.patch(taskId, {
        status: missingFiles.length ? 'interrupted' : 'completed', deliveryStatus: missingFiles.length ? 'text_only' : 'accepted',
        deliveryReceipt: JSON.stringify(receipt), steps,
        errorCode: missingFiles.length ? 'file_delivery_unavailable' : '',
        error: missingFiles.length ? `${task.sourceChannel} 的当前机器人通道只确认了文字结果，${missingFiles.length} 个产物文件仍在本地，未冒充文件已发送。` : '',
      })
    } catch (error) {
      this.officeTaskService.patch(taskId, { status: 'review', deliveryStatus: 'review_required', deliveryReceipt: JSON.stringify(receipt), errorCode: classifyOfficeTaskError(error), error: error instanceof Error ? error.message : String(error), attempts: task.attempts + 1 })
      throw error
    }
  }

  async #startTelegram(connection, config, secret) {
    const { Bot } = await import('grammy')
    const bot = new Bot(secret.TELEGRAM_BOT_TOKEN)
    let running = true
    bot.on('message:text', (ctx) => this.receive({
      connectionId: connection.id,
      userId: String(ctx.from?.id || ''),
      userName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username || '',
      chatId: String(ctx.chat?.id || ''),
      messageId: String(ctx.message?.message_id || ''),
      text: ctx.message?.text || '',
      createdAt: ctx.message?.date ? new Date(ctx.message.date * 1000).toISOString() : now(),
      reply: (message) => ctx.reply(message),
    }).catch((error) => console.error('Telegram 入站消息处理失败：', error)))
    void bot.start({ drop_pending_updates: false }).catch((error) => {
      running = false
      this.#markFailed(connection.id, error)
    })
    return { client: bot, stop: () => { running = false; return bot.stop() }, healthy: () => running }
  }

  async #startDiscord(connection, config, secret) {
    const { Client, GatewayIntentBits, Partials } = await import('discord.js')
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    })
    client.on('messageCreate', (message) => {
      if (message.author?.bot || !message.content) return
      void this.receive({
        connectionId: connection.id,
        userId: message.author.id,
        userName: message.member?.displayName || message.author.globalName || message.author.username,
        chatId: message.channelId,
        messageId: message.id,
        text: message.content,
        createdAt: message.createdAt?.toISOString() || now(),
        reply: (content) => message.reply(content.slice(0, 1_950)),
      }).catch((error) => console.error('Discord 入站消息处理失败：', error))
    })
    await client.login(secret.DISCORD_BOT_TOKEN)
    return { client, stop: () => client.destroy(), healthy: () => client.isReady() }
  }

  async #startSlack(connection, config, secret) {
    const [{ SocketModeClient }, { WebClient }] = await Promise.all([import('@slack/socket-mode'), import('@slack/web-api')])
    const client = new SocketModeClient({ appToken: secret.SLACK_APP_TOKEN })
    const web = new WebClient(secret.SLACK_BOT_TOKEN)
    let connected = false
    client.on('connected', () => { connected = true })
    client.on('disconnected', () => { connected = false })
    client.on('message', async ({ event, ack }) => {
      await ack().catch(() => undefined)
      if (!event?.text || event.bot_id || event.subtype) return
      void this.receive({
        connectionId: connection.id,
        userId: event.user || '',
        userName: event.user || '',
        chatId: event.channel || '',
        messageId: event.client_msg_id || event.ts || '',
        text: event.text,
        createdAt: event.ts ? new Date(Number(event.ts) * 1000).toISOString() : now(),
        reply: (text) => web.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts || event.ts, text }),
      }).catch((error) => console.error('Slack 入站消息处理失败：', error))
    })
    await client.start()
    connected = true
    return { client, stop: () => { connected = false; return client.disconnect() }, healthy: () => connected }
  }

  async #startFeishu(connection, config, secret) {
    const { createLarkChannel } = await import('@larksuiteoapi/node-sdk')
    const client = createLarkChannel({ appId: config.FEISHU_APP_ID, appSecret: secret.FEISHU_APP_SECRET, transport: 'websocket', includeRawEvent: true, source: 'zsense' })
    client.on('message', (message) => {
      let statusSent = false
      void this.receive({
        connectionId: connection.id,
        userId: message.senderId,
        userName: message.senderName || message.senderId,
        chatId: message.chatId,
        messageId: message.messageId,
        text: message.content,
        attachmentDescriptors: message.resources || [],
        resolveAttachments: (workspacePath) => downloadFeishuAttachments(client, message, workspacePath),
        attachmentSourceLabel: '飞书附件',
        createdAt: message.createTime ? new Date(message.createTime).toISOString() : now(),
        status: async (phase, text) => {
          if (statusSent && phase !== 'review') return
          statusSent = true
          await client.send(message.chatId, { text: `⏳ ${text}` }, { replyTo: message.messageId })
        },
        reply: (text) => client.send(message.chatId, { markdown: text }, { replyTo: message.messageId }),
        sendFile: (filePath, fileName) => client.send(message.chatId, { file: { source: filePath, fileName } }, { replyTo: message.messageId }),
        replyError: (text) => client.send(message.chatId, { text: `❌ ${text}` }, { replyTo: message.messageId }),
      }).catch((error) => console.error('飞书入站消息处理失败：', error))
    })
    client.on('error', (error) => this.#markFailed(connection.id, error))
    await client.connect()
    return { client, stop: () => client.disconnect(), healthy: () => ['open', 'connected', 'ready'].includes(string(client.getConnectionStatus()?.state).toLowerCase()) || Boolean(client.rawWsClient) }
  }

  async #startDingTalk(connection, config, secret) {
    const { DWClient, TOPIC_ROBOT } = await import('dingtalk-stream')
    const client = new DWClient({ clientId: config.DINGTALK_CLIENT_ID, clientSecret: secret.DINGTALK_CLIENT_SECRET, keepAlive: true })
    client.registerCallbackListener(TOPIC_ROBOT, (downstream) => {
      try { client.socketCallBackResponse(downstream.headers.messageId, { status: 'SUCCESS' }) } catch { /* optional acknowledgement */ }
      const message = safeJson(downstream.data, {})
      const content = collectDingTalkContent(message)
      const dwsResources = collectDwsDingTalkResources(message)
      if (!content.text && !content.quotedText && !content.descriptors.length && !content.quotedMessageIds.length && !dwsResources.length) return
      const emotions = createDingTalkEmotionController({ client, robotCode: config.DINGTALK_CLIENT_ID, message })
      const responder = createDingTalkReplyController({ client, robotCode: config.DINGTALK_CLIENT_ID, message, templateId: config.DINGTALK_AI_CARD_TEMPLATE_ID, emotions })
      // 立刻贴 🤔Thinking：钉钉没有“正在输入”，这相当于已读回执
      void emotions.thinking()
      const messageId = message.msgId || downstream.headers.messageId
      const chatId = message.conversationId || message.senderId || ''
      const createdAt = message.createAt ? new Date(message.createAt).toISOString() : now()
      const fallbackAttachmentDownload = (workspacePath, descriptors) => downloadDingTalkAttachments(client, config.DINGTALK_CLIENT_ID, descriptors, workspacePath)
      void this.receive({
        connectionId: connection.id,
        userId: message.senderStaffId || message.senderId || '',
        userName: message.senderNick || '',
        chatId,
        messageId,
        text: content.text,
        quotedText: content.quotedText,
        attachmentDescriptors: [...content.descriptors, ...dwsResources.map((item) => ({ ...item, fileId: item.type === 'fileId' ? item.resourceId : '' }))],
        quotedMessageIds: content.quotedMessageIds,
        resolveAttachments: (workspacePath, descriptors) => this.#resolveDingTalkAttachmentsWithDws({
          workspacePath, descriptors, chatId, messageId, createdAt,
          quotedMessageIds: content.quotedMessageIds,
          rawMessage: message,
        }, fallbackAttachmentDownload),
        attachmentSourceLabel: '钉钉附件',
        createdAt,
        status: responder.status,
        reply: responder.reply,
        replyError: responder.fail,
      }).catch((error) => console.error('钉钉入站消息处理失败：', error))
    })
    await client.connect()
    return { client, stop: () => stopDingTalkClient(client), healthy: () => Boolean(client.connected) }
  }

  async #startWeCom(connection, config, secret) {
    const { WSClient } = await import('@wecom/aibot-node-sdk')
    const client = new WSClient({ botId: config.WECOM_BOT_ID, secret: secret.WECOM_SECRET, ...(config.WECOM_WEBSOCKET_URL ? { wsUrl: config.WECOM_WEBSOCKET_URL } : {}) })
    let authenticated = false
    client.on('authenticated', () => { authenticated = true })
    client.on('disconnected', () => { authenticated = false })
    client.on('error', (error) => {
      authenticated = false
      this.#markFailed(connection.id, error)
    })
    client.on('message.text', (frame) => {
      const message = frame?.body || frame || {}
      const userId = message.from?.userid || message.from?.user_id || message.userid || ''
      const streamId = `zsense-${randomUUID()}`
      void this.receive({
        connectionId: connection.id,
        userId,
        userName: message.from?.name || userId,
        chatId: message.chatid || userId,
        messageId: frame?.headers?.req_id || message.msgid || randomUUID(),
        text: message.text?.content || '',
        createdAt: message.create_time ? new Date(Number(message.create_time) * 1000).toISOString() : now(),
        reply: (text) => client.replyStream(frame, streamId, text, true),
      }).catch((error) => console.error('企业微信入站消息处理失败：', error))
    })
    await new Promise((resolve, reject) => {
      let timeout
      const cleanup = () => { clearTimeout(timeout); client.off('authenticated', ready); client.off('error', failed) }
      const ready = () => { cleanup(); resolve() }
      const failed = (error) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))) }
      timeout = setTimeout(() => failed(new Error('企业微信长连接认证超时。')), 30_000)
      client.once('authenticated', ready)
      client.once('error', failed)
      try { client.connect() } catch (error) { failed(error) }
    })
    authenticated = true
    return { client, stop: () => { authenticated = false; return client.disconnect() }, healthy: () => authenticated }
  }

  async #startWeixin(connection, config, secret) {
    const controller = new AbortController()
    const baseUrl = config.WEIXIN_BASE_URL || ILINK_BASE_URL
    let syncBuffer = ''
    let running = true
    const loop = async () => {
      while (running && !controller.signal.aborted) {
        try {
          const result = await ilinkRequest(baseUrl, 'ilink/bot/getupdates', { token: secret.WEIXIN_TOKEN, payload: { get_updates_buf: syncBuffer }, signal: controller.signal })
          if (result.get_updates_buf) syncBuffer = String(result.get_updates_buf)
          for (const message of result.msgs || []) {
            const senderId = string(message.from_user_id)
            if (!senderId || senderId === config.WEIXIN_ACCOUNT_ID) continue
            const content = (message.item_list || []).map((item) => item?.text_item?.text || '').filter(Boolean).join('\n').trim()
            if (!content) continue
            const contextToken = string(message.context_token)
            if (contextToken) this.contextTokens.set(`${connection.id}:${senderId}`, contextToken)
            void this.receive({
              connectionId: connection.id,
              userId: senderId,
              userName: senderId,
              chatId: string(message.room_id || message.chat_room_id || senderId),
              messageId: string(message.message_id) || randomUUID(),
              text: content,
              reply: (text) => ilinkRequest(baseUrl, 'ilink/bot/sendmessage', {
                token: secret.WEIXIN_TOKEN,
                payload: { msg: {
                  from_user_id: '', to_user_id: senderId, client_id: `zsense-weixin-${randomUUID()}`,
                  message_type: 2, message_state: 2,
                  ...(this.contextTokens.get(`${connection.id}:${senderId}`) ? { context_token: this.contextTokens.get(`${connection.id}:${senderId}`) } : {}),
                  item_list: [{ type: 1, text_item: { text } }],
                } },
              }),
            }).catch((error) => console.error('微信入站消息处理失败：', error))
          }
        } catch (error) {
          if (controller.signal.aborted) break
          this.#markFailed(connection.id, error)
          await new Promise((resolve) => setTimeout(resolve, 3_000))
        }
      }
    }
    void loop()
    return { client: controller, stop: () => { running = false; controller.abort() }, healthy: () => running && !controller.signal.aborted }
  }

  async #ensureWebhookServer() {
    const settings = this.database.loadSettings()
    const configuredUrl = string(settings.gatewayUrl || 'http://127.0.0.1:9119')
    let port = 9119
    try { port = Number(new URL(configuredUrl).port || 9119) || 9119 } catch { /* use default */ }
    if (this.webhookServer && this.webhookPort === port) return
    if (this.webhookServer) await new Promise((resolve) => this.webhookServer.close(resolve))
    this.webhookServer = http.createServer((request, response) => { void this.#handleWebhookRequest(request, response) })
    await new Promise((resolve, reject) => {
      this.webhookServer.once('error', reject)
      this.webhookServer.listen(port, '127.0.0.1', resolve)
    })
    this.webhookPort = port
  }

  async #handleWebhookRequest(request, response) {
    const fail = (status, message) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ ok: false, error: message })) }
    try {
      const pathname = new URL(request.url || '/', `http://127.0.0.1:${this.webhookPort}`).pathname
      const connection = this.database.loadGatewayConnections().find((item) => item.provider === 'webhook' && item.status === 'connected' && string(item.config.WEBHOOK_PATH || '/zsense').replace(/^([^/])/, '/$1') === pathname)
      if (!connection || request.method !== 'POST') return fail(404, 'Webhook 不存在。')
      const stored = this.database.getGatewayConnection(connection.id)
      const secret = this.secrets.get(stored.secretScope).WEBHOOK_SIGNING_SECRET || ''
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 2_000_000) return fail(413, '请求体过大。')
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      const signature = string(request.headers['x-zsense-signature']).replace(/^sha256=/, '')
      const expected = createHmac('sha256', secret).update(body).digest('hex')
      if (!signature || signature !== expected) return fail(401, '签名无效。')
      const payload = safeJson(body.toString('utf8'), {})
      let outbound = ''
      const result = await this.receive({
        connectionId: connection.id,
        userId: string(payload.userId || payload.user_id),
        userName: string(payload.userName || payload.user_name),
        chatId: string(payload.chatId || payload.chat_id),
        messageId: string(payload.messageId || payload.message_id) || randomUUID(),
        text: string(payload.text || payload.content),
        reply: async (text) => { outbound = text },
      })
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, accepted: result.accepted, text: outbound }))
    } catch (error) { fail(500, error instanceof Error ? error.message : 'Webhook 处理失败。') }
  }

  async #startConnection(connection) {
    const stored = this.database.getGatewayConnection(connection.id)
    const secret = this.secrets.get(stored.secretScope)
    const config = connection.config || {}
    let adapter
    if (connection.provider === 'telegram') adapter = await this.#startTelegram(connection, config, secret)
    else if (connection.provider === 'discord') adapter = await this.#startDiscord(connection, config, secret)
    else if (connection.provider === 'slack') adapter = await this.#startSlack(connection, config, secret)
    else if (connection.provider === 'feishu') adapter = await this.#startFeishu(connection, config, secret)
    else if (connection.provider === 'dingtalk') adapter = await this.#startDingTalk(connection, config, secret)
    else if (connection.provider === 'wecom') adapter = await this.#startWeCom(connection, config, secret)
    else if (connection.provider === 'weixin') adapter = await this.#startWeixin(connection, config, secret)
    else if (connection.provider === 'webhook') {
      await this.#ensureWebhookServer()
      adapter = { client: this.webhookServer, stop: () => undefined, healthy: () => Boolean(this.webhookServer?.listening) }
    } else throw new Error(`暂不支持 ${connection.provider} 网关。`)
    this.instances.set(connection.id, { ...adapter, provider: connection.provider, startedAt: now(), error: null })
    return adapter
  }

  #markFailed(connectionId, error) {
    const message = error instanceof Error ? error.message : String(error)
    const instance = this.instances.get(connectionId)
    if (instance) instance.error = message
    this.lastError = message
  }

  async stopConnection(connectionId) {
    const instance = this.instances.get(connectionId)
    if (!instance) return
    this.instances.delete(connectionId)
    for (const [taskId, pending] of this.pendingOfficeDeliveries) {
      if (pending.connectionId !== connectionId) continue
      this.pendingOfficeDeliveries.delete(taskId)
      this.officeTaskService?.patch(taskId, { status: 'interrupted', deliveryStatus: 'manual_required', errorCode: 'delivery_context_lost', error: '消息网关已断开，原消息安全回复通道不再可用。结果保留在任务工作台。' })
    }
    try { await instance.stop?.() } catch (error) { this.#markFailed(connectionId, error) }
  }

  async reconcile() {
    const workspace = this.database.loadGatewayRuntime()
    const onlineBots = new Set(workspace.bots.filter((bot) => bot.status === 'online').map((bot) => bot.id))
    const active = new Map(workspace.gatewayConnections.filter((connection) => connection.configured && connection.status === 'connected' && onlineBots.has(connection.botId)).map((connection) => [connection.id, connection]))
    let configuredWebhookPort = 9119
    try { configuredWebhookPort = Number(new URL(string(workspace.settings.gatewayUrl || 'http://127.0.0.1:9119')).port || 9119) || 9119 } catch { /* validated by settings */ }
    const obsolete = [...this.instances.keys()].filter((id) => {
      if (!active.has(id)) return true
      return this.instances.get(id)?.provider === 'webhook' && this.webhookPort !== configuredWebhookPort
    })
    await Promise.allSettled(obsolete.map((id) => this.stopConnection(id)))
    if (![...active.values()].some((connection) => connection.provider === 'webhook') && this.webhookServer) {
      await new Promise((resolve) => this.webhookServer.close(resolve))
      this.webhookServer = null
      this.webhookPort = null
    }
    const starts = [...active.values()].filter((connection) => !this.instances.has(connection.id))
    const results = await Promise.allSettled(starts.map((connection) => this.#startConnection(connection)))
    const errors = results.flatMap((result, index) => result.status === 'rejected' ? [`${starts[index].name}：${result.reason instanceof Error ? result.reason.message : result.reason}`] : [])
    if (errors.length) this.lastError = errors.at(-1)
    return { ok: !errors.length, errors, started: starts.length - errors.length, active: this.instances.size }
  }

  async healthCheck() {
    this.lastHealthCheckAt = now()
    const failed = []
    for (const [id, instance] of this.instances) {
      try { if (!instance.healthy?.()) failed.push(id) }
      catch { failed.push(id) }
    }
    for (const id of failed) {
      await this.stopConnection(id)
      this.recoveryCount += 1
    }
    const result = await this.reconcile()
    return { ...result, recovered: failed.length }
  }

  setMonitorEnabled(enabled) { this.monitorEnabled = Boolean(enabled) }

  inspect() {
    const workspace = this.database.loadGatewayRuntime()
    const onlineBots = new Set(workspace.bots.filter((bot) => bot.status === 'online').map((bot) => bot.id))
    const expected = workspace.gatewayConnections.filter((connection) => connection.configured && connection.status === 'connected' && onlineBots.has(connection.botId)).length
    const healthy = [...this.instances.values()].filter((instance) => {
      try { return instance.healthy?.() !== false }
      catch { return false }
    }).length
    return {
      managedByApp: true,
      managedGatewayCount: this.instances.size,
      lifecycle: this.instances.size ? 'running' : 'idle',
      lastGatewayError: this.lastError,
      gatewayMonitorEnabled: this.monitorEnabled,
      gatewayHealthCheckIntervalSeconds: GATEWAY_HEALTH_CHECK_INTERVAL_MS / 1_000,
      lastGatewayHealthCheckAt: this.lastHealthCheckAt,
      gatewayHealthyCount: healthy,
      gatewayExpectedCount: expected,
      gatewayRecoveryCount: this.recoveryCount,
      dataPath: this.root,
    }
  }

  async startWeixinQrLogin() {
    const loginId = randomUUID()
    const controller = new AbortController()
    const initial = { loginId, state: 'preparing', qrImage: '', message: '正在获取微信二维码…', accountId: '', userId: '', baseUrl: ILINK_BASE_URL, token: '' }
    this.qrLogins.set(loginId, { status: initial, controller })
    void (async () => {
      try {
        const qr = await ilinkRequest(ILINK_BASE_URL, 'ilink/bot/get_bot_qrcode?bot_type=3', { signal: controller.signal })
        const qrcode = string(qr.qrcode)
        const item = this.qrLogins.get(loginId)
        if (!item || !qrcode) throw new Error('微信没有返回有效二维码。')
        item.status = { ...item.status, state: 'waiting', qrImage: string(qr.qrcode_img_content), message: '请使用微信扫码，并在手机上确认。' }
        let baseUrl = ILINK_BASE_URL
        const deadline = Date.now() + 8 * 60_000
        while (!controller.signal.aborted && Date.now() < deadline) {
          const status = await ilinkRequest(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, { signal: controller.signal })
          const state = string(status.status || 'wait')
          if (state === 'scaned') item.status = { ...item.status, state: 'scanned', message: '已扫码，请在微信中确认。' }
          else if (state === 'scaned_but_redirect' && status.redirect_host) baseUrl = `https://${status.redirect_host}`
          else if (state === 'expired') { item.status = { ...item.status, state: 'expired', message: '二维码已过期，请重新获取。' }; return }
          else if (state === 'confirmed') {
            item.status = {
              ...item.status,
              state: 'confirmed',
              message: '微信授权成功。',
              accountId: string(status.ilink_bot_id),
              userId: string(status.ilink_user_id),
              baseUrl: string(status.baseurl || baseUrl),
              token: string(status.bot_token),
            }
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        if (!controller.signal.aborted) item.status = { ...item.status, state: 'expired', message: '微信授权超时，请重新获取二维码。' }
      } catch (error) {
        const item = this.qrLogins.get(loginId)
        if (item && !controller.signal.aborted) item.status = { ...item.status, state: 'error', message: error instanceof Error ? error.message : '微信授权失败。' }
      }
    })()
    return initial
  }

  getWeixinQrLoginStatus(loginId) {
    const item = this.qrLogins.get(loginId)
    if (!item) throw new Error('微信扫码授权已经结束或不存在。')
    return { ...item.status }
  }

  cancelWeixinQrLogin(loginId) {
    const item = this.qrLogins.get(loginId)
    if (!item) throw new Error('微信扫码授权已经结束或不存在。')
    item.controller.abort()
    item.status = { ...item.status, state: 'cancelled', message: '微信扫码授权已取消。' }
    return { ...item.status }
  }

  async shutdown() {
    for (const item of this.qrLogins.values()) item.controller.abort()
    this.qrLogins.clear()
    await Promise.allSettled([...this.instances.keys()].map((id) => this.stopConnection(id)))
    if (this.webhookServer) await new Promise((resolve) => this.webhookServer.close(resolve))
    this.webhookServer = null
    this.webhookPort = null
    this.setMonitorEnabled(false)
  }
}
