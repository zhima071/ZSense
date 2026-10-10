#!/usr/bin/env node
// Exercise the production screenshot editor in an isolated headless browser.
// Mock IPC only: no screen capture, clipboard, save dialog, or user windows.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-shot-ui-qa-'))
const keepArtifacts = process.argv.includes('--keep-artifacts')
const results = []
const browserErrors = []
let browser, server, page, failed = false

try {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const filename = pathname === '/global-screenshot.html' ? 'global-screenshot.html'
      : pathname === '/global-screenshot-ui.js' ? 'global-screenshot-ui.js' : null
    if (!filename) { response.writeHead(404); response.end(); return }
    response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.end(fs.readFileSync(path.join(root, 'electron', filename)))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/global-screenshot.html?mode=edit`
  let playwright
  try { playwright = await import('playwright/test') } catch {
    const entry = process.env.ZSENSE_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
    playwright = await import(pathToFileURL(path.join(path.dirname(entry), 'test.mjs')).href)
  }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 750 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    let outputGate, rejectNext = false, holdNext = false
    const state = { outputs: [], closes: 0 }
    window.__shotQa = {
      snapshot: () => ({ ...state, outputs: state.outputs.map(({ action, dataUrl }) => ({ action, dataUrl })) }),
      holdOutput: () => { holdNext = true },
      releaseOutput: () => { outputGate?.(); outputGate = undefined },
      rejectOutput: () => { rejectNext = true },
    }
    window.zsenseShot = {
      onInit(callback) {
        const image = document.createElement('canvas')
        image.width = 1200; image.height = 600
        const ctx = image.getContext('2d')
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, image.width, image.height)
        queueMicrotask(() => callback({ image: image.toDataURL('image/png') }))
        return () => undefined
      },
      async close() { state.closes += 1 },
      async output(action, dataUrl) {
        state.outputs.push({ action, dataUrl })
        if (holdNext) { holdNext = false; await new Promise((resolve) => { outputGate = resolve }) }
        if (rejectNext) { rejectNext = false; throw new Error('隔离测试：输出失败，请重试') }
        return action === 'download' ? { saved: true, path: '/isolated-test/screenshot.png' }
          : action === 'pin' ? { pinned: true } : { copied: true }
      },
    }
  })
  page = await context.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (error) => browserErrors.push(error.message))
  const canvas = page.locator('#editor-canvas')
  const tooltip = page.getByRole('tooltip')
  const snapshot = () => page.evaluate(() => window.__shotQa.snapshot())
  const reset = async (width = 1100, height = 750) => {
    await page.setViewportSize({ width, height })
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelector('#editor-canvas').width === 1200)
    await page.mouse.move(0, 0)
  }
  const pixel = (x, y) => canvas.evaluate((element, point) => [...element.getContext('2d').getImageData(point.x, point.y, 1, 1).data], { x, y })
  const drag = async (tool, from, to) => {
    await page.locator(`button[data-tool="${tool}"]`).click()
    const bounds = await canvas.boundingBox()
    const scaleX = bounds.width / 1200, scaleY = bounds.height / 600
    await page.mouse.move(bounds.x + from.x * scaleX, bounds.y + from.y * scaleY)
    await page.mouse.down()
    await page.mouse.move(bounds.x + to.x * scaleX, bounds.y + to.y * scaleY, { steps: 8 })
    await page.mouse.up()
  }
  const assertInsideViewport = async (selector) => {
    const layout = await page.locator(selector).evaluate((element) => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    assert(layout.width > 0 && layout.height > 0, `${selector} must be visible`)
    assert(layout.x >= -1 && layout.y >= -1 && layout.right <= layout.viewportWidth + 1 && layout.bottom <= layout.viewportHeight + 1, `${selector} must not be clipped by the viewport: ${JSON.stringify(layout)}`)
  }
  async function scenario(name, run) {
    try { await run(); results.push({ name, ok: true }) } catch (error) {
      failed = true
      await page.screenshot({ path: path.join(temporary, `${name}-failure.png`) }).catch(() => undefined)
      results.push({ name, ok: false, error: error.message })
    }
  }

  await scenario('compact-icon-only-toolbar-without-footer', async () => {
    await reset()
    const buttons = await page.locator('#edit-view button').evaluateAll((items) => items.map((button) => ({
      text: button.innerText.trim(), label: button.getAttribute('aria-label'), tooltip: button.dataset.tooltip,
      isColor: Boolean(button.dataset.color), svg: Boolean(button.querySelector('svg[aria-hidden="true"]')),
    })))
    assert.equal(buttons.length, 15, 'keep all five drawing tools, four colors, undo/redo, close and three outputs')
    for (const button of buttons) {
      assert.equal(button.text, '', `button ${button.label} must not show text`)
      assert(button.label?.trim(), 'every icon/color button requires an accessible label')
      assert(button.tooltip?.trim(), `button ${button.label} requires a hover tooltip`)
      assert(button.isColor || button.svg, `button ${button.label} must render a decorative SVG icon`)
    }
    assert.equal(await page.locator('#edit-view .editor-title').count(), 0, 'remove the redundant screenshot title')
    assert.equal((await page.locator('.editor-bar').innerText()).trim(), '', 'toolbar must not show other persistent text')
    assert.equal(await page.locator('.editor-footer').count(), 0, 'remove the redundant footer and use a single consolidated toolbar')
    await expect(page.locator('#editor-status')).toBeHidden()
    const bar = await page.locator('.editor-bar').boundingBox()
    assert(bar.height <= 48, `the consolidated toolbar should be compact on desktop, got ${bar.height}px`)
    await expect(page.locator('#label-wrap')).toBeHidden()
    await page.screenshot({ path: path.join(temporary, 'screenshot-editor-desktop.png') })
  })

  await scenario('all-hover-tooltips-and-edge-buttons-stay-visible', async () => {
    for (const width of [1100, 480, 360]) {
      await reset(width, 650)
      const buttons = page.locator('#edit-view button')
      for (let index = 0; index < await buttons.count(); index += 1) {
        const button = buttons.nth(index)
        await button.hover()
        await expect(tooltip).toBeVisible()
        await expect(tooltip).toHaveText(await button.getAttribute('data-tooltip'))
        await assertInsideViewport('[role="tooltip"]')
        const clip = await tooltip.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const center = { x: Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)) }
          return document.elementsFromPoint(center.x, center.y).some((item) => item === element || element.contains(item))
        })
        // Tooltips may deliberately use pointer-events:none. Bounds plus a fixed
        // container are the key clipping check; stacking is checked below.
        const style = await tooltip.evaluate((element) => ({ position: getComputedStyle(element).position, zIndex: Number(getComputedStyle(element).zIndex) }))
        assert(clip || (style.position === 'fixed' && style.zIndex > 1), 'tooltip must overlay the stage instead of hiding behind it')
      }
      await page.mouse.move(0, 0)
      await expect(tooltip).toBeHidden()
    }
    await reset()
    await page.locator('button[data-tool="pen"]').focus()
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toHaveText(await page.locator('button[data-tool="pen"]').getAttribute('data-tooltip'))
    await assertInsideViewport('[role="tooltip"]')
    await page.locator('button[data-tool="pen"]').evaluate((element) => element.blur())
    await expect(tooltip).toBeHidden()
  })

  await scenario('narrow-window-wraps-without-clipped-controls', async () => {
    for (const width of [850, 480, 360]) {
      await reset(width, 550)
      const layout = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }))
      assert(layout.body <= width + 1 && layout.document <= width + 1, `no horizontal overflow at ${width}px`)
      const bar = await page.locator('.editor-bar').boundingBox()
      assert(bar.height <= (width <= 480 ? 80 : 48), `toolbar may use at most two compact rows at ${width}px`)
      for (const button of await page.locator('#edit-view button').all()) {
        const box = await button.boundingBox()
        assert(box.x >= -1 && box.x + box.width <= width + 1, `each control must remain visible and usable at ${width}px`)
      }
      await page.locator('[data-tool="text"]').click()
      await expect(page.locator('#label-text')).toBeVisible()
      await assertInsideViewport('#label-text')
      const bounds = await canvas.boundingBox()
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await expect(page.locator('#editor-status')).toBeVisible()
      await assertInsideViewport('#editor-status')
    }
    await page.screenshot({ path: path.join(temporary, 'screenshot-editor-narrow.png') })
  })

  await scenario('scaled-canvas-coordinates-and-undo-redo', async () => {
    await reset(700, 550)
    await drag('pen', { x: 100, y: 100 }, { x: 600, y: 400 })
    const ink = await pixel(350, 250)
    assert(ink[0] > 150 && ink[1] < 110 && ink[2] < 110, `scaled pointer should paint the correct original-image pixel, got ${ink}`)
    assert.deepEqual(await pixel(900, 100), [255, 255, 255, 255])
    await page.locator('#undo').click()
    assert.deepEqual(await pixel(350, 250), [255, 255, 255, 255])
    await page.locator('#redo').click()
    assert.deepEqual(await pixel(350, 250), ink)
    await page.keyboard.press('Control+z')
    assert.deepEqual(await pixel(350, 250), [255, 255, 255, 255])
    await page.keyboard.press('Control+Shift+z')
    assert.deepEqual(await pixel(350, 250), ink)
  })

  await scenario('shapes-colors-and-text-input-remain-functional', async () => {
    for (const tool of ['ellipse', 'rectangle', 'arrow']) {
      await reset()
      await page.locator('[data-color="#2563eb"]').click()
      await expect(page.locator('[data-color="#2563eb"]')).toHaveAttribute('aria-pressed', 'true')
      await drag(tool, { x: 250, y: 180 }, { x: 750, y: 420 })
      const inkCount = await canvas.evaluate((element) => {
        const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data
        let count = 0
        for (let offset = 0; offset < data.length; offset += 4) if (data[offset] < 130 && data[offset + 2] > 170) count += 1
        return count
      })
      assert(inkCount > 100, `${tool} should create a blue annotation`)
    }
    await reset()
    await page.locator('[data-tool="text"]').click()
    await expect(page.locator('#label-text')).toBeFocused()
    const bounds = await canvas.boundingBox()
    await page.mouse.click(bounds.x + bounds.width / 3, bounds.y + bounds.height / 3)
    await expect(page.locator('#editor-status')).toBeVisible()
    await expect(page.locator('#editor-status')).toContainText('先输入标注文字')
    await page.locator('#label-text').fill('测试标注 ABC')
    await page.mouse.click(bounds.x + bounds.width / 3, bounds.y + bounds.height / 3)
    const darkPixels = await canvas.evaluate((element) => {
      const data = element.getContext('2d').getImageData(395, 160, 260, 60).data
      let count = 0
      for (let offset = 0; offset < data.length; offset += 4) if (data[offset + 1] < 130) count += 1
      return count
    })
    assert(darkPixels > 50, 'text entry should create actual image pixels')
    await page.locator('[data-tool="pen"]').click()
    await expect(page.locator('#label-wrap')).toBeHidden()
  })

  await scenario('download-pin-copy-retain-full-resolution-output', async () => {
    await reset(700, 550)
    await drag('pen', { x: 100, y: 100 }, { x: 600, y: 400 })
    const image = await canvas.evaluate((element) => element.toDataURL('image/png'))
    for (const id of ['download', 'pin', 'copy']) {
      await page.locator(`#${id}`).click()
      await expect(page.locator(`#${id}`)).toBeEnabled()
    }
    const outputs = (await snapshot()).outputs
    assert.deepEqual(outputs.map((item) => item.action), ['download', 'pin', 'copy'])
    for (const output of outputs) assert(output.dataUrl === image, `${output.action} must use the annotated full-resolution PNG`)
  })

  await scenario('text-input-native-undo-does-not-remove-canvas-annotations', async () => {
    await reset()
    await drag('pen', { x: 100, y: 100 }, { x: 600, y: 400 })
    const image = await canvas.evaluate((element) => element.toDataURL('image/png'))
    await page.locator('button[data-tool="text"]').click()
    const input = page.locator('#label-text')
    await input.pressSequentially('Native undo 123')
    const text = await input.inputValue()
    await input.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
    assert.notEqual(await input.inputValue(), text, 'the platform undo shortcut in the text input must use the browser text-edit undo stack')
    assert((await canvas.evaluate((element) => element.toDataURL('image/png'))) === image, 'text-input undo must not erase existing canvas annotations')
  })

  await scenario('single-flight-output-errors-and-retry', async () => {
    await reset()
    await page.evaluate(() => { window.__shotQa.holdOutput(); document.querySelector('#download').click(); document.querySelector('#pin').click() })
    for (const id of ['download', 'pin', 'copy']) await expect(page.locator(`#${id}`)).toBeDisabled()
    assert.equal((await snapshot()).outputs.length, 1, 'rapid duplicate actions must not create concurrent outputs')
    await page.evaluate(() => window.__shotQa.releaseOutput())
    await expect(page.locator('#download')).toBeEnabled()
    await page.evaluate(() => window.__shotQa.rejectOutput())
    await page.locator('#download').click()
    await expect(page.locator('#editor-status')).toBeVisible()
    await expect(page.locator('#editor-status')).toContainText('隔离测试：输出失败')
    await expect(page.locator('#editor-status')).toHaveClass(/error/)
    for (const id of ['download', 'pin', 'copy']) await expect(page.locator(`#${id}`)).toBeEnabled()
    await page.locator('#download').click()
    await expect(page.locator('#download')).toBeEnabled()
    assert.equal((await snapshot()).outputs.length, 3, 'failed output must allow retry')
  })

  await scenario('close-and-escape-retain-close-actions', async () => {
    await reset()
    await page.locator('#editor-close').click()
    assert.equal((await snapshot()).closes, 1)
    await page.keyboard.press('Escape')
    assert.equal((await snapshot()).closes, 2)
  })

  assert.deepEqual(browserErrors, [], 'production screenshot editor must not emit browser runtime errors')
  console.log(JSON.stringify({ ok: !failed, tests: results, fixture: 'production screenshot editor, isolated mock IPC, no user desktop or clipboard', artifacts: failed || keepArtifacts ? temporary : 'temporary artifacts removed' }, null, 2))
  if (failed) process.exitCode = 1
} catch (error) {
  failed = true
  console.error(error)
  console.error(`Diagnostic directory: ${temporary}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  await new Promise((resolve) => server ? server.close(resolve) : resolve())
  if (!failed && !keepArtifacts) fs.rmSync(temporary, { recursive: true, force: true })
}
