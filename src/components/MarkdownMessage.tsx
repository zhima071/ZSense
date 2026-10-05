import { memo, useEffect, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { imageDocumentPathFromHref, previewableDocumentPathFromHref } from '../services/office-artifacts'
import { unwrapDesktop } from '../services/desktop'
import { useDisplaySettings } from './DisplaySettingsContext'

interface MarkdownMessageProps {
  content: string
  workspacePath?: string
  onOpenOfficeFile?: (filePath: string) => void
  onOpenBrowserUrl?: (url: string) => void
}

function MarkdownImage({ src, alt, title, workspacePath, onOpenOfficeFile }: {
  src?: string
  alt?: string
  title?: string
  workspacePath: string
  onOpenOfficeFile?: (filePath: string) => void
}) {
  const localPath = workspacePath ? imageDocumentPathFromHref(src, workspacePath) : ''
  const [preview, setPreview] = useState({ path: '', url: '', error: '' })

  useEffect(() => {
    if (!localPath) return
    let active = true
    if (!window.zsenseDesktop?.office.inlineImage) {
      setPreview({ path: localPath, url: '', error: '当前环境无法读取工作区图片。' })
      return
    }
    void unwrapDesktop(window.zsenseDesktop.office.inlineImage({ workspacePath, filePath: localPath }))
      .then(({ previewUrl }) => { if (active) setPreview({ path: localPath, url: previewUrl, error: '' }) })
      .catch((error) => { if (active) setPreview({ path: localPath, url: '', error: error instanceof Error ? error.message : '图片无法读取。' }) })
    return () => { active = false }
  }, [localPath, workspacePath])

  if (!localPath) return <img src={src} alt={alt || ''} title={title} loading="lazy" decoding="async" />
  const activePreview = preview.path === localPath ? preview : null
  if (!activePreview?.url) {
    return <span className="markdown-local-image-status" title={activePreview?.error || ''}>{activePreview?.error ? `图片无法预览：${alt || '本地图片'}` : `正在加载图片：${alt || '本地图片'}`}</span>
  }
  const image = <img src={activePreview.url} alt={alt || ''} title={title} loading="lazy" decoding="async" onError={() => setPreview((current) => current.path === localPath ? { path: localPath, url: '', error: '图片文件无法解码。' } : current)} />
  return onOpenOfficeFile
    ? <button className="markdown-inline-image" type="button" onClick={() => onOpenOfficeFile(localPath)} title="在右侧打开图片">{image}</button>
    : image
}

function MarkdownMessageView({ content, workspacePath = '', onOpenOfficeFile, onOpenBrowserUrl }: MarkdownMessageProps) {
  const { inlineDiff } = useDisplaySettings()
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key, node) => key === 'src' && node.tagName === 'img' && /^file:\/\//i.test(url) && imageDocumentPathFromHref(url, workspacePath)
          ? url
          : defaultUrlTransform(url)}
        components={{
          img: ({ src, alt, title }) => <MarkdownImage src={src} alt={alt} title={title} workspacePath={workspacePath} onOpenOfficeFile={onOpenOfficeFile} />,
          a: ({ children, href, ...props }) => {
            const previewPath = previewableDocumentPathFromHref(href, workspacePath)
            if (previewPath && onOpenOfficeFile) return <button className="markdown-office-link" type="button" onClick={() => onOpenOfficeFile(previewPath)} title={`在右侧打开 ${previewPath}`}>{children}</button>
            if (href && /^https?:\/\//i.test(href) && onOpenBrowserUrl) return <button className="markdown-browser-link" type="button" onClick={() => onOpenBrowserUrl(href)} title="在当前会话浏览器中打开">{children}</button>
            return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          },
          code: ({ children, className, ...props }) => {
            const isDiff = inlineDiff && /language-(diff|patch)/.test(className || '')
            if (!isDiff) return <code className={className} {...props}>{children}</code>
            return <code className={`${className || ''} inline-diff-code`} {...props}>{String(children).replace(/\n$/, '').split('\n').map((line, index) => <span className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-added' : line.startsWith('-') && !line.startsWith('---') ? 'diff-removed' : line.startsWith('@@') ? 'diff-meta' : ''} key={`${index}-${line.slice(0, 12)}`}>{line || ' '}</span>)}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

// memo：消息多起来以后，每次打字或每次流式增量都会重渲染整个消息列表，
// 而 react-markdown 的解析是全流程里最贵的一步；内容没变就不该重新解析。
export const MarkdownMessage = memo(MarkdownMessageView)
