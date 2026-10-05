#!/usr/bin/env node
// 一次跑完全部 smoke 测试：串行执行时总耗时是所有测试之和，很多时间其实在等各自的进程启动。
// 这里用一个有上限的并行池（每个测试都是独立进程、各自用临时目录和随机端口），把总时间压到
// 接近“最慢的那一批”，同时在失败时仍然打印完整日志路径和末尾输出，方便定位。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const argumentsList = process.argv.slice(2)
const hasFlag = (name) => argumentsList.includes(`--${name}`)
const readFlag = (name, fallback) => {
  const index = argumentsList.indexOf(`--${name}`)
  return index >= 0 && argumentsList[index + 1] ? argumentsList[index + 1] : fallback
}
const readList = (name) => argumentsList.flatMap((value, index) => (argumentsList[index - 1] === `--${name}` ? [value] : []))

// 需要 macOS 屏幕录制/辅助功能权限的测试在没有授权时会一直等系统弹窗，默认跳过。
const environmentDependentTests = new Set(['test:computer-use'])
const defaultConcurrency = Math.max(2, Math.min(6, os.cpus().length - 1))
const concurrency = Math.max(1, Math.min(16, Number(readFlag('concurrency', hasFlag('serial') ? 1 : defaultConcurrency)) || defaultConcurrency))
const timeoutMs = Math.max(30, Number(readFlag('timeout', 300)) || 300) * 1000
const onlyPatterns = readList('only')
const skipPatterns = readList('skip')

const scripts = packageJson.scripts || {}
// 只收集单项测试：聚合入口（npm test / test:serial / test:fast）本身会再次启动本脚本，
// 一旦被当成普通测试就会无限递归地派生测试进程。
let entries = Object.keys(scripts).filter((name) => name.startsWith('test:') && !String(scripts[name]).includes('run-all-tests.mjs'))
if (onlyPatterns.length) entries = entries.filter((name) => onlyPatterns.some((pattern) => name.includes(pattern)))
if (skipPatterns.length) entries = entries.filter((name) => !skipPatterns.some((pattern) => name.includes(pattern)))
if (!hasFlag('include-env')) entries = entries.filter((name) => !environmentDependentTests.has(name))

if (hasFlag('list')) {
  console.log(entries.join('\n'))
  process.exit(0)
}
if (!entries.length) {
  console.log('没有匹配的测试。')
  process.exit(1)
}

const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-tests-'))
const startedAt = Date.now()
const results = []
let cursor = 0
let completed = 0

function runOne(name) {
  return new Promise((resolve) => {
    const logPath = path.join(logDirectory, `${name.replace(/[:/]/g, '-')}.log`)
    const logStream = fs.createWriteStream(logPath)
    const child = spawn('npm', ['run', name, '--silent'], { cwd: projectRoot, env: process.env, detached: true })
    const testStartedAt = Date.now()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, timeoutMs)
    child.stdout.pipe(logStream)
    child.stderr.pipe(logStream)
    child.on('close', (code) => {
      clearTimeout(timer)
      logStream.end()
      completed += 1
      const durationMs = Date.now() - testStartedAt
      const ok = !timedOut && code === 0
      results.push({ name, ok, code, timedOut, durationMs, logPath })
      const marker = ok ? '✅' : '❌'
      const extra = timedOut ? '超时' : code === 0 ? '' : `退出码 ${code}`
      console.log(`${marker} [${completed}/${entries.length}] ${name} ${(durationMs / 1000).toFixed(1)}s ${extra}`)
      resolve()
    })
  })
}

async function worker() {
  while (cursor < entries.length) {
    const name = entries[cursor]
    cursor += 1
    await runOne(name)
  }
}

console.log(`▶️  并行运行 ${entries.length} 个测试，并行度 ${concurrency}，单个超时 ${timeoutMs / 1000}s，日志目录 ${logDirectory}`)
await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()))

const elapsedMs = Date.now() - startedAt
const serialMs = results.reduce((total, item) => total + item.durationMs, 0)
const failures = results.filter((item) => !item.ok)
console.log('')
console.log(`总计 ${results.length} 个测试：通过 ${results.length - failures.length}，失败 ${failures.length}`)
console.log(`并行耗时 ${(elapsedMs / 1000).toFixed(1)}s（逐个串行需要 ${(serialMs / 1000).toFixed(1)}s，节省 ${Math.max(0, Math.round((1 - elapsedMs / serialMs) * 100))}%）`)
console.log(`最慢的三个：${[...results].sort((left, right) => right.durationMs - left.durationMs).slice(0, 3).map((item) => `${item.name} ${(item.durationMs / 1000).toFixed(1)}s`).join('、')}`)
if (failures.length) {
  console.log('')
  for (const failure of failures) {
    console.log(`❌ ${failure.name}${failure.timedOut ? '（超时）' : ''} → ${failure.logPath}`)
    try {
      const tail = fs.readFileSync(failure.logPath, 'utf8').trim().split('\n').slice(-8).join('\n')
      if (tail) console.log(tail.split('\n').map((line) => `   ${line}`).join('\n'))
    } catch { /* 日志读取失败时只保留路径 */ }
  }
  process.exit(1)
}
process.exit(0)
