import { ChevronLeft, ChevronRight, Folder, FolderOpen, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { unwrapDesktop } from '../services/desktop'

type DirectoryListing = {
  path: string
  parentPath: string
  roots: { label: string; path: string }[]
  directories: { name: string; path: string }[]
  truncated: boolean
}

interface RemoteWorkspacePickerProps {
  initialPath: string
  onSelect: (path: string) => void | Promise<void>
  onClose: () => void
}

export function RemoteWorkspacePicker({ initialPath, onSelect, onClose }: RemoteWorkspacePickerProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [jumpPath, setJumpPath] = useState(initialPath)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [initialPathWarning, setInitialPathWarning] = useState('')
  const [loading, setLoading] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const requestId = useRef(0)
  const closeButton = useRef<HTMLButtonElement>(null)
  const closeHandler = useRef(onClose)
  closeHandler.current = onClose

  const browse = useCallback(async (directoryPath: string): Promise<boolean | null> => {
    const id = ++requestId.current
    setLoading(true)
    setError('')
    setInitialPathWarning('')
    try {
      if (!window.zsenseDesktop) throw new Error('远程工作区接口不可用。')
      const next = await unwrapDesktop(window.zsenseDesktop.chat.listWorkspaceDirectories(directoryPath))
      if (requestId.current !== id) return null
      setListing(next)
      setJumpPath(next.path)
      setSearch('')
      return true
    } catch (reason) {
      if (requestId.current === id) setError(reason instanceof Error ? reason.message : '读取文件夹失败。')
      return requestId.current === id ? false : null
    } finally {
      if (requestId.current === id) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // A conversation may point at a moved folder. Show the remote device's
    // default location instead of leaving the mobile picker unusable.
    void (async () => {
      const result = await browse(initialPath)
      if (result === false && initialPath) {
        if (await browse('')) setInitialPathWarning('原工作区已无法访问，已打开默认位置供你重新选择。')
      }
    })()
    closeButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeHandler.current() }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { requestId.current += 1; document.removeEventListener('keydown', onKeyDown); document.body.style.overflow = previousOverflow }
  }, [browse, initialPath])

  const directories = useMemo(() => listing?.directories.filter((directory) =>
    directory.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) || [], [listing, search])

  const selectCurrent = async () => {
    if (!listing || loading || selecting) return
    setSelecting(true)
    setError('')
    try { await onSelect(listing.path); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存工作区失败。') }
    finally { setSelecting(false) }
  }

  return createPortal(
    <div className="remote-workspace-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="remote-workspace-picker" role="dialog" aria-modal="true" aria-labelledby="remote-workspace-title">
        <header className="remote-workspace-header">
          <div><span>远程设备文件夹</span><h2 id="remote-workspace-title">选择会话工作区</h2></div>
          <button ref={closeButton} type="button" className="remote-workspace-icon-button" onClick={onClose} aria-label="关闭工作区选择"><X size={19} /></button>
        </header>
        <p className="remote-workspace-hint">这里显示的是被控电脑上的文件夹，不是手机存储。选定后，对话生成的文件会保存在该文件夹。</p>
        {initialPathWarning && <p className="remote-workspace-error" role="status">{initialPathWarning}</p>}
        <div className="remote-workspace-roots" aria-label="常用位置">
          {listing?.roots.map((root) => <button key={root.path} type="button" onClick={() => void browse(root.path)} disabled={loading} title={root.path}>{root.label}</button>)}
        </div>
        <form className="remote-workspace-jump" onSubmit={(event) => { event.preventDefault(); void browse(jumpPath) }}>
          <label htmlFor="remote-workspace-path">当前路径</label>
          <div><input id="remote-workspace-path" value={jumpPath} onChange={(event) => setJumpPath(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" /><button type="submit" disabled={loading || !jumpPath.trim()}>前往</button></div>
        </form>
        <div className="remote-workspace-navigation">
          <button type="button" onClick={() => listing?.parentPath && void browse(listing.parentPath)} disabled={!listing?.parentPath || loading} aria-label="返回上一级文件夹"><ChevronLeft size={18} />上一级</button>
          <span title={listing?.path || ''}>{listing?.path || '正在读取文件夹…'}</span>
        </div>
        <label className="remote-workspace-search"><span>筛选当前文件夹</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入文件夹名称" disabled={!listing || loading} /></label>
        <div className="remote-workspace-list" role="list" aria-busy={loading}>
          {loading && <p className="remote-workspace-empty"><LoaderCircle className="spin" size={18} />正在读取文件夹…</p>}
          {!loading && directories.map((directory) => <button type="button" role="listitem" key={directory.path} onClick={() => void browse(directory.path)} title={directory.path}><Folder size={18} /><span>{directory.name}</span><ChevronRight size={16} /></button>)}
          {!loading && !directories.length && <p className="remote-workspace-empty">{search ? '没有匹配的文件夹。' : '这里没有子文件夹，可以直接使用当前文件夹。'}</p>}
        </div>
        {listing?.truncated && <p className="remote-workspace-limit">当前文件夹的子目录过多，仅显示前 500 个；也可以在上方输入完整路径。</p>}
        {error && <p className="remote-workspace-error" role="alert">{error}</p>}
        <footer className="remote-workspace-footer">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" className="primary" onClick={() => void selectCurrent()} disabled={!listing || loading || selecting}>{selecting ? <LoaderCircle className="spin" size={17} /> : <FolderOpen size={17} />}使用此文件夹</button>
        </footer>
      </section>
    </div>, document.body,
  )
}
