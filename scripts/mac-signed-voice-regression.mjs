import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  meloFiles as officialMeloFiles, meloRevision, voiceLicenseAssets as officialLicenses,
  voiceRuntimeAssets as officialRuntimes, voiceThirdPartyNotices as officialNotices,
  whisperModel as officialWhisper, whisperRevision,
} from './voice-assets.mjs'

// Exercise the production verifier and signing-state code with a small, known
// resource catalog. Only catalog declarations are replaced in a temporary
// module mirror; validation and signing implementation remain unchanged. This
// test does not read packaged/user resources or invoke codesign/keychain tools.
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-signed-voice-test-')))
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const identitySha1 = '0123456789ABCDEF0123456789ABCDEF01234567'
const otherIdentitySha1 = 'A'.repeat(40)
const identity = { identitySha1, name: 'ZSense Local Code Signing', developerId: false }
const payloads = new Map()
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const fixtureEntry = (namespace, file, native = false) => {
  const bytes = Buffer.concat([native ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) : Buffer.alloc(0), Buffer.from(`fixture:${namespace}:${file}\n`)])
  payloads.set(`${namespace}/${file}`, bytes)
  return { file, size: bytes.length, sha256: digest(bytes) }
}
const meloFiles = officialMeloFiles.map(({ file }) => fixtureEntry('melo', file))
const whisperModel = fixtureEntry('stt', officialWhisper.file)
const voiceThirdPartyNotices = fixtureEntry('notices', officialNotices.file)
const voiceLicenseAssets = officialLicenses.map((license) => ({ ...license, sha256: fixtureEntry('licenses', license.file).sha256 }))
const voiceRuntimeAssets = Object.fromEntries(Object.entries(officialRuntimes).map(([platformKey, asset]) => [platformKey, {
  ...asset,
  files: asset.files.map(({ file }) => fixtureEntry(platformKey, file, platformKey.startsWith('darwin-'))),
}]))

