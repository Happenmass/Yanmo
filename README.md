# 言墨 · Yanmo

**言语之间，自有笔墨。**

以中文表达为中心的本地语音输入工具，采用宣纸、墨色与朱砂视觉。0.4 开始使用 Electron + React 重建桌面端，Python 推理后端独立运行；当前已交付 Apple Silicon Mac 的 MLX 开发版本。

> A local-first, offline voice input app for macOS (Apple Silicon). Press FN, speak, and the text lands in whatever input box has focus — ASR (Qwen3-ASR + SenseVoice) and the cleanup LLM (Qwen3-4B) run entirely on your Mac via MLX.

[![宣传片](docs/promo-poster.jpg)](https://github.com/Happenmass/Yanmo/releases/latest/download/Yanmo-promo.mp4)

▶ [观看 32 秒宣传片](https://github.com/Happenmass/Yanmo/releases/latest/download/Yanmo-promo.mp4)

![主窗口](docs/design/main-window-v2.png)

## 下载安装

从 [Releases](https://github.com/Happenmass/Yanmo/releases/latest) 下载 `Yanmo-<版本>-mac-arm64.zip`，解压后把 `言墨.app` 拖入「应用程序」。要求 Apple Silicon、macOS 14+。

言墨是个人开源项目，未加入 Apple 开发者计划，应用为 ad-hoc 签名、未经 Apple 公证，首次打开会被 Gatekeeper 拦截。确认来源后任选一种方式放行：

- 终端执行：

  ```bash
  xattr -dr com.apple.quarantine /Applications/言墨.app
  ```

- 或先双击打开一次，在提示框点「完成」，再到「系统设置 → 隐私与安全性」底部点「仍要打开」，并输入密码确认。macOS 15 起右键「打开」不再能绕过拦截。

ad-hoc 签名每次构建都会变化，更新版本后若辅助功能显示已授权却无法使用，请在系统设置中移除旧条目后重新添加。

然后在「设置 → 本地模型」点击「准备模型」（默认从 ModelScope 下载约 5 GB 权重到用户全局缓存，仅此一步需要联网），并按提示授予麦克风与辅助功能权限。

## 当前版本

Mac 版保留原型的主要功能：

- 默认 FN 开始／结束语音输入，FN + Shift 口述翻译，FN + 空格划词翻译，Esc 取消；支持自定义多组快捷键和左右纯修饰键。键名使用 FN、Control、Option、Command、Shift；纯修饰键组合全部松开时触发，参与打字或鼠标组合时不触发。更新默认值不会覆盖已保存的自定义配置，设置中可逐项恢复默认。
- 静音的 200×36 pt 黑墨浮层，显示真实音量、计时、取消和完成；不抢走原输入框焦点。
- 本机 Qwen3-ASR 先识别并判断语言；中文、英文再用 SenseVoice Small 复核。两路对等结合上下文纠错，可在文稿中对照；数字按语义自然呈现，精确金额等优先使用阿拉伯数字。可关闭语气整理、保留原话或选择即时消息／文档风格。
- 转录和本地整理保留识别原文的语言：日语仍输出日语，混合语言逐段保留；中文上下文和翻译目标设置不会把转录改成中文。只有翻译模式转换语言。
- 口述翻译直接执行识别→翻译→写入；划词翻译在可拖动的独立宣纸窗口显示，按普通窗口层级切换，不替换选区、不保存历史。
- 两种翻译分别保存目标语言和快捷键，支持英语、简体中文、日语、德语。
- Markdown 译文排版／源码、代码着色和代码复制；围栏代码与行内代码由程序保护，不执行 HTML 或加载远程图片。
- 统计首页、20 周落笔日历、文稿搜索／编辑／复制／导出、个人词库及误识别纠正。
- 导入 5 分钟以内的音频、麦克风选择、历史保留周期和登录启动。关闭主窗口后隐藏程序坞图标，仅保留菜单栏及快捷键；菜单栏图标左键打开主窗口，右键打开菜单，重新打开窗口时按偏好恢复程序坞图标。
- 录音与输入框可读性分离；可读正文只作上下文，读取失败仍正常录音。
- 正文生成后向当时前台应用的当前焦点粘贴一次，允许途中切换应用、窗口和光标；文稿保留正文，导入音频仅生成文稿。
- 连续空闲 1 小时退出推理进程；录音开始后后台预加载，连续输入复用已加载模型。

模型下载来源默认 **ModelScope**，准备时先复用完整的全局缓存；日常推理不自动下载或上传输入。SenseVoice Small 共用一份多语言权重，按 Qwen 检测出的中文、英文分别指定 `zh`、`en`；其他语言或未知语言跳过复核。

Electron、Swift 系统桥接和独立 Python/MLX 运行时均随应用包交付，权重另存用户全局缓存。当前是 ad-hoc 签名的本机开发构建，尚未完成公证及干净机器验收。Mac 可明确启用 OpenAI 兼容的在线接口，默认仍走本机；Windows 本地推理改用原生 PyTorch（CUDA）与 transformers，无可用 CUDA 时推荐在线处理；运行库安装、模型准备与推理适配已实现（[运行时说明](docs/architecture/electron_01_Runtime_运行时与预检查.md)），Windows 系统桥接尚未接入，Windows 版暂不能启动。

[重构方案](docs/architecture/electron_00_Overview_顶层架构.md) · [本轮实现与验证](docs/electron-mac-2026-10-21.md)

## 构建与启动

使用环境：Apple Silicon、macOS 14+；构建需要 Node.js 24、npm、Xcode Command Line Tools、Python 3 与 uv。当前实测环境为 macOS 26.6.2 / arm64，其他系统版本尚未逐一验收。

```bash
npm ci
uv python install 3.12.12
npm run runtime:mac
npm run build
npm start
```

首次进入「设置 → 本地模型」，点击「准备模型」。默认从 ModelScope 准备；也可以选择 Hugging Face，或填写完整的本地模型目录。已有完整缓存会直接复用。准备阶段需要网络，处理录音时保持离线。

命令行准备模型：

```bash
runtime/macos/python/bin/python3.12 scripts/prepare-models.py
# 可选：--source huggingface --asr 模型ID --sensevoice 模型ID --llm 模型ID
```

构建包含运行时的应用：

```bash
npm run package:mac
open dist-electron/mac-arm64/言墨.app
```

产物 `dist-electron/mac-arm64/言墨.app` 可以移出项目目录运行，不需要另外安装 Python、uv 或 Homebrew。当前应用包约 830 MB，不含模型权重。发布到其他机器前仍需稳定签名、公证及系统权限验收。

旧 0.3 应用包已移除，当前只使用上述 0.4 应用。`./scripts/build.sh` 同样调用新版打包入口；原 SwiftUI 源码仅保留作迁移对照。

## 权限与使用

首次录音由 macOS 请求麦克风权限。FN、纯修饰键与跨应用写入需要在「系统设置 → 隐私与安全性 → 辅助功能」中允许当前的言墨应用；设置页提供权限入口与重新检查。

ad-hoc 开发签名随构建变化。若系统显示已授权但当前版本仍无法使用，请移除旧条目，重新添加当前应用，再点击重新检查。与其他使用 FN 的软件同时运行时，快捷键可能冲突。

按快捷键开始录音，正文生成后粘贴到当时的当前输入位置；期间可以切换应用、窗口、聊天或光标。输入框不可读时仍正常录音，只是不提供其正文作为上下文。结果同时保留为文稿；导入音频仅生成文稿。

划词翻译一次支持 4000 字以内的可复制文本。优先读取复制提供的 HTML 并转换为 Markdown，随后恢复剪贴板；无有效选区时不使用旧剪贴板。关闭译文窗口会清除本次原文与译文。

## 隐私、缓存与迁移

- 默认 ASR：`mlx-community/Qwen3-ASR-1.7B-8bit`（运行约占 3.5 GB 内存）；内存紧张时可在「设置 → 本地模型 → 语音识别规格」改选低内存的 `mlx-community/Qwen3-ASR-0.6B-8bit`（约 1.8 GB），嘈杂环境与外语准确率明显较低；中英复核：`mlx-community/SenseVoiceSmall`；文字模型：`mlx-community/Qwen3-4B-Instruct-2507-4bit`。SenseVoice 权重约 936 MB，首次准备时从 ModelScope 下载到全局缓存。
- ModelScope 缓存：`~/.cache/codex/models/modelscope/`，可通过 `MODELSCOPE_CACHE` 指定其他用户全局位置；同时复用 SDK 既有缓存与 `~/.cache/huggingface/`。不在项目和安装包中复制权重。
- Python 后端仅监听 `127.0.0.1` 动态端口，以每次启动的随机密钥认证；主进程通过私有管道取得端口。Renderer 不持有密钥或音频路径。
- 运行时设置 `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`，模型定位只使用本地缓存；显式准备模型在单独进程中执行。
- 录音、正文、词库和上下文默认留在本机；光标上下文默认关闭，启用后在录音开始时读取输入框光标前后各最多 300 字，同一快照用于 Qwen ASR 和纠错 LLM，不截图或 OCR。SenseVoice 独立识别，不接收文本提示；输入框不支持辅助功能读取时上下文为空。
- Electron 数据在 `~/Library/Application Support/Yanmo/electron/`；文件权限为 600，目录为 700，原子保存。
- 首次启动复制旧版 `library.json`、保存迁移备份，并导入 macOS UserDefaults 中的快捷键、语言及隐私设置；保留旧数据源。损坏文件暂停覆盖保存。
- 测试可用 `YANMO_DATA_DIR` 指定隔离数据目录，此时不导入个人数据。
- 临时音频在正常结束、取消或受控退出后删除；系统强制终止时仍可能残留在系统临时目录。

正文质量由提示词和模型负责：两路结合上下文纠错、保留转录原语言、翻译到指定语言，以及数字按语义自然呈现。模型只返回最终正文，程序原样采用；空输出、生成截断、取消和运行失败保留识别原文供重试。手动修改后，后续整理以用户修订为准。当前行为与评测入口见[双路识别与正文生成](docs/asr-fusion.md)。

## 开发与验证

```bash
npm test
npm run typecheck
runtime/macos/python/bin/python3.12 -m unittest discover -s engine -v
runtime/macos/python/bin/python3.12 -m unittest discover -s backend -v
runtime/macos/python/bin/python3.12 scripts/evaluate-fusion.py
runtime/macos/python/bin/python3.12 scripts/check-transcription-language.py
runtime/macos/python/bin/python3.12 scripts/check-translation-output.py --output /tmp/yanmo-translation-output.json
swift run YanmoChecks
swift run YanmoInputChecks
swift run YanmoLifecycleChecks
npm run test:desktop
```

不公开辅助功能输入控件的编辑器可用隔离窗口验证，需已有辅助功能授权；测试只粘贴合成文字，验证一次写入、切换窗口后写入新的当前焦点，并自动退出清理：

```bash
swift build -c release --product YanmoBridge
node --import tsx scripts/check-opaque-input.mts
```

只检查某个已运行应用能否保留录音目标（不读正文、不粘贴）：`node --import tsx scripts/check-input-capture.mts <bundle-id>`。`YANMO_QA_BRIDGE` 可指定打包后的 helper 路径。

真实模型界面检查使用合成音频及隔离文稿，不读取个人口述历史：

```bash
say -v Tingting -o /tmp/yanmo-synthetic.aiff '今天测试语音输入。预算三千五百元，周五交付，不是周四。'
YANMO_QA_AUDIO=/tmp/yanmo-synthetic.aiff npm run test:desktop
```

设置 `YANMO_QA_APP=/完整路径/言墨.app/Contents/MacOS/言墨` 可检查打包应用。`swift run YanmoShortcutChecks`直接检查监听函数，不向系统发送输入。可选的旧版 `YANMO_QA_NATIVE=1` TextEdit 组合脚本使用 AppleScript，本轮未执行；当前原生交互经 CUA 检查。自动化不代替实体 FN 口述验收。

桌面测试在隔离配置中默认关闭程序坞图标；只有显式设置 `YANMO_QA_DOCK=1` 才运行会反复切换程序坞的系统检查，避免常规回归影响当前桌面。测试结束后应确认没有遗留测试主进程。

关键入口：`desktop/controller.ts` 管理任务，`desktop/processes.ts` 管理子进程及通信，`Sources/YanmoBridge/` 管理系统能力，`backend/server.py` 提供认证 HTTP/SSE，`backend/pipeline.py` 组织推理，`engine/mlx_provider.py` 实现 MLX。原逐行 JSON worker 仍用于原生原型。

视觉与动效依据 [已确认设计](docs/design/README.md)。原生版本的 [输入验证](docs/verification-2026-10-21.md)、[翻译](docs/translation-0.3.md)、[Markdown](docs/markdown-translation-2026-10-21.md) 可作为迁移对照。

## 许可证

项目代码使用 [MIT License](LICENSE)。模型权重和第三方依赖遵循各自许可证；ASR与LLM权重不随代码或应用包分发，轻量离线语种分类器随Python依赖提供。
