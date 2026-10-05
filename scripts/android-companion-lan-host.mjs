// Manual Android emulator / device integration fixture. Never uses production data.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceLinkService } from '../electron/services/device-link-service.mjs'

class Vault {
  values = new Map()
  get(key) { return { ...(this.values.get(key) || {}) } }
  set(key, next) { this.values.set(key, { ...this.get(key), ...next }) }
  delete(key) { this.values.delete(key) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-android-lan-host-'))
const service = new DeviceLinkService({ rootPath: root, secrets: new Vault(), platform: 'darwin', hostname: 'LAN Test Desktop',
  discoveryPort: 39971, autoScan: false,
  remoteTaskRunner: { async run({ prompt }) { return { output: `LAN 测试桌面收到：${prompt}` } } },
})
service.appLockProvider = () => true
let closing = false
async function close() {
  if (closing) return
  closing = true
  await service.shutdown()
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
await service.setEnabled(true)
const state = service.inspect()
console.log(JSON.stringify({ port: state.device.port, pairingCode: state.pairingCode, pairingIdentityCode: state.pairingIdentityCode }))
process.stdin.setEncoding('utf8')
process.stdin.resume()
process.stdin.on('data', (input) => {
  const command = input.trim()
  if (command === 'quit') { void close(); return }
  if (command === 'grant') {
    const phone = service.inspect().trustedPeers.find((peer) => peer.platform === 'android')
    if (phone) {
      service.setPeerAccess(phone.deviceId, { allowTasks: true })
      console.log(JSON.stringify({ granted: phone.deviceId }))
    } else console.log(JSON.stringify({ granted: false }))
    return
  }
  if (command === 'inspect') console.log(JSON.stringify({ peers: service.inspect().trustedPeers }))
})
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
