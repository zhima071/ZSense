import path from 'node:path'
import { mossBundleRoot, verifyWindowsOfflineBundle, windowsBundleRoot } from './windows-offline-assets.mjs'

try {
  const rootPath = process.argv[2] ? path.resolve(process.argv[2]) : windowsBundleRoot
  const mossRootPath = process.argv[3] ? path.resolve(process.argv[3]) : mossBundleRoot
  const result = verifyWindowsOfflineBundle({ rootPath, mossRootPath })
  console.log(JSON.stringify({ ok: true, platform: 'win32-x64', offline: true, ...result }))
} catch (error) {
  console.error(`Windows 完整离线资源检查失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
