import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../android-companion/app/src/main/java/com/zsense/companion/AndroidUpdateManager.java', import.meta.url), 'utf8')
assert.match(source, /open\(RELEASE_API, null, false\)/, 'release metadata must use the JSON request path')
assert.match(source, /open\(release\.url, [^\n]+, true\)/, 'APK must use the binary download request path')
assert.match(source, /setRequestProperty\("Accept", download \? "application\/octet-stream" : "application\/vnd\.github\+json"\)/,
  'GitHub release metadata must not request an octet stream (HTTP 415)')
console.log(JSON.stringify({ ok: true, releaseMetadataAccept: 'application/vnd.github+json', apkAccept: 'application/octet-stream' }))
