import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { voiceLicenseAssets, voiceRuntimeAssets } from './voice-assets.mjs'

// This creates a GPLv3 6(d) source-DIRECTIONS supplement, not an offline CCS
// archive. It never fetches model weights, executable archives, or SDKs.
const run = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sherpaCommit = '11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf'
const ortCommit = '33ca9628233dc8f002435e868d4c2e9f82766ca1'
const ortVendorCommit = '5cc3d2e84d9eade2562cf29a93fa3a520a75ca57'
const sha256 = (body) => crypto.createHash('sha256').update(body).digest('hex')
const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = /^--(version|output)=(.+)$/u.exec(argument)
  if (!match) throw new Error(`Unknown argument: ${argument}`)
  return [match[1], match[2]]
}))
const version = options.version || JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u.test(version)) throw new Error('Invalid release version')
if (Object.values(voiceRuntimeAssets).some((asset) => asset.version !== '1.13.8')) throw new Error('Review source pins before changing the native TTS version')
const outputRoot = path.resolve(options.output || path.join(projectRoot, 'release'))
const archivePath = path.join(outputRoot, `ZSense-${version}-VOICE-SOURCE-DIRECTIONS.zip`)
if (fs.existsSync(archivePath)) throw new Error(`Refusing to overwrite ${archivePath}`)
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'zsense-voice-source-directions-'))
const metadata = []
const sourceArchives = []
const captured = new Map()
const checkedAt = new Date().toISOString()
let fetchedBytes = 0
let archiveStage = null

function permittedUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['raw.githubusercontent.com', 'api.github.com', 'github.com', 'codeload.github.com', 'gitlab.com', 'files.portaudio.com'].includes(url.hostname)) throw new Error(`Unexpected source host: ${value}`)
  return url.href
}

async function retrieve(url) {
  permittedUrl(url)
  const { stdout } = await run('curl', ['--location', '--fail', '--silent', '--show-error', '--retry', '1', '--max-time', '30', '--max-filesize', '2097152', url], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })
  fetchedBytes += stdout.length
  if (fetchedBytes > 12 * 1024 * 1024) throw new Error('Source metadata download exceeded the 12 MiB bound')
  return stdout
}

async function capture(destination, url) {
  const body = await retrieve(url)
  captured.set(destination, body)
  metadata.push({ file: destination, url, size: body.length, sha256: sha256(body) })
  return body.toString('utf8')
}

async function boundedMap(items, mapper) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await mapper(item)
    }
  }))
}