function replaceCatalog(source, name, value) {
  const declaration = `export const ${name} = `
  const start = source.indexOf(declaration)
  assert(start >= 0, `Missing production catalog declaration: ${name}`)
  let end
  if (name === 'whisperModel') end = source.indexOf('\n', start)
  else end = source.indexOf('\nexport ', start + declaration.length)
  assert(end > start, `Unbounded production catalog declaration: ${name}`)
  return `${source.slice(0, start)}${declaration}Object.freeze(${JSON.stringify(value)})\n${source.slice(end)}`
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function writeManifest(filePath, manifest) {
  writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`)
}

let scenarioNumber = 0
let rejected = 0
const reject = (callback, message) => {
  assert.throws(callback, undefined, message)
  rejected += 1
}

try {
  const moduleDirectory = path.join(temporary, 'modules')
  fs.mkdirSync(moduleDirectory)
  let voiceSource = fs.readFileSync(path.join(scriptsDirectory, 'voice-assets.mjs'), 'utf8')
  for (const [name, catalog] of Object.entries({ whisperModel, meloFiles, voiceRuntimeAssets, voiceLicenseAssets, voiceThirdPartyNotices })) voiceSource = replaceCatalog(voiceSource, name, catalog)
  writeFile(path.join(moduleDirectory, 'voice-assets.mjs'), voiceSource)
  writeFile(path.join(moduleDirectory, 'mac-signing.mjs'), fs.readFileSync(path.join(scriptsDirectory, 'mac-signing.mjs'), 'utf8'))
  writeFile(path.join(moduleDirectory, 'mac-sign-voice-assets.mjs'), fs.readFileSync(path.join(scriptsDirectory, 'mac-sign-voice-assets.mjs'), 'utf8'))
  const voice = await import(pathToFileURL(path.join(moduleDirectory, 'voice-assets.mjs')).href)
  const signing = await import(pathToFileURL(path.join(moduleDirectory, 'mac-sign-voice-assets.mjs')).href)
  assert.equal(typeof signing.captureMacVoiceSigningState, 'function')
  assert.equal(typeof signing.refreshMacSignedVoiceManifest, 'function')

  function createFixture(platformKey = 'darwin-arm64') {
    const appPath = path.join(temporary, `scenario-${++scenarioNumber}`, 'ZSense.app')
    const rootPath = path.join(appPath, 'Contents', 'Resources', 'bundled-tools')
    const ttsRoot = path.join(rootPath, 'tts')
    const meloRootPath = path.join(ttsRoot, 'melo')
    const asset = voiceRuntimeAssets[platformKey]
    for (const name of ['ZSense Helper.app', 'ZSense Helper (GPU).app', 'ZSense Helper (Renderer).app', 'ZSense Helper (Plugin).app']) fs.mkdirSync(path.join(appPath, 'Contents', 'Frameworks', name), { recursive: true })
    for (const entry of asset.files) writeFile(path.join(ttsRoot, entry.file), payloads.get(`${platformKey}/${entry.file}`))
    for (const license of voiceLicenseAssets) writeFile(path.join(ttsRoot, 'licenses', license.file), payloads.get(`licenses/${license.file}`))
    writeFile(path.join(ttsRoot, voiceThirdPartyNotices.file), payloads.get(`notices/${voiceThirdPartyNotices.file}`))
    for (const entry of meloFiles) writeFile(path.join(meloRootPath, entry.file), payloads.get(`melo/${entry.file}`))
    writeManifest(path.join(meloRootPath, 'manifest.json'), { schemaVersion: 1, offline: true, precision: 'fp32', revision: meloRevision, files: meloFiles })
    writeFile(path.join(rootPath, 'stt', whisperModel.file), payloads.get(`stt/${whisperModel.file}`))
    writeManifest(path.join(rootPath, 'stt', 'manifest.json'), { networkRequiredAtRuntime: false, model: { precision: 'q5_1', revision: whisperRevision, ...whisperModel } })
    const originalFiles = voice.voiceFileEntries(ttsRoot).filter(({ file }) => file !== 'manifest.json' && !file.startsWith('melo/'))
    const manifest = { schemaVersion: 1, platform: platformKey, binary: asset.binary, networkRequiredAtRuntime: false, source: { version: asset.version, sha256: asset.sha256 }, files: originalFiles }
    const manifestPath = path.join(ttsRoot, 'manifest.json')
    writeManifest(manifestPath, manifest)
    return { appPath, rootPath, ttsRoot, meloRootPath, platformKey, asset, originalFiles, manifest, manifestPath }
  }

  const commands = []
  function execute(command, args) {
    assert.equal(command, '/usr/bin/codesign', 'No real commands, security, or keychain access is permitted.')
    commands.push({ command, args: [...args] })
    if (args.includes('--display')) {
      const target = args.at(-1)
      const name = path.basename(target)
      const identifier = name === 'ZSense.app' ? 'ai.zsense.studio'
        : name === 'ZSense Helper.app' ? 'ai.zsense.studio.helper'
          : name === 'ZSense Helper (GPU).app' ? 'ai.zsense.studio.helper.GPU'
            : name === 'ZSense Helper (Renderer).app' ? 'ai.zsense.studio.helper.Renderer'
              : name === 'ZSense Helper (Plugin).app' ? 'ai.zsense.studio.helper.Plugin' : name
      return `Identifier=${identifier}\n# designated => identifier "${identifier}" and anchor H"${identitySha1}"\n`
    }
    assert(args.includes('--verify') && args.includes('--strict'), 'Native TTS requires strict signature verification.')
    if (args.includes('-R')) assert.equal(args[args.indexOf('-R') + 1], `=certificate leaf = H"${identitySha1}"`, 'Use the pinned certificate as an inline requirement.')
    return ''
  }

  const verify = (fixture, options = {}) => voice.verifyVoiceBundle({ platformKey: fixture.platformKey, rootPath: fixture.rootPath, meloRootPath: fixture.meloRootPath, ...options })
  const signedOptions = (fixture) => ({ macSigningIdentity: identity, macSignedAppPath: fixture.appPath, executeSigning: execute })
  const appendSignature = (fixture) => {
    for (const { file } of fixture.asset.files) fs.appendFileSync(path.join(fixture.ttsRoot, file), '\nfixture-code-signature\n')
  }
  const refresh = (state, options = {}) => signing.refreshMacSignedVoiceManifest(state, identity, { execute, ...options })
  const signedFixture = () => {
    const fixture = createFixture()
    const state = signing.captureMacVoiceSigningState(fixture.appPath)
    appendSignature(fixture)
    refresh(state)
    return { ...fixture, state, signedManifest: JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8')) }
  }
  const updateDeclaredFile = (fixture, file, manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'))) => {
    const actual = voice.voiceFileEntries(fixture.ttsRoot).find((entry) => entry.file === file)
    manifest.files = manifest.files.map((entry) => entry.file === file ? actual : entry)
    writeManifest(fixture.manifestPath, manifest)
    return manifest
  }

  const sourceFixture = createFixture()
  const originalManifestBytes = fs.readFileSync(sourceFixture.manifestPath)
  assert.equal(verify(sourceFixture).ttsFiles, sourceFixture.originalFiles.length)
  const state = signing.captureMacVoiceSigningState(sourceFixture.appPath)
  assert.equal(state.ttsRoot, sourceFixture.ttsRoot)
  assert.deepEqual(state.originalFiles, sourceFixture.originalFiles)
  assert.deepEqual(fs.readFileSync(sourceFixture.manifestPath), originalManifestBytes, 'Capturing original assets is read-only.')
  appendSignature(sourceFixture)
  refresh(state)
  const signedManifest = JSON.parse(fs.readFileSync(sourceFixture.manifestPath, 'utf8'))
  assert.deepEqual(signedManifest.originalFiles, sourceFixture.originalFiles, 'Retain trusted upstream digests and sizes.')
  assert.deepEqual(signedManifest.packaging, { schemaVersion: 1, kind: 'macos-codesign', identitySha1 })
  assert.deepEqual(signedManifest.source, sourceFixture.manifest.source)
  assert.deepEqual(signedManifest.files, voice.voiceFileEntries(sourceFixture.ttsRoot).filter(({ file }) => file !== 'manifest.json' && !file.startsWith('melo/')))
  const commandStart = commands.length
  assert.equal(verify(sourceFixture, signedOptions(sourceFixture)).ttsFiles, sourceFixture.originalFiles.length)
  const signedTargets = commands.slice(commandStart).filter(({ args }) => args.includes('-R')).map(({ args }) => args.at(-1))
  assert.equal(signedTargets.length, 7, 'Verify the top-level App, four helpers, TTS executable, and dylib certificates.')
  for (const { file } of sourceFixture.asset.files) assert(signedTargets.includes(path.join(sourceFixture.ttsRoot, file)))
  reject(() => verify(sourceFixture), 'Default source verification must reject signed-resource overrides.')
  reject(() => signing.captureMacVoiceSigningState(sourceFixture.appPath), 'Signing capture only accepts original upstream assets.')

  for (const mutate of [
    (manifest) => { manifest.packaging.schemaVersion = 2 },
    (manifest) => { manifest.packaging.kind = 'arbitrary-transform' },
    (manifest) => { manifest.packaging.identitySha1 = otherIdentitySha1 },
    (manifest) => { manifest.packaging.identitySha1 = '-' },
    (manifest) => { manifest.source.sha256 = '0'.repeat(64) },
    (manifest) => { manifest.source.version = '0.0.0' },
    (manifest) => { delete manifest.originalFiles },
    (manifest) => { manifest.originalFiles[0].sha256 = '0'.repeat(64) },
    (manifest) => { manifest.originalFiles.find(({ file }) => file === 'sherpa-onnx-offline-tts').sha256 = '0'.repeat(64) },
    (manifest) => { manifest.originalFiles.find(({ file }) => file === 'libonnxruntime.dylib').size += 1 },
    (manifest) => { manifest.originalFiles.find(({ file }) => file === voiceThirdPartyNotices.file).sha256 = '0'.repeat(64) },
    (manifest) => { manifest.originalFiles.find(({ file }) => file === voiceThirdPartyNotices.file).size += 1 },
    (manifest) => {
      manifest.originalFiles = manifest.originalFiles.map((entry) => entry.file === 'sherpa-onnx-offline-tts' ? { ...manifest.files.find(({ file }) => file === entry.file) } : entry)
    },
    (manifest) => { manifest.originalFiles[0].size = -1 },
    (manifest) => { manifest.originalFiles.push({ ...manifest.originalFiles[0] }) },
    (manifest) => { manifest.files.push({ ...manifest.files[0] }) },
    (manifest) => { manifest.files = manifest.files.filter(({ file }) => file !== 'libonnxruntime.dylib') },
  ]) {
    const fixture = signedFixture()
    mutate(fixture.signedManifest)
    writeManifest(fixture.manifestPath, fixture.signedManifest)
    reject(() => verify(fixture, signedOptions(fixture)), 'Manifest fields cannot grant trust to forged signed resources.')
  }

  const wrongIdentity = signedFixture()
  reject(() => verify(wrongIdentity, { ...signedOptions(wrongIdentity), macSigningIdentity: { ...identity, identitySha1: otherIdentitySha1 } }), 'The caller and manifest must agree on the pinned identity.')
  reject(() => verify(wrongIdentity, { ...signedOptions(wrongIdentity), macSigningIdentity: undefined }), 'A self-reported manifest identity cannot replace the caller context.')
  reject(() => verify(wrongIdentity, { ...signedOptions(wrongIdentity), macSignedAppPath: undefined }), 'Signed resources require a verified parent app context.')
  const unrelatedApp = createFixture()
  reject(() => verify(wrongIdentity, { ...signedOptions(wrongIdentity), macSignedAppPath: unrelatedApp.appPath }), 'An unrelated signed app cannot authorize these resources.')
  reject(() => verify(wrongIdentity, { ...signedOptions(wrongIdentity), executeSigning: (command, args) => {
    if (args.includes('--deep')) throw new Error('fixture top-level resource seal invalid')
    return execute(command, args)
  } }), 'The parent app resource seal must authenticate the signed-resource manifest.')
  reject(() => verify(wrongIdentity, { ...signedOptions(wrongIdentity), executeSigning: (command, args) => {
    if (args.includes('-R') && args.at(-1) === path.join(wrongIdentity.ttsRoot, wrongIdentity.asset.binary)) throw new Error('fixture leaf certificate mismatch')
    return execute(command, args)
  } }), 'A native leaf-certificate verification failure must propagate.')
  const missingHelper = signedFixture()
  fs.rmdirSync(path.join(missingHelper.appPath, 'Contents', 'Frameworks', 'ZSense Helper (GPU).app'))
  reject(() => verify(missingHelper, signedOptions(missingHelper)), 'A signed native TTS bundle does not excuse a missing helper.')
  const tamperedSignedBinary = signedFixture()
  fs.appendFileSync(path.join(tamperedSignedBinary.ttsRoot, tamperedSignedBinary.asset.binary), 'post-manifest-tamper')
  reject(() => verify(tamperedSignedBinary, signedOptions(tamperedSignedBinary)), 'Signed file bytes must still match their recorded checksum.')

  for (const file of ['THIRD_PARTY_NOTICES.txt', `licenses/${voiceLicenseAssets[0].file}`, 'melo/model.onnx', 'melo/LICENSE']) {
    const fixture = createFixture()
    const capture = signing.captureMacVoiceSigningState(fixture.appPath)
    const before = fs.readFileSync(fixture.manifestPath)
    appendSignature(fixture)
    fs.appendFileSync(path.join(fixture.ttsRoot, file), 'unauthorized-non-native-change')
    reject(() => refresh(capture), `Signing must not accept a changed model, license, or notice: ${file}`)
    assert.deepEqual(fs.readFileSync(fixture.manifestPath), before, 'Failed transformation cannot write a permissive manifest.')
  }

  for (const change of [
    (fixture) => writeFile(path.join(fixture.ttsRoot, 'extra-runtime.dylib'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe])),
    (fixture) => fs.unlinkSync(path.join(fixture.ttsRoot, fixture.asset.libraryFiles[0])),
  ]) {
    const fixture = createFixture()
    const capture = signing.captureMacVoiceSigningState(fixture.appPath)
    const before = fs.readFileSync(fixture.manifestPath)
    appendSignature(fixture)
    change(fixture)
    reject(() => refresh(capture), 'Signing cannot add or remove native resources.')
    assert.deepEqual(fs.readFileSync(fixture.manifestPath), before)
  }

  const changedSignedLicense = signedFixture()
  const signedLicenseFile = `licenses/${voiceLicenseAssets[0].file}`
  fs.appendFileSync(path.join(changedSignedLicense.ttsRoot, signedLicenseFile), 'forged-signed-license')
  updateDeclaredFile(changedSignedLicense, signedLicenseFile)
  reject(() => verify(changedSignedLicense, signedOptions(changedSignedLicense)), 'Updating a signed-file checksum cannot authorize a license modification.')

  for (const file of [voiceThirdPartyNotices.file, signedLicenseFile]) {
    const fixture = signedFixture()
    fs.appendFileSync(path.join(fixture.ttsRoot, file), 'forged-content-with-matching-self-reported-hashes')
    const manifest = updateDeclaredFile(fixture, file)
    const selfReported = manifest.files.find((entry) => entry.file === file)
    manifest.originalFiles = manifest.originalFiles.map((entry) => entry.file === file ? { ...selfReported } : entry)
    writeManifest(fixture.manifestPath, manifest)
    reject(() => verify(fixture, signedOptions(fixture)), 'Matching files and originalFiles cannot replace trusted notice or license pins.')
  }

  const additionalSignedResource = signedFixture()
  const additionalFile = 'licenses/self-reported-license.txt'
  writeFile(path.join(additionalSignedResource.ttsRoot, additionalFile), 'self-reported extra license\n')
  const additionalEntry = voice.voiceFileEntries(additionalSignedResource.ttsRoot).find(({ file }) => file === additionalFile)
  additionalSignedResource.signedManifest.files.push(additionalEntry)
  additionalSignedResource.signedManifest.originalFiles.push({ ...additionalEntry })
  writeManifest(additionalSignedResource.manifestPath, additionalSignedResource.signedManifest)
  reject(() => verify(additionalSignedResource, signedOptions(additionalSignedResource)), 'Matching self-reported inventories cannot add resources beyond the official catalog.')

  for (const file of [voiceThirdPartyNotices.file, signedLicenseFile]) {
    const fixture = signedFixture()
    fs.unlinkSync(path.join(fixture.ttsRoot, file))
    fixture.signedManifest.files = fixture.signedManifest.files.filter((entry) => entry.file !== file)
    fixture.signedManifest.originalFiles = fixture.signedManifest.originalFiles.filter((entry) => entry.file !== file)
    writeManifest(fixture.manifestPath, fixture.signedManifest)
    reject(() => verify(fixture, signedOptions(fixture)), 'Matching self-reported inventories cannot omit official licenses or notices.')
  }

  for (const manifestLocation of ['tts/manifest.json', 'tts/melo/manifest.json', 'stt/manifest.json']) {
    const fixture = createFixture()
    const capture = signing.captureMacVoiceSigningState(fixture.appPath)
    appendSignature(fixture)
    const changedPath = path.join(fixture.rootPath, manifestLocation)
    const changed = JSON.parse(fs.readFileSync(changedPath, 'utf8'))
    if (manifestLocation === 'tts/manifest.json') changed.source.sha256 = '0'.repeat(64)
    else if (manifestLocation === 'tts/melo/manifest.json') changed.offline = false
    else changed.networkRequiredAtRuntime = true
    writeManifest(changedPath, changed)
    const beforeRefresh = fs.readFileSync(fixture.manifestPath)
    reject(() => refresh(capture), `Signing cannot replace or change the trusted manifest: ${manifestLocation}`)
    assert.deepEqual(fs.readFileSync(fixture.manifestPath), beforeRefresh, 'Manifest changes must fail before writing signed TTS metadata.')
  }

  const changedManifestWhitespace = createFixture()
  const whitespaceState = signing.captureMacVoiceSigningState(changedManifestWhitespace.appPath)
  appendSignature(changedManifestWhitespace)
  fs.appendFileSync(changedManifestWhitespace.manifestPath, '\n')
  const whitespaceManifestBytes = fs.readFileSync(changedManifestWhitespace.manifestPath)
  reject(() => refresh(whitespaceState), 'Capture binds exact source-manifest bytes, including otherwise valid JSON changes.')
  assert.deepEqual(fs.readFileSync(changedManifestWhitespace.manifestPath), whitespaceManifestBytes)

  const forgedCapturedOriginal = createFixture()
  const forgedCapturedState = signing.captureMacVoiceSigningState(forgedCapturedOriginal.appPath)
  const forgedCapturedManifest = fs.readFileSync(forgedCapturedOriginal.manifestPath)
  forgedCapturedState.originalFiles.find(({ file }) => file === forgedCapturedOriginal.asset.binary).sha256 = '0'.repeat(64)
  appendSignature(forgedCapturedOriginal)
  reject(() => refresh(forgedCapturedState), 'Signing state cannot forge the trusted original native digests.')
  assert.deepEqual(fs.readFileSync(forgedCapturedOriginal.manifestPath), forgedCapturedManifest)

  const failedLeaf = createFixture()
  const failedState = signing.captureMacVoiceSigningState(failedLeaf.appPath)
  const failedOriginalManifest = fs.readFileSync(failedLeaf.manifestPath)
  appendSignature(failedLeaf)
  reject(() => refresh(failedState, { execute: () => { throw new Error('fixture invalid native signature') } }))
  assert.deepEqual(fs.readFileSync(failedLeaf.manifestPath), failedOriginalManifest, 'Check signatures before replacing the manifest.')

  const forgedSource = createFixture()
  fs.appendFileSync(path.join(forgedSource.ttsRoot, forgedSource.asset.binary), 'forged-before-capture')
  updateDeclaredFile(forgedSource, forgedSource.asset.binary)
  reject(() => signing.captureMacVoiceSigningState(forgedSource.appPath), 'Self-reported source digests do not replace official native hashes.')
  const forgedLicense = createFixture()
  const licenseFile = `licenses/${voiceLicenseAssets[0].file}`
  fs.appendFileSync(path.join(forgedLicense.ttsRoot, licenseFile), 'forged-before-capture')
  updateDeclaredFile(forgedLicense, licenseFile)
  reject(() => signing.captureMacVoiceSigningState(forgedLicense.appPath), 'Self-reported source digests do not replace pinned license hashes.')
  const forgedNotice = createFixture()
  fs.appendFileSync(path.join(forgedNotice.ttsRoot, voiceThirdPartyNotices.file), 'forged-notice-before-capture')
  updateDeclaredFile(forgedNotice, voiceThirdPartyNotices.file)
  reject(() => signing.captureMacVoiceSigningState(forgedNotice.appPath), 'Self-reported source digests do not replace pinned third-party notice size and hash.')

  for (const change of [
    (fixture) => {
      writeFile(path.join(fixture.ttsRoot, additionalFile), 'self-reported source license\n')
      fixture.manifest.files.push(voice.voiceFileEntries(fixture.ttsRoot).find(({ file }) => file === additionalFile))
    },
    (fixture) => {
      fs.unlinkSync(path.join(fixture.ttsRoot, licenseFile))
      fixture.manifest.files = fixture.manifest.files.filter(({ file }) => file !== licenseFile)
    },
  ]) {
    const fixture = createFixture()
    change(fixture)
    writeManifest(fixture.manifestPath, fixture.manifest)
    reject(() => signing.captureMacVoiceSigningState(fixture.appPath), 'Source resources must match the exact trusted catalog inventory.')
  }

  const windows = createFixture('win32-x64')
  assert.equal(verify(windows).ttsFiles, windows.originalFiles.length)
  reject(() => signing.captureMacVoiceSigningState(windows.appPath), 'A macOS signing capture cannot accept a Windows speech bundle.')
  appendSignature(windows)
  windows.manifest.originalFiles = windows.originalFiles
  windows.manifest.packaging = { schemaVersion: 1, kind: 'macos-codesign', identitySha1 }
  windows.manifest.files = voice.voiceFileEntries(windows.ttsRoot).filter(({ file }) => file !== 'manifest.json' && !file.startsWith('melo/'))
  writeManifest(windows.manifestPath, windows.manifest)
  reject(() => verify(windows, signedOptions(windows)), 'macOS signature overrides cannot relax Windows native-resource pins.')

  console.log(JSON.stringify({ ok: true, rejectedCases: rejected, fixtureOnly: true, officialOriginalPins: true, sourceCatalogCannotBeSelfAttested: true, onlyNativeFilesMayChange: true, exactSigningIdentity: true, defaultSourceVerificationStrict: true, failureDoesNotRewriteManifest: true }))
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
