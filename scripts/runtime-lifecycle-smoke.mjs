import assert from 'node:assert/strict'
import fs from 'node:fs'
import { composeAgentRuntimeStatus, ZSENSE_AGENT_CORE_VERSION } from '../electron/services/zsense-agent-core.mjs'

const status = composeAgentRuntimeStatus(
  { runnable: true, version: ZSENSE_AGENT_CORE_VERSION, message: 'ready' },
  { managedByApp: true, lifecycle: 'running', managedGatewayCount: 2, gatewayExpectedCount: 2, gatewayHealthyCount: 2, gatewayMonitorEnabled: true, gatewayHealthCheckIntervalSeconds: 30, gatewayRecoveryCount: 1, dataPath: '/tmp/zsense-gateway' },
  { supported: true, provider: 'ZSense 客户端识别 + macOS 系统语音', wakePhrase: '你好 ZSense' },
  '/tmp/zsense-agent-core',
)

assert.equal(status.runnable, true)
assert.equal(status.agentEngine, 'zsense-core')
assert.equal(status.gatewayEngine, 'zsense-native')
assert.equal(status.voiceEngine, 'zsense-native')
assert.equal(status.gatewayHealthyCount, 2)
assert.equal(status.managedByApp, true)
assert.equal(status.agentDataPath, '/tmp/zsense-agent-core')
assert.equal(status.gatewayDataPath, '/tmp/zsense-gateway')
assert.equal('dataPath' in status, false)

const main = fs.readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8')
const ipc = fs.readFileSync(new URL('../electron/ipc.mjs', import.meta.url), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

assert(main.includes('new ZSenseAgentCore'))
assert(main.includes('new ZSenseGatewayService'))
assert(main.includes('new ZSenseVoiceService'))
assert(main.includes('startGatewayHealthMonitor()'))
assert(main.includes('await gatewayService?.shutdown()'))
assert(main.includes('voiceService?.shutdown()'))
assert(!main.includes('new HermesAdapter'))
assert(ipc.includes("'zsense:runtime:inspect'"))
assert(ipc.includes('ZSense Agent Core、消息网关和本地数据目录检查通过'))
assert(!packageJson.build.extraResources?.some((item) => String(item.from || '').includes('runtime-bundles')))

console.log(JSON.stringify({ ok: true, coreLifecycle: true, gatewayLifecycle: true, voiceLifecycle: true, appManaged: true, bundledExternalRuntime: false }))
