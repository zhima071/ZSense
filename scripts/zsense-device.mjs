#!/usr/bin/env node
/**
 * ZSense 设备管理工具（在域名主人的机器上运行，用于给每台设备开通独立公网入口）
 *
 * 用法：
 *   node scripts/zsense-device.mjs create [昵称]     # 生成设备号（昵称+4位随机数）→ 建隧道 → 建子域名记录 → 输出令牌
 *   node scripts/zsense-device.mjs list              # 列出已开通的设备入口
 *   node scripts/zsense-device.mjs remove <设备号>   # 删除某台设备的入口与隧道
 *
 * 前置条件：
 *   1. 本机已安装 cloudflared，且执行过 cloudflared tunnel login（~/.cloudflared/cert.pem）
 *   2. Cloudflare API 令牌（权限 Zone → DNS → Edit）保存在 ~/.cloudflared/api-token
 *   3. 环境变量 ZSENSE_ZONE 可覆盖默认域名（默认 zsense.space）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ZONE = (process.env.ZSENSE_ZONE || 'zsense.space').trim()
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || 'cloudflared'
const TOKEN_PATH = path.join(os.homedir(), '.cloudflared', 'api-token')

function readApiToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim()
  } catch {
    throw new Error(`找不到 Cloudflare API 令牌：${TOKEN_PATH}（权限需要 Zone → DNS → Edit）`)
  }
}

async function api(pathname, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${readApiToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.success === false) {
    const message = (payload.errors || []).map((item) => item.message).join('；') || `HTTP ${response.status}`
    throw new Error(`Cloudflare API 失败：${message}`)
  }
  return payload.result
}

function cloudflared(args) {
  return execFileSync(CLOUDFLARED, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function slug(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32)
}

function randomSuffix() {
  return String(Math.floor(1000 + Math.random() * 9000))
}

async function resolveZoneId() {
  const zones = await api(`/zones?name=${encodeURIComponent(ZONE)}`)
  if (!zones?.length) throw new Error(`Cloudflare 账号里没有 ${ZONE} 这个域名，请先在 Cloudflare 添加站点。`)
  return zones[0].id
}

async function listRecords(zoneId) {
  const records = await api(`/zones/${zoneId}/dns_records?per_page=200`)
  return (records || []).filter((record) => record.type === 'CNAME' && String(record.content || '').endsWith('.cfargotunnel.com'))
}

function tunnelUuidByName(name) {
  const output = cloudflared(['tunnel', 'list', '--output', 'json', '--name', name])
  const list = JSON.parse(output || '[]')
  return list?.[0]?.id || ''
}

async function create(requested) {
  const base = slug(requested) || slug(os.hostname()) || 'device'
  const zoneId = await resolveZoneId()
  const existing = await listRecords(zoneId)
  const taken = new Set(existing.map((record) => String(record.name).split('.')[0]))

  let deviceId = /-\d{4}$/.test(base) ? base : `${base}-${randomSuffix()}`
  for (let attempt = 0; attempt < 8 && taken.has(deviceId); attempt += 1) {
    deviceId = `${base.replace(/-\d{4}$/, '')}-${randomSuffix()}`
  }
  if (taken.has(deviceId)) throw new Error(`设备号 ${deviceId} 连续多次都撞号了，请换个昵称再试。`)

  console.log(`设备号：${deviceId}`)
  console.log(`地址：https://${deviceId}.${ZONE}`)

  let uuid = tunnelUuidByName(deviceId)
  if (!uuid) {
    const created = cloudflared(['tunnel', 'create', deviceId])
    uuid = (created.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0] || ''
    if (!uuid) throw new Error('创建隧道失败，请检查 cloudflared 是否已登录。')
    console.log(`已创建隧道：${uuid}`)
  } else {
    console.log(`复用已有隧道：${uuid}`)
  }

  const record = existing.find((item) => String(item.name).split('.')[0] === deviceId)
  if (!record) {
    await api(`/zones/${zoneId}/dns_records`, 'POST', {
      type: 'CNAME',
      name: deviceId,
      content: `${uuid}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: 'ZSense 远程连接（由 scripts/zsense-device.mjs 创建）',
    })
    console.log('已创建子域名记录（代理开启）')
  } else {
    console.log('子域名记录已存在，跳过')
  }

  const token = cloudflared(['tunnel', 'token', deviceId]).trim()
  console.log('\n=== 把下面这行令牌填到那台设备的「设备互联 → 远程连接」里 ===')
  console.log(token)
  console.log(`\n填完后那台设备的地址就是：https://${deviceId}.${ZONE}`)
  console.log('连接它需要：设备号 + 那台设备自己设置的设备锁密码')
}

async function list() {
  const zoneId = await resolveZoneId()
  const records = await listRecords(zoneId)
  if (!records.length) {
    console.log(`${ZONE} 下还没有开通任何设备入口。`)
    return
  }
  console.log(`已开通 ${records.length} 个设备入口：`)
  for (const record of records.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const label = String(record.name).split('.')[0]
    console.log(`  ${label.padEnd(24)} https://${record.name}  ${record.proxied ? '（代理开启）' : '（未代理）'}`)
  }
}

async function remove(deviceId) {
  const id = slug(deviceId)
  if (!id) throw new Error('请提供要删除的设备号，例如：node scripts/zsense-device.mjs remove zhima-4821')
  const zoneId = await resolveZoneId()
  const records = await listRecords(zoneId)
  const record = records.find((item) => String(item.name).split('.')[0] === id)
  if (record) {
    await api(`/zones/${zoneId}/dns_records/${record.id}`, 'DELETE')
    console.log(`已删除子域名记录：${record.name}`)
  } else {
    console.log('没有找到对应的子域名记录')
  }
  try {
    cloudflared(['tunnel', 'delete', '-f', id])
    console.log(`已删除隧道：${id}`)
  } catch (error) {
    console.log(`隧道删除跳过：${error instanceof Error ? error.message.split('\n')[0] : error}`)
  }
}

const [command = 'list', argument = ''] = process.argv.slice(2)
try {
  if (command === 'create') await create(argument)
  else if (command === 'list') await list()
  else if (command === 'remove') await remove(argument)
  else {
    console.log('用法：node scripts/zsense-device.mjs <create [昵称] | list | remove <设备号>>')
    process.exitCode = 1
  }
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
