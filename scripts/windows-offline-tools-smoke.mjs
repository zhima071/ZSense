import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyWindowsOfflineBundle, windowsBundleRoot } from './windows-offline-assets.mjs'

const verified = verifyWindowsOfflineBundle()
assert(verified.files >= 20, 'Windows 完整离线包登记文件过少')
assert(verified.bytes > 200 * 1024 * 1024, 'Windows 完整离线包没有包含 STT 模型与运行组件')
assert(verified.mossFiles >= 16, 'Windows 完整离线包没有包含完整 MOSS-TTS 模型')

if (process.platform === 'win32' && process.arch === 'x64') {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-windows-office-'))
  try {
    for (const name of ['officecli.exe', 'dws.exe', 'kdocs-cli.exe', 'lark-cli.exe', 'bsk.exe']) {
      fs.copyFileSync(path.join(windowsBundleRoot, name), path.join(temporaryDirectory, name))
    }
    const command = (file, args) => execFileSync(file.startsWith('stt/') ? path.join(windowsBundleRoot, file) : path.join(temporaryDirectory, file), args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 }).trim()
    assert.match(command('officecli.exe', ['--version']), /^1\.0\.149(?:\b|$)/)
    assert.match(command('dws.exe', ['version']), /v1\.0\.61(?:\b|$)/)
    assert.match(command('kdocs-cli.exe', ['version']), /^2\.5\.7(?:\b|$)/)
    assert.match(command('lark-cli.exe', ['--version']), /1\.0\.95(?:\b|$)/)
    assert.match(command('bsk.exe', ['--version']), /0\.3\.0(?:\b|$)/)
    assert.match(command('stt/whisper-cli.exe', ['--version']), /whisper/i)
    const workbook = path.join(temporaryDirectory, 'offline.xlsx')
    command('officecli.exe', ['create', workbook, '--json'])
    assert(fs.existsSync(workbook), 'Windows OfficeCLI 没有创建测试工作簿')
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, actualWindowsExecution: process.platform === 'win32' && process.arch === 'x64', ...verified }))
