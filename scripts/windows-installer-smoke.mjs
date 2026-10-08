import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const installer = read('build/installer.nsh')
const workflow = read('.github/workflows/build-windows-offline.yml')
const desktopBuild = read('scripts/desktop-build.mjs')
const windowsAssets = read('scripts/windows-offline-assets.mjs')
const windowsPrepare = read('scripts/prepare-windows-offline-tools.mjs')
const electronMain = read('electron/main.mjs')

assert.equal(packageJson.build?.win?.target, 'nsis')
assert.equal(packageJson.build?.nsis?.oneClick, false)
assert.equal(packageJson.build?.nsis?.include, 'build/installer.nsh')
for (const requiredCheck of [
  '${AtLeastWin10}',
  '${RunningX64}',
  '${DriveSpace}',
  '$APPDATA\\ZSense\\.installer-write-test',
  'tasklist.exe',
  '3072',
  'Agent Core',
  '消息网关',
  '本地 STT / TTS',
  'VC_redist.x64.exe',
  'Office / 钉钉 / 金山文档',
  '!define ZSENSE_INSTALL_FOLDER "ZSense"',
  'Function ZSenseEnsureInstallDirectory',
  '${GetFileName} "$INSTDIR" $0',
  'StrCpy $INSTDIR "$INSTDIR\\${ZSENSE_INSTALL_FOLDER}"',
  '√ 最终安装目录：$INSTDIR',
  'Function un.ZSenseUninstallDataCreate',
  'Function un.ZSenseUninstallDataLeave',
  '!macro customUnWelcomePage',
  '!macro customUnInit',
  '!macro customUnInstall',
  '保留用户数据（推荐，重新安装后可继续使用）',
  '删除全部用户数据',
  'MB_DEFBUTTON2',
  'RMDir /r "$APPDATA\\${APP_FILENAME}"',
  'RMDir /r "$APPDATA\\${APP_PACKAGE_NAME}"',
  'RMDir /r "$LOCALAPPDATA\\${APP_FILENAME}"',
  '${IfNot} ${isUpdated}',
  '/KEEP_APP_DATA',
]) assert(installer.includes(requiredCheck), `Windows 安装前检查缺少：${requiredCheck}`)
assert.equal(packageJson.build?.win?.icon, 'build/icon-win.png', 'Windows 安装包没有使用白底专用图标')
assert(packageJson.build?.files?.includes('build/icon-win.png'), 'Windows 白底图标没有包含进安装包')
for (const trayCapability of ['new Tray(', "process.platform === 'win32' && !isQuitting", 'mainWindow?.hide()', '退出 ZSense']) {
  assert(electronMain.includes(trayCapability), `Windows 托盘生命周期缺少：${trayCapability}`)
}

for (const obsolete of ['ZSENSE_HERMES_VERSION', 'hermes-runtime', 'Hermes Agent', 'Python ${', 'Node.js ${', 'Git ${']) {
  assert(!installer.includes(obsolete), `Windows 安装器仍包含外部 Runtime 项：${obsolete}`)
}
assert(!workflow.includes('runtime-bundles'), 'Windows 构建仍在下载或发布外部 Runtime')
assert(!workflow.includes('prepare-hermes-runtime-source'), 'Windows 构建仍在准备外部 Runtime')
assert(workflow.includes('npm run test:independence'))
assert(workflow.includes('npm run tools:prepare:win'))
assert(workflow.includes('npm run test:windows-tools'))
assert(workflow.includes('npm run test:office'))
assert(workflow.includes('npm run desktop:build:win'))
assert(desktopBuild.includes("run('scripts/verify-windows-offline-tools.mjs')"), 'Windows 构建没有强制执行完整离线资源检查')
assert(windowsPrepare.includes("safeCopy(archives.get('cloudflared'), path.join(windowsBundleRoot, 'cloudflared.exe'))"), 'Windows 离线准备没有把校验后的 cloudflared 写入安装资源')
for (const requiredFile of ['officecli.exe', 'dws.exe', 'kdocs-cli.exe', 'whisper-cli.exe', 'ggml-base.bin', 'VC_redist.x64.exe']) {
  assert(windowsAssets.includes(`'${requiredFile}'`) || windowsAssets.includes(`/${requiredFile}`), `Windows 完整资源定义缺少：${requiredFile}`)
}

console.log(JSON.stringify({ ok: true, nsisPreflight: true, uninstallDataChoice: true, defaultUninstallBehavior: 'keep-user-data', checks: ['windows-version', 'x64', 'disk-space', 'appdata-write', 'running-app', 'offline-tools', 'vc-runtime', 'uninstall-data-choice'], externalRuntimeRequired: false }))
