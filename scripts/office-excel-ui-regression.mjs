#!/usr/bin/env node
// Runs the actual SpreadsheetEditor and Univer in an isolated browser. The
// desktop bridge is an in-memory fixture: no user workbook, Electron database,
// live app, credentials, or model request is touched.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-office-excel-qa-'))
const keepArtifacts = process.argv.includes('--keep-artifacts')
const fixtureId = '/__office_excel_fixture.tsx'
const results = []
const browserErrors = []
let browser
let server
let failed = false

const fixtureCode = String.raw`
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SpreadsheetEditor } from '/src/components/SpreadsheetEditor.tsx'
import '/src/styles.css'
const clone = value => structuredClone(value)
const pathA = '/isolated/Book-A.xlsx', pathB = '/isolated/Book-B.xlsx'
const cell = (address, value, style) => ({ address, value: String(value), display: String(value), formula: '', dataType: typeof value, style })
const newModel = filePath => ({ filePath, revision: 'fixture-v1', sessionId: 'fixture-' + filePath, sessionRevision: 1, dirty: false, pendingCount: 0,
  sheets: [{ id: 'fixture-sheet-1', sheet: 'Sheet1', rowCount: 80, columnCount: 20, usedRowCount: 1, usedColumnCount: 2, cells: { A1: cell('A1', 1), B1: cell('B1', 'stable') } }] })
const models = new Map([[pathA, newModel(pathA)], [pathB, newModel(pathB)]])
const baselines = new Map([...models].map(([key, value]) => [key, clone(value)]))
const pending = new Map([...models.keys()].map(key => [key, new Map()]))
const listeners = new Set()
const qa = window.__officeExcelQa = { creates: 0, stageCalls: [], saveCalls: [], dirtyCalls: [], feedback: [], stageDelay: 0, getDelay: 0, failNextStage: false, modelReads: 0 }
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const same = (a, b) => String(a?.display ?? '') === String(b?.display ?? '') && (a?.formula || '') === (b?.formula || '') && JSON.stringify(a?.style || {}) === JSON.stringify(b?.style || {})
const metadata = model => ({ filePath: model.filePath, sessionId: model.sessionId, revision: model.sessionRevision, dirty: model.dirty, pendingCount: model.pendingCount, message: 'isolated fixture' })
function update(filePath, changes) {
  const model = models.get(filePath), base = baselines.get(filePath), staged = pending.get(filePath)
  for (const change of changes) {
    const sheet = model.sheets.find(item => item.sheet === change.sheet), old = sheet.cells[change.cell]
    const next = cell(change.cell, change.contentChanged === false ? old?.display ?? '' : change.value ?? '', change.styleSnapshot ? clone(change.style) : { ...old?.style, ...change.style })
    next.formula = change.contentChanged === false ? old?.formula || '' : change.formula || ''
    if (next.formula) { next.display = next.formula; next.value = next.formula; next.dataType = 'formula' }
    if (!change.style && !old?.style) delete next.style
    sheet.cells[change.cell] = next
    const key = change.sheet + '!' + change.cell
    if (same(next, base.sheets.find(item => item.sheet === change.sheet)?.cells[change.cell])) staged.delete(key)
    else staged.set(key, clone(change))
  }
  model.sessionRevision++; model.pendingCount = staged.size; model.dirty = staged.size > 0
  return model
}
function doc(filePath) { return { filePath, name: filePath.split('/').pop(), extension: '.xlsx', kind: 'spreadsheet', accessedAt: '', editable: true, previewUrl: '', modifiedAt: '', size: 0, sheets: ['Sheet1'], message: '' } }
window.zsenseDesktop = { isDesktop: true, office: {
  getWorkbook: async ({filePath}) => { qa.modelReads++; const captured = clone(models.get(filePath)); await pause(qa.getDelay); return { ok: true, data: captured } },
  stageCells: async request => {
    qa.stageCalls.push(clone(request)); await pause(qa.stageDelay)
    if (qa.failNextStage) { qa.failNextStage = false; return { ok: false, error: 'Injected stage failure' } }
    return { ok: true, data: metadata(update(request.filePath, request.changes)) }
  },
  saveWorkbook: async request => {
    qa.saveCalls.push(clone(request)); const model = models.get(request.filePath)
    baselines.set(request.filePath, clone(model)); pending.get(request.filePath).clear()
    model.sessionRevision++; model.pendingCount = 0; model.dirty = false
    for (const listener of listeners) listener({ ...metadata(model), kind: 'saved', source: 'editor', sourceClientId: request.clientId })
    return { ok: true, data: { ...metadata(model), document: { ...doc(request.filePath), modifiedAt: 'saved-' + model.sessionRevision } } }
  },
  discardWorkbook: async ({filePath}) => { const model = clone(baselines.get(filePath)); model.sessionRevision = models.get(filePath).sessionRevision + 1; model.dirty = false; model.pendingCount = 0; models.set(filePath, model); pending.get(filePath).clear(); return { ok: true, data: clone(model) } },
  onSessionChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
} }
qa.snapshot = () => ({ creates: qa.creates, stageCalls: clone(qa.stageCalls), saveCalls: clone(qa.saveCalls), dirtyCalls: clone(qa.dirtyCalls), feedback: clone(qa.feedback), models: clone([...models]), baselines: clone([...baselines]), modelReads: qa.modelReads })
qa.remote = (changes, kind = 'changed', operations) => {
  const filePath = qa.activePath, model = update(filePath, changes)
  if (kind === 'saved') { baselines.set(filePath, clone(model)); pending.get(filePath).clear(); model.pendingCount = 0; model.dirty = false }
  const event = { ...metadata(model), kind, source: 'agent', sourceClientId: 'isolated-agent', changes: clone(changes), operations }
  for (const listener of listeners) listener(event)
}
function App() {
  const [document, setDocument] = useState(doc(pathA)); const [, setRerender] = useState(0)
  qa.activePath = document.filePath
  qa.rerender = () => setRerender(value => value + 1)
  qa.switchFile = () => setDocument(doc(document.filePath === pathA ? pathB : pathA))
  return <main style={{height: '100vh', display: 'grid', gridTemplateRows: 'minmax(0, 1fr)'}}>
    <SpreadsheetEditor document={document} onDocumentChange={value => setDocument(value)} onDirtyChange={value => qa.dirtyCalls.push(value)} onFeedback={value => { if (value) qa.feedback.push(value) }} />
  </main>
}
createRoot(document.getElementById('root')).render(<App />)
`

