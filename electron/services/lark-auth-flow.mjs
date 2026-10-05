import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const AUTH_TIMEOUT_MS = 45_000

function parseJson(output, label) {
  try { return JSON.parse(String(output || '').trim()) }
  catch { throw new Error(`${label}未返回可识别的 JSON，请检查飞书 CLI 版本。`) }
}

function authScope(conversationId) {
  const id = String(conversationId || '').trim()
  if (!id || id.length > 180) throw new Error('飞书授权必须绑定到当前会话。')
  return `lark-pending-auth:${id}`
}

export class LarkAuthFlow {
  constructor({ runCommand = execFileAsync, secrets = null, now = Date.now } = {}) {
    this.runCommand = runCommand
    this.secrets = secrets
    this.now = now
    this.pending = new Map()
  }

  #load(conversationId) {
    const scope = authScope(conversationId)
    let record = this.pending.get(scope)
    if (!record && this.secrets) {
      try { record = JSON.parse(this.secrets.get(scope).pending || 'null') }
      catch { /* Keychain unavailable: in-memory flow remains usable. */ }
      if (record) this.pending.set(scope, record)
    }
    if (record && (!record.deviceCode || !Number.isFinite(record.expiresAt) || record.expiresAt <= this.now())) {
      this.#clear(conversationId)
      return null
    }
    return record || null
  }

  #save(conversationId, record) {
    const scope = authScope(conversationId)
    this.pending.set(scope, record)
    try { this.secrets?.set(scope, { pending: JSON.stringify(record) }) }
    catch { /* Safe storage may be unavailable; preserve this session in memory. */ }
  }

  #clear(conversationId) {
    const scope = authScope(conversationId)
    this.pending.delete(scope)
    try { this.secrets?.delete(scope) } catch { /* best effort */ }
  }

  async #run(cliPath, args, { cwd, signal, timeout = AUTH_TIMEOUT_MS } = {}) {
    return this.runCommand(cliPath, args, { cwd, signal, timeout, maxBuffer: 1024 * 1024, windowsHide: true })
  }

  async start({ cliPath, args, cwd, conversationId, requestId, signal }) {
    authScope(conversationId)
    const existing = this.#load(conversationId)
    if (existing) return this.#startResponse(existing)
    const values = args.filter((value) => !['--no-wait', '--json'].includes(value))
    const result = await this.#run(cliPath, [...values, '--no-wait', '--json'], { cwd, signal })
    const response = parseJson(result.stdout, '飞书授权启动命令')
    const deviceCode = String(response.device_code || '')
    const verificationUrl = String(response.verification_url || '')
    const expiresIn = Math.min(1800, Math.max(30, Number(response.expires_in) || 600))
    let url
    try { url = new URL(verificationUrl) } catch { /* handled below */ }
    if (!deviceCode || !url || url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('飞书 CLI 没有返回有效的设备授权信息。')
    }
    const expiresAt = this.now() + expiresIn * 1000
    const record = { deviceCode, verificationUrl, expiresAt, requestId: String(requestId || '') }
    this.#save(conversationId, record)

    let qrFile = ''
    if (cwd && fs.existsSync(cwd)) {
      const filename = `lark-auth-${this.now()}-${randomUUID().slice(0, 8)}.png`
      try {
        await this.#run(cliPath, ['auth', 'qrcode', verificationUrl, '--output', filename], { cwd, signal, timeout: 15_000 })
        if (fs.existsSync(path.join(cwd, filename))) qrFile = filename
      } catch { /* The authorization URL remains usable without a QR image. */ }
    }
    if (qrFile) {
      record.qrFile = qrFile
      this.#save(conversationId, record)
    }
    return this.#startResponse(record)
  }

  #startResponse(record) {
    return JSON.stringify({
      status: 'authorization_required',
      verification_url: record.verificationUrl,
      expires_at: new Date(record.expiresAt).toISOString(),
      ...(record.qrFile ? { qr_file: record.qrFile } : {}),
      next_step: '将链接或二维码发给用户，结束当前回复。用户确认授权后，在同一会话调用 run_lark_cli，参数为 ["auth","complete"]；不要重新生成链接或把 device_code 放入工具参数。',
    })
  }

  async complete({ cliPath, cwd, conversationId, requestId, signal }) {
    const record = this.#load(conversationId)
    if (!record) {
      const status = parseJson((await this.#run(cliPath, ['auth', 'status', '--json'], { cwd, signal })).stdout, '飞书授权状态')
      if (status.identities?.user?.available && status.identities.user.status === 'ready') return '飞书用户身份已就绪；可以直接重试原来的读取操作。'
      throw new Error('没有待完成的飞书授权，或授权链接已过期。请重新发起 auth login。')
    }
    if (record.requestId && record.requestId === String(requestId || '')) {
      return '授权链接已生成。请先把链接发给用户并结束当前回复；用户确认后再调用 auth complete。'
    }
    try {
      await this.#run(cliPath, ['auth', 'login', '--device-code', record.deviceCode, '--json'], {
        cwd, signal, timeout: Math.min(AUTH_TIMEOUT_MS, Math.max(5_000, record.expiresAt - this.now())),
      })
    } catch (error) {
      if (this.now() >= record.expiresAt) {
        this.#clear(conversationId)
        throw new Error('飞书授权链接已过期，请重新发起 auth login。')
      }
      // execFile's default error contains the complete command line, including device_code.
      // Never pass that error to the model, chat transcript, or tool event log.
      if (signal?.aborted) throw new Error('飞书授权等待已取消；未过期时可在同一会话再次调用 auth complete。')
      throw new Error('飞书尚未确认授权，或令牌换取暂时失败。请确认授权页面显示成功后，在同一会话重试 auth complete。')
    }
    const status = parseJson((await this.#run(cliPath, ['auth', 'status', '--json'], { cwd, signal })).stdout, '飞书授权状态')
    if (!status.identities?.user?.available || status.identities.user.status !== 'ready') {
      throw new Error('飞书令牌换取后仍未显示用户身份就绪，请检查授权页面并重试 auth complete。')
    }
    this.#clear(conversationId)
    return '飞书用户授权已完成，用户身份已就绪；请重试原来的读取操作并核对所需权限。'
  }

  async status({ cliPath, cwd, conversationId, signal }) {
    const result = await this.#run(cliPath, ['auth', 'status', '--json'], { cwd, signal })
    const pending = conversationId ? this.#load(conversationId) : null
    return pending
      ? `${result.stdout.trim()}\nZSense 提示：本会话有尚未完成的设备授权。用户确认后调用 run_lark_cli ["auth","complete"] 换取令牌；不要重新生成授权链接。`
      : result.stdout.trim()
  }
}
