// ZSense 局域网 Web 桥接客户端：让浏览器里的界面以为自己在桌面窗口里。
// - window.zsenseDesktop 用 Proxy 动态生成，方法调用转成 POST /bridge/invoke；
// - 事件用 SSE 接收，按清单里的“订阅路径 → 通道”映射分发给页面回调；
// - 未登录时先显示访问口令输入层，登录成功后重新加载页面。
(() => {
  if (window.zsenseDesktop) return
  document.documentElement.classList.add('zsense-web-bridge')
  const state = {
    authenticated: false,
    manifest: null,
    manifestPromise: null,
    listeners: new Map(),
    channelByPath: new Map(),
    source: null,
  }

  const loadManifest = () => {
    if (state.manifestPromise) return state.manifestPromise
    state.manifestPromise = fetch('/bridge/manifest', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!payload?.ok) return null
        state.manifest = payload.data
        for (const entry of payload.data.eventPaths || []) state.channelByPath.set(entry.path, entry.channel)
        return payload.data
      })
      .catch(() => null)
    return state.manifestPromise
  }

  const startEvents = () => {
    if (state.source) return
    const source = new EventSource('/bridge/events', { withCredentials: true })
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data)
        const listeners = state.listeners.get(parsed.channel)
        if (!listeners) return
        for (const listener of [...listeners]) {
          try { listener(parsed.payload) } catch { /* 页面回调异常不影响其他监听 */ }
        }
      } catch { /* 忽略非法事件 */ }
    }
    state.source = source
  }

  const callPath = async (pathText, args) => {
    const response = await fetch('/bridge/invoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pathText, args }),
    })
    if (response.status === 401) { showLogin('登录已过期，请重新输入安全锁密码。'); throw new Error('需要先输入安全锁密码。') }
    return response.json()
  }

  const subscribePath = (pathText, callback) => {
    if (typeof callback !== 'function') return () => undefined
    const key = `pending:${pathText}`
    const listeners = state.listeners.get(key) || new Set()
    listeners.add(callback)
    state.listeners.set(key, listeners)
    loadManifest().then(() => {
      const channel = state.channelByPath.get(pathText)
      if (!channel) return
      const pending = state.listeners.get(key)
      state.listeners.delete(key)
      const target = state.listeners.get(channel) || new Set()
      if (pending) for (const listener of pending) target.add(listener)
      state.listeners.set(channel, target)
      startEvents()
    })
    return () => {
      for (const set of state.listeners.values()) set.delete(callback)
    }
  }

  const specials = {
    isDesktop: true,
    platform: 'web',
    transport: 'web-bridge',
    versions: { electron: 'web-bridge', app: '' },
    appVersion: '',
  }

  const makeNode = (segments) => {
    const pathText = segments.join('.')
    const node = (...args) => {
      // 事件订阅：桌面端的订阅方法第一个参数永远是回调函数（调用参数都是 JSON 可序列化的），
      // 因此不必等清单加载完就能区分订阅与普通调用。
      if (typeof args[0] === 'function') return subscribePath(pathText, args[0])
      const manifest = state.manifest
      const isEventPath = Boolean(manifest && (manifest.eventPaths || []).some((entry) => entry.path === pathText))
      if (isEventPath) return subscribePath(pathText, args[0])
      return callPath(pathText, args)
    }
    return new Proxy(node, {
      get(target, property) {
        if (typeof property !== 'string') return target[property]
        if (segments.length <= 1 && property in specials) return specials[property]
        // 注意：不能占用真实接口名（例如 runtime.inspect / deviceLink.inspect），
        // 调试用的路径查询放在 __zsensePath 上。
        if (property === 'then') return undefined
        if (property === '__zsensePath') return () => pathText
        return makeNode([...segments, property])
      },
      has() { return true },
    })
  }

  window.zsenseDesktop = makeNode([])

  // 未登录时的访问口令输入层（独立于应用本身，避免应用在半可用状态下启动）
  let loginLayer = null
  function showLogin(hint) {
    if (loginLayer) {
      const message = loginLayer.querySelector('[data-role="hint"]')
      if (hint && message) message.textContent = hint
      return
    }
    loginLayer = document.createElement('div')
    loginLayer.setAttribute('data-zsense-web-login', '1')
    loginLayer.innerHTML = `
      <div class="zsense-web-login-card">
        <strong>ZSense 局域网访问</strong>
        <p data-role="hint">${hint || '已开启安全锁时输入安全锁密码；未开启时输入桌面端设备互联面板显示的访问口令。'}</p>
        <input type="password" placeholder="安全锁密码" aria-label="安全锁密码" />
        <button type="button">进入 ZSense</button>
      </div>`
    const style = document.createElement('style')
    style.textContent = `
      [data-zsense-web-login] { position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center; background: linear-gradient(160deg, #0f172a, #1e293b); font-family: -apple-system, "PingFang SC", system-ui, sans-serif; }
      .zsense-web-login-card { width: min(360px, 88vw); padding: 26px 24px; border-radius: 16px; background: #fff; box-shadow: 0 20px 60px rgba(2, 6, 23, .45); display: grid; gap: 12px; text-align: center; }
      .zsense-web-login-card strong { font-size: 16px; color: #0f172a; }
      .zsense-web-login-card p { margin: 0; color: #64748b; font-size: 12px; line-height: 1.6; }
      .zsense-web-login-card input { min-height: 44px; padding: 0 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 16px; text-align: center; letter-spacing: .3em; }
      .zsense-web-login-card button { min-height: 44px; border: 0; border-radius: 10px; background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
      .zsense-web-login-card button[disabled] { opacity: .6; cursor: default; }
    `
    document.head.appendChild(style)
    document.body.appendChild(loginLayer)
    const input = loginLayer.querySelector('input')
    const button = loginLayer.querySelector('button')
    const submit = async () => {
      const password = (input.value || '').trim()
      if (!password) { loginLayer.querySelector('[data-role="hint"]').textContent = '请输入安全锁密码，或桌面端显示的访问口令。'; return }
      button.disabled = true
      try {
        const response = await fetch('/bridge/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        })
        const payload = await response.json().catch(() => null)
        if (payload?.ok) { window.location.reload(); return }
        loginLayer.querySelector('[data-role="hint"]').textContent = payload?.error || '安全锁密码不正确，请重试。'
      } catch {
        loginLayer.querySelector('[data-role="hint"]').textContent = '无法连接 ZSense，请确认桌面端仍在运行。'
      } finally {
        button.disabled = false
      }
    }
    button.addEventListener('click', () => void submit())
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') void submit() })
    input.focus()
  }

  window.__zsenseWebBridge = {
    logout: async () => { await fetch('/bridge/logout', { method: 'POST', credentials: 'same-origin' }); window.location.reload() },
  }

  // 先确认登录状态：未登录就先要口令；已登录则直接加载界面
  fetch('/bridge/session', { credentials: 'same-origin' })
    .then((response) => response.json())
    .then((payload) => {
      if (payload?.ok && payload.data?.authenticated) {
        state.authenticated = true
        loadManifest()
        startEvents()
        return
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => showLogin())
      else showLogin()
    })
    .catch(() => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => showLogin('无法连接 ZSense 桌面端。')) })
})()
