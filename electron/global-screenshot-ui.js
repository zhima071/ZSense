const mode = new URLSearchParams(location.search).get('mode') || 'select'
document.body.dataset.mode = mode
const api = window.zsenseShot
const close = () => { void api.close() }
const point = (event, element) => {
  const bounds = element.getBoundingClientRect()
  return { x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)) }
}

if (mode === 'select') {
  const view = document.getElementById('select-view')
  const selection = document.getElementById('selection')
  const dim = document.getElementById('select-dim')
  let origin = null
  let selecting = false
  let submitting = false
  document.getElementById('select-close').addEventListener('click', close)
  api.onInit((payload) => { document.getElementById('select-image').src = payload.image })
  view.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('#select-hint') || submitting) return
    origin = point(event, view)
    selecting = true
    view.setPointerCapture(event.pointerId)
    selection.style.display = 'block'
    dim.classList.add('dragging')
  })
  view.addEventListener('pointermove', (event) => {
    if (!selecting || !origin) return
    const current = point(event, view)
    selection.style.left = `${Math.min(origin.x, current.x)}px`
    selection.style.top = `${Math.min(origin.y, current.y)}px`
    selection.style.width = `${Math.abs(origin.x - current.x)}px`
    selection.style.height = `${Math.abs(origin.y - current.y)}px`
  })
  view.addEventListener('pointerup', async (event) => {
    if (!selecting || !origin) return
    selecting = false
    const current = point(event, view)
    const rectangle = {
      x: Math.round(Math.min(origin.x, current.x)), y: Math.round(Math.min(origin.y, current.y)),
      width: Math.round(Math.abs(origin.x - current.x)), height: Math.round(Math.abs(origin.y - current.y)),
    }
    origin = null
    if (rectangle.width < 8 || rectangle.height < 8) {
      selection.style.display = 'none'
      dim.classList.remove('dragging')
      return
    }
    submitting = true
    try { await api.select(rectangle) }
    catch (error) {
      submitting = false
      selection.style.display = 'none'
      dim.classList.remove('dragging')
      document.querySelector('#select-hint strong').textContent = String(error?.message || '截图失败，请重新选择')
    }
  })
}

