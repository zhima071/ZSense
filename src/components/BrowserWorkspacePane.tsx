import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe2, LoaderCircle, MessageSquareText, RefreshCw, Scissors, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, isDesktopApp, unwrapDesktop } from '../services/desktop'
import type { ChatAttachment } from '../types'
import { ScreenshotAnnotationDialog } from './ScreenshotAnnotationDialog'

const HOME_URL = 'about:blank'
const BROWSER_PARTITION = 'persist:zsense-browser'

interface ZSenseWebviewElement extends HTMLElement {
  canGoBack: () => boolean
  canGoForward: () => boolean
  getTitle: () => string
  getURL: () => string
  getWebContentsId: () => number
  executeJavaScript: <T = unknown>(code: string) => Promise<T>
  goBack: () => void
  goForward: () => void
  loadURL: (url: string) => Promise<void>
  reload: () => void
  stop: () => void
}

interface BrowserAnnotation {
  id: number
  selector: string
  text: string
  note: string
  url: string
}

interface BrowserWorkspacePaneProps {
  sessionId: string
  visible: boolean
  requestedUrl?: string
  requestKey?: number
  showFullUrl?: boolean
  workspacePath: string
  onOpen: () => void
  onClose: () => void
  onAnnotatedScreenshot: (attachment: ChatAttachment, requirement: string, sendImmediately: boolean) => void | Promise<void>
}

