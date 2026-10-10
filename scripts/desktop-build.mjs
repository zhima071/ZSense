import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { configureMacSigningBuild, requireMacSigningIdentity, verifyMacSignedApp } from './mac-signing.mjs'

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

let builderArguments = process.argv.slice(2)
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
  if (process.platform !== 'win32') {
    console.error('Windows NSIS 安装包必须在原生 Windows 环境构建并完成安装验证；macOS 交叉构建的安装程序可能启动即崩溃。请使用 GitHub Actions 的 Build Windows Installer 工作流。')
    process.exit(1)
  }
  if (requestedArch !== 'x64') {
    console.error(`当前 Windows 完整离线包只支持 x64，收到的架构为 ${requestedArch}。`)
    process.exit(1)
  }
}
let macIdentity = null
if (requestedPlatform === 'darwin') {
  if (process.platform !== 'darwin') throw new Error('macOS packages must be signed and verified on macOS.')
  if (environment.CSC_LINK || environment.CSC_KEY_PASSWORD || environment.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    throw new Error('Use the fixed keychain identity configuration; imported build keys and disabled identity discovery are not supported.')
  }
  const identity = requireMacSigningIdentity()
  macIdentity = identity
  builderArguments = configureMacSigningBuild(builderArguments, identity, projectDirectory)
  environment.ZSENSE_MAC_SIGN_EXPECTED_SHA1 = identity.identitySha1
  console.log(`固定 macOS 签名身份：${identity.name} (${identity.identitySha1})；缺失时不降级临时签名。`)
}
run('node_modules/typescript/bin/tsc', ['-b'])
run('node_modules/vite/bin/vite.js', ['build'])
if (requestedPlatform === 'win32') {
  run('scripts/verify-windows-offline-tools.mjs')
} else if (requestedPlatform === 'darwin') {
  run('scripts/build-mac-screen-permission.mjs', [`--arch=${requestedArch}`])
  run('scripts/verify-voice-assets.mjs', [`${requestedPlatform}-${requestedArch}`])
}
const localElectronDist = path.join(projectDirectory, 'node_modules', 'electron', 'dist')
const hasElectronDistOverride = builderArguments.some((argument) => argument.startsWith('--config.electronDist=') || argument.startsWith('-c.electronDist='))
if (!hasElectronDistOverride && requestedPlatform === process.platform && requestedArch === process.arch && fs.existsSync(localElectronDist)) {
  builderArguments.push(`--config.electronDist=${localElectronDist}`)
  console.log(`使用本地 Electron 运行时打包：${localElectronDist}`)
}
run('node_modules/electron-builder/out/cli/cli.js', builderArguments)
if (macIdentity) {
  const outputArgument = builderArguments.find((argument) => /^(?:--config|-c)\.directories\.output=/.test(argument))
  const outputDirectory = path.resolve(projectDirectory, outputArgument ? outputArgument.slice(outputArgument.indexOf('=') + 1) : 'release')
  const appDirectory = requestedArch === 'x64' ? 'mac' : `mac-${requestedArch}`
  const appPath = path.join(outputDirectory, appDirectory, 'ZSense.app')
  // A builder/CI skip must not turn a successfully exited build into an unsigned
  // deliverable. Independently verify the final bundle even if the hook was skipped.
  const report = verifyMacSignedApp(appPath, macIdentity)
  console.log(`macOS 构建最终签名验证通过：${report.signedTargets} 个代码对象。`)
}
if (!process.env.CI && !builderArguments.includes('--dir') && ['darwin', 'win32'].includes(requestedPlatform)) {
  const outputArgument = builderArguments.find((argument) => argument.startsWith('--config.directories.output='))
  const outputDirectory = outputArgument ? outputArgument.slice('--config.directories.output='.length) : 'release'
  run('scripts/collect-installers.mjs', [`--output=${outputDirectory}`, `--platform=${requestedPlatform === 'darwin' ? 'mac' : 'win'}`])
}
