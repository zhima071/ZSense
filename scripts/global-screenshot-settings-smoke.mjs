#!/usr/bin/env node
// Actual React component in an isolated headless browser. All screenshot IPC is
// mocked in memory: this test never reads the display, clipboard, or user data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')
const calls = []
let browser, server

// Exercise the real preload screenshot namespace, without loading Electron.
const ipcListeners = new Map()
let exposed
vm.runInNewContext(read('electron/preload.cjs'), {
  require(name) {
    assert.equal(name, 'electron', 'preload must not access a real runtime')
    return {
      contextBridge: { exposeInMainWorld(_name, value) { exposed = value } },
      ipcRenderer: {
        invoke(channel, ...args) { calls.push({ channel, args }); return Promise.resolve({ marker: channel }) },
        on(channel, listener) { ipcListeners.set(channel, listener) },
        removeListener(channel, listener) { assert.equal(ipcListeners.get(channel), listener); ipcListeners.delete(channel) },
      },
      webUtils: { getPathForFile() { throw new Error('File APIs must not be used by screenshot settings QA') } },
    }
  },
  process: { platform: 'darwin', versions: { electron: 'mock', chrome: 'mock' } },
  console,
})
for (const [method, channel, args] of [
  ['globalStatus', 'zsense:global-screenshot:status', []],
  ['recheckGlobalPermissions', 'zsense:global-screenshot:recheck-permissions', []],
  ['requestGlobalPermissions', 'zsense:global-screenshot:request-permissions', []],
  ['startGlobal', 'zsense:global-screenshot:start', []],
  ['setGlobalShortcut', 'zsense:global-screenshot:set-shortcut', ['CommandOrControl+Shift+9']],
]) {
  assert.deepEqual(JSON.parse(JSON.stringify(await exposed.screenshot[method](...args))), { ok: true, data: { marker: channel } })
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { channel, args: args.length ? args : [null] })
}
let receivedError = ''
const unsubscribe = exposed.screenshot.onGlobalError((message) => { receivedError = message })
ipcListeners.get('zsense:global-screenshot:error')({}, 'Permission rejected by mocked service')
assert.equal(receivedError, 'Permission rejected by mocked service')
unsubscribe()
assert.equal(ipcListeners.has('zsense:global-screenshot:error'), false)
const declarations = read('src/electron.d.ts')
assert.match(declarations, /recheckGlobalPermissions:\s*\(\)\s*=>\s*Promise<DesktopResult<GlobalScreenshotStatus>>/)
assert.match(declarations, /requestGlobalPermissions:\s*\(\)\s*=>\s*Promise<DesktopResult<GlobalScreenshotStatus>>/)
assert.match(declarations, /screenCaptureRequestAttempted:\s*boolean/)
assert.match(declarations, /onGlobalError:\s*\(callback:\s*\(message:\s*string\)\s*=>\s*void\)\s*=>\s*\(\)\s*=>\s*void/)
assert.match(read('src/App.tsx'), /useEffect\(\(\) => \{\s*if \(window\.zsenseDesktop\?\.transport === 'web-bridge'\) return\s*return window\.zsenseDesktop\?\.screenshot\?\.onGlobalError\(\(message\) => \{\s*setNotice\(\{ tone: 'error', message \}\)/, 'global shortcut errors must surface even when the settings panel is closed')

const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { GlobalScreenshotSettings } from './src/components/GlobalScreenshotSettings';
      const spec = window.__screenshotSpec || {};
      const initial = {shortcut:'CommandOrControl+Shift+8',registered:true,error:'',screenCapturePermission:'granted',screenCaptureNeedsRestart:false,screenCaptureRequestAttempted:false,captureInProgress:false,...spec.status};
      let current = {...initial};
      const events = []; const subscribers = new Set(); const pending = new Map();
      const copy = value => JSON.parse(JSON.stringify(value));
      const invoke = (name, value) => {
        events.push({name,value});
        if (name === 'setGlobalShortcut') current = {...current,shortcut:value};
        if (name === 'requestGlobalPermissions') current = {...current,screenCaptureRequestAttempted:true,...spec.requestStatus};
        if (spec.pending === name) return new Promise((resolve, reject) => pending.set(name,{resolve,reject}));
        if (spec.failure === name) return Promise.resolve({ok:false,error:'Mocked service failed: '+name});
        return Promise.resolve({ok:true,data:copy(current)});
      };
      if (spec.desktop !== false) window.zsenseDesktop = {
        isDesktop:true,platform:spec.platform || 'darwin',transport:spec.transport,
        screenshot:{
          globalStatus:()=>invoke('globalStatus'),
          recheckGlobalPermissions:()=>invoke('recheckGlobalPermissions'),
          ...(spec.requestMethod === false ? {} : {requestGlobalPermissions:()=>invoke('requestGlobalPermissions')}),
          startGlobal:()=>invoke('startGlobal'),
          setGlobalShortcut:value=>invoke('setGlobalShortcut',value),
          onGlobalError:callback=>{subscribers.add(callback);return ()=>subscribers.delete(callback)},
        },
      };
      const reactRoot = createRoot(document.getElementById('root'));
      reactRoot.render(<GlobalScreenshotSettings />);
      window.__screenshotQa = {
        events,
        update:value=>{current={...current,...value}},
        resolve:name=>{const request=pending.get(name);if(!request) throw new Error('No pending '+name);pending.delete(name);request.resolve({ok:true,data:copy(current)})},
        reject:name=>{const request=pending.get(name);if(!request) throw new Error('No pending '+name);pending.delete(name);request.reject(new Error('Mocked asynchronous capture failure'))},
        emitError:message=>{for(const callback of subscribers) callback(message)},
        subscribers:()=>subscribers.size,
        unmount:()=>reactRoot.unmount(),
      };
    `,
    resolveDir: root,
    sourcefile: 'isolated-global-screenshot-settings-fixture.tsx',
    loader: 'tsx',
  },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
})
const javascript = bundle.outputFiles[0].text
const styles = read('src/styles.css')
const results = []
const errors = []
try {
  server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(javascript) }
    else if (request.url === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(styles) }
    else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="root"></main><script src="/fixture.js"></script></body></html>')
    } else { response.statusCode = 404; response.end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let playwright
  try { playwright = await import('playwright/test') } catch {
    const entry = process.env.ZSENSE_PLAYWRIGHT_MODULE
      ? path.join(path.dirname(path.resolve(process.env.ZSENSE_PLAYWRIGHT_MODULE)), 'test.mjs')
      : path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/test.mjs')
    playwright = await import(pathToFileURL(entry).href)
  }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, locale: 'zh-CN' })
  await context.route('**/*', (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort())
  async function scenario(name, spec, run) {
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`))
    await page.addInitScript((value) => { window.__screenshotSpec = value }, spec)
    try {
      await page.goto(origin, { waitUntil: 'networkidle' })
      await page.waitForFunction(() => Boolean(window.__screenshotQa))
      await run(page)
      results.push(name)
    } finally { await page.close() }
  }
  const callsFor = (page, name) => page.evaluate((action) => window.__screenshotQa.events.filter((event) => event.name === action).length, name)
  const statusCalls = (page) => callsFor(page, 'globalStatus')
  const feedback = (page) => page.locator('.global-screenshot-feedback')
  const startButton = (page) => page.getByRole('button', { name: '立即截图', exact: true })
  const permissionButton = (page) => page.getByRole('button', { name: '检测权限', exact: true })
  const requestButton = (page) => page.getByRole('button', { name: '重新申请权限', exact: true })

  await scenario('mount-and-focus-are-read-only-with-cleanup', { status: { screenCapturePermission: 'denied' } }, async (page) => {
    await expect.poll(() => statusCalls(page)).toBe(1)
    await expect(feedback(page)).toContainText('当前应用未获授权')
    await expect(permissionButton(page)).toHaveAttribute('title', '只检测录屏权限，不读取屏幕')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => statusCalls(page)).toBe(2)
    assert.equal(await callsFor(page, 'startGlobal'), 0)
    assert.equal(await callsFor(page, 'recheckGlobalPermissions'), 0)
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 0)
    assert.equal(await page.evaluate(() => window.__screenshotQa.subscribers()), 1)
    await page.evaluate(() => window.__screenshotQa.unmount())
    assert.equal(await page.evaluate(() => window.__screenshotQa.subscribers()), 0)
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.__screenshotQa.emitError('Must not arrive after unmount') })
    assert.equal(await statusCalls(page), 2, 'unmount must remove the focus listener')
    await expect(page.locator('.global-screenshot-row')).toHaveCount(0)
  })

  for (const [permission, expected] of [
    ['granted', '系统已报告录屏授权；可以手动尝试截图。此次检测未读取屏幕。'],
    ['denied', '当前应用仍未获得录屏权限'],
    ['restricted', '当前应用仍未获得录屏权限'],
    ['unknown', '当前应用仍未获得录屏权限'],
    ['not-determined', '尚未请求录屏权限；可以主动申请一次。此次检测未读取屏幕。'],
  ]) {
    await scenario(`manual-permission-recheck-${permission}-never-captures`, { status: { screenCapturePermission: permission } }, async (page) => {
      await permissionButton(page).click()
      await expect(feedback(page)).toContainText(expected)
      assert.equal(await callsFor(page, 'recheckGlobalPermissions'), 1)
      assert.equal(await callsFor(page, 'startGlobal'), 0)
      assert.equal(await callsFor(page, 'requestGlobalPermissions'), 0)
      if (!['granted', 'not-determined'].includes(permission)) {
        await expect(page.getByRole('alert')).toContainText('此次检测未读取屏幕')
        await expect(feedback(page)).not.toContainText('系统已授权')
      }
    })
  }

  await scenario('explicit-permission-request-denied-to-granted-only-on-click', {
    status: { screenCapturePermission: 'denied' },
    requestStatus: { screenCapturePermission: 'granted', screenCaptureNeedsRestart: false },
  }, async (page) => {
    await expect(requestButton(page)).toBeEnabled()
    await expect(requestButton(page)).toHaveAttribute('title', '仅发起一次系统录屏授权申请，不读取屏幕')
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 0, 'mount must never request access')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => statusCalls(page)).toBe(2)
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 0, 'focus must never request access')
    await requestButton(page).click()
    await expect(feedback(page)).toContainText('系统已')
    await expect(feedback(page)).toContainText('截图')
    await expect(requestButton(page)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 1)
    assert.equal(await callsFor(page, 'startGlobal'), 0, 'permission recovery is not an implicit screen capture')
  })

  await scenario('explicit-permission-request-not-determined-to-denied-is-attempted-once', {
    status: { screenCapturePermission: 'not-determined' },
    requestStatus: { screenCapturePermission: 'denied', screenCaptureNeedsRestart: true },
  }, async (page) => {
    await expect(requestButton(page)).toBeEnabled()
    await requestButton(page).click()
    await expect(requestButton(page)).toBeDisabled()
    await expect(feedback(page)).toContainText('系统设置')
    await expect(feedback(page)).toContainText('完整退出')
    await expect(feedback(page)).toContainText('本次启动不会重复申请')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await requestButton(page).evaluate((button) => { button.click(); button.click() })
    await permissionButton(page).click()
    await expect(requestButton(page)).toBeDisabled()
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 1, 'recheck must not reset the per-launch attempt latch')
    assert.equal(await callsFor(page, 'startGlobal'), 0)
  })

  await scenario('pending-permission-request-disables-controls-and-prevents-repeat-request', {
    status: { screenCapturePermission: 'denied' }, pending: 'requestGlobalPermissions',
  }, async (page) => {
    await requestButton(page).click()
    await expect(requestButton(page)).toBeDisabled()
    await expect(permissionButton(page)).toBeDisabled()
    await expect(startButton(page)).toBeDisabled()
    await expect(page.getByRole('button', { name: /设置全局截图快捷键/ })).toBeDisabled()
    await requestButton(page).evaluate((button) => { button.click(); button.click() })
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 1)
    await page.evaluate(() => window.__screenshotQa.resolve('requestGlobalPermissions'))
    await expect(permissionButton(page)).toBeEnabled()
    await expect(startButton(page)).toBeEnabled()
    await expect(requestButton(page)).toBeDisabled()
    assert.equal(await callsFor(page, 'startGlobal'), 0)
  })

  await scenario('previous-permission-request-remains-disabled-after-read-only-recheck', {
    status: { screenCapturePermission: 'denied', screenCaptureRequestAttempted: true },
  }, async (page) => {
    await expect(requestButton(page)).toBeDisabled()
    await requestButton(page).evaluate((button) => button.click())
    await permissionButton(page).click()
    await expect(requestButton(page)).toBeDisabled()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => statusCalls(page)).toBe(2)
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 0)
    assert.equal(await callsFor(page, 'startGlobal'), 0)
  })

  await scenario('older-native-preload-without-request-api-hides-request-control', {
    requestMethod: false, status: { screenCapturePermission: 'denied' },
  }, async (page) => {
    await expect(requestButton(page)).toHaveCount(0)
    await expect(permissionButton(page)).toBeEnabled()
    await permissionButton(page).click()
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 0)
    assert.equal(await callsFor(page, 'startGlobal'), 0)
  })

  for (const permission of ['granted', 'restricted', 'unknown']) {
    await scenario(`permission-request-hidden-for-${permission}`, {
      status: { screenCapturePermission: permission },
    }, async (page) => {
      await expect.poll(() => statusCalls(page)).toBe(1)
      await expect(requestButton(page)).toHaveCount(0)
      await permissionButton(page).click()
      assert.equal(await callsFor(page, 'requestGlobalPermissions'), 0)
      assert.equal(await callsFor(page, 'startGlobal'), 0)
    })
  }

  await scenario('explicit-permission-request-failure-is-visible-and-never-captures', {
    status: { screenCapturePermission: 'denied' }, failure: 'requestGlobalPermissions',
  }, async (page) => {
    await requestButton(page).click()
    await expect(page.getByRole('alert')).toHaveText('Mocked service failed: requestGlobalPermissions')
    await expect(permissionButton(page)).toBeEnabled()
    await expect(startButton(page)).toBeEnabled()
    await expect(requestButton(page)).toBeDisabled()
    assert.equal(await statusCalls(page), 2, 'failed request must read back the attempt latch')
    await expect(feedback(page)).not.toContainText('系统已授权')
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 1)
    assert.equal(await callsFor(page, 'recheckGlobalPermissions'), 0)
    assert.equal(await callsFor(page, 'startGlobal'), 0)
  })

  await scenario('pending-permission-request-rejection-restores-controls', {
    status: { screenCapturePermission: 'not-determined' }, pending: 'requestGlobalPermissions',
  }, async (page) => {
    await requestButton(page).click()
    await expect(requestButton(page)).toBeDisabled()
    await page.evaluate(() => window.__screenshotQa.reject('requestGlobalPermissions'))
    await expect(page.getByRole('alert')).toHaveText('Mocked asynchronous capture failure')
    await expect(permissionButton(page)).toBeEnabled()
    await expect(startButton(page)).toBeEnabled()
    await expect(requestButton(page)).toBeDisabled()
    assert.equal(await statusCalls(page), 2, 'rejected request must read back the attempt latch')
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 1)
    assert.equal(await callsFor(page, 'recheckGlobalPermissions'), 0)
    assert.equal(await callsFor(page, 'startGlobal'), 0)
  })

  await scenario('global-shortcut-failure-is-visible-and-status-refresh-does-not-retry', {}, async (page) => {
    await expect.poll(() => statusCalls(page)).toBe(1)
    await page.evaluate(() => {
      window.__screenshotQa.update({ screenCapturePermission: 'denied', screenCaptureNeedsRestart: true })
      window.__screenshotQa.emitError('模拟录屏授权失效，请退出重开')
    })
    await expect(page.getByRole('alert')).toHaveText('模拟录屏授权失效，请退出重开')
    await expect(feedback(page)).toContainText('当前应用未获授权；截图暂已暂停，请完整退出并重开。')
    await expect.poll(() => statusCalls(page)).toBe(2)
    assert.equal(await callsFor(page, 'startGlobal'), 0)
    await page.evaluate(() => window.__screenshotQa.update({ screenCapturePermission: 'granted', screenCaptureNeedsRestart: false }))
    await permissionButton(page).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(feedback(page)).toContainText('系统已报告录屏授权')
    assert.equal(await callsFor(page, 'startGlobal'), 0, 'recovery detection is not an implicit retry')
  })

  await scenario('pending-capture-disables-controls-and-prevents-repeat-start', { pending: 'startGlobal' }, async (page) => {
    await startButton(page).click()
    await expect(startButton(page)).toBeDisabled()
    await expect(permissionButton(page)).toBeDisabled()
    await expect(page.getByRole('button', { name: /设置全局截图快捷键/ })).toBeDisabled()
    await expect(page.getByRole('button', { name: '恢复默认', exact: true })).toBeDisabled()
    await startButton(page).evaluate((button) => { button.click(); button.click() })
    assert.equal(await callsFor(page, 'startGlobal'), 1)
    await page.evaluate(() => window.__screenshotQa.resolve('startGlobal'))
    await expect(startButton(page)).toBeEnabled()
    await expect(permissionButton(page)).toBeEnabled()
    assert.equal(await callsFor(page, 'startGlobal'), 1)
  })

  await scenario('pending-capture-rejection-restores-controls-and-surfaces-feedback', { pending: 'startGlobal' }, async (page) => {
    await startButton(page).click()
    await expect(startButton(page)).toBeDisabled()
    await page.evaluate(() => window.__screenshotQa.reject('startGlobal'))
    await expect(page.getByRole('alert')).toHaveText('Mocked asynchronous capture failure')
    await expect(startButton(page)).toBeEnabled()
  })

  await scenario('permission-recheck-failure-is-not-reported-as-granted', { failure: 'recheckGlobalPermissions' }, async (page) => {
    await permissionButton(page).click()
    await expect(page.getByRole('alert')).toHaveText('Mocked service failed: recheckGlobalPermissions')
    await expect(feedback(page)).not.toContainText('系统已报告录屏授权')
    assert.equal(await callsFor(page, 'startGlobal'), 0)
  })

  await scenario('mac-shortcut-recording-persistence-and-validation', {}, async (page) => {
    const key = page.getByRole('button', { name: /设置全局截图快捷键/ })
    await expect(key).toHaveText('⌘⇧8')
    await key.click()
    const input = page.getByRole('textbox', { name: '录制全局截图快捷键' })
    await input.press('A')
    await expect(page.getByRole('alert')).toContainText('请按住 Ctrl/⌘ + Shift')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    assert.equal(await callsFor(page, 'setGlobalShortcut'), 0)
    await key.click()
    await input.press('Meta+Shift+9')
    await expect(key).toHaveText('⌘⇧9')
    await expect(feedback(page)).toContainText('快捷键已保存并立即生效')
    assert.equal(await callsFor(page, 'setGlobalShortcut'), 1)
    await page.getByRole('button', { name: '恢复默认', exact: true }).click()
    await expect(key).toHaveText('⌘⇧8')
    await expect(page.getByRole('button', { name: '恢复默认', exact: true })).toBeDisabled()
    assert.equal(await callsFor(page, 'startGlobal'), 0)
  })

  await scenario('windows-uses-ctrl-label-and-hides-macos-permission-controls', { platform: 'win32' }, async (page) => {
    await expect(page.getByRole('button', { name: /设置全局截图快捷键/ })).toHaveText('Ctrl + Shift + 8')
    await expect(permissionButton(page)).toHaveCount(0)
    await expect(requestButton(page)).toHaveCount(0)
    await expect(feedback(page)).not.toContainText('录屏权限')
    await startButton(page).click()
    assert.equal(await callsFor(page, 'startGlobal'), 1)
    assert.equal(await callsFor(page, 'recheckGlobalPermissions'), 0)
    assert.equal(await callsFor(page, 'requestGlobalPermissions'), 0)
  })

  for (const [name, spec] of [
    ['web-bridge', { transport: 'web-bridge' }],
    ['browser-without-desktop', { desktop: false }],
  ]) {
    await scenario(`${name}-cannot-access-host-screen`, spec, async (page) => {
      await expect(feedback(page)).toContainText('全局截图仅在本机桌面应用中使用')
      await expect(startButton(page)).toBeDisabled()
      await expect(page.getByRole('button', { name: /设置全局截图快捷键/ })).toBeDisabled()
      await expect(permissionButton(page)).toHaveCount(0)
      await expect(requestButton(page)).toHaveCount(0)
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.__screenshotQa.emitError('Remote must ignore host errors') })
      assert.deepEqual(await page.evaluate(() => window.__screenshotQa.events), [])
      assert.equal(await page.evaluate(() => window.__screenshotQa.subscribers()), 0)
      await expect(page.getByRole('alert')).toHaveCount(0)
    })
  }
  assert.deepEqual(errors, [], 'component must not emit browser/React runtime errors')
  console.log(JSON.stringify({ ok: true, tests: results.length, results, preloadContract: 'status/recheck/request/start/shortcut/error-event', isolation: 'headless React; in-memory screenshot IPC; loopback-only network; no screen/clipboard/user-data access' }, null, 2))
} finally {
  await browser?.close()
  await new Promise((resolve, reject) => server ? server.close((error) => error ? reject(error) : resolve()) : resolve())
}
