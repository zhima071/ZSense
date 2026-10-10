# 本地语音组件的源码分发

本说明用于 ZSense Mac arm64 / Windows x64 安装包的公开分发。它是工程上的源码范围、来源与操作说明，不是法律意见或合规保证。

## 本轮采用的分发方式

采用 GPLv3 第 6(d) 条的网络分发方式：在安装包所在的同一 Release / 下载页面，紧邻安装包链接，提供免费、清楚的完整对应源码获取指引。完整源码可以位于第三方服务器，但发布者仍负责保证它持续可获取。不能只放项目首页、只附许可证，或说“需要时联系索取”。

`ZSense-<版本>-VOICE-SOURCE-DIRECTIONS.zip` 是固定源码下载指引、原始版权/许可证声明、构建/补丁配置及校验记录的补充资产，**不是完整离线对应源码包**。其 `SOURCE-DIRECTIONS.md` 逐项列出精确免费源码归档，`SOURCE-MANIFEST.json` 保存原始来源、固定版本/提交、上游哈希与 HTTP 检查记录。此 ZIP 同时是二进制分发随附的版权/许可材料，不能仅标成开发者可选源码附件。

Release 正文应明确写出：

> 安装包中的通用 TTS CLI 静态包含 GPLv3 eSpeak NG，不能按仅 Apache/MIT 的二进制分发。同页 `ZSense-<版本>-VOICE-SOURCE-DIRECTIONS.zip` 是随附版权/许可证材料，并提供免费完整对应源码及构建/平台补丁指引；其 `SOURCE-DIRECTIONS.md` 列出精确第三方源码下载入口。此附件不是完整离线源码包。发布者负责保持整个源码获取链可用；如上游入口失效，将补充等价免费镜像。

每个额外安装包下载页面也必须在下载链接旁放相同的清楚指引。仅上传 ZIP 而不在发布页说明其用途不满足本流程。

## 不能缩减为两个源码包

GPLv3 第 1 条的 Corresponding Source 包括生成、安装、运行与修改所需源码及控制这些活动的脚本，原则上也覆盖程序专门依赖的非系统共享库。当前一般用途 CLI 中 eSpeak 为静态组件，源码提供范围不是仅 `espeak-ng`：

| 范围 | 本轮精确来源 |
| --- | --- |
| 整体 CLI、接口、CMake、Mac/Windows release recipes | `k2-fsa/sherpa-onnx` v1.13.8，提交 `11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf` |
| 静态 eSpeak NG | `csukuangfj/espeak-ng` 提交 `ed530aa113046142eb5115cf2fc9157854d0ffe1`；上游 archive SHA256 `e4e262cbe34f7fe21f91f1ba3397f2728e1f30eafbae7853f2b753a9ed13f0dd` |
| Piper phonemize，包括其 uni-algo 源码 | `csukuangfj/piper-phonemize` 提交 `f3ff95afc03640bc1399e113e83361192a2fafb4`；上游 archive SHA256 `d9cca4e2bdc7d6dd8dffb96a4668283dbd3f77a9c194a3e530c1e8eba9406a5d` |
| 非系统 CLI 依赖 | 上述提交的 CMake 配置，加 kaldi-decoder v0.3.0 / kaldifst v1.8.0 的嵌套配置；包括 kaldi-native-fbank、sentencepiece、JSON、OpenFST、Eigen 等，不能遗漏嵌套下载 |
| fbank 的必需嵌套 KissFFT | `mborgerding/kissfft` 提交 `febd4caeed32e33ad8b2e0bb5ea77542c40f18ec`，上游 archive SHA256 `497103e664168ebe39580b757adbe616f6cf85a16572af581ca7bc42d0ab13fd` |
| Mac 完整 release recipe 的 PortAudio 构建依赖 | 官方 `https://files.portaudio.com/archives/pa_stable_v190700_20210406.tgz`，archive SHA256 `47efbf42c77c19a05d22e627d42873e991ec0c1357219c0d74ce6a2948cb2def`；offline-tts 目标本身不链接 PortAudio，Windows 配方关闭它 |
| 动态 ONNX Runtime | `microsoft/onnxruntime` v1.28.2，提交 `33ca9628233dc8f002435e868d4c2e9f82766ca1`；完整仓库源码、Git submodules 和 `cmake/deps.txt` 指定依赖 |
| 实际 ONNX Runtime 平台构建和补丁 | `csukuangfj/onnxruntime-libs` v1.28.2，提交 `5cc3d2e84d9eade2562cf29a93fa3a520a75ca57`；Mac `macos-shared.yaml` 会删除 `cmake/onnxruntime.cmake` 的 SOVERSION/VERSION 声明，Windows `windows-x64.yaml` 指定 shared / MT / Release 构建 |
| 本应用的打包变换 | 发布 checkout 的 `voice-assets.mjs`、资源准备、打包和 Mac 签名脚本；没有私钥或账号凭据 |

