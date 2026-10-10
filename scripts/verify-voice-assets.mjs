import path from 'node:path'
import { verifyVoiceBundle } from './voice-assets.mjs'

const platformKey = process.argv[2] || `${process.platform}-${process.arch}`
const rootPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined
const meloRootPath = process.argv[4] ? path.resolve(process.argv[4]) : undefined
try {
  console.log(JSON.stringify({ ok: true, platformKey, ...verifyVoiceBundle({ platformKey, rootPath, meloRootPath }) }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, platformKey, error: error.message }))
  process.exitCode = 1
}
