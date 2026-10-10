import assert from 'node:assert/strict'
import { app } from 'electron'
import { ComputerUseService } from '../electron/services/computer-use-service.mjs'

// Permission/capture/input APIs are all mocks. No user screen is captured, no
// consent dialog is requested, and no system privacy setting is modified.
const display = {
  id: 1, bounds: { x: -1200, y: 0, width: 1200, height: 800 },
  size: { width: 1200, height: 800 }, scaleFactor: 2, rotation: 0,
}
const source = {
  display_id: '1',
  thumbnail: {
    isEmpty: () => false, getSize: () => ({ width: 2048, height: 1365 }),
    toDataURL: () => 'data:image/png;base64,mocked',
  },
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ platform = 'darwin', permission = 'granted', capture, dryRun = false, throwPermission = false } = {}) {
  const state = { permission, captures: 0, reads: 0, screenReads: 0, accessibilityRequests: 0, capture, requests: [] }
  const service = new ComputerUseService({
    platform, dryRun,
    runtime: {
      systemPreferences: {
        getMediaAccessStatus: (kind) => { assert.equal(kind, 'screen'); state.reads += 1; if (throwPermission) throw new Error('status unavailable'); return state.permission },
        isTrustedAccessibilityClient: (prompt) => { if (prompt) state.accessibilityRequests += 1; return true },
      },
      desktopCapturer: { getSources: async (request) => { state.captures += 1; state.requests.push(request); return state.capture ? await state.capture() : [source] } },
      screen: {
        getAllDisplays: () => { state.screenReads += 1; return [display] },
        getPrimaryDisplay: () => display,
        getCursorScreenPoint: () => ({ x: -900, y: 40 }),
        getDisplayNearestPoint: () => display,
      },
    },
  })
  return { service, state }
}