function navigableUrl(value: string) {
  const input = value.trim()
  if (!input) return HOME_URL
  if (/^zsense-office:\/\//i.test(input)) return input
  if (/^https?:\/\//i.test(input)) return input
  if (/^(?:localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(input)) return `http://${input}`
  if (/^[\w-]+(?:\.[\w-]+)+(?:[/:?#].*)?$/i.test(input)) return `https://${input}`
  return `https://cn.bing.com/search?q=${encodeURIComponent(input)}`
}

export function BrowserWorkspacePane({ sessionId, visible, requestedUrl, requestKey = 0, showFullUrl = false, workspacePath, onOpen, onClose, onAnnotatedScreenshot }: BrowserWorkspacePaneProps) {
  const paneRef = useRef<HTMLElement>(null)
  const webviewRef = useRef<ZSenseWebviewElement | null>(null)
  const registeredIdRef = useRef(0)
  const annotationUrlRef = useRef(HOME_URL)
  const [address, setAddress] = useState('')
  const [addressFocused, setAddressFocused] = useState(false)
  const [currentUrl, setCurrentUrl] = useState(HOME_URL)
  const [title, setTitle] = useState('新标签页')
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [error, setError] = useState('')
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotationDraft, setAnnotationDraft] = useState<{ selector: string; text: string; note: string } | null>(null)
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([])
  const [capturing, setCapturing] = useState(false)
  const [capturedScreenshot, setCapturedScreenshot] = useState<{ dataUrl: string; name: string } | null>(null)
  const [webviewActivated, setWebviewActivated] = useState(Boolean(visible || requestedUrl))
  const shouldMountWebview = webviewActivated || visible
  const [panePercent, setPanePercent] = useState(() => {
    const stored = Number(window.localStorage.getItem('zsense.browserPaneWidthPercent'))
    return Number.isFinite(stored) && stored >= 38 && stored <= 75 ? stored : 56
  })

  // 第一次由用户打开后保持 guest 实例，切换到 Canvas/Office 再回来时保留网页和表单状态。
  // requestKey 代表一次新的 Agent/链接导航；不要把 requestedUrl 本身作为永久挂载条件，
  // 否则显式关闭后旧 URL 仍会马上把 WebView 重新创建出来。
  useEffect(() => { if (visible) setWebviewActivated(true) }, [visible])
  useEffect(() => { if (requestKey > 0) setWebviewActivated(true) }, [requestKey])
  useEffect(() => {
    if (annotationUrlRef.current === currentUrl) return
    annotationUrlRef.current = currentUrl
    setAnnotationMode(false)
    setAnnotationDraft(null)
    setAnnotations([])
  }, [currentUrl])

  useEffect(() => {
    const container = paneRef.current?.parentElement
    if (!container) return
    container.style.setProperty('--browser-pane-width', `${panePercent}%`)
    window.localStorage.setItem('zsense.browserPaneWidthPercent', String(panePercent))
    return () => { container.style.removeProperty('--browser-pane-width') }
  }, [panePercent])

  const syncNavigationState = useCallback(() => {
    const webview = webviewRef.current
    if (!webview) return
    const url = webview.getURL?.() || currentUrl
    if (url) {
      setCurrentUrl(url)
      setAddress(url === HOME_URL ? '' : url)
    }
    setTitle(url === HOME_URL ? '新标签页' : webview.getTitle?.() || '新标签页')
    setCanGoBack(Boolean(webview.canGoBack?.()))
    setCanGoForward(Boolean(webview.canGoForward?.()))
  }, [currentUrl])

  const registerVisibleBrowser = useCallback(async () => {
    const desktop = window.zsenseDesktop
    const webview = webviewRef.current
    if (!desktop?.browser || !webview?.getWebContentsId) return
    try {
      const webContentsId = webview.getWebContentsId()
      if (!webContentsId) return
      if (registeredIdRef.current && registeredIdRef.current !== webContentsId) {
        await desktop.browser.unregister(sessionId, registeredIdRef.current).catch(() => undefined)
      }
      registeredIdRef.current = webContentsId
      await unwrapDesktop(desktop.browser.register(sessionId, webContentsId))
    }
    catch (reason) { setError(`无法连接会话浏览器：${errorMessage(reason)}`) }
  }, [sessionId])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !isDesktopApp || !shouldMountWebview) return
    const start = (() => { setLoading(true); setError('') }) as EventListener
    const stop = (() => { setLoading(false); syncNavigationState() }) as EventListener
    const navigate = ((event: Event) => {
      const url = (event as Event & { url?: string }).url
      if (url) { setCurrentUrl(url); setAddress(url === HOME_URL ? '' : url) }
      syncNavigationState()
    }) as EventListener
    const updateTitle = ((event: Event) => {
      const nextTitle = (event as Event & { title?: string }).title
      if (nextTitle) setTitle(nextTitle)
    }) as EventListener
    const ready = (() => { void registerVisibleBrowser(); syncNavigationState() }) as EventListener
    const failed = ((event: Event) => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string }
      if (detail.errorCode === -3) return
      setLoading(false)
      setError(`页面加载失败：${detail.errorDescription || '无法打开该网址'}`)
      if (detail.validatedURL) setCurrentUrl(detail.validatedURL)
    }) as EventListener
    webview.addEventListener('did-start-loading', start)
    webview.addEventListener('did-stop-loading', stop)
    webview.addEventListener('did-navigate', navigate)
    webview.addEventListener('did-navigate-in-page', navigate)
    webview.addEventListener('page-title-updated', updateTitle)
    webview.addEventListener('dom-ready', ready)
    webview.addEventListener('did-fail-load', failed)
    void registerVisibleBrowser()
    return () => {
      webview.removeEventListener('did-start-loading', start)
      webview.removeEventListener('did-stop-loading', stop)
      webview.removeEventListener('did-navigate', navigate)
      webview.removeEventListener('did-navigate-in-page', navigate)
      webview.removeEventListener('page-title-updated', updateTitle)
      webview.removeEventListener('dom-ready', ready)
      webview.removeEventListener('did-fail-load', failed)
    }
  }, [registerVisibleBrowser, shouldMountWebview, syncNavigationState])

  useEffect(() => {
    const desktop = window.zsenseDesktop
    return () => {
      const webContentsId = registeredIdRef.current
      if (desktop?.browser && webContentsId) void desktop.browser.unregister(sessionId, webContentsId).catch(() => undefined)
    }
  }, [sessionId])

  useEffect(() => window.zsenseDesktop?.browser?.onActivity((event) => {
    if (event.sessionId !== sessionId) return
    if (event.action === 'close') {
      setWebviewActivated(false)
      onClose()
    } else {
      setWebviewActivated(true)
      onOpen()
    }
  }), [onClose, onOpen, sessionId])

  useEffect(() => {
    if (!visible || !window.zsenseDesktop?.browser) return
    void unwrapDesktop(window.zsenseDesktop.browser.activate(sessionId)).catch((reason) => setError(`无法重新打开会话浏览器：${errorMessage(reason)}`))
  }, [sessionId, visible])

  const open = useCallback(async (target: string) => {
    const url = navigableUrl(target)
    setAddress(url === HOME_URL ? '' : url)
    setCurrentUrl(url)
    setError('')
    setLoading(true)
    onOpen()
    try { await webviewRef.current?.loadURL(url) }
    catch (reason) { setLoading(false); setError(`页面加载失败：${errorMessage(reason)}`) }
  }, [onOpen])

  useEffect(() => {
    if (!requestedUrl) return
    void open(requestedUrl)
  }, [open, requestKey, requestedUrl])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void open(address)
  }

  const closePane = async () => {
    try {
      if (window.zsenseDesktop?.browser) await unwrapDesktop(window.zsenseDesktop.browser.close(sessionId))
    } catch (reason) {
      setError(`关闭浏览器失败：${errorMessage(reason)}`)
    } finally {
      onClose()
    }
  }

  const startAnnotation = async () => {
    const webview = webviewRef.current
    if (!webview || currentUrl === HOME_URL) return
    if (annotationMode) {
      await webview.executeJavaScript('window.__zsenseCancelAnnotation?.()').catch(() => undefined)
      setAnnotationMode(false)
      return
    }
    setAnnotationMode(true)
    setAnnotationDraft(null)
    try {
      const selected = await webview.executeJavaScript<{ selector: string; text: string } | null>(`new Promise((resolve) => {
        window.__zsenseCancelAnnotation?.();
        const style = document.createElement('style');
        style.dataset.zsenseAnnotationPicker = 'true';
        style.textContent = '[data-zsense-annotation-hover]{outline:2px solid #2563eb!important;outline-offset:2px!important;cursor:crosshair!important}';
        document.head.appendChild(style);
        let hovered = null;
        const selectorFor = (node) => {
          if (node.id) return '#' + CSS.escape(node.id);
          const parts = [];
          let current = node;
          while (current && current.nodeType === 1 && parts.length < 6) {
            let part = current.tagName.toLowerCase();
            const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName) : [];
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
            parts.unshift(part);
            current = current.parentElement;
          }
          return parts.join(' > ');
        };
        const cleanup = (value) => {
          hovered?.removeAttribute('data-zsense-annotation-hover');
          document.removeEventListener('mouseover', over, true);
          document.removeEventListener('click', click, true);
          document.removeEventListener('keydown', key, true);
          style.remove();
          delete window.__zsenseCancelAnnotation;
          resolve(value);
        };
        const over = (event) => {
          hovered?.removeAttribute('data-zsense-annotation-hover');
          hovered = event.target;
          hovered?.setAttribute('data-zsense-annotation-hover', 'true');
        };
        const click = (event) => {
          event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
          const node = event.target;
          cleanup({ selector: selectorFor(node), text: (node.innerText || node.getAttribute?.('aria-label') || node.getAttribute?.('alt') || node.tagName || '').trim().slice(0, 500) });
        };
        const key = (event) => { if (event.key === 'Escape') cleanup(null); };
        window.__zsenseCancelAnnotation = () => cleanup(null);
        document.addEventListener('mouseover', over, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', key, true);
      })`)
      if (selected) setAnnotationDraft({ ...selected, note: '' })
    } catch (reason) {
      setError(`无法进入批注模式：${errorMessage(reason)}`)
    } finally {
      setAnnotationMode(false)
    }
  }

  const saveAnnotation = async () => {
    if (!annotationDraft || !webviewRef.current) return
    const annotation: BrowserAnnotation = { id: annotations.length + 1, ...annotationDraft, url: currentUrl }
    setAnnotations((current) => [...current, annotation])
    setAnnotationDraft(null)
    await webviewRef.current.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(annotation.selector)});
      if (!node) return false;
      node.setAttribute('data-zsense-annotation-id', ${JSON.stringify(String(annotation.id))});
      node.style.outline = '2px solid #2563eb'; node.style.outlineOffset = '2px';
      node.title = ${JSON.stringify(annotation.note || `批注 ${annotation.id}`)};
      return true;
    })()`).catch(() => undefined)
  }

  const removeAnnotation = async (annotation: BrowserAnnotation) => {
    setAnnotations((current) => current.filter((item) => item !== annotation))
    await webviewRef.current?.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(annotation.selector)});
      if (!node) return; node.style.outline = ''; node.style.outlineOffset = ''; node.removeAttribute('data-zsense-annotation-id'); node.removeAttribute('title');
    })()`).catch(() => undefined)
  }

  const openExternally = async () => {
    if (!window.zsenseDesktop?.browser || currentUrl === HOME_URL) return
    try { await unwrapDesktop(window.zsenseDesktop.browser.openExternal(currentUrl)) }
    catch (reason) { setError(`无法在外部浏览器打开：${errorMessage(reason)}`) }
  }

  const captureScreenshot = async () => {
    if (!window.zsenseDesktop?.browser || currentUrl === HOME_URL || capturing) return
    setCapturing(true)
    setError('')
    try {
      const result = await unwrapDesktop(window.zsenseDesktop.browser.capture(sessionId))
      setCapturedScreenshot({ dataUrl: result.dataUrl, name: result.name || '网页截图.png' })
    } catch (reason) {
      setError(`网页截图失败：${errorMessage(reason)}`)
    } finally { setCapturing(false) }
  }

  const displayedAddress = (() => {
    if (showFullUrl || addressFocused || !address) return address
    try {
      const target = new URL(address)
      return target.hostname || address
    } catch { return address }
  })()

  const setPaneFromClientX = (clientX: number) => {
    const container = paneRef.current?.parentElement
    if (!container) return
    const bounds = container.getBoundingClientRect()
    const percent = ((bounds.right - clientX) / bounds.width) * 100
    setPanePercent(Math.round(Math.min(75, Math.max(38, percent)) * 10) / 10)
  }

  const resizeFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setPaneFromClientX(event.clientX)
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') return setPanePercent(56)
    setPanePercent((current) => Math.min(75, Math.max(38, current + (event.key === 'ArrowLeft' ? 2 : -2))))
  }

  return (
    <aside ref={paneRef} className={`browser-workspace-pane ${visible ? 'is-visible' : 'is-hidden'}`} aria-label="当前会话浏览器" aria-hidden={!visible}>
      <div
        className="browser-workspace-resize-handle"
        role="separator"
        aria-label="调整浏览器区域宽度"
        aria-orientation="vertical"
        aria-valuemin={38}
        aria-valuemax={75}
        aria-valuenow={Math.round(panePercent)}
        tabIndex={visible ? 0 : -1}
        onPointerDown={resizeFromPointer}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setPaneFromClientX(event.clientX) }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
        onDoubleClick={() => setPanePercent(56)}
        onKeyDown={resizeFromKeyboard}
        title="拖动调整宽度，双击恢复默认"
      ><span /></div>

      <header className="browser-workspace-toolbar">
        <div className="browser-workspace-nav">
          <button type="button" disabled={!canGoBack} onClick={() => webviewRef.current?.goBack()} aria-label="后退" title="后退"><ArrowLeft size={16} /></button>
          <button type="button" disabled={!canGoForward} onClick={() => webviewRef.current?.goForward()} aria-label="前进" title="前进"><ArrowRight size={16} /></button>
          <button type="button" onClick={() => loading ? webviewRef.current?.stop() : webviewRef.current?.reload()} aria-label={loading ? '停止加载' : '刷新'} title={loading ? '停止加载' : '刷新'}>{loading ? <X size={16} /> : <RefreshCw size={16} />}</button>
        </div>
        <form className="browser-workspace-address" onSubmit={submit} role="search">
          {loading ? <LoaderCircle className="spin" size={15} /> : currentUrl.startsWith('https://') ? <ShieldCheck size={15} /> : <Globe2 size={15} />}
          <input value={displayedAddress} onFocus={() => { setAddressFocused(true); if (currentUrl !== HOME_URL) setAddress(currentUrl) }} onBlur={() => setAddressFocused(false)} onChange={(event) => setAddress(event.target.value)} aria-label="网址或搜索关键词" placeholder="输入网址或搜索关键词" spellCheck={false} />
          <button type="submit" aria-label="打开网址" title="打开"><Search size={15} /></button>
        </form>
        <button type="button" className="screenshot-trigger" disabled={currentUrl === HOME_URL || capturing} onClick={() => void captureScreenshot()} aria-label="截取当前网页并批注" title="截图并批注">{capturing ? <LoaderCircle className="spin" size={16} /> : <Scissors size={17} />}</button>
        <button type="button" className={annotationMode ? 'active' : ''} disabled={currentUrl === HOME_URL} onClick={() => void startAnnotation()} aria-pressed={annotationMode} aria-label={annotationMode ? '退出批注模式' : '批注网页'} title={annotationMode ? '退出批注模式（Esc）' : '批注网页'}><MessageSquareText size={16} /></button>
        <button type="button" disabled={currentUrl === HOME_URL} onClick={() => void openExternally()} aria-label="在外部浏览器打开" title="在外部浏览器打开"><ExternalLink size={16} /></button>
        <span className="browser-workspace-agent" title="你与 ZSense Agent 正在操作同一个网页"><Bot size={14} /><span>共享页面</span></span>
        <button type="button" className="browser-workspace-close" onClick={() => void closePane()} aria-label="关闭浏览器面板" title="关闭浏览器"><X size={17} /></button>
      </header>

      <div className="browser-workspace-titlebar"><Globe2 size={13} /><strong title={title}>{currentUrl === HOME_URL ? '空白页' : title}</strong><small>{currentUrl === HOME_URL ? '当前会话独立' : `${currentUrl.startsWith('https://') ? '安全连接' : '本地或 HTTP 连接'} · 当前会话独立`}</small></div>

      <div className="browser-workspace-viewport">
        {isDesktopApp && shouldMountWebview ? <webview
          ref={(element) => { webviewRef.current = element as ZSenseWebviewElement | null }}
          src={HOME_URL}
          partition={BROWSER_PARTITION}
        /> : !isDesktopApp ? <div className="browser-unavailable"><Globe2 size={32} /><strong>会话浏览器需要 ZSense 桌面端</strong><p>桌面应用中，用户和 Agent 会共享同一个可见网页实例。</p></div> : null}
        {error && <div className="browser-workspace-error" role="alert"><Globe2 size={27} /><strong>无法打开页面</strong><p>{error}</p><button type="button" className="secondary-button" onClick={() => void open(currentUrl)}><RefreshCw size={15} />重试</button></div>}
        {(annotationDraft || annotations.length > 0) && <aside className="browser-annotation-panel" aria-label="网页批注">
          <header><strong>网页批注</strong><small>{annotations.length} 条</small></header>
          {annotationDraft && <div className="browser-annotation-draft"><small title={annotationDraft.text}>{annotationDraft.text || '已选中网页元素'}</small><textarea autoFocus value={annotationDraft.note} onChange={(event) => setAnnotationDraft({ ...annotationDraft, note: event.target.value })} placeholder="写下批注…" /><span><button type="button" onClick={() => setAnnotationDraft(null)}>取消</button><button type="button" className="primary" onClick={() => void saveAnnotation()}>保存</button></span></div>}
          {annotations.map((annotation) => <div className="browser-annotation-item" key={`${annotation.url}:${annotation.id}`}><b>{annotation.id}</b><span><strong>{annotation.note || '未填写批注'}</strong><small title={annotation.text}>{annotation.text || annotation.selector}</small></span><button type="button" onClick={() => void removeAnnotation(annotation)} aria-label={`删除批注 ${annotation.id}`} title="删除批注"><Trash2 size={13} /></button></div>)}
        </aside>}
      </div>
      {capturedScreenshot && <ScreenshotAnnotationDialog sourceDataUrl={capturedScreenshot.dataUrl} sourceName={capturedScreenshot.name} workspacePath={workspacePath} onClose={() => setCapturedScreenshot(null)} onComplete={onAnnotatedScreenshot} />}
    </aside>
  )
}
