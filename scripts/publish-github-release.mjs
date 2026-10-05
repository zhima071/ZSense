#!/usr/bin/env node
// 校验本地安装包与更新清单；显式传入 --publish 才会创建 GitHub Release。
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const directory = path.join(root, '安装包', '当前')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const repo = process.argv.find((arg) => arg.startsWith('--repo='))?.slice(7) || ''
const publish = process.argv.includes('--publish')
if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('仓库格式应为 owner/repo')
if (publish && !repo) throw new Error('发布时必须指定 --repo=owner/repo')

function runGh(args) {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'gh 执行失败').trim())
  return result.stdout.trim()
}

async function digest(file, algorithm) {
  const hash = createHash(algorithm)
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex')
}

function readFeed(name) {
  const source = fs.readFileSync(path.join(directory, name), 'utf8')
  const feedVersion = source.match(/^version:\s*(\S+)/m)?.[1]
  if (feedVersion !== version) throw new Error(`${name} 的版本不是 ${version}`)
  const files = []
  let current = null
  for (const line of source.split(/\r?\n/)) {
    const url = line.match(/^\s+- url:\s*(\S+)/)
    if (url) { current = { name: url[1] }; files.push(current) }
    if (current) {
      const sha512 = line.match(/^\s+sha512:\s*(\S+)/)
      const size = line.match(/^\s+size:\s*(\d+)/)
      if (sha512) current.sha512 = sha512[1]
      if (size) current.size = Number(size[1])
    }
  }
  if (!files.length) throw new Error(`${name} 没有安装包列表`)
  return files
}

const feedFiles = [...readFeed('latest-mac.yml'), ...readFeed('latest.yml')]
for (const entry of feedFiles) {
  if (!/^ZSense-\d+\.\d+\.\d+-(mac-(arm64|x64)\.(dmg|zip)|win-x64\.exe)$/.test(entry.name)) {
    throw new Error(`更新清单包含意外文件：${entry.name}`)
  }
  const file = path.join(directory, entry.name)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`缺少 ${entry.name}`)
  if (fs.statSync(file).size !== entry.size) throw new Error(`${entry.name} 的文件大小与更新清单不符`)
  if (await digest(file, 'sha512') !== entry.sha512) throw new Error(`${entry.name} 的 SHA-512 与更新清单不符`)
}

const checksums = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)
for (const line of checksums) {
  const match = line.match(/^([a-f0-9]{64})  (ZSense-[^/]+)$/)
  if (!match) throw new Error('SHA256SUMS 格式错误')
  const file = path.join(directory, match[2])
  if (!fs.existsSync(file) || await digest(file, 'sha256') !== match[1]) throw new Error(`${match[2]} 的 SHA-256 校验失败`)
}

const assetNames = fs.readdirSync(directory).filter((name) =>
  name === 'SHA256SUMS' || name === 'latest-mac.yml' || name === 'latest.yml'
  || /^ZSense-(?:\d+\.\d+\.\d+-(?:mac-(?:arm64|x64)\.(?:dmg|zip)|win-x64\.exe)(?:\.blockmap)?|\d+\.\d+\.\d+-android13-release\.apk)$/.test(name)
).sort()
if (assetNames.some((name) => name.includes('-mac-') && !name.includes(`ZSense-${version}-`))) throw new Error('当前目录混有其他版本的 macOS 包')
if (assetNames.some((name) => name.includes('-win-') && !name.includes(`ZSense-${version}-`))) throw new Error('当前目录混有其他版本的 Windows 包')
if (!assetNames.some((name) => name.endsWith('.apk'))) throw new Error('缺少 Android 安装包')
console.log(JSON.stringify({ verified: true, version, repo: repo || null, assets: assetNames, publish }, null, 2))

if (publish) {
  const info = JSON.parse(runGh(['repo', 'view', repo, '--json', 'visibility,defaultBranchRef']))
  if (info.visibility !== 'PUBLIC') throw new Error('更新下载需无需登录：只允许发布到公开的安装包仓库')
  const tag = `v${version}`
  const existing = spawnSync('gh', ['release', 'view', tag, '-R', repo], { encoding: 'utf8', stdio: 'ignore' })
  if (existing.status === 0) throw new Error(`${repo} 已有 ${tag} Release；请递增版本号，不覆盖旧版本`)
  const assets = assetNames.map((name) => path.join(directory, name))
  runGh(['release', 'create', tag, ...assets, '-R', repo, '--target', info.defaultBranchRef.name,
    '--title', `ZSense ${version}`, '--notes', `ZSense ${version} 安装包。下载后请核对 SHA256SUMS。`])
  console.log(`发布完成：https://github.com/${repo}/releases/tag/${tag}`)
}
