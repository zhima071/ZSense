import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../src/services/office-navigation-guard.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { registerOfficeNavigationGuard, requestOfficeNavigation } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
assert.equal(await requestOfficeNavigation(), true)
let calls = 0, release
const unregister = registerOfficeNavigationGuard('editor', () => { calls += 1; return new Promise((resolve) => { release = resolve }) })
const first = requestOfficeNavigation()
const concurrent = requestOfficeNavigation()
assert.equal(first, concurrent, 'Concurrent navigation must share one draft confirmation')
assert.equal(calls, 1)
release(false)
assert.equal(await first, false, 'Declining must leave editor mounted')
const next = requestOfficeNavigation()
assert.equal(calls, 2, 'The next request must ask again')
release(true)
assert.equal(await next, true)
unregister()
const old = registerOfficeNavigationGuard('same-editor', () => false)
const current = registerOfficeNavigationGuard('same-editor', () => true)
old()
assert.equal(await requestOfficeNavigation(), true, 'Stale cleanup must not remove a newer guard')
current()
const failing = registerOfficeNavigationGuard('failed-discard', () => { throw new Error('discard failed') })
await assert.rejects(requestOfficeNavigation(), /discard failed/)
failing()
assert.equal(await requestOfficeNavigation(), true, 'Failed discard must not permanently lock navigation')

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const voice = app.slice(app.indexOf('const startVoiceInteraction'), app.indexOf('voiceStartRef.current ='))
assert(voice.indexOf('await requestOfficeNavigation()') < voice.indexOf("setActiveView('chat')"), 'Voice navigation must respect unsaved Office work')
const wake = app.slice(app.indexOf('onDetected: (phrase)'), app.indexOf('onError: (error)', app.indexOf('onDetected: (phrase)')))
assert(wake.indexOf('requestOfficeNavigation().then') < wake.indexOf("setActiveView('chat')"), 'Wake navigation must respect unsaved Office work')
for (const name of ['NativeChatPage', 'ChatDialog']) {
  const page = fs.readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8')
  const catalog = page.slice(page.indexOf('const slashCommands ='), page.indexOf('const visibleSlashCommands ='))
  assert.match(catalog, /id: 'browser'.*run: \(\) => openBrowserUrl\(\)/, `${name}: /browser must use the guarded browser entry`)
  assert.match(catalog, /id: 'canvas'.*run: \(\) => openCanvas\(\)/, `${name}: /canvas must use the guarded canvas entry`)
  assert.doesNotMatch(catalog, /setOfficeArtifactPath/, `${name}: slash commands must not directly discard the pane`)
  for (const entry of ['openCanvas', 'openBrowserUrl']) {
    assert(page.indexOf(`const ${entry} =`) < page.indexOf('const slashCommands ='), `${name}: guarded callbacks must initialize before catalog dependencies`)
  }
}
console.log('Office navigation regression passed: shared confirmation, decline/retry, cleanup/recovery, voice and slash guards')
