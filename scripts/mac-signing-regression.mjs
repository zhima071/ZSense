import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAC_APP_ID, MAC_HELPER_IDS, parseSigningIdentities, readMacSigningConfiguration,
  requireMacSigningIdentity, configureMacSigningBuild, assertStableDesignatedRequirement,
  macSignedTargets, verifyMacSignedApp,
} from './mac-signing.mjs'

const hash = '0123456789ABCDEF0123456789ABCDEF01234567'
const otherHash = 'A'.repeat(40)
const homeDirectory = '/fixture-user'
const keychainPath = '/fixture-user/Library/Keychains/login.keychain-db'
const config = { version: 1, identitySha1: hash.toLowerCase(), keychainPath }
const readFile = () => JSON.stringify(config)
const env = {}
const localIdentity = { ...config, identitySha1: hash, name: 'ZSense Local Code Signing', developerId: false }
const securityOutput = `  1) ${otherHash} "Unrelated Identity"\n  2) ${hash} "ZSense Local Code Signing"\n     2 valid identities found\n`
assert.equal(parseSigningIdentities(securityOutput).length, 2)
assert.deepEqual(parseSigningIdentities(`1) ${hash} "Expired" (CSSMERR_TP_CERT_EXPIRED)`), [])
assert.equal(readMacSigningConfiguration({ env, homeDirectory, readFile }).identitySha1, hash)
assert.throws(() => readMacSigningConfiguration({ env, homeDirectory, readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } }), /never falls back/)
assert.throws(() => readMacSigningConfiguration({ env, homeDirectory, readFile: () => JSON.stringify({ ...config, version: 2 }) }), /version/)
assert.throws(() => readMacSigningConfiguration({ env: { ZSENSE_MAC_SIGN_IDENTITY_SHA1: '-' }, homeDirectory, readFile }), /40-character/)
assert.throws(() => readMacSigningConfiguration({ env: { ZSENSE_MAC_SIGN_KEYCHAIN: 'relative' }, homeDirectory, readFile }), /absolute/)
assert.throws(() => readMacSigningConfiguration({ env: { ZSENSE_MAC_SIGN_EXPECTED_SHA1: otherHash }, homeDirectory, readFile }), /changed during/)
let lookup
const identity = requireMacSigningIdentity({ env, homeDirectory, readFile, execute: (command, args) => { lookup = [command, args]; return securityOutput } })
assert.equal(identity.identitySha1, hash)
assert.equal(identity.developerId, false)
assert.deepEqual(lookup, ['/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', keychainPath]])
assert.throws(() => requireMacSigningIdentity({ env, homeDirectory, readFile, execute: () => '0 valid identities found' }), /No replacement identity/)
assert.throws(() => requireMacSigningIdentity({ env, homeDirectory, readFile, execute: () => `1) ${hash} "Other Identity"` }), /must be ZSense/)
const formal = requireMacSigningIdentity({ env: { ZSENSE_MAC_SIGN_IDENTITY_SHA1: otherHash }, homeDirectory, readFile, execute: () => `1) ${otherHash} "Developer ID Application: Example (ABCDEFGHIJ)"` })
assert.equal(formal.developerId, true)
const args = configureMacSigningBuild(['--dir', '--config.directories.output=/fixture-stage'], identity, '/fixture-project')
assert(args.includes('--config.mac.identity=ZSense Local Code Signing'))
assert(args.includes('--config.forceCodeSigning=true'))
assert(args.includes(`--config.appId=${MAC_APP_ID}`))
for (const bad of ['--config.mac.identity=-', '-c.mac.sign=evil', '--config.appId=other', '--config=evil.json', '-c', '--config.mac={}', '--config.forceCodeSigning=false', '--config.afterSign=evil']) {
  assert.throws(() => configureMacSigningBuild(['--dir', bad], identity, '/fixture-project'), /Unsafe/)
}
const metadata = (id, dr = `identifier "${id}" and anchor H"${hash}"`) => `Identifier=${id}\n# designated => ${dr}\n`
assert.equal(assertStableDesignatedRequirement(metadata(MAC_APP_ID), identity, MAC_APP_ID).identifier, MAC_APP_ID)
assert.throws(() => assertStableDesignatedRequirement(metadata(MAC_APP_ID, `cdhash H"${hash}"`), identity), /stable certificate/)
assert.throws(() => assertStableDesignatedRequirement(metadata(MAC_APP_ID, `identifier "${MAC_APP_ID}"`), identity), /stable certificate/)
assert.throws(() => assertStableDesignatedRequirement(metadata(MAC_APP_ID, `identifier "${MAC_APP_ID}" and anchor H"${otherHash}"`), identity), /pinned/)
assert.throws(() => assertStableDesignatedRequirement(metadata('Electron'), identity, MAC_APP_ID), /Unexpected/)
assert.throws(() => assertStableDesignatedRequirement(metadata(MAC_APP_ID, `identifier "${MAC_APP_ID}" or anchor H"${hash}"`), identity), /stable certificate/)
assert.doesNotThrow(() => assertStableDesignatedRequirement(metadata(MAC_APP_ID, `identifier "${MAC_APP_ID}" and anchor apple generic and certificate leaf[subject.OU] = "ABCDEFGHIJ"`), formal, MAC_APP_ID))

