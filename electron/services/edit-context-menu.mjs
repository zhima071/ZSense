// Keep the desktop editing menu native so it works for input, textarea,
// contenteditable (including the Word editor), and ordinary selected text.
export function editContextMenuTemplate(params = {}, { copyLink } = {}) {
  const editable = Boolean(params.isEditable)
  const selected = Boolean(params.selectionText?.length)
  const link = String(params.linkURL || '')
  const flags = params.editFlags || {}
  const password = params.inputFieldType === 'password'
  const items = []

  if (editable) {
    items.push(
      { role: 'undo', label: '撤销', enabled: flags.canUndo !== false },
      { role: 'redo', label: '重做', enabled: flags.canRedo !== false },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: !password && selected && flags.canCut !== false },
      { role: 'copy', label: '复制', enabled: !password && selected && flags.canCopy !== false },
      { role: 'paste', label: '粘贴', enabled: flags.canPaste !== false },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式', enabled: flags.canPaste !== false },
      { role: 'delete', label: '删除', enabled: selected },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    )
  } else if (selected) {
    items.push({ role: 'copy', label: '复制', enabled: flags.canCopy !== false })
  }

  if (link && copyLink) {
    if (items.length) items.push({ type: 'separator' })
    items.push({ label: '复制链接地址', click: () => copyLink(link) })
  }

  return items
}
