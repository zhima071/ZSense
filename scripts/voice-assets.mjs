import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyMacSignedApp, runMacCommand } from './mac-signing.mjs'

export const voiceProjectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const meloBundleRoot = path.join(voiceProjectDirectory, 'bundled-tools', 'shared', 'tts', 'melo')
export const meloRevision = 'a0d5c6a264c0ef92d70d8661d8cc502d79627cd6'
export const meloRepository = 'csukuangfj/vits-melo-tts-zh_en'
export const whisperRevision = 'f281eb45af861ab5e5297d23694b7d46e090c02c'
export const whisperModel = Object.freeze({ file: 'ggml-base-q5_1.bin', size: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' })

// The model LFS digest is published by the original repository. Auxiliary file
// digests were derived from a Git checkout whose complete HEAD matched the
// official Hugging Face commit above, rather than trusting a mirror's metadata.
export const meloFiles = Object.freeze([
  { file: 'model.onnx', size: 170429550, sha256: 'bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d' },
  { file: 'lexicon.txt', size: 6837671, sha256: '7236884b02435ac5d10cf69b4be40a61b45aa676b5300f0e412f185748fee528' },
  { file: 'tokens.txt', size: 655, sha256: 'd18664a7e12bd7ea1022ddaf951e534e136815016c5a809d6b64156bffb4369d' },
  { file: 'date.fst', size: 59154, sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
  { file: 'number.fst', size: 64482, sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
  { file: 'phone.fst', size: 88630, sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
  { file: 'new_heteronym.fst', size: 21974, sha256: 'ca14b2127e27baa571664e4bb791e143e7425f56a6bc29db08d74f97e6aa4e29' },
  { file: 'LICENSE', size: 1053, sha256: '88a50e5a02bbc2a5c2f084dc19da751aa97b1690f5fda76cd8005c8634d1ca70' },
])

export const voiceRuntimeAssets = Object.freeze({
  'darwin-arm64': {
    id: 'sherpa-onnx-darwin-arm64', version: '1.13.8', archiveName: 'sherpa-mac.tar.bz2',
    archiveDirectory: 'sherpa-onnx-v1.13.8-osx-arm64-shared',
    sha256: 'b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2',
    binary: 'sherpa-onnx-offline-tts', libraryFiles: ['libonnxruntime.dylib'],
    files: [
      { file: 'sherpa-onnx-offline-tts', size: 2131920, sha256: '947a31ca98559ec8e97d35543f43324110514bfe4940d64567b2b54fde6de74c' },
      { file: 'libonnxruntime.dylib', size: 28775120, sha256: '3567d114f7299d559993e536d605a6f46d7bc9d2542004accc80ee9bf5457f0b' },
    ],
  },
  'win32-x64': {
    id: 'sherpa-onnx-win32-x64', version: '1.13.8', archiveName: 'sherpa-win.tar.bz2',
    archiveDirectory: 'sherpa-onnx-v1.13.8-win-x64-shared-MT-Release',
    sha256: '6dffdc715a4465b989446a6105265d2cb345e7101591a17d35534b6758f6e8df',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2',
    binary: 'sherpa-onnx-offline-tts.exe', libraryFiles: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll'],
    files: [
      { file: 'sherpa-onnx-offline-tts.exe', size: 2768896, sha256: '17ae204c3d82e05a15d96c37e57ddd6210e9ffe27d1f0408d99ea54ba1b2d2f6' },
      { file: 'onnxruntime.dll', size: 17799168, sha256: '7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25' },
      { file: 'onnxruntime_providers_shared.dll', size: 104960, sha256: '551d0e1fe4c227d8542314ba718d52f4379e0c7bfe729a37c59833a884e27b4d' },
    ],
  },
})

export const voiceLicenseAssets = Object.freeze([
  { file: 'LICENSE.sherpa-onnx', url: 'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  { file: 'LICENSE.onnxruntime', url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE', sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c' },
  { file: 'NOTICE.onnxruntime', url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/ThirdPartyNotices.txt', sha256: '0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2' },
  { file: 'COPYING.espeak-ng', url: 'https://raw.githubusercontent.com/csukuangfj/espeak-ng/ed530aa113046142eb5115cf2fc9157854d0ffe1/COPYING', sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },
  { file: 'LICENSE.kaldi-native-fbank', url: 'https://raw.githubusercontent.com/csukuangfj/kaldi-native-fbank/v1.22.3/LICENSE', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  { file: 'LICENSE.kaldi-decoder', url: 'https://raw.githubusercontent.com/k2-fsa/kaldi-decoder/v0.3.0/LICENSE', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  { file: 'LICENSE.simple-sentencepiece', url: 'https://raw.githubusercontent.com/pkufool/simple-sentencepiece/v0.7/LICENSE', sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' },
  { file: 'LICENSE.json', url: 'https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT', sha256: '46a65cffd1ea955132d95a8dd921640714a8d6b537d2e4e482d31145ae95b603' },
  { file: 'LICENSE.piper-phonemize', url: 'https://raw.githubusercontent.com/csukuangfj/piper-phonemize/f3ff95afc03640bc1399e113e83361192a2fafb4/LICENSE.md', sha256: '13746d509d74e55ea2265fbef204bb7cdbf84a8315b0207e988326cb54387028' },
  { file: 'LICENSE.uni-algo', url: 'https://raw.githubusercontent.com/csukuangfj/piper-phonemize/f3ff95afc03640bc1399e113e83361192a2fafb4/licenses/uni-algo/LICENSE.md', sha256: 'c55648b02873556d6ab2de14938998101fda3a0f293337542af9196435def318' },
  { file: 'LICENSE.kaldifst', url: 'https://raw.githubusercontent.com/k2-fsa/kaldifst/v1.8.0/LICENSE', sha256: 'a682d6efd1ee5dee08a8e405c233c2c198ea70ae0718129daa83ab58cfe31c5d' },
  { file: 'LICENSE.eigen', url: 'https://gitlab.com/libeigen/eigen/-/raw/3.4.0/COPYING.MPL2', sha256: 'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85' },
  { file: 'LICENSE.openfst', url: 'https://raw.githubusercontent.com/csukuangfj/openfst/v1.8.5-2026-04-10/COPYING', sha256: '4300529197035fd3452350718a0b8cee984e9412c9932d7f35fcde849fc97a4b' },
])

// This is the deterministic ZSense notice assembled by prepare-voice-assets;
// it is not metadata that a packaged manifest can redefine for itself.
export const voiceThirdPartyNotices = Object.freeze({ file: 'THIRD_PARTY_NOTICES.txt', size: 2713, sha256: 'df4679bbbfee8355399d577471113a705fcf81d3db03f903a684d33fbf138273' })

export function voicePlatformRoot(platformKey) {
  if (!voiceRuntimeAssets[platformKey]) throw new Error(`Unsupported offline speech platform: ${platformKey}`)
  return path.join(voiceProjectDirectory, 'bundled-tools', platformKey)
}

export function voiceSha256(filePath) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let read
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally { fs.closeSync(descriptor) }
  return hash.digest('hex')
}

export function voiceFileEntries(rootPath, prefix = '') {
  return fs.readdirSync(path.join(rootPath, prefix), { withFileTypes: true }).flatMap((entry) => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return voiceFileEntries(rootPath, file)
    if (!entry.isFile()) throw new Error(`Speech resources must be regular files: ${file}`)
    const filePath = path.join(rootPath, file)
    return [{ file, size: fs.statSync(filePath).size, sha256: voiceSha256(filePath) }]
  }).sort((a, b) => a.file.localeCompare(b.file))
}

function verifyFile(rootPath, entry) {
  if (!entry || typeof entry.file !== 'string' || entry.file.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') || path.isAbsolute(entry.file)) throw new Error('Invalid speech manifest file path')
  const filePath = path.join(rootPath, entry.file)
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile() || fs.statSync(filePath).size !== entry.size || voiceSha256(filePath) !== entry.sha256) throw new Error(`Speech resource checksum mismatch: ${entry.file}`)
}

export function verifyMeloBundle(rootPath = meloBundleRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootPath, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.offline !== true || manifest.precision !== 'fp32' || manifest.revision !== meloRevision || !Array.isArray(manifest.files)) throw new Error('Invalid offline FP32 MeloTTS manifest')
  const declared = new Map(manifest.files.map((entry) => [entry.file, entry]))
  for (const expected of meloFiles) {
    const entry = declared.get(expected.file)
    if (!entry || entry.size !== expected.size || entry.sha256 !== expected.sha256) throw new Error(`Untrusted MeloTTS resource: ${expected.file}`)
    verifyFile(rootPath, expected)
  }
  const actual = voiceFileEntries(rootPath).filter((entry) => entry.file !== 'manifest.json')
  if (actual.length !== meloFiles.length || declared.size !== meloFiles.length || manifest.files.length !== declared.size) throw new Error('MeloTTS directory contains undeclared or redundant resources')
  return { meloFiles: actual.length, meloBytes: actual.reduce((sum, entry) => sum + entry.size, 0) }
}

export function verifyVoiceBundle({ platformKey = `${process.platform}-${process.arch}`, rootPath = voicePlatformRoot(platformKey), meloRootPath = meloBundleRoot, macSigningIdentity, macSignedAppPath, executeSigning = runMacCommand } = {}) {
  const asset = voiceRuntimeAssets[platformKey]
  if (!asset) throw new Error(`Unsupported offline speech platform: ${platformKey}`)
  const ttsRoot = path.join(rootPath, 'tts')
  const manifest = JSON.parse(fs.readFileSync(path.join(ttsRoot, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== platformKey || manifest.networkRequiredAtRuntime !== false || manifest.source?.sha256 !== asset.sha256 || manifest.source?.version !== asset.version || !Array.isArray(manifest.files)) throw new Error('Untrusted native offline TTS manifest')
  const declared = new Map(manifest.files.map((entry) => [entry.file, entry]))
  const expectedInventory = new Set([asset.binary, ...asset.libraryFiles, ...voiceLicenseAssets.map((entry) => `licenses/${entry.file}`), voiceThirdPartyNotices.file])
  if (manifest.files.length !== declared.size || declared.size !== expectedInventory.size || [...declared.keys()].some((file) => !expectedInventory.has(file))) throw new Error('Native TTS file inventory does not match the trusted resource catalog')
  let originals = declared
  if (manifest.packaging !== undefined || manifest.originalFiles !== undefined) {
    const packaging = manifest.packaging
    if (!platformKey.startsWith('darwin-') || !macSigningIdentity || !macSignedAppPath || packaging?.schemaVersion !== 1 || packaging?.kind !== 'macos-codesign' || packaging?.identitySha1 !== macSigningIdentity.identitySha1 || !Array.isArray(manifest.originalFiles)) throw new Error('Signed native TTS resources require the fixed signing identity and verified app context')
    const packagedToolsRoot = path.join(fs.realpathSync(macSignedAppPath), 'Contents', 'Resources', 'bundled-tools')
    if (fs.realpathSync(rootPath) !== packagedToolsRoot) throw new Error('Signed TTS resources must belong to the verified app bundle')
    // The manifest itself must be covered by the top-level resource seal; a
    // self-reported signer field does not authenticate transformed binaries.
    verifyMacSignedApp(macSignedAppPath, macSigningIdentity, { execute: executeSigning })
    originals = new Map(manifest.originalFiles.map((entry) => [entry.file, entry]))
    if (originals.size !== manifest.originalFiles.length || originals.size !== declared.size || [...originals.keys()].some((file) => !declared.has(file))) throw new Error('Signed TTS original file inventory is invalid')
    const transformedFiles = new Set(asset.files.map((entry) => entry.file))
    for (const [file, original] of originals) {
      const signed = declared.get(file)
      if (!Number.isSafeInteger(original.size) || original.size <= 0 || !/^[a-f0-9]{64}$/.test(original.sha256)) throw new Error('Signed TTS original resource metadata is invalid')
      if (!transformedFiles.has(file) && (signed.size !== original.size || signed.sha256 !== original.sha256)) throw new Error(`Non-native TTS resource changed during signing: ${file}`)
    }
  }
  for (const file of [asset.binary, ...asset.libraryFiles, ...voiceLicenseAssets.map((entry) => `licenses/${entry.file}`), 'THIRD_PARTY_NOTICES.txt']) if (!declared.has(file)) throw new Error(`Missing native TTS resource: ${file}`)
  for (const entry of manifest.files) verifyFile(ttsRoot, entry)
  for (const expected of asset.files) {
    const entry = originals.get(expected.file)
    if (entry?.sha256 !== expected.sha256 || entry?.size !== expected.size) throw new Error(`Untrusted native TTS binary: ${expected.file}`)
  }
  for (const license of voiceLicenseAssets) if (declared.get(`licenses/${license.file}`)?.sha256 !== license.sha256 || originals.get(`licenses/${license.file}`)?.sha256 !== license.sha256) throw new Error(`Untrusted speech license: ${license.file}`)
  const notices = originals.get(voiceThirdPartyNotices.file)
  if (notices?.sha256 !== voiceThirdPartyNotices.sha256 || notices?.size !== voiceThirdPartyNotices.size) throw new Error('Untrusted third-party speech notices')
  if (fs.existsSync(path.join(ttsRoot, 'moss')) || fs.existsSync(path.join(rootPath, 'stt', 'ggml-base.bin'))) throw new Error('Legacy MOSS or unquantized Whisper resources must not ship')
  // A packaged build places the independently verified shared model in tts/melo.
  const actual = voiceFileEntries(ttsRoot).filter((entry) => entry.file !== 'manifest.json' && !entry.file.startsWith('melo/'))
  if (actual.length !== declared.size || manifest.files.length !== declared.size) throw new Error('Native TTS directory contains undeclared resources')
  verifyFile(path.join(rootPath, 'stt'), whisperModel)
  const sttManifest = JSON.parse(fs.readFileSync(path.join(rootPath, 'stt', 'manifest.json'), 'utf8'))
  if (sttManifest.networkRequiredAtRuntime !== false || sttManifest.model?.precision !== 'q5_1' || sttManifest.model?.revision !== whisperRevision || sttManifest.model?.file !== whisperModel.file || sttManifest.model?.sha256 !== whisperModel.sha256 || sttManifest.model?.size !== whisperModel.size) throw new Error('Untrusted Whisper base Q5_1 manifest')
  return { ...verifyMeloBundle(meloRootPath), ttsFiles: declared.size, ttsBytes: actual.reduce((sum, entry) => sum + entry.size, 0), whisperBytes: whisperModel.size }
}
