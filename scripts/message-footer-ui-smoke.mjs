#!/usr/bin/env node
// Real ChatMessageMeta + styles in a disposable browser. Does not load Electron,
// the application database, or send tasks to a model or remote service.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-message-footer-qa-'))
const keepArtifacts = process.argv.includes('--keep-artifacts')
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

try {
  const fixture = { name: 'zsense-message-footer-isolated-fixture', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/__message-footer-qa/') return next()
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZSense isolated footer QA</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/scripts/fixtures/message-footer-fixture.tsx"></script></body></html>')
    })
  } }
  const port = await availablePort()
  server = await createServer({ root, configFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite-cache'), plugins: [fixture, react()], clearScreen: false, logLevel: 'warn', server: { host: '127.0.0.1', port, strictPort: true, open: false, hmr: false } })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__message-footer-qa/`
  let playwright
  try { playwright = await import('playwright/test') } catch {
    const entry = process.env.ZSENSE_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
    playwright = await import(pathToFileURL(path.join(path.dirname(entry), 'test.mjs')).href)
  }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => Boolean(window.__messageFooterQa))
  const footer = page.locator('.chat-message-meta')
  const facts = footer.locator('.chat-message-facts')
  const actions = footer.locator('.chat-message-actions')
  const branch = () => actions.getByRole('button', { name: /分支到新聊天|正在创建分支/ })
  const snapshot = () => page.evaluate(() => window.__messageFooterQa.snapshot())
  const reset = async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.mouse.move(0, 0)
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.__messageFooterQa.reset() })
    await expect(footer).toBeVisible()
    await expect(branch()).toBeEnabled()
  }
  const geometry = () => footer.evaluate((element) => {
    const box = (node) => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 } }
    const factGroup = element.querySelector('.chat-message-facts')
    const actionGroup = element.querySelector('.chat-message-actions')
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, footer: box(element), facts: box(factGroup), actions: box(actionGroup), factItems: [...factGroup.children].map(box), buttons: [...actionGroup.children].map(box), factsOverflow: factGroup.scrollWidth > factGroup.clientWidth + 1 }
  })
  const assertNoOverlap = (layout) => {
    assert(layout.documentWidth <= layout.viewport + 1, 'footer must not cause page horizontal scrolling')
    const groups = [layout.facts, layout.actions]
    const overlapX = Math.min(groups[0].x + groups[0].width, groups[1].x + groups[1].width) - Math.max(groups[0].x, groups[1].x)
    const overlapY = Math.min(groups[0].y + groups[0].height, groups[1].y + groups[1].height) - Math.max(groups[0].y, groups[1].y)
    assert(overlapX <= 1 || overlapY <= 1, 'facts and controls must not overlap')
    for (const item of [...layout.factItems, ...layout.buttons]) {
      assert(item.x >= layout.footer.x - 1 && item.x + item.width <= layout.footer.x + layout.footer.width + 1, 'each fact/control must fit the footer width')
      assert(item.y >= layout.footer.y - 1 && item.y + item.height <= layout.footer.y + layout.footer.height + 1, 'footer must contain each fact/control vertically')
    }
    for (let index = 0; index < layout.buttons.length - 1; index += 1) {
      const a = layout.buttons[index], b = layout.buttons[index + 1]
      if (Math.abs(a.cy - b.cy) < 1) assert(a.x + a.width <= b.x + 1, 'neighboring action buttons must not overlap')
    }
  }
  async function scenario(name, run) {
    try { await run(); results.push({ name, ok: true }) } catch (error) {
      failed = true
      await page.screenshot({ path: path.join(temporary, `${name}-failure.png`), fullPage: false }).catch(() => undefined)
      results.push({ name, ok: false, error: error.message, state: await snapshot(), layout: await geometry() })
    }
  }

  await scenario('desktop-facts-and-all-actions-share-one-row', async () => {
    await reset()
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 })
      const layout = await geometry()
      assert.equal(layout.buttons.length, 6, 'assistant response should have branch, regenerate, speech, copy, delete, and quote')
      assert.equal(layout.factItems.length, 4)
      assert(Math.abs(layout.facts.cy - layout.actions.cy) <= 1, `facts/actions must align at viewport ${width}`)
      for (const fact of layout.factItems) assert(Math.abs(fact.cy - layout.actions.cy) <= 1, `each metadata fact must share the action row at ${width}`)
      assertNoOverlap(layout)
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await footer.screenshot({ path: path.join(temporary, 'footer-desktop.png') })
  })
  await scenario('accessible-labels-tooltips-and-keyboard-branch', async () => {
    await reset()
    const names = ['再次提交对应问题并生成新回复', '播报这条 AI 回复', '复制这条 AI 回复', '删除这条消息', '引用 AI 回复', '分支到新聊天']
    for (const name of names) {
      const button = actions.getByRole('button', { name, exact: true })
      await expect(button).toBeVisible()
      const title = await button.getAttribute('title')
      const customTooltip = await button.getAttribute('data-tooltip')
      assert(title?.trim() || customTooltip?.trim(), `${name} must have tooltip text`)
      await button.focus()
      await expect(button).toBeFocused()
      await expect(button).toHaveCSS('outline-style', 'solid')
      await page.keyboard.press('Escape')
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    }
    await branch().focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__messageFooterQa.snapshot().branchCalls.length === 1)
    await page.evaluate(() => window.__messageFooterQa.resolveBranch())
    await expect(branch()).toBeEnabled()
    assert.deepEqual((await snapshot()).branched, ['footer-qa-assistant'])
  })
  await scenario('branch-single-flight-pending-success-error-retry-and-disabled', async () => {
    await reset()
    // Two synchronous DOM clicks catch stale React state duplicate-submission bugs.
    await branch().evaluate((button) => { button.click(); button.click() })
    await expect(branch()).toBeDisabled()
    const busy = await branch().getAttribute('aria-busy')
    assert.equal(busy, 'true', 'pending branch should expose its busy state')
    await expect(branch()).toContainText(/正在|创建/)
    assert.equal((await snapshot()).branchCalls.length, 1, 'same-tick branch actions must run once')
    await branch().evaluate((button) => button.click())
    assert.equal((await snapshot()).branchCalls.length, 1)
    await page.evaluate(() => window.__messageFooterQa.resolveBranch())
    await expect(branch()).toBeEnabled()
    assert.deepEqual((await snapshot()).branched, ['footer-qa-assistant'])
    await branch().click()
    await expect(branch()).toBeDisabled()
    await page.evaluate(() => window.__messageFooterQa.rejectBranch())
    await expect(page.getByRole('alert')).toContainText('隔离测试模拟分支创建失败')
    await expect(branch()).toBeEnabled()
    assert.equal((await snapshot()).branchCalls.length, 2)
    assert.equal((await snapshot()).errors.length, 1)
    await branch().click()
    await page.evaluate(() => window.__messageFooterQa.resolveBranch())
    await expect(branch()).toBeEnabled()
    assert.equal((await snapshot()).branched.length, 2, 'failed branch must allow retry')
    await page.evaluate(() => window.__messageFooterQa.configure({ branchDisabled: true }))
    await expect(branch()).toBeDisabled()
    await branch().evaluate((button) => button.click())
    assert.equal((await snapshot()).branchCalls.length, 3, 'externally disabled branch must not call handler')
  })
  await scenario('existing-actions-still-call-their-handlers', async () => {
    await reset()
    await actions.getByRole('button', { name: '再次提交对应问题并生成新回复' }).click()
    await actions.getByRole('button', { name: '引用 AI 回复' }).click()
    await actions.getByRole('button', { name: '复制这条 AI 回复' }).click()
    await page.waitForFunction(() => window.__messageFooterQa.snapshot().copied.length === 1)
    const state = await snapshot()
    assert.equal(state.regenerated, 1); assert.equal(state.quotes, 1)
    assert.deepEqual(state.copied, ['这是一条隔离的 AI 回复，用于检查回复底部信息和操作按钮。'])
    await actions.getByRole('button', { name: '删除这条消息' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal((await snapshot()).deleted, 0)
  })
  await scenario('long-model-id-clips-with-full-title', async () => {
    await reset()
    const longModel = 'vendor/deepseek-flash-long-model-identifier-' + 'extended-context-version-2026-'.repeat(14)
    await page.evaluate((model) => window.__messageFooterQa.configure({ model }), longModel)
    await expect(facts.locator('.chat-message-model')).toHaveAttribute('title', longModel)
    const model = await facts.locator('.chat-message-model').evaluate((element) => {
      const textContainer = [...element.querySelectorAll('span')].find((candidate) => candidate.textContent === element.textContent) || element
      const style = getComputedStyle(textContainer)
      return { width: element.getBoundingClientRect().width, labelWidth: textContainer.clientWidth, textWidth: textContainer.scrollWidth, overflow: style.overflow, textOverflow: style.textOverflow }
    })
    assert(model.width > 0 && model.width <= 361, 'long model ID should have bounded visible width')
    assert(model.textWidth > model.labelWidth, 'test model must actually overflow its text container')
    assert.equal(model.textOverflow, 'ellipsis', 'long model ID should use ellipsis')
    assert(['hidden', 'clip'].includes(model.overflow), 'overflowing model label should be clipped')
    assertNoOverlap(await geometry())
  })
  await scenario('narrow-viewports-wrap-without-clipping-or-overlap', async () => {
    await reset()
    for (const width of [700, 480, 375, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const layout = await geometry()
      assertNoOverlap(layout)
      assert.equal(layout.factsOverflow, false, `facts must remain readable without hidden horizontal scrolling at ${width}`)
      await branch().focus()
      await branch().hover()
      assertNoOverlap(await geometry())
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      await page.mouse.move(0, 0)
      for (const box of layout.buttons) assert(box.height >= 43, `mobile action hit target should be at least 44px at ${width}`)
    }
    await footer.screenshot({ path: path.join(temporary, 'footer-mobile.png') })
  })
  await scenario('branch-only-renders-when-action-provided', async () => {
    await reset()
    await page.evaluate(() => window.__messageFooterQa.configure({ branch: false }))
    await expect(branch()).toHaveCount(0)
    await page.evaluate(() => window.__messageFooterQa.configure({ branch: true, role: 'user', showModel: false }))
    await expect(branch()).toHaveCount(0)
  })

  assert.deepEqual(browserErrors, [], 'browser and React must not emit runtime errors')
  console.log(JSON.stringify({ ok: !failed, serverPort: port, tests: results, fixture: 'isolated real ChatMessageMeta, mock action callbacks, no application database', artifacts: failed || keepArtifacts ? temporary : 'temporary artifacts removed' }, null, 2))
  if (failed) process.exitCode = 1
} catch (error) {
  failed = true
  console.error(error)
  if (browserErrors.length) console.error(JSON.stringify({ browserErrors }))
  console.error(`Diagnostic directory: ${temporary}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  await server?.close().catch(() => undefined)
  fs.rmSync(path.join(temporary, 'vite-cache'), { recursive: true, force: true })
  if (!failed && !keepArtifacts) fs.rmSync(temporary, { recursive: true, force: true })
}
