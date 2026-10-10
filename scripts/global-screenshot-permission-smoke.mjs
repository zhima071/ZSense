import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { GlobalScreenshotService } from '../electron/services/global-screenshot-service.mjs'

// All Electron screen/window/shortcut APIs are injected mocks. This fixture
// never captures the desktop, requests OS consent, changes TCC, or touches the
// clipboard. It exercises the real service methods, not source markers.
const image = {
  isEmpty: () => false,
  toDataURL: () => 'data:image/png;base64,fixture',
}
const source = { display_id: '1', thumbnail: image }
const display = {
  id: 1, bounds: { x: -1200, y: 0, width: 1200, height: 800 },
  workArea: { x: -1200, y: 0, width: 1200, height: 760 }, scaleFactor: 2,
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ platform = 'darwin', permission = 'granted', capture, load, requestPermission, throwPermission = false } = {}) {
  const state = {
    permission, captures: 0, permissionReads: 0, displayReads: 0,
    windows: [], requests: [], messages: [], load, capture, shortcuts: new Map(), handlers: new Map(),
    nativePermissionRequests: 0,
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.destroyed = false
      this.visible = false
      this.focused = 0
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = (callback) => { this.openHandler = callback }
      this.webContents.send = (...args) => { this.sent = args }
      state.windows.push(this)
    }
    static fromWebContents(contents) { return state.windows.find((item) => item.webContents === contents) }
    isDestroyed() { return this.destroyed }
    async loadFile(file, options) { this.loaded = { file, options }; await state.load?.() }
    show() { this.visible = true }
    focus() { this.focused += 1 }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    close() { this.destroy() }
  }
  const main = { isDestroyed: () => false, webContents: { send: (...args) => state.messages.push(args) } }
  const service = new GlobalScreenshotService({
    app: { getPath: () => path.join(os.tmpdir(), `zsense-shot-fixture-absent-${process.pid}`) },
    getMainWindow: () => main,
    platform,
    runtime: {
      BrowserWindow: FakeWindow,
      systemPreferences: { getMediaAccessStatus: (kind) => { assert.equal(kind, 'screen'); state.permissionReads += 1; if (throwPermission) throw new Error('permission status unavailable'); return state.permission } },
      requestScreenCapturePermission: () => { state.nativePermissionRequests += 1; return requestPermission?.(state) ?? false },
      desktopCapturer: { getSources: async (request) => { state.captures += 1; state.requests.push(request); return state.capture ? await state.capture() : [source] } },
      screen: {
        getCursorScreenPoint: () => ({ x: -900, y: 40 }),
        getDisplayNearestPoint: () => { state.displayReads += 1; return display },
        getAllDisplays: () => [display],
      },
      globalShortcut: {
        register: (key, callback) => { state.shortcuts.set(key, callback); return true },
        unregister: (key) => state.shortcuts.delete(key),
      },
      ipcMain: {
        handle: (channel, callback) => state.handlers.set(channel, callback),
        removeHandler: (channel) => state.handlers.delete(channel),
      },
    },
  })
  return { service, state, main }
}

