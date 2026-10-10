#!/usr/bin/env node
// Browser-only QA against the actual JumpNav component. No Electron, account,
// remote device, or real conversation data is accessed by this fixture.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-bookmark-qa-'))
const keepArtifacts = process.argv.includes('--keep-artifacts')
const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex < 0 ? null : new RegExp(process.argv[onlyIndex + 1] || '')
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
  const fixture = {
    name: 'zsense-bookmark-isolated-fixture',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/__bookmark-qa/') return next()
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZSense isolated bookmark QA</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/scripts/fixtures/conversation-bookmark-fixture.tsx"></script></body></html>')
      })
    },
  }
  const port = await availablePort()
  server = await createServer({ root, configFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite-cache'), plugins: [fixture, react()], clearScreen: false, logLevel: 'warn', server: { host: '127.0.0.1', port, strictPort: true, open: false, hmr: false } })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__bookmark-qa/`
  let playwright
  try { playwright = await import('playwright/test') } catch {
    const entry = process.env.ZSENSE_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
    playwright = await import(pathToFileURL(path.join(path.dirname(entry), 'test.mjs')).href)
  }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => Boolean(window.__bookmarkQa))
  const entry = (index = 0) => page.locator('.chat-jump-entry').nth(index)
  const marker = (index = 0) => entry(index).locator('.chat-jump-marker')
  const preview = (index = 0) => entry(index).locator('.chat-jump-preview')
  const bookmark = (index = 0) => entry(index).locator('.chat-jump-bookmark')
  const reset = async () => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.evaluate(() => window.__bookmarkQa.reset())
    await page.waitForTimeout(50)
  }
  const open = async (index = 0) => {
    await page.mouse.move(1400, 8)
    await marker(index).hover()
    await expect(preview(index)).toBeVisible()
    await expect(preview(index)).toHaveCSS('opacity', '1')
  }
  const state = () => page.evaluate(() => window.__bookmarkQa.snapshot())
  const waitSaved = async (id, messageId, marked) => {
    await page.waitForFunction(({ id, messageId, marked }) => window.__bookmarkQa.snapshot().bookmarks[id]?.includes(messageId) === marked, { id, messageId, marked })
  }
  const captureCard = async (index, name) => {
    const [card, ruler] = await Promise.all([preview(index).boundingBox(), marker(index).boundingBox()])
    assert(card && ruler)
    const x = Math.max(0, Math.min(card.x, ruler.x) - 12)
    const y = Math.max(0, card.y - 12)
    const right = Math.min(1440, Math.max(card.x + card.width, ruler.x + ruler.width) + 12)
    const bottom = Math.min(960, card.y + card.height + 12)
    await page.screenshot({ path: path.join(temporary, name), clip: { x, y, width: right - x, height: bottom - y } })
  }
  async function scenario(name, run) {
    if (only && !only.test(name)) return
    try { await run(); results.push({ name, ok: true }) }
    catch (error) {
      failed = true
      await page.screenshot({ path: path.join(temporary, `${name}-failure.png`), fullPage: false }).catch(() => undefined)
      results.push({ name, ok: false, error: error.message, state: await state(), source: error.stack?.split('\n').find((line) => line.includes('conversation-bookmark-ui-smoke.mjs'))?.trim() })
    }
  }
  await scenario('hover-transfer-toggle-without-jump-and-cancel', async () => {
    await reset(); await open()
    await captureCard(0, 'bookmark-card-before.png')
    const buttonBox = await bookmark().boundingBox()
    await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2, { steps: 20 })
    await page.waitForTimeout(200)
    await expect(preview()).toHaveCSS('opacity', '1')
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'false')
    await expect(bookmark()).toHaveAttribute('title', /标记/)
    await bookmark().click(); await waitSaved('a', 'user-1', true)
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'true')
    assert.deepEqual((await state()).jumps, [], 'clicking bookmark must not invoke message scrolling/jump')
    await captureCard(0, 'bookmark-card-after.png')
    await bookmark().click(); await waitSaved('a', 'user-1', false)
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'false')
    assert.deepEqual((await state()).jumps, [])
    assert.equal((await state()).calls.length, 2, 'each toggle must call persistence exactly once')
  })
  await scenario('fixture-persistence-reload-and-shared-prefix-conversation-isolation', async () => {
    await reset(); await open(); await bookmark().click(); await waitSaved('a', 'user-1', true)
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForFunction(() => Boolean(window.__bookmarkQa)); await open()
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.__bookmarkQa.setConversation('b')); await open()
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'false')
    await bookmark().click(); await waitSaved('b', 'user-1', true)
    await bookmark().click(); await waitSaved('b', 'user-1', false)
    await page.evaluate(() => window.__bookmarkQa.setConversation('a')); await open()
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'true')
    assert.deepEqual((await state()).bookmarks, { a: ['user-1'], b: [] }, 'same anchorPrefix/message ID must not merge conversations')
  })
  await scenario('keyboard-tab-space-without-nested-buttons', async () => {
    await reset()
    await page.evaluate(() => window.__bookmarkQa.setDelay(250))
    await marker().focus(); await page.keyboard.press('Tab')
    await expect(bookmark()).toBeFocused()
    await expect(preview()).toHaveCSS('opacity', '1')
    await page.keyboard.press('Space')
    await expect(bookmark()).toHaveAttribute('aria-busy', 'true')
    await expect(bookmark()).toBeFocused()
    await expect(preview()).toHaveCSS('opacity', '1')
    await page.keyboard.press('Space'); await page.keyboard.press('Enter')
    await waitSaved('a', 'user-1', true)
    await expect(bookmark()).toHaveAttribute('aria-busy', 'false')
    await expect(bookmark()).toBeFocused()
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'true')
    assert.equal((await state()).calls.length, 1, 'pending keyboard events must not create duplicate writes')
    assert.deepEqual((await state()).jumps, [], 'keyboard toggle must not trigger parent ruler jump')
    assert.equal(await page.locator('button button').count(), 0, 'bookmark controls must be siblings, never invalid nested buttons')
    await page.keyboard.press('Space'); await waitSaved('a', 'user-1', false)
    await expect(bookmark()).toHaveAttribute('aria-busy', 'false')
    await expect(bookmark()).toBeFocused()
    await page.evaluate(() => window.__bookmarkQa.failNext())
    await page.keyboard.press('Enter')
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(bookmark()).toBeFocused()
    await page.getByRole('button', { name: '重试保存标记' }).focus()
    await page.keyboard.press('Enter')
    await expect(bookmark()).toBeFocused()
    await waitSaved('a', 'user-1', true)
    await expect(bookmark()).toHaveAttribute('aria-busy', 'false')
    await expect(bookmark()).toBeFocused()
    assert.equal((await state()).calls.length, 4)
    await marker(1).focus(); await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__bookmarkQa.snapshot().jumps.includes('user-2'))
  })
  await scenario('save-failure-rollback-retry-and-pending-guard', async () => {
    await reset(); await open()
    await page.evaluate(() => window.__bookmarkQa.failNext())
    await bookmark().click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('alert')).toContainText(/失败|重试/)
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'false')
    assert.deepEqual((await state()).bookmarks.a, [], 'failed save must not persist an optimistic bookmark')
    await page.getByRole('button', { name: '重试保存标记' }).click(); await waitSaved('a', 'user-1', true)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.evaluate(() => window.__bookmarkQa.failNext())
    await bookmark().click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(bookmark()).toHaveAttribute('aria-pressed', 'true')
    assert.deepEqual((await state()).bookmarks.a, ['user-1'], 'failed removal must preserve original saved state')
    await page.evaluate(() => window.__bookmarkQa.setDelay(200))
    await page.getByRole('button', { name: '重试保存标记' }).click()
    await expect(bookmark()).toHaveAttribute('aria-disabled', 'true')
    await expect(bookmark()).toHaveAttribute('aria-busy', 'true')
    await bookmark().evaluate((button) => { button.click(); button.click() })
    await waitSaved('a', 'user-1', false)
    await expect(bookmark()).toHaveAttribute('aria-busy', 'false')
    await expect(bookmark()).toBeEnabled()
    assert.equal((await state()).calls.length, 4, 'pending guard must not create duplicate writes')
  })
  await scenario('temporary-and-unsaved-conversation-disabled', async () => {
    await reset(); await open(2)
    await expect(bookmark(2)).toBeDisabled()
    await expect(preview(2).locator('.chat-jump-bookmark-status')).toBeVisible()
    await expect(preview(2).locator('.chat-jump-bookmark-status')).toContainText('保存后可标记')
    assert.equal(await bookmark(2).getAttribute('aria-describedby'), await preview(2).locator('.chat-jump-bookmark-status').getAttribute('id'))
    await page.evaluate(() => window.__bookmarkQa.configure({ unsaved: true })); await open()
    await expect(bookmark()).toBeDisabled()
    await expect(preview().locator('.chat-jump-bookmark-status')).toBeVisible()
    assert.equal((await state()).calls.length, 0)
  })
  await scenario('preview-viewport-edge-and-existing-mobile-office-hiding', async () => {
    await reset()
    for (const edge of ['top', 'bottom']) {
      await reset()
      await page.evaluate((edge) => window.__bookmarkQa.configure({ edge }), edge)
      await open()
      const card = await preview().boundingBox()
      assert(card && card.x >= 0 && card.y >= 0 && card.x + card.width <= 1440 && card.y + card.height <= 960, `${edge} preview must remain entirely inside viewport`)
      const buttonBox = await bookmark().boundingBox()
      assert(buttonBox.x >= card.x && buttonBox.x + buttonBox.width <= card.x + card.width + 1, 'bookmark must stay in card upper-right corner')
      assert(buttonBox.y >= card.y && buttonBox.y - card.y < 50, 'bookmark control must be near top of preview, not cover the summary lower down')
    }
    await reset(); await page.setViewportSize({ width: 760, height: 820 }); await marker().hover()
    await expect(preview()).toBeHidden()
    await reset(); await page.evaluate(() => window.__bookmarkQa.configure({ officeOpen: true })); await marker().hover()
    await expect(preview()).toBeHidden()
  })
  const overlap = (left, right) => left.x < right.x + right.width - 1 && left.x + left.width > right.x + 1 && left.y < right.y + right.height - 1 && left.y + left.height > right.y + 1
  for (const [name, viewport, width, remote] of [
    ['desktop', { width: 1440, height: 960 }, 900, false],
    ['mobile', { width: 375, height: 820 }, 351, false],
    ['narrow-sidepane', { width: 1440, height: 960 }, 320, false],
    ['remote-focused-input', { width: 375, height: 430 }, 351, true],
  ]) {
    await scenario(`composer-${name}-horizontal-actions-and-callbacks`, async () => {
      await reset(); await page.setViewportSize(viewport)
      await page.evaluate(({ width, remote }) => window.__bookmarkQa.configure({ composer: true, composerWidth: width, webBridge: remote }), { width, remote })
      const form = page.locator('[data-testid="composer-fixture"] form')
      const textarea = form.getByRole('textbox', { name: '输入任务内容' })
      if (remote) {
        await textarea.focus()
        await expect(form.locator('.chat-composer-toolbar')).toBeHidden()
      }
      const stop = form.getByRole('button', { name: '停止当前轮次' })
      const send = form.getByRole('button', { name: '调整本轮' })
      await expect(stop).toBeVisible(); await expect(send).toBeVisible()
      const [formBox, dockBox, stopBox, sendBox, textBox] = await Promise.all([form.boundingBox(), form.locator('.chat-send-actions').boundingBox(), stop.boundingBox(), send.boundingBox(), textarea.boundingBox()])
      assert(formBox && dockBox && stopBox && sendBox && textBox)
      assert.equal(stopBox.y, sendBox.y, 'stop and send must be on the same horizontal line')
      assert(stopBox.x + stopBox.width <= sendBox.x - 6, 'stop must be left of send with a gap')
      assert(!overlap(stopBox, sendBox), 'buttons must never overlap')
      assert(dockBox.x >= formBox.x && dockBox.y >= formBox.y && dockBox.x + dockBox.width <= formBox.x + formBox.width && dockBox.y + dockBox.height <= formBox.y + formBox.height, 'action dock must be inside composer')
      assert(Math.abs(formBox.x + formBox.width - sendBox.x - sendBox.width) < 15, 'send must remain anchored to lower-right')
      assert(Math.abs(formBox.y + formBox.height - sendBox.y - sendBox.height) < 15, 'send must remain anchored to bottom')
      if (remote) {
        const rightPadding = await textarea.evaluate((element) => parseFloat(getComputedStyle(element).paddingRight))
        assert(textBox.x + textBox.width - rightPadding <= dockBox.x - 6, 'focused remote text must reserve space for both action buttons')
      } else {
        assert(!overlap(textBox, dockBox), 'normal input content must not be covered by action dock')
        for (const control of await form.locator('[data-composer-control]').all()) {
          const controlBox = await control.boundingBox()
          assert(controlBox && !overlap(controlBox, dockBox), `${await control.getAttribute('data-composer-control')} must not be covered by actions`)
          assert(controlBox.x >= formBox.x && controlBox.x + controlBox.width <= formBox.x + formBox.width, 'toolbar controls must remain inside composer')
        }
      }
      await form.screenshot({ path: path.join(temporary, `composer-${name}.png`) })
      await stop.click()
      assert.deepEqual((await state()).composer, { stop: 1, send: 0 }, 'stop is type=button and must not also submit')
      await send.click()
      assert.deepEqual((await state()).composer, { stop: 1, send: 1 }, 'send should submit exactly once')
      await page.evaluate(() => window.__bookmarkQa.configure({ sendDisabled: true }))
      await expect(send).toBeDisabled(); await expect(stop).toBeEnabled()
      await page.evaluate(() => window.__bookmarkQa.configure({ sendDisabled: false, sending: false }))
      await expect(stop).toHaveCount(0)
      await expect(form.getByRole('button', { name: '发送消息' })).toBeVisible()
      assert.equal(await form.locator('.chat-send-actions button').count(), 1)
    })
  }
  const openDialog = async (mode) => {
    await reset()
    await page.evaluate((dialog) => window.__bookmarkQa.configure({ dialog }), mode)
    await page.waitForFunction(() => Boolean(window.__dialogQa))
    const dialog = page.locator('.chat-dialog')
    await expect(dialog).toBeVisible()
    return dialog
  }
  const dialogState = () => page.evaluate(() => window.__dialogQa.snapshot())
  const openDialogPreview = async (dialog, index) => {
    const round = dialog.locator('.chat-jump-entry').nth(index)
    await page.mouse.move(1400, 8)
    await round.locator('.chat-jump-marker').hover()
    await expect(round.locator('.chat-jump-preview')).toHaveCSS('opacity', '1')
    return round
  }
  await scenario('dialog-existing-round-reconciles-saved-ids-and-can-bookmark', async () => {
    const dialog = await openDialog('existing')
    const draft = dialog.getByRole('textbox', { name: /输入消息/ })
    await draft.fill('已有Bot保存后可立即标记本轮')
    await dialog.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(dialog.locator('.chat-message.assistant.streaming')).toContainText('流式初始片段')
    await draft.fill('保存期间新输入的草稿不能被清掉')
    await page.evaluate(() => window.__dialogQa.finish())
    await expect(dialog.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
    const saved = await dialogState()
    await expect(dialog.locator(`.chat-message[data-message-id="${saved.userId}"]`)).toHaveCount(1)
    await expect(dialog.locator(`.chat-message[data-message-id="${saved.assistantId}"]`)).toContainText('最终回答：流式完整内容已保存。')
    await expect(dialog.locator('.chat-message[data-message-id^="local-user-"]')).toHaveCount(0)
    await expect(dialog.locator('.chat-message[data-message-id^="local-assistant-"]')).toHaveCount(0)
    await expect(draft).toHaveValue('保存期间新输入的草稿不能被清掉')
    const round = await openDialogPreview(dialog, 1)
    await expect(round.locator('.chat-jump-bookmark')).toBeEnabled()
    await round.locator('.chat-jump-bookmark').click()
    await expect(round.locator('.chat-jump-bookmark')).toHaveAttribute('aria-pressed', 'true')
    assert.deepEqual((await dialogState()).bookmarkCalls, [{ conversationId: saved.conversation.id, messageId: saved.userId, bookmarked: true }])
    await expect(draft).toHaveValue('保存期间新输入的草稿不能被清掉')
  })
  await scenario('dialog-new-conversation-prop-association-preserves-live-stream', async () => {
    const dialog = await openDialog('new')
    assert.equal((await dialogState()).conversation, undefined)
    const draft = dialog.getByRole('textbox', { name: /输入消息/ })
    await draft.fill('新Bot会话关联测试')
    await dialog.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(dialog.locator('.chat-message.assistant.streaming')).toContainText('流式初始片段')
    await draft.fill('流式中关联会话也应保留草稿')
    await page.evaluate(() => window.__dialogQa.associate())
    await expect(dialog.locator('.chat-message.assistant.streaming')).toContainText('流式初始片段')
    await expect(draft).toHaveValue('流式中关联会话也应保留草稿')
    await page.evaluate(() => window.__dialogQa.emit(' · 关联后的第二片段'))
    await expect(dialog.locator('.chat-message.assistant.streaming')).toContainText('流式初始片段 · 关联后的第二片段')
    await page.evaluate(() => window.__dialogQa.finish())
    await expect(dialog.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
    const saved = await dialogState()
    assert(saved.conversation?.id)
    await expect(dialog.locator(`.chat-message[data-message-id="${saved.userId}"]`)).toHaveCount(1)
    await expect(dialog.locator('.chat-message.assistant.streaming')).toHaveCount(0)
    await expect(draft).toHaveValue('流式中关联会话也应保留草稿')
    const round = await openDialogPreview(dialog, 0)
    await expect(round.locator('.chat-jump-bookmark')).toBeEnabled()
    await round.locator('.chat-jump-bookmark').click()
    await expect(round.locator('.chat-jump-bookmark')).toHaveAttribute('aria-pressed', 'true')
    assert.equal((await dialogState()).bookmarkCalls[0].messageId, saved.userId)
  })
  await scenario('dialog-bookmark-metadata-preserves-draft-and-open-previews', async () => {
    const dialog = await openDialog('existing')
    const draft = dialog.getByRole('textbox', { name: /输入消息/ })
    await draft.fill('书签metadata变化不能清理这段未发送文本\n第二行保留')
    await dialog.getByRole('button', { name: '打开会话浏览器' }).click()
    await expect(page.locator('.chat-split-shell')).toHaveClass(/has-browser-workspace/)
    const round = await openDialogPreview(dialog, 0)
    await expect(round.locator('.chat-jump-bookmark')).toHaveAttribute('aria-pressed', 'false')
    await page.evaluate(() => window.__dialogQa.updateMetadata())
    await expect(round.locator('.chat-jump-bookmark')).toHaveAttribute('aria-pressed', 'true')
    await expect(round.locator('.chat-jump-preview')).toHaveCSS('opacity', '1')
    await expect(draft).toHaveValue('书签metadata变化不能清理这段未发送文本\n第二行保留')
    await expect(page.locator('.chat-split-shell')).toHaveClass(/has-browser-workspace/)
    assert.equal((await dialogState()).sends, 0)
    assert.deepEqual((await dialogState()).bookmarkCalls, [])
  })
  for (const outcome of ['cancel', 'error']) {
    await scenario(`dialog-${outcome}-run-expiry-preserves-prompt-partial-and-draft`, async () => {
      const dialog = await openDialog('existing')
      const draft = dialog.getByRole('textbox', { name: /输入消息/ })
      const prompt = `${outcome}后必须保留本轮尚未写入数据库的用户问题`
      await draft.fill(prompt)
      await dialog.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(dialog.locator('.chat-message.assistant.streaming')).toContainText('流式初始片段')
      await draft.fill(`${outcome}中编辑的未发送草稿`)
      if (outcome === 'cancel') await dialog.getByRole('button', { name: '停止当前轮次' }).click()
      else await page.evaluate(() => window.__dialogQa.fail('隔离测试模拟发送失败'))
      await expect(dialog.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
      await expect(dialog.locator('.chat-message.assistant.streaming')).toHaveCount(0)
      // The run cache is deliberately removed after 1.5 seconds. A subsequent
      // idle reconciliation must not replace this unsaved turn with old history.
      await page.waitForTimeout(1800)
      await expect(dialog.locator('.chat-message[data-message-id^="local-user-"]')).toContainText(prompt)
      await expect(dialog.locator('.chat-message[data-message-id^="local-assistant-"]')).toContainText('流式初始片段')
      await expect(draft).toHaveValue(`${outcome}中编辑的未发送草稿`)
      assert.equal((await dialogState()).sends, 1)
      assert.equal((await dialogState()).conversation.messages.length, 2, 'fixture has not pretended to persist a failed round')
    })
  }
  assert.deepEqual(browserErrors, [], 'browser/React must not emit runtime errors')
  console.log(JSON.stringify({ ok: !failed, serverPort: port, tests: results, storage: 'isolated browser localStorage, not the actual app database', artifacts: failed || keepArtifacts ? temporary : 'temporary artifacts removed' }, null, 2))
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
