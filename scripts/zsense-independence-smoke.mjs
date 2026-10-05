import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const main = read('electron/main.mjs')
const ipc = read('electron/ipc.mjs')
const desktopBuild = read('scripts/desktop-build.mjs')

assert.equal(fs.existsSync(path.join(root, 'electron/services/hermes-adapter.mjs')), false, '应用仍携带旧 Agent 适配器')
assert.equal(fs.existsSync(path.join(root, 'runtime-bundles/darwin-arm64/hermes-runtime.tar.gz')), false, '仓库仍携带旧 Runtime 压缩包')
assert(!main.includes("from './services/hermes-adapter.mjs'"), '主进程仍导入旧 Agent 适配器')
assert(!ipc.includes('configureProfileModel'), 'IPC 仍调用外部 Profile 模型配置')
for (const obsoleteChannel of ['zsense:runtime:install', 'zsense:runtime:check-update', 'zsense:runtime:update', 'zsense:runtime:configure-model', 'zsense:runtime:open-docs']) {
  assert(!ipc.includes(obsoleteChannel), `IPC 仍暴露旧外部 Runtime 操作：${obsoleteChannel}`)
}
assert(!desktopBuild.includes('runtime-bundles'), '桌面构建仍要求外部 Runtime')
assert(!Object.hasOwn(packageJson.dependencies || {}, 'tar'), '应用仍携带仅用于旧 Runtime 解压的 tar 依赖')
assert(!packageJson.build.extraResources?.some((item) => String(item.from || '').includes('runtime-bundles')), '安装包仍声明外部 Runtime 资源')
assert(packageJson.build.files.includes('electron/**/*'))
assert(main.includes('new ZSenseAgentCore'))
assert(main.includes('new ZSenseGatewayService'))
assert(main.includes('new ZSenseVoiceService'))

console.log(JSON.stringify({ ok: true, externalAgentAdapter: false, bundledExternalRuntime: false, nativeCore: true, nativeGateway: true, nativeVoice: true }))
