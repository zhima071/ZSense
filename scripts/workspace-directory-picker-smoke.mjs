import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listWorkspaceDirectories } from '../electron/services/workspace-directory-picker.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-workspace-picker-'))
try {
  fs.mkdirSync(path.join(root, 'Folder 10'))
  fs.mkdirSync(path.join(root, 'Folder 2'))
  fs.writeFileSync(path.join(root, 'not-a-folder.txt'), 'ignored')
  const initial = listWorkspaceDirectories('', root)
  assert.equal(initial.path, fs.realpathSync.native(root))
  assert.deepEqual(initial.directories.map((entry) => entry.name), ['Folder 2', 'Folder 10'])
  assert(initial.roots.some((item) => item.label === '默认工作区' && item.path === initial.path))
  const nested = listWorkspaceDirectories(path.join(root, 'Folder 2'), root)
  assert.equal(nested.parentPath, initial.path)
  assert.deepEqual(nested.directories, [])
  assert.throws(() => listWorkspaceDirectories(path.join(root, 'not-a-folder.txt'), root), /文件夹不存在/)
  assert.throws(() => listWorkspaceDirectories(path.join(root, 'missing'), root), /文件夹不存在/)
  assert.equal(listWorkspaceDirectories('', path.join(root, 'missing')).path, fs.realpathSync.native(os.homedir()), '默认工作区失效后应回退到主目录')
  console.log('远程工作区浏览：默认位置、目录导航、自然排序和无效路径校验通过。')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