const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-mac-sign-test-')))
try {
  const appPath = path.join(temporary, 'ZSense.app')
  fs.mkdirSync(path.join(appPath, 'Contents', 'Frameworks'), { recursive: true })
  const helperNames = ['ZSense Helper.app', 'ZSense Helper (GPU).app', 'ZSense Helper (Renderer).app', 'ZSense Helper (Plugin).app']
  const helpers = helperNames.map((name) => path.join(appPath, 'Contents', 'Frameworks', name))
  for (const helper of helpers) fs.mkdirSync(helper)
  const executable = path.join(appPath, 'Contents', 'fixture-executable')
  fs.writeFileSync(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
  fs.writeFileSync(path.join(appPath, 'Contents', 'fixture-image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const targets = macSignedTargets(appPath)
  assert.equal(targets.length, 6)
  const execute = (command, commandArgs) => {
    assert.equal(command, '/usr/bin/codesign')
    const target = commandArgs.at(-1)
    if (commandArgs.includes('--display')) {
      return metadata(target === appPath ? MAC_APP_ID : helpers.includes(target) ? MAC_HELPER_IDS[helpers.indexOf(target)] : 'fixture-executable')
    }
    if (commandArgs.includes('-R')) {
      assert.equal(commandArgs[commandArgs.indexOf('-R') + 1], `=certificate leaf = H"${hash}"`, 'codesign -R requires = for inline expressions, otherwise it interprets a file path.')
    }
    return ''
  }
  const report = verifyMacSignedApp(appPath, localIdentity, { targets, execute })
  assert.equal(report.signedTargets, 6)
  assert.equal(report.requirements.length, 5)
  assert.throws(() => verifyMacSignedApp(appPath, localIdentity, { targets, execute: (command, commandArgs) => {
    if (commandArgs.includes('-R') && commandArgs.at(-1) === executable) throw new Error('wrong leaf certificate')
    return execute(command, commandArgs)
  } }), /wrong leaf/)
  assert.throws(() => verifyMacSignedApp(appPath, localIdentity, { targets: targets.filter((target) => target !== helpers[0]), execute }), /Missing signed helper/)
  fs.symlinkSync(temporary, path.join(appPath, 'Contents', 'outside'))
  assert.throws(() => macSignedTargets(appPath), /External symbolic link/)
  fs.unlinkSync(path.join(appPath, 'Contents', 'outside'))
  fs.symlinkSync(appPath, path.join(appPath, 'Contents', 'recursive'))
  assert.throws(() => macSignedTargets(appPath), /Recursive symbolic link/)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hook = fs.readFileSync(path.join(projectDirectory, 'scripts', 'mac-sign-app.mjs'), 'utf8')
assert(hook.includes('signAsync'))
assert(!hook.includes("'--deep'"))
assert(!fs.readFileSync(path.join(projectDirectory, 'scripts', 'mac-local-entitlements.plist'), 'utf8').includes('disable-library-validation'))
const buildSource = fs.readFileSync(path.join(projectDirectory, 'scripts', 'desktop-build.mjs'), 'utf8')
assert(buildSource.indexOf('const report = verifyMacSignedApp(appPath, macIdentity)') > buildSource.indexOf("run('node_modules/electron-builder/out/cli/cli.js'"), 'Verify final artifact even if a builder/CI hook is skipped.')
console.log('Fixed macOS signing regression passed: exact SHA1/keychain, no fallback, identity continuity, nested signer/content verification, no broad requirements or external links.')
