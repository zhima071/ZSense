#!/usr/bin/env node
// Real task card and both chat pages, synthetic events only; no Electron/data/model access.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-task-plan-qa-'))
const keepArtifacts = process.argv.includes('--keep-artifacts')
const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex < 0 ? null : new RegExp(process.argv[onlyIndex + 1] || '')
const results = [], browserErrors = []
let browser, server, failed = false
async function availablePort() {
  const reservation = net.createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  return port
}
const task = (id, status = 'pending', patch = {}) => ({ id, title: `任务 ${id}`, goal: `任务 ${id} 的目标`, dependencies: [], expectedOutputs: ['隔离测试交付'], writeResources: [], status, toolCallCount: 1, durationMs: 1000, ...patch })
const plan = (phase, tasks, patch = {}) => ({ planId: 'fixture-plan', phase, tasks, ...patch })
try {
  const fixture = { name: 'zsense-task-plan-isolated-fixture', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/__task-plan-qa/') return next()
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store')
      response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZSense isolated task plan QA</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/scripts/fixtures/agent-task-plan-fixture.tsx"></script></body></html>')
    })
  } }
  const port = await availablePort()
  server = await createServer({ root, configFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite-cache'), plugins: [fixture, react()], clearScreen: false, logLevel: 'warn', server: { host: '127.0.0.1', port, strictPort: true, open: false, hmr: false } })
  await server.listen()
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__task-plan-qa/`
  let playwright
  try { playwright = await import('playwright/test') } catch {
    const entry = process.env.ZSENSE_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
    playwright = await import(pathToFileURL(path.join(path.dirname(entry), 'test.mjs')).href)
  }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage(); page.setDefaultTimeout(6000)
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  const card = page.getByRole('region', { name: '多 Agent 任务计划' })
  const setPlan = async (value) => { await page.evaluate((snapshot) => window.__taskPlanQa.setPlan(snapshot), value) }
  const openCard = async () => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => Boolean(window.__taskPlanQa))
  }
  const assertWithinViewport = async () => {
    const layout = await card.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const outside = [...element.querySelectorAll('header, li, strong, small, p, summary, pre')].filter((child) => child.getClientRects().length).map((child) => {
        const rect = child.getBoundingClientRect()
        return { tag: child.tagName, class: child.className, x: rect.x, width: rect.width, scrollWidth: child.scrollWidth, clientWidth: child.clientWidth, overflowX: getComputedStyle(child).overflowX }
      }).filter((child) => child.x < bounds.x - 1 || child.x + child.width > bounds.right + 1 || (child.scrollWidth > child.clientWidth + 1 && !['auto', 'scroll'].includes(child.overflowX)))
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, x: bounds.x, width: bounds.width, outside }
    })
    assert(layout.documentWidth <= layout.viewport + 1, 'task card must not cause page horizontal scrolling')
    assert(layout.x >= -1 && layout.x + layout.width <= layout.viewport + 1, 'task card must fit viewport')
    assert.deepEqual(layout.outside, [], 'visible task card children must not be clipped outside card')
  }
  async function scenario(name, run) {
    if (only && !only.test(name)) return
    try { await run(); results.push({ name, ok: true }) } catch (error) {
      failed = true
      await page.screenshot({ path: path.join(temporary, `${name}-failure.png`), fullPage: false }).catch(() => undefined)
      results.push({ name, ok: false, error: error.message })
    }
  }
  const assertTransparentSurface = async (control) => {
    await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(control).toHaveCSS('background-image', 'none')
  }
  const assertVisibleActionIcon = async (button) => {
    const icon = await button.locator('svg').evaluate((element) => {
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
      const channels = style.stroke.match(/[\d.]+/g)?.slice(0, 3).map(Number) || []
      const luminance = channels.reduce((sum, channel, index) => {
        const value = channel / 255
        return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]
      }, 0)
      return { stroke: style.stroke, opacity: Number(style.opacity), width: bounds.width, height: bounds.height, contrast: 1.05 / (luminance + .05), channels: channels.length }
    })
    assert(icon.width > 0 && icon.height > 0 && icon.opacity > 0, 'send/stop icon must remain visible')
    assert.equal(icon.channels, 3, `action icon must have a visible stroke: ${icon.stroke}`)
    assert(icon.contrast >= 3, `action icon must contrast against the white composer: ${icon.stroke}`)
  }
  const controlTooltip = page.locator('body > .chat-control-tooltip[role="tooltip"]')
  const assertControlTooltip = async (focusTarget, currentState) => {
    await expect(controlTooltip).toHaveCount(1)
    await expect(controlTooltip).toBeVisible()
    await expect(controlTooltip).toContainText(currentState)
    if (await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)) await expect(controlTooltip).toHaveCSS('animation-name', 'none')
    const tooltipId = await controlTooltip.getAttribute('id')
    assert(tooltipId, 'the visible control tooltip must have a stable accessible ID')
    await expect(focusTarget).toHaveAttribute('aria-describedby', tooltipId)
    const bounds = await controlTooltip.evaluate((element) => {
      const rect = element.getBoundingClientRect(), previousPointerEvents = element.style.pointerEvents
      // Tooltips intentionally do not intercept clicks. Temporarily include this
      // synthetic fixture node in hit-testing to check stacking/clipping.
      try {
        element.style.pointerEvents = 'auto'
        const topmost = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { ...rect.toJSON(), viewportWidth: innerWidth, viewportHeight: innerHeight, portal: element.parentElement === document.body, visibleAtCenter: Boolean(topmost && (topmost === element || element.contains(topmost))) }
      } finally { element.style.pointerEvents = previousPointerEvents }
    })
    assert(bounds.portal, 'control tooltip must be portaled outside the clipping composer')
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= bounds.viewportWidth + 1 && bounds.y + bounds.height <= bounds.viewportHeight + 1, 'control tooltip must fit inside the visible viewport')
    assert(bounds.visibleAtCenter, 'control tooltip must not be clipped or covered by the composer')
  }
  const assertContextRing = async (control, percent) => {
    await expect(control).toHaveAttribute('aria-valuenow', String(percent))
    await expect(control).toHaveAttribute('aria-valuemin', '0')
    await expect(control).toHaveAttribute('aria-valuemax', '100')
    const svg = control.locator('svg.chat-context-ring')
    await expect(svg).toHaveAttribute('viewBox', '0 0 28 28')
    await expect(svg).toHaveCSS('width', '22px')
    await expect(svg).toHaveCSS('height', '22px')
    const renderedRing = await svg.boundingBox()
    assert(renderedRing && Math.abs(renderedRing.width - 22) < .01 && Math.abs(renderedRing.height - 22) < .01, 'the context ring must render at 22 × 22 px without changing its progress geometry')
    const value = svg.locator('circle.chat-context-ring-value')
    await expect(value).toHaveAttribute('pathLength', '100')
    await expect(value).toHaveAttribute('opacity', percent > 0 ? '1' : '0')
    const ring = await value.evaluate((element) => ({ dashArray: getComputedStyle(element).strokeDasharray, dashOffset: getComputedStyle(element).strokeDashoffset }))
    assert.equal(Number.parseFloat(ring.dashArray), 100, 'the context ring must use the normalized circumference')
    assert(Number.isFinite(Number.parseFloat(ring.dashOffset)), 'context ring must never emit NaN or Infinity')
    assert(Math.abs(Number.parseFloat(ring.dashOffset) - (100 - percent)) < .01, `context ring must match ${percent}% usage`)
  }
  const assertHoveredControlIcon = async (control) => {
    const icon = await control.locator('.chat-control-summary > svg:not(.chat-control-chevron)').evaluate((element) => {
      const style = getComputedStyle(element), matrix = new DOMMatrixReadOnly(style.transform)
      const probe = document.createElement('span'); probe.style.color = 'var(--primary)'; document.body.append(probe)
      try { return { scaleX: matrix.a, scaleY: matrix.d, color: style.color, primary: getComputedStyle(probe).color, transitionDuration: style.transitionDuration, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches } } finally { probe.remove() }
    })
    assert.equal(icon.scaleX, 1.25, 'hovered icon must scale to 125%')
    assert.equal(icon.scaleY, 1.25, 'hovered icon must preserve its aspect ratio')
    assert.equal(icon.color, icon.primary, 'hovered icon must use the app theme blue')
    if (icon.reducedMotion) assert(icon.transitionDuration.split(',').every((duration) => Number.parseFloat(duration) <= .001), 'reduced motion must remove perceptible icon transitions (the global accessibility rule allows at most 1ms)')
  }
  const assertClampedSummary = async (control, text, mustTruncate = false) => {
    const label = control.locator('.chat-control-summary > strong')
    await expect(label).toHaveText(text)
    await expect(label).toHaveCSS('overflow', 'hidden')
    await expect(label).toHaveCSS('white-space', 'nowrap')
    await expect(label).toHaveCSS('text-overflow', 'ellipsis')
    const bounds = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect(), strong = element.querySelector('.chat-control-summary > strong')
      return { x: rect.x, right: rect.right, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, labelWidth: strong.clientWidth, labelScrollWidth: strong.scrollWidth }
    })
    assert(bounds.x >= 0 && bounds.right <= bounds.viewport + 1 && bounds.documentWidth <= bounds.viewport + 1, 'restored state text must not create horizontal viewport overflow')
    if (mustTruncate) assert(bounds.labelScrollWidth > bounds.labelWidth, `long summary must be visibly ellipsized: ${text}`)
  }
  await scenario('planning-empty-plan-and-no-plan', async () => {
    await openCard()
    await expect(card.getByRole('status')).toHaveText('正在拆分任务')
    await expect(card).toContainText('正在识别目标、依赖与交付结果')
    await expect(card.locator('li')).toHaveCount(0)
    await expect(card.locator('header')).toContainText('0/0 已完成')
    await setPlan(undefined); await expect(card).toHaveCount(0)
  })
  await scenario('three-running-and-dependent-waiting-is-not-complete', async () => {
    await openCard()
    await setPlan(plan('running', [task('a', 'running'), task('b', 'running'), task('c', 'running'), task('d', 'waiting', { dependencies: ['a', 'b'] }), task('e', 'queued')]))
    await expect(card.getByRole('status')).toHaveText('并行执行中 · 3 路运行')
    await expect(card.locator('li.running')).toHaveCount(3)
    await expect(card.locator('[data-task-id="d"]')).toContainText('等待依赖或文件锁')
    await expect(card.locator('[data-task-id="d"] .agent-task-dependencies')).toHaveText('依赖：任务 a、任务 b')
    await expect(card.locator('header')).toContainText('0/5 已完成')
    await card.screenshot({ path: path.join(temporary, 'task-plan-running.png') })
  })
  await scenario('failed-and-blocked-never-count-as-completed', async () => {
    await openCard()
    await setPlan(plan('error', [task('a', 'failed', { error: '测试上游失败' }), task('b', 'blocked', { dependencies: ['a'], error: '前置任务 a 未完成，已阻断。' }), task('c', 'completed')]))
    await expect(card.getByRole('status')).toHaveText('执行中断')
    await expect(card.locator('header')).toContainText('1/3 已完成')
    await expect(card.locator('[data-task-id="a"]')).toContainText('失败')
    await expect(card.locator('[data-task-id="b"]')).toContainText('依赖未完成')
    await expect(card.locator('li.completed')).toHaveCount(1)
    await expect(card.locator('.agent-task-error')).toHaveCount(2)
  })
  await scenario('stable-task-ids-details-and-scroll-survive-snapshot-updates', async () => {
    await openCard()
    const tasks = [task('a', 'running', { output: '首个输出' }), task('b', 'waiting', { dependencies: ['a'] })]
    await setPlan(plan('running', tasks))
    await card.locator('[data-task-id="a"] summary').click()
    await expect(card.locator('[data-task-id="a"] details')).toHaveAttribute('open', '')
    const scrollBefore = await page.evaluate(() => { window.__taskPlanNodes = [...document.querySelectorAll('.agent-task-plan li')]; return scrollY })
    await setPlan(plan('validating', [task('a', 'completed', { output: '最新交付输出' }), task('b', 'completed')]))
    await expect(card.getByRole('status')).toHaveText('主 Agent 汇总校验')
    assert(await page.evaluate(() => window.__taskPlanNodes.every((node, index) => node === document.querySelectorAll('.agent-task-plan li')[index])), 'stable IDs must reuse task DOM nodes')
    await expect(card.locator('[data-task-id="a"] details')).toHaveAttribute('open', '')
    await expect(card.locator('pre')).toHaveText('最新交付输出')
    assert.equal(await page.evaluate(() => scrollY), scrollBefore, 'status updates must not move page scroll')
    await setPlan(plan('complete', [task('a', 'completed'), task('b', 'completed')]))
    await expect(card.getByRole('status')).toHaveText('已完成汇总')
    await expect(card.locator('header')).toContainText('2/2 已完成')
    await setPlan(plan('cancelled', [task('a', 'completed'), task('b', 'cancelled', { error: '用户已停止' })]))
    await expect(card.getByRole('status')).toHaveText('已停止')
    await expect(card.locator('header')).toContainText('1/2 已完成')
    await expect(card.locator('[data-task-id="b"]')).toHaveAttribute('data-task-status', 'cancelled')
  })
  await scenario('long-details-desktop-and-320px-selectable-copyable-without-overflow', async () => {
    await openCard()
    const output = '完整交付输出\n' + 'long-unbroken-output-token-'.repeat(90) + '\n末尾保留'
    await setPlan(plan('complete', [task('long-task', 'completed', { title: '任务标题'.repeat(28), goal: '长目标与交付说明'.repeat(45), expectedOutputs: ['预期产出'.repeat(40)], writeResources: ['/isolated/' + 'long-path-segment'.repeat(40)], output, toolCallCount: 999 })], { message: '主 Agent 校验说明'.repeat(50) }))
    const summary = card.locator('summary')
    await summary.focus(); await page.keyboard.press('Enter')
    await expect(card.locator('details')).toHaveAttribute('open', '')
    await expect(card.locator('pre')).toHaveText(output)
    await expect(card.locator('pre')).toHaveCSS('user-select', 'text')
    await card.locator('pre').evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range) })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
    assert.deepEqual(await page.evaluate(() => window.__taskPlanQa.copied()), [output], 'native copy gesture should see the full selected details, including hidden scroll area')
    for (const width of [1440, 700, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await assertWithinViewport()
    }
    await page.screenshot({ path: path.join(temporary, 'task-plan-mobile-long.png'), fullPage: true })
  })
  for (const kind of ['bot', 'native']) {
    await scenario(`${kind}-composer-state-text-bubbles-and-live-context-ring`, async () => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
      await page.waitForFunction(() => Boolean(window.__taskChatQa))
      const form = page.locator('form.unified-composer'), composer = form.locator('textarea')
      const toolbar = form.locator('.chat-composer-toolbar.composer-layout')
      const controls = [
        { selector: '.chat-attachment-button', state: '添加附件', summaryText: '', chevron: false, iconSize: 18 },
        { selector: '.chat-workspace-button', state: '/isolated-fixture-workspace', summaryText: 'isolated-fixture-workspace', chevron: false, iconSize: 15 },
        { selector: '.chat-reasoning-select', state: 'high', summaryText: 'high', chevron: true, iconSize: 14 },
        { selector: '.chat-model-select', state: 'fixture-model', summaryText: 'fixture-model', chevron: true, iconSize: 14 },
        { selector: '.chat-context-usage', state: '上下文使用量', summaryText: '', chevron: false, iconSize: 22 },
      ]
      for (const width of [1440, 375, 320]) {
        await page.setViewportSize({ width, height: 1000 })
        for (const { selector, state, summaryText, chevron, iconSize } of controls) {
          const control = toolbar.locator(selector), summary = control.locator('.chat-control-summary')
          await expect(summary).toHaveText(summaryText)
          const shape = await summary.evaluate((element) => ({ text: element.textContent?.trim(), childTags: [...element.children].map((child) => child.tagName.toLowerCase()), chevrons: element.querySelectorAll('.chat-control-chevron').length }))
          assert.equal(shape.text, summaryText, `${selector} must display its current state text only where requested`)
          assert.deepEqual(shape.childTags, summaryText ? chevron ? ['svg', 'strong', 'svg'] : ['svg', 'strong'] : ['svg'], `${selector} must preserve its requested icon/text/dropdown structure`)
          assert.equal(shape.chevrons, chevron ? 1 : 0, 'only reasoning and model selectors should display a dropdown arrow')
          await expect(summary.locator('svg:not(.chat-control-chevron)')).toHaveCSS('width', `${iconSize}px`)
          await expect(summary.locator('svg:not(.chat-control-chevron)')).toHaveCSS('height', `${iconSize}px`)
          if (summaryText) await assertClampedSummary(control, summaryText)
          const focusTarget = selector.includes('-select') ? control.locator('select') : control
          await page.mouse.move(0, 0); await composer.focus()
          await control.hover()
          await assertControlTooltip(focusTarget, state)
          if (selector !== '.chat-context-usage') await assertHoveredControlIcon(control)
          if (chevron) {
            await expect(summary.locator('.chat-control-chevron')).toHaveCSS('width', '12px')
            await expect(summary.locator('.chat-control-chevron')).toHaveCSS('height', '12px')
            await expect(summary.locator('.chat-control-chevron')).toHaveCSS('transform', 'none')
          }
          await page.mouse.move(0, 0); await composer.focus()
          await expect(controlTooltip, `${selector} bubble should close after pointer and focus leave`).toHaveCount(0)
          await focusTarget.focus()
          await assertControlTooltip(focusTarget, state)
          await page.keyboard.press('Escape')
          await expect(controlTooltip, `${selector} bubble should close with Escape`).toHaveCount(0)
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      // A pointer activation focuses this real button, but must not reopen its
      // bubble over the picker or accidentally submit the chat form.
      const workspaceButton = toolbar.locator('.chat-workspace-button')
      await page.mouse.move(0, 0); await composer.focus()
      await workspaceButton.evaluate((anchor) => {
        const events = [], controller = new AbortController()
        for (const type of ['pointerenter', 'pointerleave', 'pointerdown', 'pointerup', 'click', 'focusin', 'focusout']) {
          anchor.addEventListener(type, (event) => events.push({ type, disabled: anchor.disabled, pointerType: event.pointerType, relatedTarget: event.relatedTarget?.tagName }), { capture: true, signal: controller.signal })
        }
        window.__taskActivationTrace = () => { controller.abort(); return events }
      })
      await workspaceButton.click()
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const activationTrace = await page.evaluate(() => window.__taskActivationTrace())
      await expect(controlTooltip, `first workspace pointer click must not reopen a bubble through focusin: ${JSON.stringify(activationTrace)}`).toHaveCount(0)
      assert.equal(await page.evaluate(() => window.__taskChatQa.snapshot().sends), 0, 'activating a toolbar control must never submit a model task')
      await page.mouse.move(0, 0); await workspaceButton.hover()
      await assertControlTooltip(workspaceButton, '/isolated-fixture-workspace')
      await page.mouse.move(0, 0); await composer.focus()
      await workspaceButton.focus()
      await assertControlTooltip(workspaceButton, '/isolated-fixture-workspace')
      await page.keyboard.press('Enter')
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await expect(controlTooltip, 'keyboard activation must close the workspace bubble').toHaveCount(0)
      await page.mouse.move(0, 0); await composer.focus()
      // Isolated DOM events cover the touch pointerdown→focusin ordering; no
      // mobile device, native picker or model invocation is required.
      await workspaceButton.dispatchEvent('pointerenter', { pointerType: 'touch' })
      await workspaceButton.dispatchEvent('pointerdown', { pointerType: 'touch' })
      await workspaceButton.focus()
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await expect(controlTooltip, 'touch activation must not leave a sticky focused tooltip').toHaveCount(0)
      await workspaceButton.dispatchEvent('pointerleave', { pointerType: 'touch' })
      await composer.focus()
      const reasoning = toolbar.locator('.chat-reasoning-select select')
      await reasoning.focus(); await reasoning.selectOption('max')
      await assertControlTooltip(reasoning, 'max')
      await expect(toolbar.locator('.chat-reasoning-select .chat-control-summary')).toHaveText('max')
      const modelSelect = toolbar.locator('.chat-model-select select')
      await modelSelect.focus(); await modelSelect.selectOption('custom\u241falternative-fixture-model-with-a-long-model-id')
      await assertControlTooltip(modelSelect, 'alternative-fixture-model-with-a-long-model-id')
      await expect(toolbar.locator('.chat-model-select .chat-control-summary')).toHaveText('alternative-fixture-model-with-a-long-model-id')
      for (const width of [1440, 375, 320]) {
        await page.setViewportSize({ width, height: 1000 })
        await assertClampedSummary(toolbar.locator('.chat-model-select'), 'alternative-fixture-model-with-a-long-model-id', true)
        await assertClampedSummary(workspaceButton, 'isolated-fixture-workspace', true)
        await assertControlTooltip(modelSelect, 'alternative-fixture-model-with-a-long-model-id')
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await modelSelect.selectOption('custom\u241ffixture-model')
      await composer.fill('仅用隔离 stream event 验证实时上下文，不执行模型')
      await form.getByRole('button', { name: '发送消息', exact: true }).click()
      await page.waitForFunction(() => window.__taskChatQa.snapshot().sends === 1)
      const contextUsage = toolbar.locator('.chat-context-usage')
      await contextUsage.focus()
      for (const percent of [0, 5, 100]) {
        await page.evaluate((value) => window.__taskChatQa.emitUsage({ contextUsed: value * 1000, contextMax: 100_000, contextPercent: value, inputTokens: value * 1000, outputTokens: 0, totalTokens: value * 1000 }), percent)
        await assertContextRing(contextUsage, percent)
        await assertControlTooltip(contextUsage, `${percent}%`)
        await expect(controlTooltip).toContainText('100')
        await expect(contextUsage.locator('.chat-control-summary')).toHaveText('')
      }
      for (const malformed of ['NaN', 'Infinity']) {
        await page.evaluate((kind) => window.__taskChatQa.emitUsage({ contextUsed: kind === 'NaN' ? Number.NaN : Number.POSITIVE_INFINITY, contextMax: 100_000, contextPercent: Number.NaN, inputTokens: 0, outputTokens: 0, totalTokens: 0 }), malformed)
        await expect(contextUsage).toHaveAttribute('aria-valuenow', '0')
        const aria = Number(await contextUsage.getAttribute('aria-valuenow'))
        assert(Number.isFinite(aria) && aria >= 0 && aria <= 100, 'malformed provider usage must still expose finite, bounded progress')
        await assertContextRing(contextUsage, aria)
        await expect(controlTooltip).not.toContainText(/NaN|Infinity/)
      }
      await page.evaluate(() => window.__taskChatQa.cancel())
    })
    await scenario(`${kind}-composer-hover-scale-and-bubble-motion-with-final-viewport-position`, async () => {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      try {
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
        await page.waitForFunction(() => Boolean(window.__taskChatQa))
        const form = page.locator('form.unified-composer'), composer = form.locator('textarea'), workspaceButton = form.locator('.chat-workspace-button')
        for (const width of [1440, 320]) {
          await page.mouse.move(0, 0); await composer.focus()
          await page.setViewportSize({ width, height: 1000 })
          await workspaceButton.hover()
          await expect(controlTooltip).toHaveCount(1)
          await expect(controlTooltip).toHaveCSS('animation-name', 'chat-control-tooltip-in')
          await expect(controlTooltip).toHaveCSS('animation-duration', '0.3s')
          await expect(controlTooltip).toHaveCSS('animation-timing-function', 'ease-in-out')
          await expect(controlTooltip).toHaveCSS('background-color', 'rgb(255, 255, 255)')
          await expect(controlTooltip).toHaveCSS('border-width', '1px')
          await expect(controlTooltip.locator('strong')).toHaveCSS('font-weight', '700')
          const frames = await controlTooltip.evaluate((element) => element.getAnimations().find((animation) => animation.animationName === 'chat-control-tooltip-in')?.effect?.getKeyframes())
          assert(frames && frames[0].transform === 'scale(0)' && frames.at(-1).transform === 'scale(1)', 'the state bubble must scale from 0 to 1')
          await expect(controlTooltip).toHaveCSS('opacity', '1')
          await expect(controlTooltip).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
          await assertControlTooltip(workspaceButton, '/isolated-fixture-workspace')
          await expect(workspaceButton.locator('.chat-control-summary > svg:not(.chat-control-chevron)')).toHaveCSS('transition-duration', '0.2s, 0.2s')
          await assertHoveredControlIcon(workspaceButton)
          const bubbleBounds = await controlTooltip.boundingBox(), formBounds = await form.boundingBox()
          const x = Math.max(0, Math.min(bubbleBounds.x, formBounds.x) - 8), y = Math.max(0, Math.min(bubbleBounds.y, formBounds.y) - 8)
          await page.screenshot({ path: path.join(temporary, `${kind}-composer-hover-motion-${width}.png`), clip: { x, y, width: Math.min(width, Math.max(bubbleBounds.x + bubbleBounds.width, formBounds.x + formBounds.width) + 8) - x, height: Math.min(1000, Math.max(bubbleBounds.y + bubbleBounds.height, formBounds.y + formBounds.height) + 8) - y } })
        }
      } finally { await page.emulateMedia({ reducedMotion: 'reduce' }) }
    })
    await scenario(`${kind}-composer-white-toolbar-transparent-controls-and-horizontal-actions`, async () => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
      await page.waitForFunction(() => Boolean(window.__taskChatQa))
      const form = page.locator('form.unified-composer'), composer = form.locator('textarea')
      const toolbar = form.locator('.chat-composer-toolbar.composer-layout')
      await expect(composer).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(toolbar).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      await expect(toolbar).toHaveCSS('background-image', 'none')
      for (const width of [1440, 375, 320]) {
        await page.setViewportSize({ width, height: 1000 })
        await expect(toolbar).toHaveCSS('border-top-width', '0px')
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await expect(toolbar.locator('.chat-workspace-button')).toHaveClass(/selected/)
      for (const selector of ['.chat-attachment-button', '.chat-workspace-button', '.chat-reasoning-select', '.chat-model-select', '.chat-context-usage']) {
        const control = toolbar.locator(selector)
        await page.mouse.move(0, 0); await composer.focus()
        await assertTransparentSurface(control)
        await control.hover(); await assertTransparentSurface(control)
        await page.mouse.move(0, 0)
        const focusTarget = selector.includes('-select') ? control.locator('select') : control
        await focusTarget.focus(); await expect(focusTarget).toBeFocused()
        await assertTransparentSurface(control)
      }
      const dictation = form.locator('.chat-dictation-button')
      await expect(dictation).toBeEnabled(); await expect(dictation).toHaveAttribute('type', 'button')
      await page.mouse.move(0, 0); await composer.focus()
      await assertTransparentSurface(dictation); await assertVisibleActionIcon(dictation)
      await dictation.hover(); await assertTransparentSurface(dictation)
      await page.mouse.move(0, 0); await dictation.focus(); await assertTransparentSurface(dictation)
      const idleSend = form.getByRole('button', { name: '发送消息', exact: true })
      await expect(idleSend).toBeDisabled(); await assertTransparentSurface(idleSend); await assertVisibleActionIcon(idleSend)
      await composer.fill('只在隔离 fixture 内验证输入区')
      await expect(idleSend).toBeEnabled()
      await idleSend.hover(); await assertTransparentSurface(idleSend); await assertVisibleActionIcon(idleSend)
      await page.mouse.move(0, 0); await idleSend.focus(); await assertTransparentSurface(idleSend)
      await form.screenshot({ path: path.join(temporary, `${kind}-composer-white-desktop.png`) })
      await idleSend.click()
      await page.waitForFunction(() => window.__taskChatQa.snapshot().sends === 1)
      await composer.fill('运行期间的调整草稿')
      const stop = form.getByRole('button', { name: '停止当前轮次', exact: true })
      const steer = form.getByRole('button', { name: '调整本轮', exact: true })
      for (const button of [stop, steer]) {
        await expect(button).toBeEnabled()
        await page.mouse.move(0, 0); await composer.focus()
        await assertTransparentSurface(button); await assertVisibleActionIcon(button)
        await button.hover(); await assertTransparentSurface(button); await assertVisibleActionIcon(button)
        await page.mouse.move(0, 0); await button.focus(); await assertTransparentSurface(button)
      }
      for (const width of [1440, 375, 320]) {
        await page.setViewportSize({ width, height: 1000 })
        await composer.focus(); await page.mouse.move(0, 0)
        await expect(toolbar).toHaveCSS('background-color', 'rgb(255, 255, 255)')
        await expect(toolbar).toHaveCSS('border-top-width', '0px')
        // Read one layout frame: resize observers can change composer geometry between locator calls.
        const { formBox, dockBox, stopBox, steerBox, textBox, dictationBox, textRightPadding, controls } = await form.evaluate((element) => {
          const bounds = (target) => target && target.getBoundingClientRect().toJSON()
          const textarea = element.querySelector('textarea')
          return { formBox: bounds(element), dockBox: bounds(element.querySelector('.chat-send-actions')), stopBox: bounds(element.querySelector('.chat-send.stop')), steerBox: bounds(element.querySelector('.chat-send.steer')), textBox: bounds(textarea), dictationBox: bounds(element.querySelector('.chat-dictation-button')), textRightPadding: parseFloat(getComputedStyle(textarea).paddingRight), controls: [...element.querySelectorAll('.chat-composer-toolbar .chat-compact-control')].map((control) => ({ className: control.className, box: bounds(control) })) }
        })
        assert(formBox && dockBox && stopBox && steerBox && textBox && dictationBox)
        assert(formBox.x >= -1 && formBox.x + formBox.width <= width + 1, 'composer must fit the viewport')
        assert(Math.abs(stopBox.y - steerBox.y) < 1, 'send and stop must stay on the same horizontal line')
        assert(stopBox.x + stopBox.width <= steerBox.x - 6, 'send and stop must retain their gap')
        assert(dockBox.x >= formBox.x && dockBox.y >= textBox.y + textBox.height - 1 && dockBox.x + dockBox.width <= formBox.x + formBox.width && dockBox.y + dockBox.height <= formBox.y + formBox.height, 'action dock must remain inside composer and clear of the input')
        assert(dictationBox.y >= formBox.y && dictationBox.y + dictationBox.height <= steerBox.y - 4, 'dictation must sit above send with a gap')
        assert(Math.abs(dictationBox.x + dictationBox.width - steerBox.x - steerBox.width) <= 1, 'dictation and send must align on the right')
        assert(textBox.x + textBox.width - textRightPadding <= dictationBox.x - 6, 'input text must reserve space for dictation')
        for (const { className, box } of controls) {
          assert(box && box.x >= formBox.x - 1 && box.x + box.width <= formBox.x + formBox.width + 1, `toolbar control must stay inside composer at ${width}px: ${JSON.stringify({ control: className, box, formBox })}`)
          assert(!(box.x < dockBox.x + dockBox.width && box.x + box.width > dockBox.x && box.y < dockBox.y + dockBox.height && box.y + box.height > dockBox.y), 'action dock must not cover toolbar controls')
          assert(!(box.x < dictationBox.x + dictationBox.width && box.x + box.width > dictationBox.x && box.y < dictationBox.y + dictationBox.height && box.y + box.height > dictationBox.y), 'dictation must not cover toolbar controls')
        }
        await form.screenshot({ path: path.join(temporary, `${kind}-composer-white-running-${width}.png`) })
      }
      if (kind === 'native') {
        await page.setViewportSize({ width: 375, height: 430 })
        // Apply the app's existing remote-transport CSS marker to the real page fixture.
        await page.evaluate(() => document.documentElement.classList.add('zsense-web-bridge'))
        await composer.focus()
        await expect(toolbar).toBeHidden()
        await expect(toolbar).toHaveCSS('border-top-width', '0px')
        await expect(composer).toHaveCSS('height', '108px')
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const remote = await form.evaluate((element) => {
          const bounds = (target) => target.getBoundingClientRect().toJSON()
          const textarea = element.querySelector('textarea')
          return { form: bounds(element), input: bounds(textarea), dock: bounds(element.querySelector('.chat-send-actions')), mic: bounds(element.querySelector('.chat-dictation-button')), stop: bounds(element.querySelector('.chat-send.stop')), send: bounds(element.querySelector('.chat-send.steer')), rightPadding: parseFloat(getComputedStyle(textarea).paddingRight) }
        })
        assert(remote.form.x >= -1 && remote.form.y >= -1 && remote.form.x + remote.form.width <= 376 && remote.form.y + remote.form.height <= 431, 'remote compact composer must fit the reduced viewport')
        assert(remote.mic.y >= remote.form.y && remote.mic.y + remote.mic.height <= remote.send.y - 4, 'remote dictation must remain above send inside the compact composer')
        assert(remote.dock.x >= remote.form.x && remote.dock.x + remote.dock.width <= remote.form.x + remote.form.width && remote.dock.y + remote.dock.height <= remote.form.y + remote.form.height, 'remote send/stop dock must stay inside compact composer')
        assert(Math.abs(remote.stop.y - remote.send.y) < 1 && remote.stop.x + remote.stop.width <= remote.send.x - 6, 'remote send and stop must remain side by side')
        assert(remote.input.x + remote.input.width - remote.rightPadding <= remote.dock.x - 6, `remote input text must reserve space for both actions: ${JSON.stringify(remote)}`)
        await form.screenshot({ path: path.join(temporary, 'native-composer-white-remote-focused-375.png') })
        await page.evaluate(() => document.documentElement.classList.remove('zsense-web-bridge'))
      }
      await stop.click()
      await expect(idleSend).toBeVisible()
      assert.equal((await page.evaluate(() => window.__taskChatQa.snapshot())).cancels, 1, 'stop must cancel only the synthetic run')
    })
    await scenario(`${kind}-history-restores-first-agent-step-plan-only-on-own-message`, async () => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
      await page.waitForFunction(() => Boolean(window.__taskChatQa))
      const historical = page.locator('.chat-message[data-message-id="history-assistant"]')
      await expect(historical.locator('.agent-task-plan')).toHaveCount(1)
      await expect(historical.locator('.agent-task-plan')).toContainText('历史任务交付')
      await expect(historical.getByRole('status')).toHaveText('已完成汇总')
      await expect(page.locator('.chat-message[data-message-id="plain-assistant"] .agent-task-plan')).toHaveCount(0)
      await expect(page.locator('.chat-message.user .agent-task-plan')).toHaveCount(0)
      await expect(card).toHaveCount(1)
    })
    await scenario(`${kind}-stream-replaces-current-plan-and-saved-remount-retains-terminal-state`, async () => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
      await page.waitForFunction(() => Boolean(window.__taskChatQa))
      const composer = page.locator('textarea').first()
      await composer.fill('隔离任务，请拆分并完成')
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await page.waitForFunction(() => window.__taskChatQa.snapshot().sends === 1)
      const live = page.locator('.chat-message.assistant.streaming')
      const currentPlan = plan('planning', [], { planId: 'live-plan' })
      await page.evaluate((snapshot) => window.__taskChatQa.emit(snapshot), currentPlan)
      await expect(live.getByRole('status', { name: '' }).first()).toContainText('正在拆分任务')
      const runningPlan = plan('running', [task('live-task', 'running', { title: '实时任务', output: '实时交付片段' })], { planId: 'live-plan' })
      await page.evaluate((snapshot) => window.__taskChatQa.emit(snapshot), runningPlan)
      await expect(live.locator('[data-task-id="live-task"]')).toHaveAttribute('data-task-status', 'running')
      await expect(live.locator('.agent-task-plan')).toHaveCount(1)
      await expect(page.locator('.chat-message[data-message-id="history-assistant"] .agent-task-plan')).toContainText('历史任务交付')
      await expect(page.locator('.chat-message[data-message-id="history-assistant"] .agent-task-plan')).not.toContainText('实时任务')
      await expect(page.locator('.chat-message[data-message-id="plain-assistant"] .agent-task-plan')).toHaveCount(0)
      const finalPlan = plan('complete', [task('live-task', 'completed', { title: '实时任务', output: '最终交付' })], { planId: 'live-plan', message: '本轮已汇总' })
      await page.evaluate((snapshot) => window.__taskChatQa.finish(snapshot), finalPlan)
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
      const state = await page.evaluate(() => window.__taskChatQa.snapshot())
      const saved = page.locator(`.chat-message[data-message-id="saved-assistant-${state.requestId}"]`)
      await expect(saved.locator('.agent-task-plan')).toContainText('本轮已汇总')
      await expect(saved.locator('.agent-task-plan [role="status"]')).toHaveText('已完成汇总')
      const branch = saved.getByRole('button', { name: '分支到新聊天', exact: true })
      await expect(branch).toBeEnabled()
      await branch.click()
      await page.waitForFunction(() => window.__taskChatQa.snapshot().forks.length === 1)
      assert.deepEqual((await page.evaluate(() => window.__taskChatQa.snapshot())).forks, [`saved-assistant-${state.requestId}`], 'completed reply should immediately branch using its persisted ID')
      await expect(card).toHaveCount(2)
      // Wait past successful run-cache expiry, then mount from persisted fixture records.
      await page.waitForTimeout(1600)
      await page.evaluate(() => window.__taskChatQa.remount())
      await expect(saved.locator('.agent-task-plan [role="status"]')).toHaveText('已完成汇总')
      await expect(card).toHaveCount(2)
    })
    await scenario(`${kind}-cancelled-live-plan-remains-cancelled-after-run-expiry`, async () => {
      await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
      await page.waitForFunction(() => Boolean(window.__taskChatQa))
      await page.locator('textarea').first().fill('隔离任务取消状态')
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await page.waitForFunction(() => window.__taskChatQa.snapshot().sends === 1)
      await page.evaluate((snapshot) => window.__taskChatQa.emit(snapshot), plan('running', [task('live-task', 'running')], { planId: 'live-plan' }))
      await page.getByRole('button', { name: '停止当前轮次', exact: true }).click()
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
      await page.waitForTimeout(1600)
      const current = page.locator('.chat-message.assistant').last().locator('.agent-task-plan')
      await expect(current.locator('[role="status"]')).toHaveText('已停止')
      await expect(current.locator('header')).toContainText('0/1 已完成')
      await expect(current.locator('[data-task-id="live-task"]')).toHaveAttribute('data-task-status', 'cancelled')
    })
    for (const outcome of ['cancel', 'error']) {
      await scenario(`${kind}-${outcome}-partial-plan-output-and-unsent-draft-survive-expiry`, async () => {
        await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
        await page.waitForFunction(() => Boolean(window.__taskChatQa))
        const composer = page.locator('textarea').first()
        await composer.fill('尚未保存的本轮任务问题')
        await page.getByRole('button', { name: '发送消息', exact: true }).click()
        await page.waitForFunction(() => window.__taskChatQa.snapshot().sends === 1)
        await page.evaluate((snapshot) => { window.__taskChatQa.emit(snapshot); window.__taskChatQa.emitAnswer('保留的部分回答输出') }, plan('running', [task('live-task', 'running')], { planId: 'live-plan' }))
        await expect(page.locator('.chat-message.assistant').last()).toContainText('保留的部分回答输出')
        await composer.fill('运行期间编辑的未发送草稿')
        if (outcome === 'cancel') await page.getByRole('button', { name: '停止当前轮次', exact: true }).click()
        else await page.evaluate(() => window.__taskChatQa.fail())
        await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
        await page.waitForTimeout(1600)
        const current = page.locator('.chat-message.assistant').last()
        await expect(current).toContainText('保留的部分回答输出')
        await expect(current.locator('.agent-task-plan [role="status"]')).toHaveText(outcome === 'cancel' ? '已停止' : '执行中断')
        await expect(page.locator('.chat-message.user').last()).toContainText('尚未保存的本轮任务问题')
        await expect(composer).toHaveValue('运行期间编辑的未发送草稿')
        assert.equal((await page.evaluate(() => window.__taskChatQa.snapshot())).savedIds.length, 4, 'fixture must not pretend failed/cancelled turns were persisted')
      })
      await scenario(`${kind}-${outcome}-without-terminal-snapshot-stays-truthful`, async () => {
        await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
        await page.waitForFunction(() => Boolean(window.__taskChatQa))
        await page.locator('textarea').first().fill('终态事件缺失的隔离任务')
        await page.getByRole('button', { name: '发送消息', exact: true }).click()
        await page.waitForFunction(() => window.__taskChatQa.snapshot().sends === 1)
        await page.evaluate((snapshot) => { window.__taskChatQa.emit(snapshot); window.__taskChatQa.omitNextTerminalSnapshot() }, plan('running', [task('done-task', 'completed'), task('live-task', 'running'), task('waiting-task', 'waiting', { dependencies: ['live-task'] })], { planId: 'live-plan' }))
        if (outcome === 'cancel') await page.getByRole('button', { name: '停止当前轮次', exact: true }).click()
        else await page.evaluate(() => window.__taskChatQa.fail())
        await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
        const current = page.locator('.chat-message.assistant').last().locator('.agent-task-plan')
        await expect(current.locator('[role="status"]')).toHaveText(outcome === 'cancel' ? '已停止' : '执行中断')
        await expect(current.locator('header')).not.toContainText('路运行')
        await expect(current.locator('[data-task-id="done-task"]')).toHaveAttribute('data-task-status', 'completed')
        await expect(current.locator('header')).toContainText('1/3 已完成')
        if (outcome === 'cancel') {
          await expect(current.locator('[data-task-id="live-task"]')).toHaveAttribute('data-task-status', 'cancelled')
          await expect(current.locator('[data-task-id="waiting-task"]')).toHaveAttribute('data-task-status', 'cancelled')
        } else {
          await expect(current.locator('.agent-task-plan-message')).toContainText('未收到子任务最终状态')
          await expect(current.locator('[data-task-id="live-task"]')).toHaveAttribute('data-task-status', 'running')
          await expect(current.locator('[data-task-id="live-task"] .agent-task-title > small')).toHaveText('最后确认：执行中')
          await expect(current.locator('[data-task-id="waiting-task"]')).toHaveAttribute('data-task-status', 'waiting')
          await expect(current.locator('li.failed, li.blocked')).toHaveCount(0)
        }
      })
    }
    await scenario(`${kind}-conversation-switch-isolates-plans-drafts-and-background-events`, async () => {
      await page.goto(`${url}?mode=${kind}`, { waitUntil: 'networkidle' })
      await page.waitForFunction(() => Boolean(window.__taskChatQa))
      const composer = page.locator('textarea').first()
      await composer.fill('第一会话运行的任务')
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await page.waitForFunction(() => window.__taskChatQa.snapshot().sends === 1)
      await page.evaluate((snapshot) => window.__taskChatQa.emit(snapshot), plan('running', [task('live-task', 'running', { title: '第一会话实时任务' })], { planId: 'live-plan' }))
      await expect(page.locator('.chat-message.assistant.streaming .agent-task-plan')).toContainText('第一会话实时任务')
      await composer.fill('第一会话未发送草稿')
      await page.evaluate(() => window.__taskChatQa.switchConversation('second'))
      await expect(page.locator('.chat-message[data-message-id="second-assistant"] .agent-task-plan')).toContainText('第二会话历史任务')
      await expect(composer).toHaveValue('')
      await expect(card).toHaveCount(1)
      await composer.fill('第二会话未发送草稿')
      await page.evaluate((snapshot) => window.__taskChatQa.emit(snapshot), plan('validating', [task('live-task', 'completed', { title: '第一会话后台最新任务' })], { planId: 'live-plan' }))
      await expect(card).not.toContainText('第一会话后台最新任务')
      await expect(composer).toHaveValue('第二会话未发送草稿')
      await page.evaluate(() => window.__taskChatQa.switchConversation('first'))
      await expect(page.locator('.chat-message.assistant.streaming .agent-task-plan')).toContainText('第一会话后台最新任务')
      await expect(composer).toHaveValue('第一会话未发送草稿')
      await expect(card).toHaveCount(2)
      await page.evaluate(() => window.__taskChatQa.cancel())
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
      await page.evaluate(() => window.__taskChatQa.switchConversation('second'))
      await expect(card).toHaveCount(1)
      await expect(card).toContainText('第二会话历史任务')
      await expect(composer).toHaveValue('第二会话未发送草稿')
    })
  }
  assert.deepEqual(browserErrors, [], 'real components should render without React/browser runtime errors')
  console.log(JSON.stringify({ ok: !failed, serverPort: port, tests: results, fixture: 'real card + bot/native pages, synthetic callbacks/events/storage, no database/OS clipboard/model tasks', artifacts: failed || keepArtifacts ? temporary : 'temporary artifacts removed' }, null, 2))
  if (failed) process.exitCode = 1
} catch (error) {
  failed = true; console.error(error)
  if (browserErrors.length) console.error(JSON.stringify({ browserErrors }))
  console.error(`Diagnostic directory: ${temporary}`); process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined); await server?.close().catch(() => undefined)
  fs.rmSync(path.join(temporary, 'vite-cache'), { recursive: true, force: true })
  if (!failed && !keepArtifacts) fs.rmSync(temporary, { recursive: true, force: true })
}
