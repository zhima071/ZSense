import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

async function startDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

export async function scheduleUpdateInstall({ platform, filePath, version, execPath, parentPid, downloadDirectory }) {
  const name = path.basename(filePath)
  const expected = platform === 'darwin' ? `ZSense-${version}-mac-${process.arch}.dmg`
    : platform === 'win32' ? `ZSense-${version}-win-x64.exe` : ''
  if (!expected || name !== expected || !fs.statSync(filePath).isFile()) throw new Error('安装包与当前平台或目标版本不匹配。')
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('无法确定正在运行的应用进程。')

  const helperName = platform === 'darwin' ? 'update-install-mac.sh' : 'update-install-win.ps1'
  const helperSource = new URL(`./${helperName}`, import.meta.url)
  const helperPath = path.join(downloadDirectory, helperName)
  const logPath = path.join(downloadDirectory, `install-${version}.log`)
  fs.writeFileSync(helperPath, fs.readFileSync(helperSource), { mode: 0o700 })

  if (platform === 'darwin') {
    const appPath = path.resolve(path.dirname(execPath), '..', '..')
    if (path.basename(appPath) !== 'ZSense.app' || !execPath.endsWith('/Contents/MacOS/ZSense')) {
      throw new Error('当前应用不在可更新的 ZSense.app 内。')
    }
    try { fs.accessSync(path.dirname(appPath), fs.constants.W_OK) }
    catch { throw new Error('应用所在文件夹不可写，无法直接替换。请把 ZSense.app 放入可写的应用文件夹。') }
    await startDetached('/bin/sh', [helperPath, String(parentPid), filePath, appPath, version, logPath])
  } else {
    if (path.basename(execPath).toLowerCase() !== 'zsense.exe') throw new Error('当前应用不是 Windows 安装版。')
    await startDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helperPath,
      '-ParentPid', String(parentPid), '-InstallerPath', filePath, '-LogPath', logPath])
  }
  return { scheduled: true }
}
