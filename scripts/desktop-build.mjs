import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const projectDirectory = process.cwd()
const environment = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

function run(entry, args = []) {
  const result = spawnSync(process.execPath, [path.join(projectDirectory, entry), ...args], {
    cwd: projectDirectory,
    stdio: 'inherit',
    env: environment,
  })

  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('node_modules/typescript/bin/tsc', ['-b'])
run('node_modules/vite/bin/vite.js', ['build'])
const builderArguments = process.argv.slice(2)
if (!builderArguments.some((argument) => argument === '--publish' || argument.startsWith('--publish='))) {
  builderArguments.push('--publish', 'never')
}

const requestedPlatform = builderArguments.includes('--win') ? 'win32'
  : builderArguments.includes('--mac') ? 'darwin'
    : builderArguments.includes('--linux') ? 'linux'
      : process.platform
const requestedArch = builderArguments.includes('--x64') ? 'x64'
  : builderArguments.includes('--arm64') ? 'arm64'
    : builderArguments.includes('--ia32') ? 'ia32'
      : builderArguments.includes('--armv7l') ? 'armv7l'
        : builderArguments.includes('--universal') ? 'universal'
      : process.arch
if (requestedPlatform === 'win32') {
  if (requestedArch !== 'x64') {
    console.error(`当前 Windows 完整离线包只支持 x64，收到的架构为 ${requestedArch}。`)
    process.exit(1)
  }
  run('scripts/verify-windows-offline-tools.mjs')
}
const localElectronDist = path.join(projectDirectory, 'node_modules', 'electron', 'dist')
const hasElectronDistOverride = builderArguments.some((argument) => argument.startsWith('--config.electronDist=') || argument.startsWith('-c.electronDist='))
if (!hasElectronDistOverride && requestedPlatform === process.platform && requestedArch === process.arch && fs.existsSync(localElectronDist)) {
  builderArguments.push(`--config.electronDist=${localElectronDist}`)
  console.log(`使用本地 Electron 运行时打包：${localElectronDist}`)
}
run('node_modules/electron-builder/out/cli/cli.js', builderArguments)
if (!process.env.CI && !builderArguments.includes('--dir') && ['darwin', 'win32'].includes(requestedPlatform)) {
  const outputArgument = builderArguments.find((argument) => argument.startsWith('--config.directories.output='))
  const outputDirectory = outputArgument ? outputArgument.slice('--config.directories.output='.length) : 'release'
  run('scripts/collect-installers.mjs', [`--output=${outputDirectory}`, `--platform=${requestedPlatform === 'darwin' ? 'mac' : 'win'}`])
}