async function availablePort() {
  const reservation = net.createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  return port
}

try {
  const fixture = {
    name: 'zsense-office-excel-isolated-fixture', enforce: 'pre',
    resolveId(id) { if (id === fixtureId) return fixtureId },
    load(id) { if (id === fixtureId) return fixtureCode },
    transform(source, id) {
      if (!id.split('?')[0].endsWith('/src/components/SpreadsheetEditor.tsx')) return
      // Instrument only the served module, never the source on disk. The real
      // API allows exercising Univer commands and verifying instance identity.
      return source.replace('univerInstance = univer', 'univerInstance = univer; window.__officeExcelQa.creates++; window.__officeExcelQa.api = univerAPI')
    },
    configureServer(vite) { vite.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/__office_excel_qa/') return next()
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store')
      response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated Excel regression</title></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="' + fixtureId + '"></script></body></html>')
    }) },
  }
  const presetNames = ['core', 'conditional-formatting', 'data-validation', 'drawing', 'filter', 'find-replace', 'hyper-link', 'note', 'sort', 'table']
  server = await createServer({ root, configFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite-cache'), plugins: [fixture, react()], clearScreen: false, logLevel: 'warn', resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: { entries: [], noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'lucide-react', '@univerjs/presets', ...presetNames.flatMap(name => [`@univerjs/preset-sheets-${name}`, `@univerjs/preset-sheets-${name}/locales/zh-CN`])] },
    server: { host: '127.0.0.1', port: await availablePort(), strictPort: true, open: false, hmr: false } })
  await server.listen()
  let playwright
  try { playwright = await import('playwright/test') } catch {
    const entry = process.env.ZSENSE_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
    playwright = await import(pathToFileURL(path.join(path.dirname(entry), 'test.mjs')).href)
  }
  const { chromium, expect } = playwright
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__office_excel_qa/`, { waitUntil: 'networkidle', timeout: 90000 })
  await page.waitForFunction(() => Boolean(window.__officeExcelQa?.api?.getActiveWorkbook()), {}, { timeout: 90000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.univer-spreadsheet-host canvas')].some(canvas => { const box = canvas.getBoundingClientRect(); return box.width > 500 && box.height > 300 }))
  const save = page.getByRole('button', { name: '保存工作簿', exact: true })
  const snapshot = () => page.evaluate(() => window.__officeExcelQa.snapshot())
  const rangeValue = address => page.evaluate(address => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange(address).getValue(), address)
  const edit = (address, value) => page.evaluate(({ address, value }) => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange(address).setValue(value), { address, value })
  const waitStages = count => page.waitForFunction(count => window.__officeExcelQa.stageCalls.length >= count, count)
  const waitClean = () => page.waitForFunction(() => window.__officeExcelQa.snapshot().models.find(([key]) => key === window.__officeExcelQa.activePath)[1].pendingCount === 0)

  async function scenario(name, run) {
    try { await run(); results.push({ name, ok: true }) } catch (error) {
      failed = true
      await page.screenshot({ path: path.join(temporary, `${name}-failure.png`), fullPage: false }).catch(() => undefined)
      results.push({ name, ok: false, error: error.message, state: await snapshot() })
    }
  }

  await scenario('undo-to-baseline-syncs-revert-and-clears-pending', async () => {
    const calls = (await snapshot()).stageCalls.length
    await edit('A1', 2); await waitStages(calls + 1); await expect(save).toBeEnabled()
    await page.evaluate(() => window.__officeExcelQa.api.undo()); await waitStages(calls + 2); await waitClean()
    assert.equal(await rangeValue('A1'), 1)
    const last = (await snapshot()).stageCalls.at(-1).changes.find(change => change.cell === 'A1')
    assert.equal(last.value, 1); assert.equal(last.styleSnapshot, true)
    await expect(save).toBeDisabled()
  })
  await scenario('style-undo-sends-complete-current-style-snapshot', async () => {
    const calls = (await snapshot()).stageCalls.length
    await page.evaluate(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('A1').setFontWeight('bold'))
    await waitStages(calls + 1)
    await page.evaluate(() => window.__officeExcelQa.api.undo()); await waitStages(calls + 2)
    const last = (await snapshot()).stageCalls.at(-1).changes.find(change => change.cell === 'A1')
    assert.equal(last.styleSnapshot, true); assert.notEqual(last.style?.bold, true)
  })
  await scenario('explicit-default-style-does-not-create-phantom-dirty-state', async () => {
    await waitClean(); await expect(save).toBeDisabled()
    const calls = (await snapshot()).stageCalls.length
    await page.evaluate(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('A1').setFontWeight('normal'))
    await page.waitForTimeout(30)
    assert.equal((await snapshot()).stageCalls.length, calls)
    await expect(save).toBeDisabled()
  })
  await scenario('save-does-not-restage-or-recreate-editor-on-parent-update', async () => {
    await edit('A1', 4); await expect(save).toBeEnabled()
    const before = await snapshot()
    await save.click(); await expect(page.locator('.spreadsheet-save-state')).not.toContainText('正在写回原文件'); await expect(save).toBeDisabled()
    const after = await snapshot()
    assert.equal(after.stageCalls.length, before.stageCalls.length)
    assert.equal(after.saveCalls.length, before.saveCalls.length + 1)
    assert.equal(after.creates, before.creates)
    await page.evaluate(() => window.__officeExcelQa.rerender())
    await page.waitForTimeout(50)
    assert.equal((await snapshot()).creates, before.creates)
  })
  await scenario('agent-cell-update-retains-selection-and-user-undo', async () => {
    await edit('A1', 7); await expect(save).toBeEnabled()
    await page.evaluate(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('D5').activate())
    const before = await snapshot()
    await page.evaluate(() => window.__officeExcelQa.remote([{ sheet: 'Sheet1', cell: 'B1', value: 'agent-update' }]))
    await page.waitForFunction(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('B1').getValue() === 'agent-update')
    assert.equal((await snapshot()).creates, before.creates)
    assert.equal((await snapshot()).stageCalls.length, before.stageCalls.length, 'external updates must not echo into stageCells')
    assert.equal(await page.evaluate(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getActiveRange().getA1Notation()), 'D5')
    await page.evaluate(() => window.__officeExcelQa.api.undo())
    await page.waitForFunction(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('A1').getValue() === 4)
    assert.equal(await rangeValue('B1'), 'agent-update', 'Agent mutation must not occupy the user undo stack')
  })
  await scenario('stale-agent-read-does-not-overwrite-newer-local-input', async () => {
    const reads = (await snapshot()).modelReads
    await page.evaluate(() => { window.__officeExcelQa.getDelay = 180; window.__officeExcelQa.remote([{ sheet: 'Sheet1', cell: 'B2', value: 'remote-B2' }]) })
    await page.waitForFunction(reads => window.__officeExcelQa.modelReads > reads, reads)
    await edit('A1', 'new-local-input')
    await edit('A3', 'new-local-input')
    await page.waitForFunction(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('B2').getValue() === 'remote-B2')
    assert.equal(await rangeValue('A3'), 'new-local-input')
    assert.equal(await rangeValue('A1'), 'new-local-input', 'stale reads must preserve newer edits to an existing cell too')
    await page.evaluate(() => { window.__officeExcelQa.getDelay = 0 })
  })
  await scenario('agent-style-replacement-and-removal-apply-without-rebuild', async () => {
    const before = await snapshot()
    await page.evaluate(() => window.__officeExcelQa.remote([{ sheet: 'Sheet1', cell: 'B1', contentChanged: false, style: { bold: true }, styleSnapshot: true }]))
    await page.waitForFunction(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('B1').getCellStyleData('cell')?.bl === 1)
    await page.evaluate(() => window.__officeExcelQa.remote([{ sheet: 'Sheet1', cell: 'B1', contentChanged: false, styleSnapshot: true }]))
    await page.waitForFunction(() => !window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('B1').getCellStyleData('cell')?.bl)
    assert.equal((await snapshot()).creates, before.creates)
    assert.equal((await snapshot()).stageCalls.length, before.stageCalls.length)
    assert.equal(await rangeValue('B1'), 'agent-update')
  })
  await scenario('failed-staging-can-retry-with-save', async () => {
    await page.evaluate(() => { window.__officeExcelQa.failNextStage = true })
    await edit('A4', 'retry-value')
    await page.waitForFunction(() => window.__officeExcelQa.feedback.some(item => item.message.includes('Injected stage failure')))
    await page.evaluate(() => window.__officeExcelQa.remote([{ sheet: 'Sheet1', cell: 'B3', value: 'unrelated-agent-change' }]))
    await page.waitForFunction(() => window.__officeExcelQa.api.getActiveWorkbook().getActiveSheet().getRange('B3').getValue() === 'unrelated-agent-change')
    assert.equal(await rangeValue('A4'), 'retry-value', 'an unrelated Agent update must preserve the failed-sync draft')
    await save.click(); await expect(page.locator('.spreadsheet-save-state')).not.toContainText('正在写回原文件'); await expect(save).toBeDisabled()
    const after = await snapshot(), disk = after.baselines.find(([key]) => key === '/isolated/Book-A.xlsx')[1]
    assert.equal(disk.sheets[0].cells.A4.display, 'retry-value')
    assert.equal(await rangeValue('A4'), 'retry-value')
  })
  await scenario('queued-edits-stay-bound-to-original-file-after-switch', async () => {
    const before = await snapshot()
    await page.evaluate(() => { window.__officeExcelQa.stageDelay = 180 })
    await edit('A5', 'only-A')
    await page.evaluate(() => window.__officeExcelQa.switchFile())
    await page.waitForFunction(() => window.__officeExcelQa.activePath === '/isolated/Book-B.xlsx' && window.__officeExcelQa.creates === 2)
    await page.waitForTimeout(250)
    const after = await snapshot(), bookB = after.models.find(([key]) => key === '/isolated/Book-B.xlsx')[1]
    assert(!bookB.sheets[0].cells.A5, 'pending A edits must not migrate to B')
    assert.equal(after.stageCalls.slice(before.stageCalls.length).at(-1).filePath, '/isolated/Book-A.xlsx')
    await expect(save).toBeDisabled()
    await page.evaluate(() => { window.__officeExcelQa.stageDelay = 0 })
  })
  assert.equal(browserErrors.length, 0, `browser errors: ${browserErrors.join('; ')}`)
  await page.waitForFunction(() => [...document.querySelectorAll('.univer-spreadsheet-host canvas')].some(canvas => { const box = canvas.getBoundingClientRect(); return box.width > 500 && box.height > 300 }))
  await page.screenshot({ path: path.join(temporary, 'excel-editor-final.png'), fullPage: false })
} catch (error) {
  failed = true; results.push({ name: 'harness', ok: false, error: error.stack || error.message, browserErrors })
} finally {
  await browser?.close().catch(() => undefined)
  await server?.close().catch(() => undefined)
  // Screenshots are useful QA evidence; the reproducible ~58 MB optimizer
  // cache is not, even when --keep-artifacts is selected.
  fs.rmSync(path.join(temporary, 'vite-cache'), { recursive: true, force: true })
  console.log(JSON.stringify({ ok: !failed, results, browserErrors, artifacts: failed || keepArtifacts ? temporary : undefined }, null, 2))
  if (!failed && !keepArtifacts) fs.rmSync(temporary, { recursive: true, force: true })
  if (failed) process.exitCode = 1
}
