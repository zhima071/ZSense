import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const MAC_APP_ID = 'ai.zsense.studio'
export const MAC_HELPER_IDS = ['ai.zsense.studio.helper', 'ai.zsense.studio.helper.GPU', 'ai.zsense.studio.helper.Renderer', 'ai.zsense.studio.helper.Plugin']

export function runMacCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${String(result.stderr || result.error?.message || result.stdout).trim()}`)
  return `${result.stdout || ''}${result.stderr || ''}`
}

export function parseSigningIdentities(output) {
  return [...String(output).matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"\r\n]+)"\s*$/gm)].map((match) => ({ identitySha1: match[1].toUpperCase(), name: match[2] }))
}

export function readMacSigningConfiguration({ env = process.env, homeDirectory = os.homedir(), readFile = fs.readFileSync } = {}) {
  const configPath = path.join(homeDirectory, 'Library', 'Application Support', 'ZSense Development', 'mac-signing.json')
  let config = null
  try { config = JSON.parse(readFile(configPath, 'utf8')) }
  catch (error) {
    if (!env.ZSENSE_MAC_SIGN_IDENTITY_SHA1 || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw new Error(`Missing or invalid fixed macOS signing configuration at ${configPath}; signing never falls back to ad-hoc.`)
  }
  if (config && (config.version !== 1 || typeof config.identitySha1 !== 'string')) throw new Error('mac-signing.json must contain version: 1 and identitySha1.')
  const identitySha1 = String(env.ZSENSE_MAC_SIGN_IDENTITY_SHA1 || config?.identitySha1 || '').toUpperCase()
  if (!/^[A-F0-9]{40}$/.test(identitySha1)) throw new Error('A fixed 40-character certificate SHA1 is required; names and ad-hoc identities are not accepted.')
  const keychainPath = env.ZSENSE_MAC_SIGN_KEYCHAIN || config?.keychainPath || path.join(homeDirectory, 'Library', 'Keychains', 'login.keychain-db')
  if (typeof keychainPath !== 'string' || !path.isAbsolute(keychainPath) || /[\0\r\n]/.test(keychainPath)) throw new Error('The signing keychain must be an absolute path.')
  if (env.ZSENSE_MAC_SIGN_EXPECTED_SHA1 && identitySha1 !== env.ZSENSE_MAC_SIGN_EXPECTED_SHA1) throw new Error('Signing identity changed during the build; refusing to sign.')
  return { identitySha1, keychainPath, configPath }
}

export function requireMacSigningIdentity(options = {}) {
  const configuration = readMacSigningConfiguration(options)
  const execute = options.execute || runMacCommand
  const identities = parseSigningIdentities(execute('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', configuration.keychainPath]))
  const identity = identities.find((item) => item.identitySha1 === configuration.identitySha1)
  if (!identity) throw new Error(`Fixed code-signing identity ${configuration.identitySha1} is unavailable, expired, or untrusted for code signing. No replacement identity or ad-hoc signing will be used.`)
  const developerId = identity.name.startsWith('Developer ID Application:')
  if (!developerId && identity.name !== 'ZSense Local Code Signing') throw new Error('The fixed identity must be ZSense Local Code Signing or Developer ID Application.')
  return { ...configuration, ...identity, developerId }
}

export function configureMacSigningBuild(builderArguments, identity, projectDirectory) {
  // A CLI configuration file/object could silently replace the hook or appId.
  // Keep the supported overrides explicit instead of attempting to sanitize a
  // general electron-builder config language after it has been interpreted.
  for (const argument of builderArguments) {
    if (/^(?:--config|-c)(?:$|=|\.)/.test(argument) && !/^(?:--config|-c)\.(?:directories\.output|electronDist)=/.test(argument)) {
      throw new Error(`Unsafe macOS build override ${argument}; fixed signing/app/helper identities cannot be overridden.`)
    }
  }
  const qualifier = identity.name.replace(/^Developer ID Application:\s*/, '')
  return [...builderArguments,
    `--config.appId=${MAC_APP_ID}`,
    '--config.mac.helperBundleId=ai.zsense.studio.helper',
    `--config.mac.identity=${qualifier}`,
    `--config.mac.sign=${path.join(projectDirectory, 'scripts', 'mac-sign-app.mjs')}`,
    '--config.forceCodeSigning=true',
  ]
}

const MACH_O_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca])
export function isMachOFile(filePath) {
  let descriptor
  try {
    if (!fs.statSync(filePath).isFile()) return false
    descriptor = fs.openSync(filePath, 'r')
    const magic = Buffer.alloc(4)
    return fs.readSync(descriptor, magic, 0, 4, 0) === 4 && MACH_O_MAGIC.has(magic.readUInt32BE())
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}

export function macSignedTargets(appPath) {
  if (!path.isAbsolute(appPath) || !appPath.endsWith('.app') || fs.lstatSync(appPath).isSymbolicLink() || !fs.statSync(appPath).isDirectory()) throw new Error('Signing requires a real, absolute .app bundle path.')
  const root = fs.realpathSync(appPath)
  const targets = new Set([root])
  const withinRoot = (candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`)
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name)
      const real = fs.realpathSync(filePath)
      if (!withinRoot(real)) throw new Error(`External symbolic link in app bundle: ${filePath}`)
      if (entry.isSymbolicLink()) {
        if (fs.statSync(real).isDirectory() && (directory === real || directory.startsWith(`${real}${path.sep}`))) throw new Error(`Recursive symbolic link in app bundle: ${filePath}`)
        continue
      }
      if (entry.isDirectory()) {
        if (/\.(?:app|framework)$/.test(entry.name)) targets.add(filePath)
        walk(filePath)
      } else if (entry.isFile() && isMachOFile(filePath)) targets.add(filePath)
    }
  }
  walk(root)
  return [...targets]
}