let checks = 0
try {
  for (const permission of ['denied', 'restricted', 'unknown', 'unexpected-status']) {
    const { service, state } = fixture({ permission })
    assert.equal(service.status().screenCapturePermission, permission === 'unexpected-status' ? 'unknown' : permission)
    assert.equal(state.captures, 0, 'reading diagnostic status never requests consent')
    assert.equal(state.nativePermissionRequests, 0)
    await assert.rejects(service.start(), /权限|无法确认/)
    await assert.rejects(service.start(), /权限|无法确认/)
    assert.equal(state.captures, 0, `${permission} must never invoke screen capture`)
    assert.equal(state.displayReads, 0)
    assert.equal(state.windows.length, 0)
    assert.equal(state.messages.length, 2, 'each explicit failed action receives app feedback')
    service.dispose()
    checks += 1
  }

  {
    const { service, state } = fixture()
    await service.start()
    assert.equal(state.captures, 1)
    assert.deepEqual(state.requests[0], { types: ['screen'], thumbnailSize: { width: 2400, height: 1600 }, fetchWindowIcons: false })
    assert.deepEqual(state.windows[0].options.x, -1200, 'negative multi-display coordinates are preserved')
    assert.equal(state.windows[0].visible, true)
    assert.equal(state.windows[0].sent[1].mode, 'select')
    await service.start()
    assert.equal(state.captures, 1, 'an existing screenshot window is focused, not recaptured')
    assert.equal(state.windows[0].focused, 2)
    assert.equal(service.status().screenCaptureNeedsRestart, false)
    service.dispose()
    checks += 1
  }

  for (const grantedAfterRequest of [true, false]) {
    const gate = deferred()
    const { service, state } = fixture({ permission: 'not-determined', capture: () => gate.promise })
    service.initialize()
    assert.equal(state.captures, 0, 'initialization does not request screen consent')
    assert.equal(state.nativePermissionRequests, 0)
    const pending = service.start()
    const concurrent = service.start()
    assert.strictEqual(pending, concurrent, 'concurrent requests share the identical in-flight promise')
    assert.equal(state.captures, 1)
    assert.equal(service.status().captureInProgress, true)
    if (grantedAfterRequest) state.permission = 'granted'
    gate.resolve([source])
    if (grantedAfterRequest) {
      await pending
      assert.equal(state.windows.length, 1)
    } else {
      await assert.rejects(pending, /尚未获得/)
      assert.equal(state.windows.length, 0, 'never display data while permission remains ungranted')
      await assert.rejects(service.start(), /尚未获得/)
      assert.equal(state.captures, 1, 'initial consent is requested at most once per service lifetime')
      service.recheckPermissions()
      await assert.rejects(service.start(), /尚未获得/)
      assert.equal(state.captures, 1, 'recheck must not reset the initial-consent limit')
      state.permission = 'denied'
      await assert.rejects(service.start(), /尚未获得/)
      state.permission = 'not-determined'
      await assert.rejects(service.start(), /尚未获得/)
      assert.equal(state.captures, 1)
    }
    assert.equal(service.status().captureInProgress, false)
    assert.equal(state.nativePermissionRequests, 0, 'start does not invoke the native permission API')
    assert.equal(service.status().screenCaptureRequestAttempted, true)
    service.dispose()
    checks += 1
  }

  for (const failure of ['throw', 'empty', 'missing']) {
    const { service, state } = fixture({ capture: async () => {
      if (failure === 'throw') throw new Error('capture subsystem unavailable')
      if (failure === 'empty') return [{ ...source, thumbnail: { isEmpty: () => true } }]
      return []
    } })
    await assert.rejects(service.start(), /可能是权限尚未生效或系统录屏服务异常/)
    assert.equal(service.status().screenCaptureNeedsRestart, true)
    for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(service.start(), /已暂停重试/)
    assert.equal(state.captures, 1, 'stale-granted failures do not repeatedly enter the system capture API')
    assert.equal(state.windows.length, 0)
    state.capture = () => [source]
    const before = state.captures
    const status = service.recheckPermissions()
    assert.equal(state.captures, before, 'explicit recheck itself never captures')
    assert.equal(status.screenCaptureNeedsRestart, false)
    assert.equal(status.error, '')
    await service.start()
    assert.equal(state.captures, 2, 'the user can explicitly retry after fixing authorization')
    service.dispose()
    checks += 1
  }

  {
    const { service, state } = fixture({ capture: () => { state.permission = 'denied'; return [source] } })
    await assert.rejects(service.start(), /尚未获得/)
    assert.equal(state.windows.length, 0, 'revocation during capture must discard the image')
    assert.equal(service.sourceImage, null)
    assert.equal(service.status().screenCaptureNeedsRestart, false)
    service.dispose()
    checks += 1
  }

  {
    const { service, state } = fixture({ capture: () => { throw new Error('temporary capture failure') } })
    await assert.rejects(service.start(), /已暂停重试/)
    state.permission = 'denied'
    assert.equal(service.status().screenCaptureNeedsRestart, false)
    state.permission = 'granted'
    state.capture = () => [source]
    await service.start()
    assert.equal(state.captures, 2, 'a newly observed authorization state also allows retry')
    service.dispose()
    checks += 1
  }

  {
    const gate = deferred()
    const { service, state } = fixture({ capture: () => gate.promise })
    service.initialize()
    const pending = service.start()
    const parallel = service.start()
    state.shortcuts.get(service.shortcut)()
    assert.strictEqual(pending, parallel)
    gate.reject(new Error('capture failed'))
    await assert.rejects(pending, /已暂停重试/)
    assert.equal(state.captures, 1)
    assert.equal(state.messages.length, 1, 'single flight reports one failure despite shortcut/IPC-style concurrent callers')
    service.dispose()
    checks += 1
  }

  {
    let fail = true
    const { service, state } = fixture({ load: () => { if (fail) throw new Error('missing HTML') } })
    await assert.rejects(service.start(), /missing HTML/)
    assert.equal(service.status().screenCaptureNeedsRestart, false, 'renderer load failure is not classified as screen permission failure')
    fail = false
    await service.start()
    assert.equal(state.captures, 2)
    assert.equal(state.windows[1].visible, true)
    service.dispose()
    checks += 1
  }

  for (const phase of ['capture', 'load']) {
    const gate = deferred()
    const { service, state } = fixture({
      ...(phase === 'capture' ? { capture: () => gate.promise } : { load: () => gate.promise }),
    })
    const pending = service.start()
    if (phase === 'load') await Promise.resolve()
    service.dispose()
    gate.resolve(phase === 'capture' ? [source] : undefined)
    await pending
    assert.ok(state.windows.every((window) => window.destroyed && !window.visible), 'a disposed service cannot open a late-returning capture window')
    assert.equal(service.selectionWindow, null)
    await assert.rejects(service.start(), /已关闭/)
    checks += 1
  }

  for (const platform of ['win32', 'linux']) {
    const { service, state } = fixture({ platform, permission: 'denied' })
    await service.start()
    assert.equal(state.captures, 1)
    assert.equal(state.permissionReads, 0, 'macOS TCC must not gate other platforms')
    assert.equal(service.status().screenCapturePermission, 'granted')
    service.dispose()
    checks += 1
  }

  for (const permission of ['not-determined', 'denied']) {
    const { service, state } = fixture({ permission })
    service.initialize()
    service.status()
    service.recheckPermissions()
    assert.equal(state.nativePermissionRequests, 0, 'initialization, status and recheck never invoke native consent')
    const result = service.requestPermissions()
    assert.equal(result.screenCapturePermission, permission)
    assert.equal(result.screenCaptureRequestAttempted, true)
    assert.equal(state.nativePermissionRequests, 1)
    assert.equal(state.captures, 0, 'explicit native consent never requests an image')
    service.requestPermissions()
    service.recheckPermissions()
    service.requestPermissions()
    assert.equal(state.nativePermissionRequests, 1, 'system consent is requested at most once per app run')
    await assert.rejects(service.start(), /尚未获得/)
    assert.equal(state.captures, 0, 'native consent and initial screenshot share the same ungranted-attempt latch')
    service.dispose()
    checks += 1
  }

  {
    const { service, state } = fixture({ permission: 'not-determined', requestPermission: (next) => { next.permission = 'granted'; return true } })
    assert.equal(service.requestPermissions().screenCapturePermission, 'granted')
    assert.equal(state.captures, 0)
    await service.start()
    assert.equal(state.captures, 1, 'capture is available after the system reports a newly granted request')
    assert.equal(state.nativePermissionRequests, 1)
    service.dispose()
    checks += 1
  }

  for (const permission of ['granted', 'restricted', 'unknown', 'unexpected-status']) {
    const { service, state } = fixture({ permission })
    if (permission === 'granted') assert.equal(service.requestPermissions().screenCapturePermission, 'granted')
    else assert.throws(() => service.requestPermissions(), /权限|无法确认/)
    assert.equal(state.nativePermissionRequests, 0, 'already granted, restricted, or unknown status must not enter native permission code')
    assert.equal(state.captures, 0)
    assert.equal(service.status().screenCaptureRequestAttempted, false)
    service.dispose()
    checks += 1
  }

  for (const platform of ['win32', 'linux']) {
    const { service, state } = fixture({ platform, permission: 'denied' })
    assert.equal(service.requestPermissions().screenCapturePermission, 'granted')
    assert.equal(state.nativePermissionRequests, 0)
    assert.equal(state.permissionReads, 0)
    assert.equal(state.captures, 0)
    service.dispose()
    checks += 1
  }

  {
    const { service, state } = fixture({ permission: 'denied', requestPermission: () => { throw new Error('native permission component missing') } })
    assert.throws(() => service.requestPermissions(), /component missing/)
    assert.equal(state.captures, 0, 'missing native module has no screen-capture fallback')
    assert.equal(state.nativePermissionRequests, 1)
    const again = service.requestPermissions()
    assert.equal(again.screenCaptureRequestAttempted, true)
    assert.match(again.error, /component missing/)
    assert.equal(state.nativePermissionRequests, 1, 'loading/request failure consumes the explicit attempt')
    assert.equal(state.messages.length, 1)
    service.dispose()
    assert.throws(() => service.requestPermissions(), /已关闭/)
    assert.equal(state.nativePermissionRequests, 1)
    checks += 1
  }

  {
    const { service, state, main } = fixture({ permission: 'denied' })
    service.initialize()
    const request = state.handlers.get('zsense:global-screenshot:request-permissions')
    assert.throws(() => request({ sender: {} }), /只有本机/)
    assert.equal(state.nativePermissionRequests, 0, 'untrusted windows cannot request OS permission')
    assert.equal(service.status().screenCaptureRequestAttempted, false)
    const result = request({ sender: main.webContents })
    assert.equal(result.screenCaptureRequestAttempted, true)
    assert.equal(state.nativePermissionRequests, 1)
    assert.equal(state.captures, 0)
    service.dispose()
    assert.equal(state.handlers.has('zsense:global-screenshot:request-permissions'), false)
    checks += 1
  }

  {
    const { service, state } = fixture({ throwPermission: true })
    assert.throws(() => service.requestPermissions(), /无法确认/)
    assert.equal(state.nativePermissionRequests, 0)
    assert.equal(state.captures, 0)
    service.dispose()
    checks += 1
  }

  {
    const { service, state, main } = fixture()
    service.initialize()
    const recheck = state.handlers.get('zsense:global-screenshot:recheck-permissions')
    assert.throws(() => recheck({ sender: {} }), /只有本机/)
    assert.equal(recheck({ sender: main.webContents }).screenCapturePermission, 'granted')
    assert.equal(state.captures, 0, 'permission recheck IPC only reads state')
    service.dispose()
    assert.equal(state.handlers.has('zsense:global-screenshot:recheck-permissions'), false)
    checks += 1
  }

  for (const platform of ['win32', 'linux']) {
    const { service, state } = fixture({ platform, capture: () => { throw new Error('transient non-mac capture failure') } })
    await assert.rejects(service.start(), /transient non-mac/)
    await assert.rejects(service.start(), /transient non-mac/)
    assert.equal(state.captures, 2, 'macOS stale authorization latch does not affect other platforms')
    assert.equal(service.status().screenCaptureNeedsRestart, false)
    assert.equal(state.permissionReads, 0)
    service.dispose()
    checks += 1
  }

  console.log(JSON.stringify({ ok: true, checks, mockedScreenCapture: true, noSystemPermissionChanges: true }))
} finally { app.quit() }
