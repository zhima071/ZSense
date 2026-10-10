import path from 'node:path'
import { requireMacSigningIdentity, verifyMacSignedApp } from './mac-signing.mjs'

if (process.platform !== 'darwin') throw new Error('macOS signing verification requires macOS.')
const appPath = path.resolve(process.argv[2] || 'release/mac-arm64/ZSense.app')
console.log(JSON.stringify(verifyMacSignedApp(appPath, requireMacSigningIdentity()), null, 2))