function directCopyUrl(original) {
  const url = new URL(original)
  const match = /^\/([^/]+)\/([^/]+)\/archive\/(.+)$/u.exec(url.pathname)
  if (url.hostname !== 'github.com' || !match) return original
  let reference = match[3].replace(/\.(?:tar\.gz|zip)$/u, '')
  // deps.txt occasionally gives an extra descriptive archive filename after SHA.
  if (/^[a-f0-9]{40}\//u.test(reference)) reference = reference.slice(0, 40)
  const kind = original.endsWith('.zip') ? 'zip' : 'tar.gz'
  return `https://codeload.github.com/${match[1]}/${match[2]}/${kind}/${reference}`
}

function addArchive(id, url, hash = null, origin = '', upstreamConfiguredUrl = url) {
  permittedUrl(url)
  const copyUrl = directCopyUrl(url)
  if (sourceArchives.some((entry) => entry.url === url)) return
  sourceArchives.push({ id, url, copyUrl, expectedArchiveHash: hash, origin, upstreamConfiguredUrl })
}

function cmakeSources(file, text) {
  const definitions = [...text.matchAll(/set\(([\w-]+)_URL\s+"(https?:[^"]+)"\)/gu)]
  for (const [, variable, url] of definitions) {
    if (!/(?:\/archive\/|\/-\/archive\/|\.(?:zip|tar\.gz|tgz)$)/u.test(url)) continue
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const hash = new RegExp(`set\\(${escaped}_HASH\\s+"SHA256=([a-f0-9]{64})"\\)`, 'u').exec(text)?.[1]
    if (!hash) throw new Error(`Unpinned source archive in ${file}: ${url}`)
    // Upstream PortAudio still spells its official source URL with HTTP. Use
    // the same official archive over HTTPS and preserve that spelling as data.
    const copySourceUrl = url.startsWith('http://files.portaudio.com/') ? url.replace('http:', 'https:') : url
    addArchive(`${file.replaceAll('/', '-')}:${variable}`, copySourceUrl, { algorithm: 'sha256', value: hash }, file, url)
  }
}

async function verifyCopyAccess(entry) {
  const { stdout } = await run('curl', ['--head', '--location', '--fail', '--silent', '--show-error', '--retry', '1', '--max-time', '30', '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{json}', entry.copyUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 })
  const response = JSON.parse(stdout)
  if (response.http_code !== 200) throw new Error(`Source copying unavailable: ${entry.copyUrl}`)
  entry.access = { checkedAt, status: response.http_code, finalUrl: response.url_effective, method: 'HEAD', archiveBodyDownloaded: false }
}

try {
  addArchive('sherpa-onnx-1.13.8', `https://github.com/k2-fsa/sherpa-onnx/archive/${sherpaCommit}.tar.gz`, null, 'official release v1.13.8')
  addArchive('onnxruntime-1.28.2', `https://github.com/microsoft/onnxruntime/archive/${ortCommit}.tar.gz`, null, 'official release v1.28.2; also obtain submodules and deps below')
  addArchive('onnxruntime-vendor-build-and-patch', `https://github.com/csukuangfj/onnxruntime-libs/archive/${ortVendorCommit}.tar.gz`, null, 'official vendor of the ONNX Runtime binaries selected by sherpa')

  const sherpaFiles = ['CMakeLists.txt', 'sherpa-onnx/csrc/CMakeLists.txt', '.github/workflows/macos.yaml', '.github/workflows/windows-x64.yaml', 'cmake/download-all-deps.py', ...['espeak-ng-for-piper', 'piper-phonemize', 'kaldi-native-fbank', 'kaldi-decoder', 'simple-sentencepiece', 'json', 'openfst', 'eigen', 'hclust-cpp', 'cargs', 'portaudio', 'asio', 'websocketpp', 'pybind11', 'googletest', 'onnxruntime-osx-arm64', 'onnxruntime-win-x64'].map((name) => `cmake/${name}.cmake`)]
  await boundedMap(sherpaFiles, async (file) => {
    const text = await capture(`upstream/sherpa-onnx/${file}`, `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/${sherpaCommit}/${file}`)
    if (file.endsWith('.cmake') && !file.startsWith('cmake/onnxruntime-')) cmakeSources(`sherpa-onnx/${file}`, text)
  })
  const nestedFiles = [
    ['kaldi-native-fbank', 'csukuangfj/kaldi-native-fbank', 'v1.22.3', 'CMakeLists.txt'],
    ['kaldi-native-fbank', 'csukuangfj/kaldi-native-fbank', 'v1.22.3', 'cmake/kissfft.cmake'],
    ['kaldi-decoder', 'k2-fsa/kaldi-decoder', 'v0.3.0', 'CMakeLists.txt'],
    ['kaldi-decoder', 'k2-fsa/kaldi-decoder', 'v0.3.0', 'cmake/kaldifst.cmake'],
    ['kaldi-decoder', 'k2-fsa/kaldi-decoder', 'v0.3.0', 'cmake/eigen.cmake'],
    ['kaldifst', 'k2-fsa/kaldifst', 'v1.8.0', 'CMakeLists.txt'],
    ['kaldifst', 'k2-fsa/kaldifst', 'v1.8.0', 'cmake/openfst.cmake'],
    ['piper-phonemize', 'csukuangfj/piper-phonemize', 'f3ff95afc03640bc1399e113e83361192a2fafb4', 'CMakeLists.txt'],
    ['simple-sentencepiece', 'pkufool/simple-sentencepiece', 'v0.7', 'CMakeLists.txt'],
    ['kissfft', 'mborgerding/kissfft', 'febd4caeed32e33ad8b2e0bb5ea77542c40f18ec', 'CMakeLists.txt'],
  ]
  await boundedMap(nestedFiles, async ([name, repo, ref, file]) => {
    const text = await capture(`upstream/${name}/${file}`, `https://raw.githubusercontent.com/${repo}/${ref}/${file}`)
    if (file.endsWith('.cmake') || file.endsWith('CMakeLists.txt')) cmakeSources(`${name}/${file}`, text)
  })
  for (const file of ['.github/workflows/macos-shared.yaml', '.github/workflows/windows-x64.yaml']) await capture(`upstream/onnxruntime-vendor/${file}`, `https://raw.githubusercontent.com/csukuangfj/onnxruntime-libs/${ortVendorCommit}/${file}`)
  const ortDeps = await capture('upstream/onnxruntime/cmake/deps.txt', `https://raw.githubusercontent.com/microsoft/onnxruntime/${ortCommit}/cmake/deps.txt`)
  await capture('upstream/onnxruntime/.gitmodules', `https://raw.githubusercontent.com/microsoft/onnxruntime/${ortCommit}/.gitmodules`)
  for (const line of ortDeps.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const [name, url, hash] = line.split(';')
    // protoc is a general-purpose build-tool binary, not a source archive. The
    // complete protobuf source is included separately in the upstream table.
    if (name.startsWith('protoc_')) continue
    if (!/^[a-f0-9]{40}$/u.test(hash || '')) throw new Error(`Unpinned ONNX dependency ${name}`)
    addArchive(`onnxruntime-dependency:${name}`, url, { algorithm: 'sha1', value: hash }, 'onnxruntime/cmake/deps.txt; optional providers also listed, not all built into these CPU binaries')
  }
  const submodules = [
    ['cmake/external/onnx', 'onnx/onnx', '2bb50465112feca9003e1ed654d77f01ff1415ca'],
    ['cmake/external/libprotobuf-mutator', 'google/libprotobuf-mutator', '7a2ed51a6b682a83e345ff49fc4cfd7ca47550db'],
    ['cmake/external/emsdk', 'emscripten-core/emsdk', 'c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56'],
  ]
  await boundedMap(submodules, async ([file, repo, commit]) => {
    const response = JSON.parse(await capture(`upstream/onnxruntime/submodule-${path.basename(file)}.json`, `https://api.github.com/repos/microsoft/onnxruntime/contents/${file}?ref=${ortCommit}`))
    if (response.sha !== commit || response.submodule_git_url !== `https://github.com/${repo}.git`) throw new Error(`ONNX submodule pin changed: ${file}`)
    addArchive(`onnxruntime-submodule:${file}`, `https://github.com/${repo}/archive/${commit}.tar.gz`, null, `gitlink ${file} at ONNX Runtime ${ortCommit}; emsdk and mutator are optional build/test tooling`)
  })

  const licenseRoot = path.join(projectRoot, 'bundled-tools', 'darwin-arm64', 'tts', 'licenses')
  for (const license of voiceLicenseAssets) {
    const body = fs.readFileSync(path.join(licenseRoot, license.file))
    if (sha256(body) !== license.sha256) throw new Error(`License checksum mismatch: ${license.file}`)
    const file = `licenses/${license.file}`
    captured.set(file, body)
    metadata.push({ file, url: license.url, size: body.length, sha256: license.sha256, alreadyBundledLicense: true })
  }
  for (const file of ['scripts/voice-assets.mjs', 'scripts/prepare-voice-assets.mjs', 'scripts/mac-sign-voice-assets.mjs', 'scripts/mac-signing.mjs', 'scripts/desktop-build.mjs']) {
    const body = fs.readFileSync(path.join(projectRoot, file))
    const destination = `zsense-packaging/${file}`
    captured.set(destination, body)
    metadata.push({ file: destination, size: body.length, sha256: sha256(body), origin: 'exact ZSense release checkout; packaging/relocation/codesign control, not a patch to TTS source' })
  }
  await boundedMap(sourceArchives, verifyCopyAccess)
  const manifest = { schemaVersion: 1, releaseVersion: version, distributionMode: 'GPL-3.0-section-6d-directions', completeOfflineCorrespondingSource: false, checkedAt,
    sourcePins: { sherpa: { version: '1.13.8', commit: sherpaCommit }, onnxruntime: { version: '1.28.2', commit: ortCommit }, onnxruntimeVendorBuild: { version: '1.28.2', commit: ortVendorCommit } },
    distributedBinaries: voiceRuntimeAssets, copiedMetadataBytes: fetchedBytes, metadata, sourceArchives,
    verificationLimits: ['HEAD verifies free source-archive copying access, not archive contents or a rebuilt binary.', 'CMake/deps hashes are upstream expected hashes; complete source archives were not downloaded here.', 'The publisher must keep the entire source chain available; a ZIP of directions is not offline CCS or a legal compliance guarantee.'] }
  const rows = sourceArchives.map((entry) => `| ${entry.id} | [Exact source archive](${entry.copyUrl}) | ${entry.expectedArchiveHash ? `${entry.expectedArchiveHash.algorithm}: ${entry.expectedArchiveHash.value}` : 'Pinned Git commit; archive body not downloaded'} |`).join('\n')
  const directions = `# ZSense ${version}: native speech corresponding-source directions\n\nThis supplement accompanies the Mac arm64 and Windows x64 installers. It is **not a complete offline Corresponding Source archive**. Under GPLv3 section 6(d), the complete source is offered free of charge through the exact archive links below, including the CLI, non-system dependencies and build/patch instructions. Publish a clear link to this supplement beside every installer on the same release/download page. The distributor remains responsible for source availability. This is engineering provenance and source-access information, not a legal compliance guarantee.\n\n## What is covered\n\nsherpa-onnx-offline-tts statically incorporates eSpeak NG (GPLv3). Do not describe the combined executable as Apache/MIT-only, and do not supply only the eSpeak subtree. The CLI's full sherpa source, Piper source, all non-system dependency sources, ONNX Runtime source, its submodules and dependencies, and the vendor's Mac patch/build control are provided below. Individual upstream component licenses remain in licenses/. ZSense invokes the CLI in a separate child process; aggregate/combined-work classification is not a legal determination made by this tool.\n\n## Exact build and installation control\n\n- sherpa v1.13.8 commit: ${sherpaCommit}. Complete CMake build files are in its source archive; captured upstream/sherpa-onnx/.github/workflows/{macos,windows-x64}.yaml are the actual release recipes. Mac: Release, TTS=ON, BUILD_SHARED_LIBS=ON, upstream universal2 build thinned to arm64. Windows: Release, x64, TTS=ON, BUILD_SHARED_LIBS=ON, SHERPA_ONNX_USE_STATIC_CRT=ON, PORTAUDIO=OFF (shared-MT-Release).\n- ONNX Runtime v1.28.2 commit: ${ortCommit}. Obtain its source, all required submodules and deps from this table. Its cmake/deps.txt is included unabridged; optional provider/test sources are deliberately also listed, without downloading GPU SDKs or binaries.\n- The ONNX Runtime vendor is csukuangfj/onnxruntime-libs commit ${ortVendorCommit}. Captured macos-shared.yaml and windows-x64.yaml give the build commands; set ONNXRUNTIME_VERSION=1.28.2. Mac uses CoreML and deletes SOVERSION/VERSION declarations from cmake/onnxruntime.cmake before building. Windows uses the ONNX shared build with --enable_msvc_static_runtime for MT. Microsoft source alone omits this vendor build/patch control.\n- GitHub source archives omit Git submodules. Put the separately listed submodule source trees at the exact paths in upstream/onnxruntime/.gitmodules, or checkout ${ortCommit} and run git submodule update --init --recursive. Keep the exact gitlink revisions. Build via tools/ci_build/build.py using the captured vendor recipe; it downloads dependency versions/hashes from the included cmake/deps.txt. No deployed speech model is needed to modify or rebuild the CLI.\n- ZSense's original checksums, extraction/relocation, manifest preparation and macOS signing control are included under zsense-packaging/. Code signing changes binary/signature bytes; it is not a TTS source-code patch. Private signing credentials are not in this archive. Users can build and run their modified CLI independently with their own or ad-hoc signature; no ZSense signing key is needed for standalone execution. Installation into an integrity-checked ZSense bundle requires rebuilding its matching manifest/signature and cannot be claimed to accept arbitrary replacement binaries.\n\n## Free exact source copying locations\n\nAccess checks: ${checkedAt}. Every copy URL returned HTTP 200 to a HEAD request. Upstream archive hashes are recorded, not claimed freshly verified by downloading the archive bodies. The manifest preserves original upstream URLs, hashes, copy URLs and all checks.\n\n| Component | Free source copying location | Upstream pin/hash |\n| --- | --- | --- |\n${rows}\n\n## Publication requirement\n\nKeep these directions immediately beside the executable download links, not only hidden inside an installer. Mirror the corresponding sources if any third-party URL stops offering equivalent free access. Preserve upstream copyrights, license texts and notices, and do not apply an installer EULA that takes away the covered executable's GPL rights. The GPL copy in licenses/COPYING.espeak-ng defines Corresponding Source in section 1 and the same-place/different-server method in section 6(d). No written-offer shortcut or promise to provide source only on request is used here.\n`
  captured.set('SOURCE-DIRECTIONS.md', Buffer.from(directions))
  captured.set('SOURCE-MANIFEST.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  captured.set('DISTRIBUTION-GUIDE.md', fs.readFileSync(path.join(projectRoot, 'docs', 'voice-source-distribution.md')))
  for (const [file, body] of captured) {
    const destination = path.join(stage, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, body)
  }
  fs.mkdirSync(outputRoot, { recursive: true })
  archiveStage = fs.mkdtempSync(path.join(outputRoot, '.voice-source-directions-'))
  const stagedArchivePath = path.join(archiveStage, path.basename(archivePath))
  await run('zip', ['-q', '-r', stagedArchivePath, '.'], { cwd: stage, maxBuffer: 1024 * 1024 })
  await run('unzip', ['-tq', stagedArchivePath], { maxBuffer: 1024 * 1024 })
  const archive = fs.readFileSync(stagedArchivePath)
  // Exclusive hard-link publication is atomic on this same filesystem. Two
  // publishers cannot update one another's ZIP or expose a half-written ZIP.
  fs.linkSync(stagedArchivePath, archivePath)
  console.log(JSON.stringify({ ok: true, archivePath, size: archive.length, sha256: sha256(archive), sourceArchives: sourceArchives.length, checkedSourceCopyUrls: sourceArchives.filter((entry) => entry.access?.status === 200).length, metadataFiles: metadata.length, metadataBytesDownloaded: fetchedBytes, completeOfflineCorrespondingSource: false, distributionMode: manifest.distributionMode }))
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
  if (archiveStage) fs.rmSync(archiveStage, { recursive: true, force: true })
}
