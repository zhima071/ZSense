import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

// Render the production composer in isolation. No real files, thumbnails, IPC,
// clipboard or model calls are used by this regression test.
const require = createRequire(import.meta.url)
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const compile = (file) => ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const artifacts = { exports: {} }
vm.runInNewContext(compile('src/services/office-artifacts.ts'), { exports: artifacts.exports, module: artifacts, URL })

function loadComposer(react = React, jsxRuntime = require('react/jsx-runtime')) {
  const module = { exports: {} }
  const imported = {
    react,
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': require('lucide-react'),
    '../services/chat-attachments': { mergeChatAttachments: (existing, added) => [...existing, ...added] },
    '../services/desktop': { unwrapDesktop: (result) => result },
    '../services/office-artifacts': artifacts.exports,
    './RemoteWorkspacePicker': { RemoteWorkspacePicker: () => null },
    './ChatComposerControlTooltip': { ChatComposerControlTooltip: ({ children }) => jsxRuntime.jsx('span', { children }) },
  }
  vm.runInNewContext(compile('src/components/ChatComposerToolbar.tsx'), {
    module, exports: module.exports, require: (id) => {
      assert(id in imported, `Unexpected dependency ${id}`)
      return imported[id]
    },
  })
  return module.exports
}

const images = [
  { id: 'image-kind', name: '1791593118369-58913408-kind.png', kind: 'image', mimeType: 'image/png', path: '/workspace/kind.png' },
  { id: 'image-mime', name: '1791593118369-58913408-mime.png', kind: 'file', mimeType: 'image/png', path: '/workspace/mime.png' },
  { id: 'image-extension', name: '1791593118369-58913408-extension.webp', kind: 'file', mimeType: 'application/octet-stream', path: '/workspace/extension.webp' },
  { id: 'image-no-path', name: '1791593118369-58913408-pathless.png', kind: 'image', mimeType: 'image/png' },
]
const document = { id: 'document', name: '办公室预算.xlsx', kind: 'file', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', path: '/workspace/办公室预算.xlsx' }
const attachments = [...images, document]
const props = {
  attachments, savedModelConfigurations: [], selectedModelProvider: '', selectedModel: '', reasoningEffort: 'high', workspacePath: '/workspace',
  onPickAttachments: async () => [], onPickWorkspace: async () => '', onAttachmentsChange: () => {}, onWorkspaceChange: () => {},
  onModelChange: () => {}, onReasoningEffortChange: () => {}, onError: () => {}, onOpenAttachment: () => {},
}
const { ChatComposerToolbar, ChatMessageAttachments } = loadComposer()
for (const layout of ['composer', 'toolbar']) {
  const html = renderToStaticMarkup(React.createElement(ChatComposerToolbar, { ...props, layout }))
  const pending = html.slice(html.indexOf('aria-label="待发送附件"'))
  const visible = pending.replace(/<[^>]*>/g, '')
  for (const image of images) {
    assert(!visible.includes(image.name), `${layout}: Pending image filename is visible`)
    assert(pending.includes(`移除附件 ${image.name}`), `${layout}: Image removal lost its accessible name`)
  }
  assert(visible.includes(document.name), `${layout}: Non-image document filename disappeared`)
  assert(!visible.includes('点击查看大图'), `${layout}: Pending image preview still displays instruction text`)
  assert(!pending.includes('title="在右侧打开 179159'), `${layout}: Image filename is still shown in its hover title`)
  const noPreview = renderToStaticMarkup(React.createElement(ChatComposerToolbar, { ...props, layout, onOpenAttachment: undefined }))
  const fallback = noPreview.slice(noPreview.indexOf('aria-label="待发送附件"')).replace(/<[^>]*>/g, '')
  for (const image of images) assert(!fallback.includes(image.name), `${layout}: Fallback image filename is visible`)
  assert(fallback.includes(document.name), `${layout}: Fallback document filename disappeared`)
}

const history = renderToStaticMarkup(React.createElement(ChatMessageAttachments, { attachments, onOpenAttachment: props.onOpenAttachment }))
const historyVisible = history.replace(/<[^>]*>/g, '')
for (const attachment of attachments) assert(historyVisible.includes(attachment.name), 'Existing message attachment names changed outside requested scope')

// A tiny JSX tree keeps event handlers available so preview/removal/disabled
// behavior is checked against the same production component, not a replica.
const jsx = (type, props) => ({ type, props })
const treeRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' }
const treeReact = { useState: (initial) => [initial, () => {}], useMemo: (callback) => callback(), useEffect: () => {} }
const treeComposer = loadComposer(treeReact, treeRuntime).ChatComposerToolbar
const nodes = []
function visit(node) {
  if (Array.isArray(node)) { for (const child of node) visit(child); return }
  if (!node || typeof node !== 'object') return
  nodes.push(node)
  if (typeof node.type === 'string') visit(node.props?.children)
}
let opened = ''
let remaining
visit(treeComposer({ ...props, onOpenAttachment: (filePath) => { opened = filePath }, onAttachmentsChange: (items) => { remaining = items } }))
const preview = nodes.find((node) => node.type === 'button' && node.props['aria-label'] === `在右侧打开附件 ${images[0].name}`)
assert(preview, 'Preview action is missing')
assert.equal(preview.props.title, '查看图片', 'Image preview lost its hover hint')
assert.equal(preview.props.children[1], false, 'Image preview still has a visible text node')
preview.props.onClick()
assert.equal(opened, images[0].path, 'Preview action no longer opens the original image')
const remove = nodes.find((node) => node.type === 'button' && node.props['aria-label'] === `移除附件 ${images[0].name}`)
remove.props.onClick()
assert.equal(remaining.length, attachments.length - 1, 'Removal did not remove exactly one image')
assert(!remaining.some((item) => item.id === images[0].id), 'Removal retained the removed image')
assert.equal(remaining.at(-1), document, 'Removal mutated another attachment')
nodes.length = 0
visit(treeComposer({ ...props, attachmentDisabled: true }))
for (const node of nodes.filter((node) => node.type === 'button' && /^(在右侧打开附件|移除附件)/.test(node.props['aria-label'] || ''))) assert.equal(node.props.disabled, true, 'Busy composer enables image actions')

for (const file of ['src/components/NativeChatPage.tsx', 'src/components/ChatDialog.tsx']) assert(read(file).includes('<ChatComposerToolbar'), `${file} does not share the corrected composer`)
assert(/\.chat-attachment-chip\.image\s*\{[^}]*max-width:\s*min\(176px,\s*100%\)/s.test(read('src/styles.css')), 'Image chip is not constrained to compact width')
console.log(JSON.stringify({ ok: true, composerLayouts: 2, imageDetectionKinds: 3, imageTextHidden: true, pathlessAndNoPreviewFallback: true, documentAndHistoryNamesPreserved: true, previewAndRemoval: true, accessibleNamesAndHoverHint: true, disabledActions: true, compactWidth: true }))
