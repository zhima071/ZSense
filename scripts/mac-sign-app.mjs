import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { signAsync } from '@electron/osx-sign'
import { requireMacSigningIdentity, isMachOFile, macSignedTargets, verifyMacSignedApp, runMacCommand } from './mac-signing.mjs'
import { captureMacVoiceSigningState, refreshMacSignedVoiceManifest } from './mac-sign-voice-assets.mjs'
import { verifyVoiceBundle } from './voice-assets.mjs'

// electron-builder invokes this hook after all packaged content has settled,
// before it creates DMG/ZIP artifacts. The maintained osx-sign walker signs
// nested code deepest-first; --deep is only used for read-only verification.
export default async function signMacApp(options) {
  const identity = requireMacSigningIdentity()
  macSignedTargets(options.app) // Reject external/recursive links before signing.
  const voiceState = captureMacVoiceSigningState(options.app)
  await signAsync({
    app: options.app,
    platform: 'darwin',
    type: 'distribution',
    identity: identity.identitySha1,
    keychain: identity.keychainPath,
    identityValidation: false, // Already validated exact SHA1 and codeSign policy.
    preAutoEntitlements: false,
    strictVerify: true,
    ignore: (filePath) => !/\.(?:app|framework)$/.test(filePath) && !isMachOFile(filePath),
    optionsForFile: () => ({
      // Local builds keep the prior app runtime policy. No broadened library
      // validation entitlement is added. Developer ID builds use hardened runtime.
      hardenedRuntime: identity.developerId,
      timestamp: identity.developerId ? undefined : 'none',
      entitlements: identity.developerId ? undefined : fileURLToPath(new URL('./mac-local-entitlements.plist', import.meta.url)),
    }),
  })
  refreshMacSignedVoiceManifest(voiceState, identity)
  // Updating the packaged manifest changes the app's resource seal, but not
  // any nested signed native bytes. Re-sign ONLY the top-level bundle last.
  runMacCommand('/usr/bin/codesign', [
    '--force', '--sign', identity.identitySha1, '--keychain', identity.keychainPath,
    '--preserve-metadata=entitlements,flags',
    identity.developerId ? '--timestamp' : '--timestamp=none', options.app,
  ])
  const report = verifyMacSignedApp(path.resolve(options.app), identity)
  verifyVoiceBundle({ platformKey: voiceState.platformKey, rootPath: voiceState.toolsRoot, meloRootPath: path.join(voiceState.ttsRoot, 'melo'), macSigningIdentity: identity, macSignedAppPath: options.app })
  console.log(`Fixed macOS signing verified: ${identity.identitySha1}, ${report.signedTargets} code targets, stable app/helper requirements.`)
}
