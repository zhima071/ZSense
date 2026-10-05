import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SecretsVault } from '../electron/services/secrets-vault.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-secrets-smoke-'))
const filePath = path.join(directory, 'zsense-secrets.json')

function fakeSafeStorage({ available = true } = {}) {
  return {
    available,
    isEncryptionAvailable() { return this.available },
    encryptString(value) { return Buffer.from(`enc:${Buffer.from(String(value), 'utf8').toString('base64')}`, 'utf8') },
    decryptString(buffer) {
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('无法解密')
      return Buffer.from(text.slice(4), 'base64').toString('utf8')
    },
  }
}

try {
  const vault = new SecretsVault(directory, fakeSafeStorage())
  assert.deepEqual(vault.status(), {
    available: true,
    backend: process.platform === 'darwin' ? 'macOS Keychain' : process.platform === 'win32' ? 'Windows DPAPI' : '系统密钥环',
    filePath,
  }, '密钥库状态应该反映系统安全存储后端')

  assert.deepEqual(vault.get('模型密钥'), {}, '未写入过的作用域应该返回空对象')
  assert.equal(vault.has('模型密钥', 'OPENAI_API_KEY'), false, '未写入的键不存在')

  const saved = vault.set('模型密钥', { OPENAI_API_KEY: 'sk-zsense-smoke-value', BASE_URL: 'https://example.com/v1', EMPTY: '   ' })
  assert.equal(saved.OPENAI_API_KEY, 'sk-zsense-smoke-value', '写入后应该返回当前作用域内容')
  assert.equal(saved.EMPTY, undefined, '空白字符串不应写入')
  assert.equal(vault.has('模型密钥', 'OPENAI_API_KEY'), true, '写入后应该能读到键')
  assert.deepEqual(vault.keys('模型密钥').sort(), ['BASE_URL', 'OPENAI_API_KEY'], '应该只列出真实存在的键')

  const onDisk = fs.readFileSync(filePath, 'utf8')
  assert(!onDisk.includes('sk-zsense-smoke-value'), '磁盘上不能出现密钥明文')
  assert(onDisk.includes('模型密钥'), '磁盘上应该按作用域保存加密内容')
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, '密钥文件权限应为 0600')

  const reopened = new SecretsVault(directory, fakeSafeStorage())
  assert.equal(reopened.get('模型密钥').OPENAI_API_KEY, 'sk-zsense-smoke-value', '重新打开应用后应该能解密已有凭证')
  assert.deepEqual(reopened.get('另一个作用域'), {}, '不同作用域互相隔离')

  reopened.set('模型密钥', { ANTHROPIC_API_KEY: 'sk-ant-smoke' })
  assert.deepEqual(reopened.keys('模型密钥').sort(), ['ANTHROPIC_API_KEY', 'BASE_URL', 'OPENAI_API_KEY'], '后续写入应该合并到同一作用域')

  reopened.set('模型密钥', { OPENAI_API_KEY: 'sk-updated' }, ['BASE_URL'])
  const afterClear = reopened.get('模型密钥')
  assert.equal(afterClear.OPENAI_API_KEY, 'sk-updated', '覆盖写入应该更新已有键')
  assert.equal(afterClear.BASE_URL, undefined, 'clearKeys 应该删除指定键')

  reopened.set('模型密钥', {}, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
  assert.deepEqual(reopened.keys('模型密钥'), [], '全部清空后作用域应该为空')
  assert(!fs.readFileSync(filePath, 'utf8').includes('模型密钥'), '清空后不应在磁盘上保留空作用域')

  vault.set('待删除', { TOKEN: 'value' })
  vault.delete('待删除')
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('待删除'), false, '删除作用域后不应残留加密内容')
  assert.equal(vault.delete('不存在的'), undefined, '删除不存在的作用域应该安全返回')

  const unavailable = new SecretsVault(path.join(directory, 'unavailable'), fakeSafeStorage({ available: false }))
  assert.equal(unavailable.status().available, false, '系统安全存储不可用时状态应为不可用')
  assert.throws(() => unavailable.set('模型密钥', { OPENAI_API_KEY: 'sk' }), /系统安全存储暂不可用/, '安全存储不可用时不应写入')
  assert.equal(unavailable.has('模型密钥', 'OPENAI_API_KEY'), false, '安全存储不可用时 has 应返回 false')
  assert.deepEqual(unavailable.keys('模型密钥'), [], '安全存储不可用时 keys 应返回空列表')
  assert(!fs.existsSync(path.join(directory, 'unavailable', 'zsense-secrets.json')), '安全存储不可用时不应创建密钥文件')

  fs.writeFileSync(filePath, '{ 这不是合法 JSON')
  assert.deepEqual(new SecretsVault(directory, fakeSafeStorage()).get('模型密钥'), {}, '损坏的密钥文件应该安全降级为空')

  console.log(JSON.stringify({
    ok: true,
    engine: 'secrets-vault',
    encryptedAtRest: true,
    fileMode: '0600',
    scopeIsolation: true,
    mergeAndClear: true,
    unavailableStorageGuarded: true,
    corruptedFileTolerated: true,
  }))
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
