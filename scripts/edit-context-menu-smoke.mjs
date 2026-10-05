import assert from 'node:assert/strict'
import { editContextMenuTemplate } from '../electron/services/edit-context-menu.mjs'

const roles = (items) => items.map((item) => item.role).filter(Boolean)

const selectedText = editContextMenuTemplate({ selectionText: '可以复制', isEditable: false })
assert.deepEqual(roles(selectedText), ['copy'])

const input = editContextMenuTemplate({
  isEditable: true,
  selectionText: '已选文字',
  editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true },
})
assert.deepEqual(roles(input), ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
assert.equal(input.find((item) => item.role === 'redo')?.enabled, false)
assert.equal(input.find((item) => item.role === 'paste')?.enabled, true)

const emptyInput = editContextMenuTemplate({ isEditable: true, selectionText: '' })
assert.equal(emptyInput.find((item) => item.role === 'copy')?.enabled, false)
assert.equal(emptyInput.find((item) => item.role === 'paste')?.enabled, true)

const password = editContextMenuTemplate({ isEditable: true, inputFieldType: 'password', selectionText: 'secret' })
assert.equal(password.find((item) => item.role === 'copy')?.enabled, false)
assert.equal(password.find((item) => item.role === 'cut')?.enabled, false)

let copied = ''
const link = editContextMenuTemplate({ linkURL: 'https://example.com/path' }, { copyLink: (url) => { copied = url } })
assert.equal(link.length, 1)
link[0].click()
assert.equal(copied, 'https://example.com/path')
assert.deepEqual(editContextMenuTemplate({}), [])

console.log('编辑右键菜单检查通过。')
