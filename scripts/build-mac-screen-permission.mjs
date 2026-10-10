import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectDirectory = fileURLToPath(new URL('../', import.meta.url))
const requiredHeaders = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h', 'node_version.h']
const clangArchitectures = { arm64: 'arm64', x64: 'x86_64' }

export function resolveNodeApiHeaders() {
  // Use the official headers shipped with an installed Node distribution.
  // There is no network fallback and no hand-written Node ABI declarations.
  const candidates = [
    path.resolve(path.dirname(process.execPath), '../include/node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
    '/opt/homebrew/opt/node/include/node',
    '/usr/local/opt/node/include/node',
  ]
  for (const candidate of candidates) {
    if (requiredHeaders.every((name) => fs.existsSync(path.join(candidate, name)))) return fs.realpathSync(candidate)
  }
  throw new Error('Official Node N-API headers are missing. Install Node development headers before building; no runtime download or ABI fallback is used.')
}

export function buildMacScreenPermission({ arch = process.arch, outputPath } = {}) {
  if (process.platform !== 'darwin') throw new Error('The macOS screen permission module must be built on macOS.')
  const clangArch = clangArchitectures[arch]
  if (!clangArch) throw new Error(`Unsupported macOS screen permission architecture: ${arch}. Expected arm64 or x64.`)
  const headers = resolveNodeApiHeaders()
  const destination = outputPath
    ? path.resolve(outputPath)
    : path.join(projectDirectory, 'bundled-tools', `darwin-${arch}`, 'screen-permission.node')
  if (path.basename(destination) !== 'screen-permission.node') throw new Error('The generated module must be named screen-permission.node.')
  const sourcePath = path.join(projectDirectory, 'native', 'mac-screen-permission.c')
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-screen-permission-build-'))
  const temporaryOutput = path.join(temporaryDirectory, 'screen-permission.node')
  try {
    const result = spawnSync('/usr/bin/xcrun', [
      'clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-arch', clangArch, '-mmacosx-version-min=11.0',
      '-DNAPI_VERSION=8', '-DBUILDING_NODE_EXTENSION', '-fvisibility=hidden',
      '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'CoreGraphics',
      '-I', headers, sourcePath, '-o', temporaryOutput,
    ], { encoding: 'utf8', timeout: 60_000 })
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to compile the macOS screen permission module: ${result.error?.message || result.stderr || result.stdout || result.status}`)
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(temporaryOutput, destination)
    fs.chmodSync(destination, 0o644)
    return { arch, outputPath: destination, headers, napiVersion: 8, bytes: fs.statSync(destination).size }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some((arg) => !/^--arch=(arm64|x64)$/.test(arg))) {
    throw new Error('Usage: node scripts/build-mac-screen-permission.mjs [--arch=arm64|x64]')
  }
  const report = buildMacScreenPermission({ arch: args[0]?.slice('--arch='.length) || process.arch })
  console.log(`macOS screen permission module built: ${report.outputPath} (${report.bytes} bytes, N-API ${report.napiVersion}; no permission function called).`)
}
