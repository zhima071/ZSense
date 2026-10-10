#!/usr/bin/env node
// Real browser/React regression coverage. The fixture keeps all data in memory
// and the Vite cache/screenshots in a fresh OS temporary directory.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-sidebar-qa-'))
const keepArtifacts = process.argv.includes('--keep-artifacts')
const fixtureOnly = process.argv.includes('--fixture-only')
const onlyIndex = process.argv.indexOf('--only')
const onlyPattern = onlyIndex >= 0 ? new RegExp(process.argv[onlyIndex + 1] || '') : null
const results = []
const browserErrors = []
let browser
let server
let failed = false

async function availablePort() {
  const reservation = net.createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  return port
}

async function loadPlaywright() {
  if (process.env.ZSENSE_PLAYWRIGHT_MODULE) {
    const entry = path.resolve(process.env.ZSENSE_PLAYWRIGHT_MODULE)
    return import(pathToFileURL(path.join(path.dirname(entry), 'test.mjs')).href)
  }
  try { return await import('playwright/test') } catch {
    const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/test.mjs')
    if (fs.existsSync(bundled)) return import(pathToFileURL(bundled).href)
    throw new Error('Playwright is unavailable. Set ZSENSE_PLAYWRIGHT_MODULE to an installed Playwright module; this test never downloads browser components.')
  }
}
try {
  const fixtureHtml = {
    name: 'zsense-sidebar-isolated-fixture',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/__sidebar-qa/') return next()
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZSense isolated sidebar QA</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/scripts/fixtures/sidebar-layout-fixture.tsx"></script></body></html>')
      })
    },
  }
  server = await createServer({
    root, configFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite-cache'),
    plugins: [fixtureHtml, react()], clearScreen: false, logLevel: 'warn',
    server: { host: '127.0.0.1', port: await availablePort(), strictPort: true, open: false, hmr: false },
  })
  await server.listen()
  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}/__sidebar-qa/`
  const { chromium, expect } = await loadPlaywright()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (reason) => browserErrors.push(reason.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => Boolean(window.__sidebarQa))
  const reset = async (options = {}, viewport = { width: 1440, height: 900 }) => {
    await page.setViewportSize(viewport)
    await page.evaluate((patch) => window.__sidebarQa.reset(patch), options)
    await page.waitForTimeout(50)
  }
  const event = async (name, args) => {
    await page.waitForFunction(({ name, args }) => window.__sidebarQa.events.some((item) => item.name === name && JSON.stringify(item.args) === JSON.stringify(args)), { name, args })
  }
  const conversationRow = (title) => page.locator('.native-chat-sidebar-row').filter({ has: page.locator('.native-chat-sidebar-open strong', { hasText: title }) })
  const screenshot = async (name) => page.screenshot({ path: path.join(temporary, `${name}.png`), fullPage: false })
  async function scenario(name, run) {
    if (onlyPattern && !onlyPattern.test(name)) return
    try { await run(); results.push({ name, ok: true }) }
    catch (reason) { failed = true; await screenshot(`${name}-failure`).catch(() => undefined); results.push({ name, ok: false, error: reason.message, source: reason.stack?.split('\n').find((line) => line.includes('sidebar-layout-smoke.mjs'))?.trim() }) }
  }
  if (fixtureOnly) {
    await expect(page.locator('.sidebar')).toBeVisible()
    assert.deepEqual(browserErrors, [], 'fixture should not emit React/browser errors')
    console.log(JSON.stringify({ ok: true, fixture: 'real Sidebar, in-memory callbacks, isolated browser', temporary }))
  } else {
    const resizeHandle = () => page.locator('.sidebar [role="separator"]')
    const sidebarGeometry = () => page.evaluate(() => {
      const panel = document.querySelector('.sidebar-panel')
      const viewport = document.querySelector('.sidebar-panel-viewport')
      const sidebar = document.querySelector('.sidebar')
      const main = document.querySelector('.app-main')
      const topbar = document.querySelector('.topbar')
      return { panel: panel.getBoundingClientRect().width, viewport: viewport?.getBoundingClientRect().width, panelVisibility: getComputedStyle(panel).visibility, sidebar: sidebar.getBoundingClientRect().width, mainLeft: main.getBoundingClientRect().x, topbarLeft: parseFloat(getComputedStyle(topbar).left), sidebarTransition: getComputedStyle(sidebar).transitionDuration, mainTransition: getComputedStyle(main).transitionDuration, topbarTransition: getComputedStyle(topbar).transitionDuration, bodyClass: document.body.className, bodyCursor: getComputedStyle(document.body).cursor }
    })
    const nextFrame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
    // Drive the real toggle handler and inspect actual rendered frames. Merely
    // checking the final position (or sleeping for the transition duration)
    // would pass even if collapse/expand still snapped without any animation.
    const sampleSidebarMotion = (toggles, duration = 430) => page.evaluate(({ toggles, duration }) => new Promise((resolve, reject) => {
      const panel = document.querySelector('.sidebar-panel')
      const viewport = document.querySelector('.sidebar-panel-viewport')
      const sidebar = document.querySelector('.sidebar')
      const main = document.querySelector('.app-main')
      const topbar = document.querySelector('.topbar')
      const content = document.querySelector('.sidebar-content')
      const snapshot = (time) => ({
        time,
        sidebar: sidebar.getBoundingClientRect().width,
        viewport: viewport.getBoundingClientRect().width,
        panel: panel.getBoundingClientRect().width,
        mainLeft: main.getBoundingClientRect().x,
        topbarLeft: parseFloat(getComputedStyle(topbar).left),
        topbarVisible: getComputedStyle(topbar).display !== 'none',
        visibility: getComputedStyle(panel).visibility,
        opacity: parseFloat(getComputedStyle(panel).opacity),
        inert: panel.inert,
        ariaHidden: panel.getAttribute('aria-hidden'),
        scrollTop: content.scrollTop,
        documentWidth: document.documentElement.scrollWidth,
        windowWidth: innerWidth,
      })
      const samples = [snapshot(0)]
      const clicks = []
      let nextToggle = 0
      const start = performance.now()
      const tick = () => {
        try {
          const time = performance.now() - start
          while (nextToggle < toggles.length && time >= toggles[nextToggle].at) {
            const toggle = toggles[nextToggle++]
            const button = Array.from(document.querySelectorAll('button')).find((element) => element.getAttribute('aria-label') === toggle.label)
            if (!button) throw new Error(`Sidebar toggle is unavailable: ${toggle.label}`)
            button.click()
            clicks.push({ label: toggle.label, time, sidebar: sidebar.getBoundingClientRect().width })
          }
          samples.push(snapshot(time))
          if (time < duration) requestAnimationFrame(tick)
          else resolve({ samples, clicks })
        } catch (error) { reject(error) }
      }
      tick()
    }), { toggles, duration })
    const assertMotionAlignment = (samples, panelWidth) => {
      for (const sample of samples) {
        assert(Math.abs(sample.sidebar - sample.mainLeft) <= 1, `main offset must track sidebar during transition at ${sample.time.toFixed(1)}ms (sidebar ${sample.sidebar}, main ${sample.mainLeft})`)
        // Desktop topbar is display:none, so it has no rendered transition to
        // align. When a responsive layout shows it, its rendered offset matters.
        if (sample.topbarVisible) assert(Math.abs(sample.sidebar - sample.topbarLeft) <= 1, `visible topbar offset must track sidebar during transition at ${sample.time.toFixed(1)}ms`)
        assert(Math.abs(sample.sidebar - sample.viewport - 56) <= 1, 'animated grid column must remain flush with the fixed rail')
        assert(Math.abs(sample.panel - panelWidth) <= 1, 'the inner conversation panel must retain its width, avoiding text reflow during animation')
        assert(sample.documentWidth <= sample.windowWidth + 1, 'clipped animated sidebar must not introduce horizontal document overflow')
      }
    }
    const beginResize = async (targetWidth) => {
      const before = await sidebarGeometry()
      const handle = resizeHandle()
      await expect(handle).toBeVisible()
      await handle.evaluate((element) => { element.addEventListener('pointerdown', (event) => { element.dataset.qaPointerId = String(event.pointerId) }, { once: true }) })
      const box = await handle.boundingBox()
      const x = box.x + box.width / 2
      const y = box.y + Math.min(box.height / 2, 300)
      await page.mouse.move(x, y); await page.mouse.down()
      await page.mouse.move(x + targetWidth - before.panel, y)
      await nextFrame()
      return { before, x, y }
    }
    const dragWidth = async (width) => {
      await beginResize(width); await page.mouse.up(); await nextFrame()
    }
    const assertResizeIndicator = async (state, highlighted) => {
      const handle = resizeHandle()
      await expect(handle.locator(':scope > span')).toHaveCount(1)
      const primary = await handle.evaluate((element) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--primary)'
        element.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      })
      await expect(handle.locator(':scope > span')).toHaveCSS('background-color', highlighted ? primary : 'rgba(0, 0, 0, 0)')
      const visual = await handle.evaluate((element) => {
        const indicator = element.querySelector(':scope > span')
        const handleStyle = getComputedStyle(element)
        const indicatorStyle = getComputedStyle(indicator)
        const handleBox = element.getBoundingClientRect()
        const indicatorBox = indicator.getBoundingClientRect()
        return { outlineStyle: handleStyle.outlineStyle, boxShadow: handleStyle.boxShadow, indicatorWidth: indicatorStyle.width, centerOffset: indicatorBox.x + indicatorBox.width / 2 - handleBox.x - handleBox.width / 2 }
      })
      assert.equal(visual.outlineStyle, 'none', `${state}: the full-height hit target must not draw a rectangular focus outline`)
      assert.equal(visual.boxShadow, 'none', `${state}: the hit target must not add side lines through a box shadow`)
      assert.equal(visual.indicatorWidth, '2px', `${state}: the separator should retain its single 2px indicator`)
      assert(Math.abs(visual.centerOffset) <= 0.5, `${state}: the visible indicator must stay centered in the wider drag hit target`)
    }
    await scenario('sidebar-resize-single-center-line-on-hover-keyboard-focus-and-drag', async () => {
      await page.mouse.move(600, 300)
      await reset()
      const handle = resizeHandle()
      await assertResizeIndicator('idle', false)
      await handle.hover()
      await assertResizeIndicator('hover', true)
      await screenshot('sidebar-resize-hover')
      await page.mouse.move(600, 300)
      await page.keyboard.press('Tab')
      await handle.focus()
      await expect(handle).toBeFocused()
      assert(await handle.evaluate((element) => element.matches(':focus-visible')), 'keyboard focus must exercise the inherited sidebar focus-visible rule')
      await assertResizeIndicator('keyboard focus', true)
      await screenshot('sidebar-resize-keyboard-focus')
      try {
        await beginResize(280)
        assert((await sidebarGeometry()).bodyClass.includes('is-resizing-sidebar'), 'pointer drag must activate the resizing indicator state')
        await assertResizeIndicator('pointer drag', true)
        await screenshot('sidebar-resize-drag')
      } finally { await page.mouse.up(); await nextFrame() }
    })
    await scenario('sidebar-resize-default-clamps-and-frame-synchronous-main-offset', async () => {
      await reset()
      const initial = await sidebarGeometry()
      assert.equal(initial.panel, 216, 'conversation column should default to 216px')
      assert.equal(initial.sidebar, 272, 'default shell should be 56px rail + 216px conversation column')
      assert.equal(initial.mainLeft, 272)
      await expect(resizeHandle()).toHaveAttribute('aria-orientation', 'vertical')
      await expect(resizeHandle()).toHaveAttribute('aria-valuemin', '180')
      await expect(resizeHandle()).toHaveAttribute('aria-valuemax', '360')
      await expect(resizeHandle()).toHaveAttribute('aria-valuenow', '216')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      try {
        for (const [requested, expected] of [[280, 280], [100, 180], [420, 360]]) {
          await beginResize(requested)
          const during = await sidebarGeometry()
          assert.equal(during.panel, expected, 'pointer movement must clamp to supported column range')
          assert.equal(during.sidebar, expected + 56)
          assert.equal(during.mainLeft, during.sidebar, 'main content must move in the same animation frame, not trail a 220ms transition')
          assert.equal(during.topbarLeft, during.sidebar)
          assert(during.mainTransition.split(',').every((value) => parseFloat(value) === 0), 'disable main margin transition while dragging')
          assert(during.topbarTransition.split(',').every((value) => parseFloat(value) === 0), 'disable topbar left transition while dragging')
          await page.mouse.up(); await nextFrame()
          await expect(resizeHandle()).toHaveAttribute('aria-valuenow', String(expected))
          assert.equal((await sidebarGeometry()).bodyClass, initial.bodyClass, 'mouseup must remove global resizing state')
        }
        await screenshot('sidebar-resized-wide-360')
      } finally { await page.mouse.up(); await page.emulateMedia({ reducedMotion: 'reduce' }) }
    })
    await scenario('sidebar-resize-persists-reload-doubleclick-keyboard-and-collapse', async () => {
      await reset(); await dragWidth(280)
      await page.reload({ waitUntil: 'networkidle' }); await page.waitForFunction(() => Boolean(window.__sidebarQa))
      assert.equal((await sidebarGeometry()).panel, 280, 'released width must survive page reload')
      await page.getByRole('button', { name: '折叠会话侧栏', exact: true }).click()
      await expect(resizeHandle()).toBeHidden()
      assert.equal((await sidebarGeometry()).sidebar, 56)
      await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click()
      assert.equal((await sidebarGeometry()).panel, 280, 'collapse/reopen must retain the chosen width')
      await resizeHandle().dblclick(); await nextFrame()
      await expect(resizeHandle()).toHaveAttribute('aria-valuenow', '216')
      assert.equal((await sidebarGeometry()).panel, 216)
      await resizeHandle().focus(); await page.keyboard.press('ArrowRight'); await nextFrame()
      const wider = (await sidebarGeometry()).panel
      assert(wider > 216 && wider <= 360, 'right arrow should widen by a bounded step')
      await page.keyboard.press('ArrowLeft'); await nextFrame()
      assert.equal((await sidebarGeometry()).panel, 216, 'left arrow should undo the same step')
      await page.keyboard.press('Shift+ArrowRight'); await nextFrame()
      assert.equal((await sidebarGeometry()).panel, 240, 'shift+arrow should use a 24px coarse step')
      await page.keyboard.press('Shift+ArrowLeft'); await nextFrame()
      assert.equal((await sidebarGeometry()).panel, 216)
      await page.keyboard.press('Home'); await nextFrame()
      assert.equal((await sidebarGeometry()).panel, 180)
      await page.keyboard.press('End'); await nextFrame()
      assert.equal((await sidebarGeometry()).panel, 360)
      await expect(resizeHandle()).toBeFocused()
      await page.reload({ waitUntil: 'networkidle' }); await page.waitForFunction(() => Boolean(window.__sidebarQa))
      assert.equal((await sidebarGeometry()).panel, 360, 'keyboard changes should be persisted too')
      await screenshot('sidebar-keyboard-max-reloaded')
    })
    await scenario('sidebar-resize-pointercancel-lostcapture-and-hidden-cleanup', async () => {
      await reset()
      const baseline = (await sidebarGeometry()).bodyClass
      for (const outcome of ['pointercancel', 'lostpointercapture']) {
        await beginResize(280)
        await resizeHandle().evaluate((element, outcome) => {
          const pointerId = Number(element.dataset.qaPointerId)
          if (outcome === 'lostpointercapture') element.releasePointerCapture(pointerId)
          else element.dispatchEvent(new PointerEvent('pointercancel', { pointerId, pointerType: 'mouse', bubbles: true }))
        }, outcome)
        // Capture release is pending until the next pointer event. Dispatch a
        // real move so Chromium delivers lostpointercapture before checking.
        if (outcome === 'lostpointercapture') await page.mouse.move(600, 300)
        await nextFrame()
        assert.equal((await sidebarGeometry()).bodyClass, baseline, `${outcome} should remove global resizing state`)
        const stoppedWidth = (await sidebarGeometry()).panel
        await page.mouse.move(600, 300); await nextFrame()
        assert.equal((await sidebarGeometry()).panel, stoppedWidth, `${outcome} must stop subsequent mouse movement from resizing`)
        await page.mouse.up()
      }
      await beginResize(290)
      await page.evaluate(() => window.__sidebarQa.configure({ collapsed: true }))
      await expect(resizeHandle()).toBeHidden()
      assert.equal((await sidebarGeometry()).bodyClass, baseline, 'hiding the panel during drag must clean global state')
      await page.mouse.up()
      await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click()
      await expect(resizeHandle()).toBeVisible()
      const originalWidth = (await sidebarGeometry()).panel
      await beginResize(originalWidth + 40)
      await page.keyboard.press('Escape'); await nextFrame()
      assert.equal((await sidebarGeometry()).panel, originalWidth, 'Escape must restore the width at drag start')
      assert.equal((await sidebarGeometry()).bodyClass, baseline)
      await page.mouse.up()
      await beginResize(originalWidth + 24)
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await nextFrame()
      assert.equal((await sidebarGeometry()).bodyClass, baseline, 'window blur should clean capture and global state')
      await page.mouse.up()
    })
    await scenario('sidebar-resize-mobile-drawer-unaffected-and-narrow-account-protected', async () => {
      const displayName = '长账号名必须保留完整悬浮说明，并且不能挤压两个侧栏控制按钮'.repeat(3)
      await reset({ displayName }); await dragWidth(180)
      const [nameBox, toolsBox] = await Promise.all([page.locator('.sidebar-account-name').boundingBox(), page.locator('.sidebar-panel-tools').boundingBox()])
      assert(nameBox.x + nameBox.width <= toolsBox.x + 1)
      await expect(page.locator('.sidebar-account-name')).toHaveAttribute('title', displayName)
      for (const button of await page.locator('.sidebar-panel-tools button:visible').all()) {
        const box = await button.boundingBox(); assert(box.width >= 28 && box.height >= 28)
      }
      await screenshot('sidebar-min-180-long-account')
      for (const viewport of [{ width: 375, height: 812 }, { width: 320, height: 640 }, { width: 812, height: 375 }]) {
        await page.setViewportSize(viewport)
        await page.evaluate(() => window.__sidebarQa.configure({ mobileOpen: true }))
        await expect(resizeHandle()).toBeHidden()
        assert.equal((await sidebarGeometry()).sidebar, Math.min(340, viewport.width - 28), 'mobile drawer width must remain responsive, not inherit desktop width')
        assert.equal((await sidebarGeometry()).mainLeft, 0, 'mobile content should not reserve desktop width')
        await expect(page.locator('.sidebar-account-name')).toHaveText(displayName)
        await expect(page.getByRole('button', { name: '收起导航', exact: true })).toBeVisible()
      }
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.evaluate(() => window.__sidebarQa.configure({ mobileOpen: false }))
      await expect(resizeHandle()).toBeVisible()
      assert.equal((await sidebarGeometry()).panel, 180, 'returning from mobile must retain the desktop width')
    })
    await scenario('account-name-header-reactive-without-duplicate-footer', async () => {
      await reset()
      const name = page.locator('.sidebar-account-name')
      await expect(name).toHaveText('测试用户')
      await expect(name).toHaveAttribute('title', '测试用户')
      await expect(page.locator('.sidebar-current-user')).toHaveCount(0)
      await expect(page.locator('.sidebar-panel-footer')).toHaveCount(0)
      await expect(page.locator('.sidebar-product-name')).toHaveCount(0)
      await page.getByRole('button', { name: '搜索会话', exact: true }).click()
      const search = page.getByRole('searchbox', { name: '搜索会话标题', exact: true })
      await search.fill('预算')
      await page.evaluate(() => window.__sidebarQa.configure({ displayName: '芝麻 · 办公室' }))
      await expect(name).toHaveText('芝麻 · 办公室')
      await expect(name).toHaveAttribute('title', '芝麻 · 办公室')
      await expect(search).toHaveValue('预算')
      await expect(conversationRow('预算表与会议纪要')).toBeVisible()
      await expect(page.locator('.native-chat-sidebar-row')).toHaveCount(1)
      await screenshot('account-name-updated-desktop')
      await page.evaluate(() => window.__sidebarQa.configure({ displayName: '   ', username: 'fallback-username' }))
      await expect(name).toHaveText('fallback-username')
      await expect(name).toHaveAttribute('title', 'fallback-username')
      await expect(search).toHaveValue('预算')
      await expect(page.locator('.sidebar-current-user')).toHaveCount(0)
      await page.evaluate(() => window.__sidebarQa.configure({ showVoiceStatus: true }))
      await expect(page.locator('.sidebar-panel-footer')).toBeVisible()
      await expect(page.locator('.sidebar-voice-status')).toHaveText('语音正在监听')
      await expect(page.locator('.sidebar-panel-footer')).not.toContainText('fallback-username')
    })
    await scenario('long-account-names-truncate-without-covering-header-controls', async () => {
      const names = [
        ['zh', '这是一个非常长的中文账号名称用于验证顶部侧栏展示不会挤压搜索与折叠按钮'.repeat(3)],
        ['en', 'OfficeTeamMemberWithAVeryLongEnglishAccountDisplayName'.repeat(4)],
      ]
      for (const [language, displayName] of names) {
        for (const viewport of [{ width: 1440, height: 900 }, { width: 980, height: 720 }, { width: 375, height: 812 }, { width: 320, height: 640 }, { width: 812, height: 375 }]) {
          const mobile = viewport.width <= 900
          await reset({ displayName, mobileOpen: mobile }, viewport)
          const name = page.locator('.sidebar-account-name')
          const heading = page.locator('.sidebar-panel-heading')
          const tools = page.locator('.sidebar-panel-tools')
          await expect(name).toHaveText(displayName)
          await expect(name).toHaveAttribute('title', displayName)
          const metrics = await name.evaluate((element) => ({ overflow: getComputedStyle(element).textOverflow, whiteSpace: getComputedStyle(element).whiteSpace, scroll: element.scrollWidth, client: element.clientWidth }))
          assert.equal(metrics.overflow, 'ellipsis'); assert.equal(metrics.whiteSpace, 'nowrap')
          assert(metrics.scroll > metrics.client && metrics.client > 20, 'long account names should be clipped to a usable single-line title')
          const [nameBox, headingBox, toolsBox] = await Promise.all([name.boundingBox(), heading.boundingBox(), tools.boundingBox()])
          assert(nameBox && headingBox && toolsBox)
          assert(nameBox.x + nameBox.width <= toolsBox.x + 1, 'account title must not overlap search/collapse controls')
          assert(toolsBox.x + toolsBox.width <= headingBox.x + headingBox.width + 1, 'header controls must stay in the panel')
          const buttons = tools.locator('button:visible')
          await expect(buttons).toHaveCount(2)
          for (const button of await buttons.all()) {
            const buttonBox = await button.boundingBox()
            assert(buttonBox && buttonBox.width >= (mobile ? 44 : 28) && buttonBox.height >= (mobile ? 44 : 28), 'long title must not shrink icon hit targets')
            await expect(button).toBeInViewport()
          }
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'long account title must not introduce horizontal document overflow')
          await expect(page.locator('.sidebar-current-user, .sidebar-panel-footer')).toHaveCount(0)
          await page.getByRole('button', { name: '搜索会话', exact: true }).click()
          await expect(page.getByRole('searchbox', { name: '搜索会话标题', exact: true })).toBeFocused()
          await page.getByRole('searchbox', { name: '搜索会话标题', exact: true }).press('Escape')
          if (viewport.width === 1440 || viewport.width === 375 || viewport.width === 320) await screenshot(`long-account-${language}-${viewport.width}`)
          if (mobile) {
            await page.getByRole('button', { name: '收起导航', exact: true }).click(); await event('closeMobile', [])
            await expect(page.locator('.sidebar')).toBeHidden()
            await page.getByRole('button', { name: '打开导航', exact: true }).click()
            await expect(name).toHaveText(displayName)
            await expect(name).toBeVisible()
          } else {
            await page.getByRole('button', { name: '折叠会话侧栏', exact: true }).click(); await event('toggleCollapsed', [])
            await expect(name).toBeHidden()
            assert(await page.locator('.sidebar-panel').evaluate((element) => element.inert), 'collapsed long title must be inert')
            await expect(page.getByRole('button', { name: '打开设置', exact: true })).toBeVisible()
            await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click()
            await expect(name).toHaveText(displayName)
            await expect(name).toBeVisible()
          }
        }
      }
    })
    await scenario('desktop-two-column-layout-and-navigation', async () => {
      await reset()
      const rail = page.locator('.sidebar-rail')
      const panel = page.locator('.sidebar-panel')
      await expect(rail).toBeVisible(); await expect(panel).toBeVisible()
      const [railBox, panelBox] = await Promise.all([rail.boundingBox(), panel.boundingBox()])
      assert(railBox.width >= 40 && railBox.width <= 100, 'rail must be a compact icon column')
      assert(panelBox.width >= 180 && panelBox.width <= 330, 'conversation column must remain usable and compact')
      assert(Math.abs(railBox.x + railBox.width - panelBox.x) <= 2, 'rail and conversation panel should be adjacent, not overlapping')
      assert(panelBox.y >= -1 && panelBox.y + panelBox.height <= 901, 'panel should fit viewport vertically')
      const botRail = rail.locator('.sidebar-bot-rail-list')
      await expect(botRail).toBeVisible()
      await expect(botRail.getByRole('button')).toHaveCount(2)
      await expect(panel.locator('.sidebar-bots, .bot-quick-list')).toHaveCount(0)
      const atlas = botRail.getByRole('button', { name: '打开 Atlas', exact: true })
      await expect(atlas).toHaveAttribute('title', 'Atlas · 办公室智能体')
      await expect(atlas).toHaveAttribute('aria-pressed', 'false')
      for (const [label, view] of [['总览', 'overview'], ['Bots', 'bots'], ['定时任务', 'scheduled-tasks'], ['任务工作台', 'office-tasks']]) {
        await rail.getByRole('button', { name: label, exact: true }).click(); await event('navigate', [view])
      }
      await page.getByRole('button', { name: '打开设置', exact: true }).click(); await event('navigate', ['settings'])
      await page.getByRole('button', { name: '锁定 ZSense', exact: true }).click(); await event('lock', [])
      await page.getByRole('button', { name: /^查看会话进度/ }).click(); await event('sessions', [])
      await page.getByRole('button', { name: '开启语音唤醒', exact: true }).click(); await event('voice', [])
      await expect(page.getByRole('button', { name: '关闭语音唤醒', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await atlas.click(); await event('openBot', ['atlas'])
      await expect(atlas).toHaveAttribute('aria-pressed', 'true')
      await expect(atlas).toHaveClass(/active/)
      await page.getByRole('button', { name: '新建 AI 对话', exact: true }).click(); await event('startChat', [])
      await conversationRow('文件整理与日报').locator('.native-chat-sidebar-open').click(); await event('openChat', ['c-alpha'])
      await screenshot('desktop-1440')
    })
    await scenario('search-focus-without-inner-blue-outline', async () => {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await reset({ mobileOpen: viewport.width <= 900 }, viewport)
        const trigger = page.getByRole('button', { name: '搜索会话', exact: true })
        await trigger.click()
        const search = page.getByRole('searchbox', { name: '搜索会话标题', exact: true })
        const frame = page.locator('.sidebar-conversation-search > div')
        await expect(search).toBeFocused()
        for (const modality of ['pointer', 'keyboard']) {
          if (modality === 'keyboard') {
            await search.press('Tab')
            await expect(page.getByRole('button', { name: '关闭会话搜索', exact: true })).toBeFocused()
            await page.keyboard.press('Shift+Tab')
            await expect(search).toBeFocused()
            assert(await search.evaluate((element) => element.matches(':focus-visible')), 'keyboard input must exercise the inherited focus-visible rule')
          }
          await expect(search).toHaveCSS('outline-style', 'none')
          await expect(search).toHaveCSS('box-shadow', 'none')
          await expect(frame).toHaveCSS('border-top-width', '1px')
          await expect(frame).toHaveCSS('border-top-color', 'rgb(166, 166, 166)')
          await expect(frame).toHaveCSS('border-top-left-radius', '7px')
        }
        await search.fill('预算')
        await expect(conversationRow('预算表与会议纪要')).toBeVisible()
        await screenshot(`search-no-blue-outline-${viewport.width}`)
        await search.press('Escape')
        await expect(search).toBeHidden()
        await expect(trigger).toBeFocused()
        await expect(trigger).toHaveCSS('outline-style', 'solid')
      }
    })
    await scenario('search-filter-clear-and-escape', async () => {
      await reset()
      await page.getByRole('button', { name: '搜索会话', exact: true }).click()
      const search = page.getByRole('searchbox', { name: '搜索会话标题', exact: true })
      await expect(search).toBeFocused()
      await search.fill('预算')
      await expect(page.locator('.native-chat-sidebar-row')).toHaveCount(1)
      await expect(conversationRow('预算表与会议纪要')).toBeVisible()
      await search.fill('折叠组内的学习笔记')
      await expect(conversationRow('折叠组内的学习笔记')).toBeVisible()
      await expect(page.getByRole('button', { name: '折叠分组 学习资料', exact: true })).toBeDisabled()
      await search.fill('  ')
      assert(await page.locator('.native-chat-sidebar-row').count() > 25, 'blank query must restore conversations')
      await search.fill('完全不存在的关键词')
      await expect(page.locator('.native-chat-sidebar-row')).toHaveCount(0)
      await search.press('Escape')
      await expect(search).toBeHidden()
      await expect(conversationRow('文件整理与日报')).toBeVisible()
      await expect(conversationRow('折叠组内的学习笔记')).toHaveCount(0)
      await page.getByRole('button', { name: '搜索会话', exact: true }).click()
      await page.getByRole('button', { name: '关闭会话搜索', exact: true }).click()
      await expect(search).toBeHidden()
    })
    await scenario('groups-create-rename-collapse-delete', async () => {
      await reset()
      await page.getByRole('button', { name: '新建对话分组', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '新建对话分组', exact: true })
      await dialog.getByRole('textbox').fill('测试项目')
      await dialog.getByRole('button', { name: '创建分组', exact: true }).click(); await event('createGroup', ['sidebar-qa-native', '测试项目'])
      await page.getByRole('button', { name: '重命名分组 测试项目', exact: true }).click()
      const rename = page.getByRole('dialog', { name: '重命名对话分组', exact: true })
      await rename.getByRole('textbox').fill('测试项目重命名')
      await rename.getByRole('button', { name: '保存名称', exact: true }).click()
      await page.waitForFunction(() => window.__sidebarQa.events.some((item) => item.name === 'renameGroup' && item.args[1] === '测试项目重命名'))
      await page.getByRole('button', { name: '折叠分组 工作项目', exact: true }).click(); await event('toggleGroup', ['g-work', true])
      await expect(conversationRow('工作组内的报告分析')).toHaveCount(0)
      await page.getByRole('button', { name: '展开分组 工作项目', exact: true }).focus(); await page.keyboard.press('Enter'); await event('toggleGroup', ['g-work', false])
      await expect(conversationRow('工作组内的报告分析')).toBeVisible()
      page.once('dialog', (prompt) => prompt.accept())
      await page.getByRole('button', { name: '删除分组 工作项目', exact: true }).click(); await event('deleteGroup', ['g-work'])
      await expect(page.getByRole('region', { name: '分组 工作项目', exact: true })).toHaveCount(0)
      await expect(conversationRow('工作组内的报告分析')).toBeVisible()
      await page.getByRole('button', { name: '新建对话分组', exact: true }).click()
      await page.getByRole('dialog', { name: '新建对话分组', exact: true }).getByRole('textbox').press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
    })
    await scenario('drag-group-move-and-reorder', async () => {
      await reset()
      await conversationRow('文件整理与日报').dragTo(page.locator('.native-chat-sidebar-group-head').filter({ hasText: '工作项目' }))
      await event('moveChat', ['c-alpha', 'g-work'])
      const group = page.getByRole('region', { name: '分组 工作项目', exact: true })
      await expect(group.locator('.native-chat-sidebar-row').filter({ hasText: '文件整理与日报' })).toBeVisible()
      await reset()
      await conversationRow('预算表与会议纪要').dragTo(conversationRow('文件整理与日报'), { targetPosition: { x: 60, y: 2 } })
      await page.waitForFunction(() => window.__sidebarQa.events.some((item) => item.name === 'reorderChats'))
      const reorder = await page.evaluate(() => window.__sidebarQa.events.find((item) => item.name === 'reorderChats'))
      const ids = reorder.args[1]
      assert.equal(ids.length, new Set(ids).size, 'drag reorder must not duplicate or drop conversation IDs')
      assert.equal(ids.length, 36, 'reorder must preserve hidden archived and collapsed-group conversations')
      assert.equal(ids.at(-1), 'c-archived', 'archived conversation must remain retained')
      assert.deepEqual(ids.slice(0, 2), ['c-beta', 'c-alpha'], 'dropping before a row should actually change the order')
    })
    await scenario('conversation-rename-archive-restore-delete', async () => {
      await reset()
      const row = conversationRow('文件整理与日报')
      await row.click({ button: 'right' })
      await page.getByRole('menu').getByRole('menuitem', { name: '重命名 文件整理与日报', exact: true }).click()
      const rename = page.getByRole('dialog', { name: '重命名对话', exact: true })
      await rename.getByRole('textbox').fill('新的任务名称')
      await rename.getByRole('button', { name: '保存名称', exact: true }).click(); await event('renameChat', ['c-alpha', '新的任务名称'])
      const renamed = conversationRow('新的任务名称')
      await renamed.click({ button: 'right' })
      await page.getByRole('menu').getByRole('menuitem', { name: '归档 新的任务名称', exact: true }).click(); await event('archiveChat', ['c-alpha', true])
      await expect(renamed).toHaveCount(0)
      await page.getByRole('button', { name: /^归档 \d+/ }).click()
      await expect(conversationRow('历史归档会话')).toBeVisible()
      await renamed.click({ button: 'right' })
      await page.getByRole('menu').getByRole('menuitem', { name: '恢复 新的任务名称', exact: true }).click(); await event('archiveChat', ['c-alpha', false])
      await page.getByRole('button', { name: /^当前 \d+/ }).click()
      await renamed.click({ button: 'right' })
      await page.getByRole('menu').getByRole('menuitem', { name: '删除 新的任务名称', exact: true }).click()
      const confirmation = page.getByRole('alertdialog')
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      await expect(renamed).toBeVisible()
      await renamed.click({ button: 'right' })
      await page.getByRole('menu').getByRole('menuitem', { name: '删除 新的任务名称', exact: true }).click()
      await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click(); await event('deleteChat', ['c-alpha'])
      await expect(renamed).toHaveCount(0)
    })
    await scenario('context-menu-dismiss-keyboard-and-mobile-long-press', async () => {
      await reset()
      const row = conversationRow('文件整理与日报')
      await expect(page.locator('.conversation-action-toggle')).toHaveCount(0)
      await row.click({ button: 'right' })
      await expect(page.getByRole('menu')).toBeVisible()
      await screenshot('desktop-context-menu')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await row.locator('.native-chat-sidebar-open').focus(); await page.keyboard.press('Shift+F10')
      await expect(page.getByRole('menu')).toBeVisible()
      await page.locator('#main-content').click()
      await expect(page.getByRole('menu')).toHaveCount(0)
      await row.locator('.native-chat-sidebar-open').focus(); await page.keyboard.press('ContextMenu')
      await expect(page.getByRole('menu')).toBeVisible()
      await page.keyboard.press('ArrowDown')
      await expect(page.getByRole('menuitem', { name: '归档 文件整理与日报', exact: true })).toBeFocused()
      await page.keyboard.press('End')
      await expect(page.getByRole('menuitem', { name: '删除 文件整理与日报', exact: true })).toBeFocused()
      await page.keyboard.press('Home')
      await expect(page.getByRole('menuitem', { name: '重命名 文件整理与日报', exact: true })).toBeFocused()
      await page.getByRole('menu').evaluate((element) => { element.style.maxHeight = '65px'; element.style.overflowY = 'auto'; element.scrollTop = 20 })
      await page.waitForTimeout(50)
      await expect(page.getByRole('menu')).toBeVisible()
      await page.locator('.sidebar-content').evaluate((element) => { element.scrollTop += 80 })
      await expect(page.getByRole('menu')).toHaveCount(0)
      await row.scrollIntoViewIfNeeded(); await row.click({ button: 'right' })
      await conversationRow('预算表与会议纪要').click({ button: 'right' })
      await expect(page.getByRole('menu')).toHaveCount(1)
      await expect(page.getByRole('menu', { name: '预算表与会议纪要 的管理操作', exact: true })).toBeVisible()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await reset({ mobileOpen: true }, { width: 375, height: 812 })
      await row.scrollIntoViewIfNeeded()
      const box = await row.boundingBox()
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + Math.min(60, box.width / 2), y: box.y + box.height / 2 }] })
      await page.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(page.getByRole('menu')).toBeVisible()
      assert(!(await page.evaluate(() => window.__sidebarQa.events.some((item) => item.name === 'openChat'))), 'long press must not also open the conversation through a synthetic click')
      await screenshot('mobile-context-menu')
      const menuBox = await page.getByRole('menu').boundingBox()
      assert(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 375, 'long-press menu must stay within mobile screen')
      await page.keyboard.press('Escape')
      const touchPoint = { x: box.x + Math.min(60, box.width / 2), y: box.y + box.height / 2 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touchPoint, x: touchPoint.x + 15 }] })
      await page.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(page.getByRole('menu')).toHaveCount(0)
      await reset({ mobileOpen: true }, { width: 375, height: 812 })
      const scrollBox = await row.boundingBox()
      const scrollPoint = { x: scrollBox.x + Math.min(60, scrollBox.width / 2), y: scrollBox.y + scrollBox.height / 2 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [scrollPoint] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...scrollPoint, y: scrollPoint.y - 40 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...scrollPoint, y: scrollPoint.y - 120 }] })
      await page.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(page.getByRole('menu')).toHaveCount(0)
      assert(await page.locator('.sidebar-content').evaluate((element) => element.scrollTop > 0), 'ordinary vertical touch gesture must still scroll the history')
      await reset({ mobileOpen: true }, { width: 375, height: 812 })
      const tapBox = await row.boundingBox()
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tapBox.x + Math.min(60, tapBox.width / 2), y: tapBox.y + tapBox.height / 2 }] })
      await page.waitForTimeout(30)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await event('openChat', ['c-alpha'])
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await cdp.detach()
    })
    await scenario('collapsed-panel-is-inert-and-rail-reopens', async () => {
      await reset()
      await page.getByRole('button', { name: '折叠会话侧栏', exact: true }).click(); await event('toggleCollapsed', [])
      const panel = page.locator('.sidebar-panel')
      await expect(panel).toHaveAttribute('aria-hidden', 'true')
      assert(await panel.evaluate((element) => element.inert), 'collapsed panel must be inert, not only visually narrow')
      await expect(panel).toHaveCSS('visibility', 'hidden')
      assert.equal((await sidebarGeometry()).viewport, 0, 'collapsed viewport must fully clip the retained conversation panel')
      assert.equal((await sidebarGeometry()).panel, 216, 'collapse must retain the inner panel width instead of reflowing its content')
      await expect(page.getByRole('button', { name: '展开会话侧栏', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click()
      await expect(panel).not.toHaveAttribute('aria-hidden', 'true')
      await expect(conversationRow('文件整理与日报')).toBeVisible()
      await screenshot('desktop-collapsed-restored')
    })
    await scenario('sidebar-collapse-expand-animates-real-frames-with-synchronous-main-offset', async () => {
      await reset(); await dragWidth(280)
      await page.getByRole('button', { name: '搜索会话', exact: true }).click()
      const search = page.getByRole('searchbox', { name: '搜索会话标题', exact: true })
      await search.fill('历史')
      const scrollTop = await page.locator('.sidebar-content').evaluate((element) => { element.scrollTop = 128; return element.scrollTop })
      assert(scrollTop > 0, 'fixture must exercise a scrolled conversation list')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      try {
        const collapsing = await sampleSidebarMotion([{ at: 0, label: '折叠会话侧栏' }])
        assertMotionAlignment(collapsing.samples, 280)
        assert(collapsing.samples.some((sample) => sample.sidebar > 56.5 && sample.sidebar < 335.5), 'collapse must have a genuinely intermediate width, not a snap to 56px')
        assert(collapsing.samples.some((sample) => sample.opacity > 0 && sample.opacity < 1), 'panel contents must fade during collapse')
        const firstInert = collapsing.samples.find((sample) => sample.inert)
        assert(firstInert && firstInert.viewport > 0, 'collapsed content must become inert while still visibly animating')
        assert.equal(firstInert.ariaHidden, 'true', 'assistive technology must not enter the collapsing panel')
        assert(collapsing.samples.filter((sample) => sample.inert).every((sample) => sample.ariaHidden === 'true'))
        const collapsed = collapsing.samples.at(-1)
        assert.equal(collapsed.sidebar, 56); assert.equal(collapsed.viewport, 0)
        assert.equal(collapsed.visibility, 'hidden'); assert.equal(collapsed.opacity, 0)
        assert(collapsing.samples.every((sample) => Math.abs(sample.scrollTop - scrollTop) <= 1), 'collapse must not reset conversation scroll position')
        assert(await page.locator('.sidebar-conversation-search input').evaluate((element) => element.value === '历史'), 'collapse must keep the search value without unmounting the panel')
        await expect(page.locator('.sidebar-panel')).not.toHaveAttribute('hidden')
        const expanding = await sampleSidebarMotion([{ at: 0, label: '展开会话侧栏' }])
        assertMotionAlignment(expanding.samples, 280)
        assert(expanding.samples.some((sample) => sample.sidebar > 56.5 && sample.sidebar < 335.5), 'expand must have a genuinely intermediate width')
        assert(expanding.samples.some((sample) => sample.opacity > 0 && sample.opacity < 1), 'panel contents must fade back in')
        const reopened = expanding.samples.at(-1)
        assert.equal(reopened.sidebar, 336); assert.equal(reopened.viewport, 280)
        assert.equal(reopened.visibility, 'visible'); assert.equal(reopened.opacity, 1)
        assert.equal(reopened.inert, false); assert.notEqual(reopened.ariaHidden, 'true')
        assert(expanding.samples.every((sample) => Math.abs(sample.scrollTop - scrollTop) <= 1), 'expand must preserve scroll position')
        await expect(search).toHaveValue('历史')
        await expect(resizeHandle()).toHaveAttribute('aria-valuenow', '280')
        await screenshot('sidebar-motion-restored-wide-search')
      } finally { await page.emulateMedia({ reducedMotion: 'reduce' }) }
    })
    await scenario('sidebar-mid-animation-reversal-and-rapid-toggle-settle-without-width-loss', async () => {
      await reset(); await dragWidth(300)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      try {
        const reversed = await sampleSidebarMotion([
          { at: 0, label: '折叠会话侧栏' },
          { at: 95, label: '展开会话侧栏' },
        ], 520)
        assertMotionAlignment(reversed.samples, 300)
        assert.equal(reversed.clicks.length, 2)
        assert(reversed.clicks[1].sidebar > 56.5 && reversed.clicks[1].sidebar < 355.5, 'reopen must interrupt an actually in-flight collapse')
        assert.equal(reversed.samples.at(-1).sidebar, 356)
        assert.equal(reversed.samples.at(-1).visibility, 'visible')
        assert.equal(reversed.samples.at(-1).inert, false)
        const rapid = await sampleSidebarMotion([
          { at: 0, label: '折叠会话侧栏' },
          { at: 48, label: '展开会话侧栏' },
          { at: 96, label: '折叠会话侧栏' },
          { at: 144, label: '展开会话侧栏' },
          { at: 192, label: '折叠会话侧栏' },
        ], 650)
        assertMotionAlignment(rapid.samples, 300)
        assert.equal(rapid.clicks.length, 5)
        const collapsed = rapid.samples.at(-1)
        assert.equal(collapsed.sidebar, 56); assert.equal(collapsed.viewport, 0)
        assert.equal(collapsed.visibility, 'hidden'); assert.equal(collapsed.inert, true)
        await page.getByRole('button', { name: '展开会话侧栏', exact: true }).click()
        await expect(page.locator('.sidebar-panel')).toHaveCSS('opacity', '1')
        await expect.poll(async () => (await sidebarGeometry()).sidebar).toBe(356)
        assert.equal((await sidebarGeometry()).sidebar, 356, 'rapid toggles must retain the user-selected width')
        await expect(resizeHandle()).toHaveAttribute('aria-valuenow', '300')
      } finally { await page.emulateMedia({ reducedMotion: 'reduce' }) }
    })
    await scenario('sidebar-reduced-motion-collapse-expand-without-delayed-visibility', async () => {
      await reset(); await dragWidth(260)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const [label, sidebarWidth, viewportWidth, visibility, inert] of [
        ['折叠会话侧栏', 56, 0, 'hidden', true],
        ['展开会话侧栏', 316, 260, 'visible', false],
      ]) {
        await page.getByRole('button', { name: label, exact: true }).click()
        await nextFrame()
        const geometry = await sidebarGeometry()
        assert.equal(geometry.sidebar, sidebarWidth); assert.equal(geometry.viewport, viewportWidth)
        assert.equal(geometry.panelVisibility, visibility, 'reduced-motion users must not wait for a visibility delay')
        assert.equal(await page.locator('.sidebar-panel').evaluate((element) => element.inert), inert)
        for (const duration of [geometry.sidebarTransition, geometry.mainTransition, geometry.topbarTransition]) assert(duration.split(',').every((value) => parseFloat(value) === 0), 'reduced motion must disable size/offset transitions')
        const panelMotion = await page.locator('.sidebar-panel').evaluate((element) => ({ duration: getComputedStyle(element).transitionDuration, delay: getComputedStyle(element).transitionDelay }))
        assert(panelMotion.duration.split(',').every((value) => parseFloat(value) === 0))
        assert(panelMotion.delay.split(',').every((value) => parseFloat(value) === 0))
      }
    })
    await scenario('narrow-and-mobile-layout-close-and-navigation', async () => {
      for (const viewport of [{ width: 980, height: 720 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
        const mobile = viewport.width <= 900
        await reset({ mobileOpen: mobile }, viewport)
        const aside = page.locator('.sidebar')
        const box = await aside.boundingBox()
        assert(box && box.x >= -1 && box.x + box.width <= viewport.width + 1, 'open rail/sidebar must fit even the 375px viewport')
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sidebar should not create horizontal document overflow')
        await expect(conversationRow('文件整理与日报')).toBeVisible()
        await screenshot(`viewport-${viewport.width}x${viewport.height}`)
        if (mobile) {
          await page.getByRole('button', { name: '关闭导航', exact: true }).click({ position: { x: viewport.width - 8, y: 20 } }); await event('closeMobile', [])
          await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toHaveCount(0)
          const closedBox = await aside.boundingBox()
          assert(!closedBox || closedBox.x + closedBox.width <= 1, 'closed mobile navigation must be offscreen')
          await page.getByRole('button', { name: '打开导航', exact: true }).click()
          await page.locator('.sidebar-rail').getByRole('button', { name: '总览', exact: true }).click(); await event('navigate', ['overview'])
          await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toHaveCount(0)
        }
      }
      for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
        const mobile = viewport.width <= 900
        await reset({ mobileOpen: mobile, extraBots: 22 }, viewport)
        const botRail = page.locator('.sidebar-rail .sidebar-bot-rail-list')
        await expect(botRail.getByRole('button')).toHaveCount(24)
        await expect(page.locator('.sidebar-panel .sidebar-bots, .sidebar-panel .bot-quick-list')).toHaveCount(0)
        const lastBot = botRail.getByRole('button', { name: '打开 额外 Bot 22', exact: true })
        await lastBot.scrollIntoViewIfNeeded()
        await expect(lastBot).toBeInViewport()
        await page.getByRole('button', { name: '打开设置', exact: true }).scrollIntoViewIfNeeded()
        await expect(page.getByRole('button', { name: '打开设置', exact: true })).toBeInViewport()
        await screenshot(`many-bots-${viewport.width}x${viewport.height}`)
        if (mobile) {
          const atlas = botRail.getByRole('button', { name: '打开 Atlas', exact: true })
          await atlas.scrollIntoViewIfNeeded(); await atlas.click(); await event('openBot', ['atlas'])
          await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toHaveCount(0)
        } else {
          await lastBot.click(); await event('openBot', ['extra-21'])
          await expect(lastBot).toHaveAttribute('aria-pressed', 'true')
        }
      }
    })
    await scenario('tooltips-long-titles-scroll-and-reduced-motion', async () => {
      await reset()
      const iconButtons = page.locator('.sidebar-rail button')
      const missingTooltips = await iconButtons.evaluateAll((buttons) => buttons.filter((button) => !button.getAttribute('aria-label') || !button.getAttribute('title')).map((button) => button.outerHTML))
      assert.deepEqual(missingTooltips, [], 'every icon-only rail control needs accessible text and a hover tooltip')
      const longTitle = conversationRow('这是一条非常长的会话标题').locator('.native-chat-sidebar-open')
      assert(await longTitle.evaluate((element) => Boolean(element.getAttribute('title') || element.querySelector('[title]'))), 'truncated conversation title should be fully available on hover')
      const geometry = await longTitle.locator('strong').evaluate((element) => ({ textOverflow: getComputedStyle(element).textOverflow, scroll: element.scrollWidth, client: element.clientWidth }))
      assert.equal(geometry.textOverflow, 'ellipsis'); assert(geometry.scroll > geometry.client)
      const scrollable = page.locator('.sidebar-panel .sidebar-content')
      assert(await scrollable.evaluate((element) => element.scrollHeight > element.clientHeight), 'long history should scroll instead of clipping/footer overflow')
      await scrollable.evaluate((element) => { element.scrollTop = element.scrollHeight })
      await expect(conversationRow('历史任务 30：文档分析')).toBeInViewport()
      await expect(page.getByRole('button', { name: '打开设置', exact: true })).toBeInViewport()
      await page.evaluate(() => window.__sidebarQa.setRunning(true))
      await expect(conversationRow('文件整理与日报')).toHaveClass(/is-running/)
      const animations = await page.locator('.sidebar').evaluate((element) => {
        return [element, ...element.querySelectorAll('*')].flatMap((node) => ['', '::before', '::after'].map((pseudo) => {
          const style = getComputedStyle(node, pseudo || null)
          return { animation: style.animationName, duration: style.animationDuration, transition: style.transitionDuration }
        })).filter((style) => style.animation !== 'none' && style.duration.split(',').some((value) => parseFloat(value) > 0.01))
      })
      assert.deepEqual(animations, [], 'reduced-motion users must not see continuous running-row animations')
      await screenshot('scrolled-long-history')
    })
    await scenario('mobile-drawer-focus-trap-and-portal-dialogs', async () => {
      await reset({ mobileOpen: true }, { width: 375, height: 812 })
      await page.waitForFunction(() => document.querySelector('.sidebar')?.contains(document.activeElement))
      const buttons = page.locator('.sidebar button:not(:disabled):visible')
      await buttons.last().focus(); await page.keyboard.press('Tab')
      await expect(buttons.first()).toBeFocused()
      await buttons.first().focus(); await page.keyboard.press('Shift+Tab')
      await expect(buttons.last()).toBeFocused()
      await page.getByRole('button', { name: '新建对话分组', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '新建对话分组', exact: true })
      await dialog.getByRole('textbox').fill('移动端焦点检查')
      const dialogButtons = dialog.locator('button:not(:disabled):visible')
      await dialogButtons.last().focus(); await page.keyboard.press('Tab')
      await expect(dialogButtons.first()).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '新建对话分组', exact: true })).toBeFocused()
      await conversationRow('文件整理与日报').click({ button: 'right' })
      await page.getByRole('menuitem', { name: '重命名 文件整理与日报', exact: true }).click()
      const rename = page.getByRole('dialog', { name: '重命名对话', exact: true })
      await expect(rename.getByRole('textbox')).toBeFocused()
      await rename.getByRole('button', { name: '保存名称', exact: true }).focus(); await page.keyboard.press('Tab')
      await expect(rename.getByRole('textbox')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(rename).toHaveCount(0)
      await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toBeVisible()
      await expect(conversationRow('文件整理与日报').locator('.native-chat-sidebar-open')).toBeFocused()
      await conversationRow('文件整理与日报').click({ button: 'right' })
      await page.getByRole('menuitem', { name: '删除 文件整理与日报', exact: true }).click()
      const deletion = page.getByRole('alertdialog')
      const cancelDeletion = deletion.getByRole('button', { name: '取消', exact: true })
      await cancelDeletion.focus()
      await page.setViewportSize({ width: 980, height: 720 })
      // setViewportSize updates CSS before matchMedia's React state/effects.
      // Wait for Sidebar's actual responsive render (the desktop-only handle),
      // rather than accepting the already-focused dialog button immediately.
      await expect(resizeHandle()).toHaveCount(1)
      await expect(cancelDeletion).toBeFocused()
      await page.setViewportSize({ width: 375, height: 812 })
      await expect(resizeHandle()).toHaveCount(0)
      await expect(cancelDeletion).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(deletion).toHaveCount(0)
      await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toBeVisible()
      await expect(conversationRow('文件整理与日报')).toBeVisible()
      await expect(conversationRow('文件整理与日报').locator('.native-chat-sidebar-open')).toBeFocused()
      assert(!(await page.evaluate(() => window.__sidebarQa.events.some((item) => item.name === 'deleteChat'))), 'resizing and dismissing delete confirmation must never delete a conversation')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '打开导航', exact: true })).toBeFocused()
    })
    assert.deepEqual(browserErrors, [], 'browser emitted runtime errors')
    console.log(JSON.stringify({ ok: !failed, fixture: 'real Sidebar with isolated callbacks', tests: results, artifacts: failed || keepArtifacts ? temporary : 'temporary artifacts removed' }, null, 2))
    if (failed) process.exitCode = 1
  }
} catch (reason) {
  failed = true
  console.error(reason)
  if (browserErrors.length) console.error(JSON.stringify({ browserErrors }))
  console.error(`Diagnostic directory: ${temporary}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  await server?.close().catch(() => undefined)
  // Kept artifacts are screenshots only, not another ~60 MB dependency cache.
  fs.rmSync(path.join(temporary, 'vite-cache'), { recursive: true, force: true })
  if (!failed && !keepArtifacts) fs.rmSync(temporary, { recursive: true, force: true })
}