let checks = 0
try {
  for (const permission of ['not-determined', 'denied', 'restricted', 'unknown', 'unexpected-status']) {
    const { service, state } = fixture({ permission })
    await assert.rejects(service.screenshot(), /未读取屏幕/)
    await assert.rejects(service.screenshot(), /未读取屏幕/)
    assert.equal(state.captures, 0, `model screenshot never requests consent for ${permission}`)
    assert.equal(state.screenReads, 0)
    checks += 1
  }

  for (const permission of ['denied', 'restricted', 'unknown', 'granted']) {
    const { service, state } = fixture({ permission })
    const status = await service.requestPermissions(true)
    await service.requestPermissions(true)
    assert.equal(status.enabled, true)
    assert.equal(state.captures, 0, `explicit checks never repeat screen consent for ${permission}`)
    assert.equal(state.accessibilityRequests, 2, 'existing explicit accessibility request behavior is preserved')
    checks += 1
  }

  {
    const { service, state } = fixture({ throwPermission: true })
    assert.equal(service.inspect().screenCapturePermission, 'unknown')
    await assert.rejects(service.screenshot(), /未读取屏幕/)
    await service.requestPermissions()
    assert.equal(state.captures, 0, 'a permission API error fails closed')
    checks += 1
  }

  {
    const gate = deferred()
    const { service, state } = fixture({ permission: 'not-determined', capture: () => gate.promise })
    const first = service.requestPermissions(true)
    const second = service.requestPermissions(true)
    assert.equal(state.captures, 1, 'simultaneous explicit requests trigger consent only once')
    assert.deepEqual(state.requests[0], { types: ['screen'], thumbnailSize: { width: 2, height: 2 } })
    state.permission = 'granted'
    gate.resolve([source])
    assert.equal((await first).screenCapturePermission, 'granted')
    await second
    state.capture = () => [source]
    const result = await service.screenshot('1')
    assert.equal(result.displayId, '1')
    assert.equal(result.bounds.x, -1200)
    assert.equal(result.imageSize.width, 2048)
    assert.match(result.__zsenseImage.url, /^data:image\/png/)
    assert.equal(state.captures, 2, 'authorized model capture still works')
    assert.deepEqual(state.requests[1], { types: ['screen'], thumbnailSize: { width: 2048, height: 1365 }, fetchWindowIcons: false })
    checks += 1
  }

  {
    const { service, state } = fixture({ permission: 'not-determined', capture: () => { throw new Error('consent pending') } })
    await service.requestPermissions()
    await service.requestPermissions()
    assert.equal(state.captures, 1, 'a failed first consent request is not silently repeated')
    await assert.rejects(service.screenshot(), /未读取屏幕/)
    assert.equal(state.captures, 1)
    checks += 1
  }

  for (const failure of ['throw', 'empty', 'missing']) {
    const { service, state } = fixture({ capture: () => {
      if (failure === 'throw') throw new Error('system screen service unavailable')
      if (failure === 'empty') return [{ ...source, thumbnail: { isEmpty: () => true } }]
      return []
    } })
    await assert.rejects(service.screenshot(), /可能是权限尚未生效或系统录屏服务异常/)
    for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(service.screenshot(), /暂停自动重试/)
    assert.equal(state.captures, 1, 'model retries cannot repeatedly prompt for stale granted identity')
    assert.equal(service.inspect().screenCaptureNeedsRestart, true)
    const before = state.captures
    assert.equal((await service.requestPermissions()).screenCaptureNeedsRestart, false)
    assert.equal(state.captures, before, 'user-initiated granted recheck clears the latch without capturing')
    state.capture = () => [source]
    await service.screenshot()
    assert.equal(state.captures, 2)
    checks += 1
  }

  {
    const { service, state } = fixture({ capture: () => { throw new Error('capture failed') } })
    await assert.rejects(service.screenshot(), /暂停自动重试/)
    state.permission = 'denied'
    assert.equal(service.inspect().screenCaptureNeedsRestart, false)
    state.permission = 'granted'
    state.capture = () => [source]
    await service.screenshot()
    assert.equal(state.captures, 2, 'observed authorization transitions clear the failure latch')
    checks += 1
  }

  {
    const { service, state } = fixture({ capture: () => { state.permission = 'denied'; return [source] } })
    await assert.rejects(service.screenshot(), /未读取屏幕/)
    assert.equal(service.inspect().screenCaptureNeedsRestart, false, 'revoked captures are not returned to the model')
    checks += 1
  }

  {
    const { service, state } = fixture({ dryRun: true, permission: 'denied' })
    const result = await service.screenshot()
    assert.match(result.summary, /Dry-run/)
    assert.match(result.__zsenseImage.url, /^data:image\/png/)
    await service.requestPermissions()
    assert.equal(state.captures, 0)
    assert.equal(state.accessibilityRequests, 0, 'dry-run does not request system consent')
    assert.equal((await service.click(-900, 40)).dryRun, true)
    assert.equal((await service.scroll('down', 120)).dryRun, true)
    assert.equal((await service.key('CTRL+A')).dryRun, true)
    assert.equal((await service.type('mocked')).dryRun, true)
    checks += 1
  }

  {
    const { service, state } = fixture({ platform: 'win32', permission: 'denied' })
    assert.equal((await service.screenshot()).displayId, '1')
    await service.requestPermissions()
    assert.equal(state.reads, 0)
    assert.equal(state.accessibilityRequests, 0)
    assert.equal(state.captures, 1)
    state.capture = () => { throw new Error('Windows temporary capture failure') }
    await assert.rejects(service.screenshot(), /Windows temporary/)
    await assert.rejects(service.screenshot(), /Windows temporary/)
    assert.equal(state.captures, 3, 'Windows has no macOS failure latch')
    checks += 1
  }

  {
    const { service, state } = fixture({ platform: 'linux' })
    assert.equal(service.inspect().supported, false)
    assert.equal((await service.requestPermissions()).screenCapturePermission, 'unsupported')
    await assert.rejects(service.screenshot(), /只支持/)
    assert.equal(state.captures, 0)
    assert.equal(state.reads, 0)
    checks += 1
  }

  console.log(JSON.stringify({ ok: true, checks, mockedScreenCapture: true, noSystemPermissionChanges: true }))
} finally { app.quit() }
