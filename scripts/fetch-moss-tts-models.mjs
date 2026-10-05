import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = path.join(projectDirectory, 'bundled-tools', 'shared', 'tts', 'moss', 'models')
const useOfficialFirst = process.argv.includes('--official')
const bases = useOfficialFirst ? ['https://huggingface.co', 'https://hf-mirror.com'] : ['https://hf-mirror.com', 'https://huggingface.co']

const repositories = [
  {
    id: 'OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX',
    files: [
      ['browser_poc_manifest.json', 503354],
      ['moss_tts_decode_step.onnx', 291483, '698cbc2fc1c2feca16e5895614ed52bbb32ded10f236c076f477b2e69abf32d8'],
      ['moss_tts_global_shared.data', 440813568, 'bce8312c3df6a44545302cae229b61054fe0672e0b252ba59cba47adeed831dc'],
      ['moss_tts_local_cached_step.onnx', 53685, 'aa9035fefc1c138a951a8bcfc0374fb03a25f1ece67f7f7f53bce349b84a1dd5'],
      ['moss_tts_local_decoder.onnx', 49231, '51aa754301b38550a5f9adda0ad93bd3dc95819afb511e6dcabf4a90b345a454'],
      ['moss_tts_local_fixed_sampled_frame.onnx', 471262, '40cdb00efc171c450cf91468e01429caa41b0252222cd308e978f58fe354afa8'],
      ['moss_tts_local_shared.data', 229678080, 'bae7782032c0fb12490ab42afe009f87ae6c75a0f0596fc7b5c08e4d5ee93916'],
      ['moss_tts_prefill.onnx', 283305, 'd56126dcd0574c2f15d98fc6b35eda68d0386b5bd9c5e38e28548d6f2ea8f3db'],
      ['tokenizer.model', 470897, 'c353ee1479b536bf414c1b247f5542b6607fb8ae91320e5af1781fee200fddff'],
      ['tts_browser_onnx_meta.json', 4487],
    ],
  },
  {
    id: 'OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX',
    files: [
      ['codec_browser_onnx_meta.json', 17036],
      ['moss_audio_tokenizer_decode_full.onnx', 681902, '0fbbafe3fd4afa2a019af5c5ced204af6e2d1db044fa40f021525d2aee95b4ac'],
      ['moss_audio_tokenizer_decode_shared.data', 44198912, 'e69d52e0f4e84ca27850557ee54face46632d3a5a16c89bd246c7c408466dcad'],
      ['moss_audio_tokenizer_decode_step.onnx', 351400, '9527c86a29e1837edec1f74db57d5eeaadb3a715af3382703566460afed25855'],
      ['moss_audio_tokenizer_encode.data', 44507136, 'aa751265b2bab2887eac224484546b194875aa7494b607115439b3dc6b228a2c'],
      ['moss_audio_tokenizer_encode.onnx', 815775, 'eadea4a645abdcf98714c7aead122ee2ce7da6e080f9f80b977cd1ca8e19473a'],
    ],
  },
]

async function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

function progressLabel(value) {
  return `${(value / 1024 / 1024).toFixed(1)}MB`
}

async function downloadFile(repository, fileName, expectedSize) {
  const directory = path.join(outputDirectory, repository.split('/').at(-1))
  const destination = path.join(directory, fileName)
  const partial = `${destination}.part`
  fs.mkdirSync(directory, { recursive: true })
  if (fs.existsSync(destination) && fs.statSync(destination).size === expectedSize) return destination
  if (fs.existsSync(destination)) fs.renameSync(destination, partial)

  let lastError
  for (const base of bases) {
    try {
      const downloaded = fs.existsSync(partial) ? fs.statSync(partial).size : 0
      const headers = downloaded > 0 && downloaded < expectedSize ? { Range: `bytes=${downloaded}-` } : {}
      const url = `${base}/${repository}/resolve/main/${encodeURIComponent(fileName)}?download=true`
      console.log(`下载 ${repository}/${fileName}（${progressLabel(expectedSize)}，来源 ${new URL(base).hostname}）`)
      const response = await fetch(url, { headers, redirect: 'follow' })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      const append = response.status === 206 && downloaded > 0
      if (!append && fs.existsSync(partial)) fs.truncateSync(partial, 0)
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { flags: append ? 'a' : 'w' }))
      const actualSize = fs.statSync(partial).size
      if (actualSize !== expectedSize) throw new Error(`文件大小 ${actualSize}，预期 ${expectedSize}`)
      fs.renameSync(partial, destination)
      return destination
    } catch (error) {
      lastError = error
      console.warn(`来源失败：${String(error?.message || error)}`)
    }
  }
  throw new Error(`无法下载 ${repository}/${fileName}：${String(lastError?.message || lastError)}`)
}

const verified = []
for (const repository of repositories) {
  for (const [fileName, expectedSize, expectedSha256] of repository.files) {
    const filePath = await downloadFile(repository.id, fileName, expectedSize)
    const actualSha256 = await sha256(filePath)
    if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error(`${repository.id}/${fileName} SHA-256 校验失败`)
    verified.push({ repository: repository.id, file: fileName, size: expectedSize, sha256: actualSha256 })
  }
}

const manifestDirectory = path.dirname(outputDirectory)
fs.mkdirSync(manifestDirectory, { recursive: true })
fs.writeFileSync(path.join(manifestDirectory, 'manifest.json'), `${JSON.stringify({
  engine: 'MOSS-TTS-Nano',
  runtime: 'ONNX Runtime Web',
  ttsModel: 'OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX',
  codecModel: 'OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX',
  offline: true,
  files: verified,
}, null, 2)}\n`)
console.log(`MOSS-TTS-Nano 模型已完成：${verified.length} 个文件，${progressLabel(verified.reduce((total, item) => total + item.size, 0))}`)
