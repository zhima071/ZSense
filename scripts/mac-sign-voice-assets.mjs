import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { verifyVoiceBundle, verifyMeloBundle, voiceFileEntries, voiceRuntimeAssets, whisperModel, voiceSha256 } from './voice-assets.mjs'
import { runMacCommand } from './mac-signing.mjs'

export function captureMacVoiceSigningState(appPath) {
  const appRoot = fs.realpathSync(appPath)
  const toolsRoot = path.join(appRoot, 'Contents', 'Resources', 'bundled-tools')
  const ttsRoot = path.join(toolsRoot, 'tts')
  const manifest = JSON.parse(fs.readFileSync(path.join(ttsRoot, 'manifest.json'), 'utf8'))
  const platformKey = manifest.platform
  if (!platformKey?.startsWith('darwin-')) throw new Error('macOS signing requires a macOS speech resource bundle.')
  // No signing override: the pre-sign resources must still match the pinned
  // original upstream bytes, including model, licenses, and source provenance.
  verifyVoiceBundle({ platformKey, rootPath: toolsRoot, meloRootPath: path.join(ttsRoot, 'melo') })
  const unchangedManifests = [path.join(ttsRoot, 'manifest.json'), path.join(ttsRoot, 'melo', 'manifest.json'), path.join(toolsRoot, 'stt', 'manifest.json')].map((filePath) => ({ filePath, sha256: voiceSha256(filePath) }))
  return { appRoot, toolsRoot, ttsRoot, platformKey, manifest, originalFiles: structuredClone(manifest.files), unchangedManifests }
}

export function refreshMacSignedVoiceManifest(state, identity, { execute = runMacCommand } = {}) {
  if (!/^[A-F0-9]{40}$/.test(identity?.identitySha1 || '')) throw new Error('A fixed certificate SHA1 is required for signed speech resources.')
  const { ttsRoot, toolsRoot, platformKey, manifest, originalFiles } = state
  const expected = voiceRuntimeAssets[platformKey]
  if (!expected || !platformKey.startsWith('darwin-')) throw new Error('Unsupported signed speech platform.')
  if (!Array.isArray(state.unchangedManifests) || state.unchangedManifests.length !== 3) throw new Error('Missing pre-sign speech manifest snapshot.')
  for (const entry of state.unchangedManifests) if (voiceSha256(entry.filePath) !== entry.sha256) throw new Error(`Speech manifest changed during signing: ${entry.filePath}`)
  const actual = voiceFileEntries(ttsRoot).filter((entry) => entry.file !== 'manifest.json' && !entry.file.startsWith('melo/'))
  const originals = new Map(originalFiles.map((entry) => [entry.file, entry]))
  const transformedFiles = new Set(expected.files.map((entry) => entry.file))
  for (const entry of expected.files) {
    const original = originals.get(entry.file)
    if (original?.sha256 !== entry.sha256 || original?.size !== entry.size) throw new Error(`Untrusted original speech resource: ${entry.file}`)
  }
  if (actual.length !== originals.size || originals.size !== originalFiles.length || actual.some((entry) => !originals.has(entry.file))) throw new Error('Speech signing added or removed resources.')
  for (const entry of actual) {
    const original = originals.get(entry.file)
    if (!transformedFiles.has(entry.file)) {
      if (original.size !== entry.size || original.sha256 !== entry.sha256) throw new Error(`Non-native TTS resource changed during signing: ${entry.file}`)
    } else {
      execute('/usr/bin/codesign', ['--verify', '--strict', '-R', `=certificate leaf = H"${identity.identitySha1}"`, path.join(ttsRoot, entry.file)])
    }
  }
  verifyMeloBundle(path.join(ttsRoot, 'melo'))
  const whisperPath = path.join(toolsRoot, 'stt', whisperModel.file)
  if (fs.statSync(whisperPath).size !== whisperModel.size || voiceSha256(whisperPath) !== whisperModel.sha256) throw new Error('Whisper model changed during signing.')
  const next = {
    ...manifest,
    originalFiles,
    packaging: { schemaVersion: 1, kind: 'macos-codesign', identitySha1: identity.identitySha1 },
    files: actual,
  }
  const manifestPath = path.join(ttsRoot, 'manifest.json')
  const temporaryPath = `${manifestPath}.signing-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
    fs.renameSync(temporaryPath, manifestPath)
  } finally {
    try { fs.unlinkSync(temporaryPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return next
}