ONNX Runtime GitHub 源码归档不包含 Git submodules。指引单列 `.gitmodules` 的准确位置和 gitlink 提交，包括 ONNX `2bb50465112feca9003e1ed654d77f01ff1415ca`、libprotobuf-mutator `7a2ed51a6b682a83e345ff49fc4cfd7ca47550db`、emsdk `c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56`。后两者是可选测试/构建工具，不代表其代码都进入本轮 CPU 产物。依赖表保守列出可选 provider 源码，但不下载 GPU SDK、模型或编译后的运行库。

Mac ONNX Runtime 使用 CoreML 构建，并有上述版本属性补丁；Windows 使用 Visual Studio 2022 shared build 和静态 MSVC runtime。因此单附 Microsoft 源码而省去 vendor 构建控制也不完整。

ZSense 以独立子进程调用 CLI，并通过参数/WAV 交互，没有将该 CLI 直接链接为 Electron 库。这支持将应用与 CLI 分开考察，但本说明不对 aggregate / combined work 的法律分类作保证。各组件原始许可证仍须保留；整体含 GPL 组件的可执行文件不能只标 Apache/MIT。

## 原始版权与许可证补充

原有安装包中的 13 项语音许可证保持不变。本附件另从上述固定依赖版本复制以下 4 份原文，并以固定 SHA256 核验；不重写版权、换行或 UTF-8 BOM，不改运行资源、ASAR 或安装包：

- `licenses/kissfft/COPYING`：2003–2010 Mark Borgerding 的真实版权声明。
- `licenses/kissfft/LICENSES/BSD-3-Clause`：与 `COPYING` 一并保留原始目录关系。BSD 第 2 条要求二进制分发的文档或其他随附材料载明版权、条件与免责；第 3 条禁止未经许可用权利人/贡献者名称背书。不能只附带 `<year> <owner>` 的许可证模板而漏掉真实版权。
- `licenses/hclust-cpp/LICENSE`：原始 BSD-2-Clause，含 Daniel Müllner（2011）与 Christoph Dalitz（2018）的版权。它属于 release 默认启用 diarization 的构建图；静态 core 不代表其中所有对象都进入 offline-TTS，故按构建范围保守补充。
- `licenses/cargs/LICENSE.md`：原始 MIT，版权 2022 Leonard Iklé。它覆盖 C API examples 的构建依赖，不声称它链接进 offline-TTS。

每个安装包下载页必须清楚标注并提供同版版权/许可附件，作为随二进制分发的材料持续保留。本轮没有逐项判断所有可选 provider 的二进制组成，不保证任意上游构建选项均已完成许可审计。

## 生成发布附件

在已准备好原始语音许可证的发布 checkout 中运行：

```sh
node scripts/prepare-voice-corresponding-source.mjs --version=0.26.11
```

或用 `--output=/绝对路径` 指定专用制品目录。已有同名资产不会覆盖。生成器只抓取固定官方代码/配置、原始许可声明、源码依赖元数据和构建脚本，并核对现有及补充许可证的固定 SHA256；每个响应最多 2 MiB、下载元数据总量最多 12 MiB。源码归档只作 HEAD 可复制性检查，不下载归档正文或语音模型。需要 `curl` 和 `zip`。

输出是单独的许可必要资产，不是额外安装包种类。生成器打印 ZIP 大小、SHA256、源码入口检查数和 `completeOfflineCorrespondingSource:false`；先在输出目录的独立临时目录生成并用 `unzip -tq` 校验，再以排他硬链接原子发布，不覆盖并行生成的同名资产。输出文件系统须支持硬链接，且需要 `unzip`。发布前核对 ZIP 清单、保存该摘要，在 Release 正文按前述方式说明并上传附件。

## 验证范围与后续责任

- HTTP 200 HEAD 只证明当时可免费访问该源码下载入口，不证明所有归档内容已下载校验，也不等价于完成二进制复现。
- 依赖哈希来自固定上游 CMake / deps 文件；附件保存这些原文和 SHA256。尚未实际下载的归档不能声称已经独立哈希验证。
- 发布者须持续提供完整源码访问。第三方入口失效时，需要把相应精确源码及构建控制补到同页/等价免费镜像；不能把责任推给上游。
- 不得用安装器 EULA 或额外条款收回 covered CLI 的 GPL 权利。若未来修改 CLI 源码，也要提供完整修改/补丁，不能沿用“上游未修改”的说明。
- macOS 代码签名会改变签名/二进制字节；单独重建和运行用户修改的 CLI 不需要本应用的私有签名密钥。把修改版放回完整性校验的 ZSense bundle 则涉及同步 manifest / 签名，不能声称应用接受任意替换。若将软件与受限制的实体 User Product 一并交付，应另行评估 GPLv3 的 Installation Information 要求。
- 若交付目标要求不依赖任何第三方服务器，则必须另做真正完整的离线 Corresponding Source 分发：至少纳入整体 CLI、所有非系统依赖、完整 ONNX Runtime 源码/子模块/所需依赖、平台构建补丁和操作说明。本轮指引附件不能冒充该离线包。

权威条款为随包 `COPYING.espeak-ng` 中的 GPLv3 第 1 条（源码范围）、第 5 条（aggregate）与第 6(d) 条（同页源码指引）。
