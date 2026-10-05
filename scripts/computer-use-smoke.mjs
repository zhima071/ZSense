import assert from 'node:assert/strict'
import { app } from 'electron'
import { ComputerUseService } from '../electron/services/computer-use-service.mjs'

await app.whenReady()
const service = new ComputerUseService({ dryRun: true })
try {
  const status = service.inspect(false)
  assert.equal(status.enabled, false)
  if (status.supported) {
    const screenInfo = service.screenInfo()
    assert(screenInfo.displays.length > 0)
    const primary = screenInfo.displays.find((item) => item.primary) || screenInfo.displays[0]
    const x = primary.bounds.x + Math.min(2, Math.max(0, primary.bounds.width - 1))
    const y = primary.bounds.y + Math.min(2, Math.max(0, primary.bounds.height - 1))
    const screenshot = await service.screenshot(primary.id)
    assert.match(screenshot.__zsenseImage?.url || '', /^data:image\/png;base64,/)
    assert.equal((await service.click(x, y)).dryRun, true)
    assert.equal((await service.scroll('down', 120)).dryRun, true)
    assert.equal((await service.key('CTRL+A')).dryRun, true)
    assert.equal((await service.type('ZSense dry run')).dryRun, true)
  }
  console.log(JSON.stringify({ ok: true, defaultOff: true, supported: status.supported, dryRun: true, screenshotTransient: status.supported }))
} finally {
  service.shutdown()
  app.quit()
}
