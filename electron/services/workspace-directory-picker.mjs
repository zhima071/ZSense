import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_DIRECTORIES = 500

function existingDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_000 || !path.isAbsolute(value.trim())) return ''
  try {
    const resolved = fs.realpathSync.native(path.resolve(value.trim()))
    return fs.statSync(resolved).isDirectory() ? resolved : ''
  } catch { return '' }
}

export function listWorkspaceDirectories(requestedPath = '', defaultPath = '') {
  const selected = requestedPath || existingDirectory(defaultPath) || os.homedir()
  const directory = existingDirectory(selected)
  if (!directory) throw new Error('文件夹不存在或无法访问，请选择该电脑上的现有文件夹。')
  let entries
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) }
  catch { throw new Error('无法读取这个文件夹，请选择其他位置。') }
  const folders = entries.filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))
  const homePath = existingDirectory(os.homedir())
  const roots = []
  const seen = new Set()
  for (const item of [
    { label: '默认工作区', path: existingDirectory(defaultPath) },
    { label: '主目录', path: homePath },
    ...(process.platform === 'win32'
      ? [...new Set([process.env.SystemDrive, path.parse(defaultPath || '').root, path.parse(homePath).root])]
        .filter(Boolean)
        .map((drive) => ({ label: `${String(drive)[0]} 盘`, path: existingDirectory(`${String(drive)[0]}:\\`) }))
      : [{ label: '磁盘根目录', path: existingDirectory('/') }]),
  ]) {
    if (item.path && !seen.has(item.path)) { roots.push(item); seen.add(item.path) }
  }
  const parent = path.dirname(directory)
  return {
    path: directory,
    parentPath: parent === directory ? '' : parent,
    roots,
    directories: folders.slice(0, MAX_DIRECTORIES).map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) })),
    truncated: folders.length > MAX_DIRECTORIES,
  }
}