if (mode === 'edit') {
  const canvas = document.getElementById('editor-canvas')
  const context = canvas.getContext('2d', { alpha: false })
  const stage = document.getElementById('editor-stage')
  const status = document.getElementById('editor-status')
  const labelWrap = document.getElementById('label-wrap')
  const labelText = document.getElementById('label-text')
  const image = new Image()
  const operations = []
  const redoStack = []
  let current = null
  let tool = 'pen'
  let color = '#dc2626'
  let busy = false
  let imageReady = false
  function showStatus(message, error = false) { status.textContent = message; status.classList.toggle('error', error) }
  function fitCanvas() {
    if (!imageReady) return
    const fit = Math.min(1, (stage.clientWidth - 36) / canvas.width, (stage.clientHeight - 36) / canvas.height)
    canvas.style.width = `${Math.max(1, Math.round(canvas.width * fit))}px`
    canvas.style.height = `${Math.max(1, Math.round(canvas.height * fit))}px`
  }
  function imagePoint(event) {
    const p = point(event, canvas)
    const bounds = canvas.getBoundingClientRect()
    return { x: p.x * canvas.width / bounds.width, y: p.y * canvas.height / bounds.height }
  }
  function stroke(ctx, operation) {
    ctx.save()
    ctx.strokeStyle = operation.color
    ctx.fillStyle = operation.color
    ctx.lineWidth = operation.width || 4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (operation.type === 'pen') {
      if (operation.points.length < 2) { ctx.restore(); return }
      ctx.beginPath()
      ctx.moveTo(operation.points[0].x, operation.points[0].y)
      for (const p of operation.points.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.stroke()
    } else if (operation.type === 'ellipse') {
      const cx = (operation.from.x + operation.to.x) / 2
      const cy = (operation.from.y + operation.to.y) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, Math.max(1, Math.abs(operation.to.x - operation.from.x) / 2), Math.max(1, Math.abs(operation.to.y - operation.from.y) / 2), 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (operation.type === 'rectangle') {
      ctx.strokeRect(operation.from.x, operation.from.y, operation.to.x - operation.from.x, operation.to.y - operation.from.y)
    } else if (operation.type === 'arrow') {
      const { from, to } = operation
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      const head = Math.max(14, ctx.lineWidth * 4)
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(to.x, to.y)
      ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
      ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
      ctx.closePath(); ctx.fill()
    } else if (operation.type === 'text') {
      const fontSize = Math.max(18, Math.min(36, canvas.width / 45))
      ctx.font = `700 ${fontSize}px Inter, sans-serif`
      ctx.lineWidth = 4
      ctx.strokeStyle = '#ffffff'
      ctx.strokeText(operation.text, operation.at.x, operation.at.y)
      ctx.fillText(operation.text, operation.at.x, operation.at.y)
    }
    ctx.restore()
  }
  function render() {
    if (!imageReady) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    operations.forEach((operation) => stroke(context, operation))
    if (current) stroke(context, current)
  }
  function commit(operation) { operations.push(operation); redoStack.length = 0; render(); showStatus(`${operations.length} 个批注 · ✅ 复制最终图片`) }
  api.onInit((payload) => {
    image.onload = () => {
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      imageReady = true
      fitCanvas()
      render()
    }
    image.onerror = () => showStatus('截图内容无法读取，请退出后重试。', true)
    image.src = payload.image
  })
  window.addEventListener('resize', fitCanvas)
  document.getElementById('editor-close').addEventListener('click', close)
  document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => {
    tool = button.dataset.tool
    canvas.dataset.tool = tool
    document.querySelectorAll('[data-tool]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)))
    labelWrap.classList.toggle('visible', tool === 'text')
    if (tool === 'text') labelText.focus()
  }))
  document.querySelectorAll('[data-color]').forEach((button) => button.addEventListener('click', () => {
    color = button.dataset.color
    document.querySelectorAll('[data-color]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)))
  }))
  function undo() { if (operations.length) { redoStack.push(operations.pop()); render(); showStatus(`${operations.length} 个批注`) } }
  function redo() { if (redoStack.length) { operations.push(redoStack.pop()); render(); showStatus(`${operations.length} 个批注`) } }
  document.getElementById('undo').addEventListener('click', undo)
  document.getElementById('redo').addEventListener('click', redo)
  canvas.addEventListener('pointerdown', (event) => {
    if (!imageReady || event.button !== 0) return
    const at = imagePoint(event)
    if (tool === 'text') {
      const text = labelText.value.trim()
      if (!text) { showStatus('先输入标注文字，再点击图片放置。', true); labelText.focus(); return }
      commit({ type: 'text', color, at, text })
      return
    }
    current = tool === 'pen' ? { type: 'pen', color, width: 4, points: [at] } : { type: tool, color, width: 4, from: at, to: at }
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!current) return
    const at = imagePoint(event)
    if (current.type === 'pen') current.points.push(at)
    else current.to = at
    requestAnimationFrame(render)
  })
  function finish(event) {
    if (!current) return
    const at = imagePoint(event)
    if (current.type === 'pen') current.points.push(at)
    else current.to = at
    const operation = current
    current = null
    const moved = operation.type === 'pen' ? operation.points.length > 2 : Math.hypot(operation.to.x - operation.from.x, operation.to.y - operation.from.y) > 3
    if (moved) commit(operation)
    else render()
  }
  canvas.addEventListener('pointerup', finish)
  canvas.addEventListener('pointercancel', finish)
  async function output(action) {
    if (busy || !imageReady) return
    busy = true
    document.querySelectorAll('.editor-footer button').forEach((button) => { button.disabled = true })
    try {
      render()
      const result = await api.output(action, canvas.toDataURL('image/png'))
      if (result?.saved) showStatus(`已下载到 ${result.path}`)
      else if (result?.canceled) showStatus('已取消下载，截图仍可继续编辑。')
    } catch (error) { showStatus(String(error?.message || '操作失败，请重试。'), true) }
    finally {
      busy = false
      document.querySelectorAll('.editor-footer button').forEach((button) => { button.disabled = false })
    }
  }
  document.getElementById('download').addEventListener('click', () => { void output('download') })
  document.getElementById('pin').addEventListener('click', () => { void output('pin') })
  document.getElementById('copy').addEventListener('click', () => { void output('copy') })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); return }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
  })
}

if (mode === 'pin') {
  api.onInit((payload) => { document.getElementById('pin-image').src = payload.image })
  document.getElementById('pin-close').addEventListener('click', close)
}

if (mode !== 'edit') document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close() })