export function assertStableDesignatedRequirement(output, identity, expectedIdentifier) {
  const identifier = String(output).match(/^Identifier=(.+)$/m)?.[1]
  const requirement = String(output).match(/(?:^|\n)#?\s*designated => (.+)/)?.[1]
  if (!identifier || (expectedIdentifier && identifier !== expectedIdentifier)) throw new Error(`Unexpected signed identifier: ${identifier || 'missing'}`)
  if (!requirement || /\bcdhash\b|\bor\b/.test(requirement) || !/\bidentifier\s+/.test(requirement) || !/\b(?:anchor|certificate)\s+/.test(requirement)) {
    throw new Error('Signing requirement must bind a stable certificate identity, not a cdhash or identifier-only rule.')
  }
  if (!identity.developerId && !requirement.toUpperCase().includes(identity.identitySha1)) throw new Error('Local signing requirement must bind the pinned certificate SHA1.')
  return { identifier, requirement }
}

export function verifyMacSignedApp(appPath, identity, { execute = runMacCommand, targets = macSignedTargets(appPath) } = {}) {
  appPath = fs.realpathSync(appPath)
  execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const identities = []
  for (const filePath of targets) {
    // Even a valid nested signature cannot be signed by an unexpected identity.
    // codesign treats a requirement argument without '=' as a filename.
    // The leading '=' explicitly selects an inline requirement expression.
    execute('/usr/bin/codesign', ['--verify', '--strict', '-R', `=certificate leaf = H"${identity.identitySha1}"`, filePath])
    const metadata = execute('/usr/bin/codesign', ['--display', '--verbose=4', '--requirements', '-', filePath])
    const expectedIdentifier = filePath === appPath ? MAC_APP_ID : filePath.endsWith('.app') ? MAC_HELPER_IDS.find((id) => {
      if (id.endsWith('.GPU')) return filePath.endsWith('ZSense Helper (GPU).app')
      if (id.endsWith('.Renderer')) return filePath.endsWith('ZSense Helper (Renderer).app')
      if (id.endsWith('.Plugin')) return filePath.endsWith('ZSense Helper (Plugin).app')
      return filePath.endsWith('ZSense Helper.app')
    }) : undefined
    if (filePath.endsWith('.app') && filePath !== appPath && !expectedIdentifier) throw new Error(`Unexpected nested application: ${filePath}`)
    identities.push({ path: filePath, ...assertStableDesignatedRequirement(metadata, identity, expectedIdentifier) })
  }
  for (const helperId of MAC_HELPER_IDS) if (!identities.some((item) => item.identifier === helperId)) throw new Error(`Missing signed helper: ${helperId}`)
  return { identitySha1: identity.identitySha1, appId: MAC_APP_ID, signedTargets: identities.length, requirements: identities.filter((item) => item.path.endsWith('.app')) }
}
