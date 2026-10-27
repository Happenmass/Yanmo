# 言墨 P0/P1：运行时、预检查与 Windows PyTorch 推理

版本：v0.3；日期：2026-10-23；上游：[双平台重构方案](electron_00_Overview_顶层架构.md) §8.5、§10、§12。

用户决定（2026-10-23）：Windows 不再使用 vLLM/WSL2，改用原生 Windows Python 上的 PyTorch（CUDA）与 transformers 作为本地推理后端。v0.2 的 WSL 发行版、`provision.sh` 及 vLLM 锁文件已删除。

本文固定预检查顺序、状态判定、Windows 无 CUDA 分流、PyTorch 运行库安装、模型准备与推理适配。Mac 内置 MLX 最小包已在 [Mac 实施记录](../electron-mac-2026-10-21.md) 完成，本文只补充其状态映射。

实施状态（2026-10-23）：以上均已实现并有单元测试；PyTorch 推理适配已在本机（Apple Silicon，MPS）用 Windows 默认模型实跑（§6）。尚未在 Windows/CUDA 实机运行。Windows 系统桥接属于 P2，在其接入前 Windows 版不能启动，运行库与模型先通过独立脚本在实机准备。

## 1. 范围

| 本阶段做 | 本阶段不做 |
|---|---|
| Windows GPU 与本地运行库的分步检查，输出可操作状态 | Win32 helper、快捷键与写入（P2） |
| 无可用 CUDA 时推荐在线 API，配置前不上传、不加载本地模型 | Windows 安装包、签名与内置 Python 的打包（P4） |
| 按带哈希的锁文件安装 PyTorch CUDA 运行库，再下载 transformers 格式模型 | SenseVoice 双路复核在 Windows 上的实现 |
| PyTorch 推理适配（ASR 与文字生成），与 MLX 共用任务协议与提示词 | 新的设置界面；新增界面先按 `docs/design/` 做视觉确认 |

## 2. 状态

两平台共用一个状态值，挂在 `AppState.runtime`；判定为纯函数 `decideRuntime`（`desktop/precheck.ts`）。

| 状态 | 含义 | 用户可见处理 |
|---|---|---|
| `checking` | 尚未得到环境结果 | 等待，不阻断已启用的在线处理 |
| `local-ready` | 两项能力均在本机可用 | 正常使用 |
| `models-pending` | 本地环境通过，模型未准备 | 提供下载模型入口 |
| `local-repair` | 有受支持的 GPU，但运行库未安装、需要更新或无法使用 CUDA | 提供「准备运行环境」，同时可配置在线 API |
| `recommend-online` | 本机不具备受支持的本地推理条件，且未启用在线 | 引导到设置配置在线识别与文字处理 |
| `api-pending` | 无本地条件，只启用了其中一项在线能力 | 指出仍缺的能力 |
| `online-ready` | 两项能力均可处理，其中至少一项在线 | 正常使用，界面显示「已开启在线处理」 |

能力逐项判定（ASR、文字生成）：用户已启用在线 → `online`；否则本地环境通过且该项模型就绪 → `local`；其余为 `unavailable`。Mac 的本地 ASR 需要 Qwen3-ASR 与 SenseVoice 两份缓存，Windows 只需 Qwen3-ASR。语音输入和口述翻译需要两项能力；划词翻译与手动整理只需文字生成。

预检查只改变状态，不修改用户的在线/本地选择。

## 3. Windows 检查顺序

每步失败即停止并给出该步结论，后续步骤不执行。命令均为只读查询。

| 步骤 | 命令 | 判定 | 失败时状态 |
|---|---|---|---|
| 1 架构 | `os.arch()` | `x64` | 不支持（→ 推荐在线） |
| 2 GPU | `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits`；旧驱动不支持 `compute_cap` 时去掉该字段重试 | 至少一块 NVIDIA GPU；已知算力需 ≥ 7.5（锁定的 PyTorch 为 CUDA 13.0 构建，CUDA 13 不再支持 Maxwell/Pascal/Volta）。多卡取符合条件中显存最大者 | 不支持（→ 推荐在线） |
| 3 运行库 | 读取 `%LOCALAPPDATA%\\Yanmo\\runtime\\lock.sha256` | 存在且等于应用随附锁文件的 SHA-256，`Scripts\\python.exe` 存在 | 待修复：运行库尚未安装或需要更新 |
| 4 CUDA | `<运行库 python> -c "import torch; …"` | `torch.cuda.is_available()` 为真 | 待修复：更新 NVIDIA 驱动后重新检测 |

宿主 `nvidia-smi` 只用于判断「有没有值得尝试的 GPU」；驱动是否满足 CUDA 13 以第 4 步的实际执行为准，不比较驱动版本号，也不以系统是否安装 CUDA Toolkit 判定。系统版本不作为阻断条件；Windows 11 x64 是首批验证目标。

## 4. 无 CUDA → 在线分流

| 规则 | 实现位置 |
|---|---|
| Windows 不调用 MLX 状态检查，模型完整性用运行库 Python 检查 | `Controller.checkModels`、`checkWindowsModels` |
| 本地 ASR 不是 `local` 时不发起后台预加载 | `Controller.perform` |
| 所需能力为 `unavailable` 时不开始录音或翻译，打开设置页并说明缺少哪一项，提示配置前不会上传 | `Controller.begin` |
| 运行库未就绪时拒绝下载模型 | `main.ts prepareModels` |
| 后端解释器随预检查切换：运行库就绪用其 Python（本地推理），否则用随应用的网关 Python（仅在线） | `main.ts`、`BackendClient.usePython` |

在线端点「已启用且填写了地址与模型」即视为已配置；连通性在第一次任务中验证，失败时按现有错误语义保留原文、不写入。

Mac 不受这些门槛影响：仍按原流程在任务中报告缺失模型，只增加 `runtime` 状态与 Metal 不可用时的 `local-repair`。

## 5. Windows 运行时组件

| 组件 | 内容 | 位置 | 状态 |
|---|---|---|---|
| 网关 Python | 独立 Python 3.12 + `backend/requirements-gateway.in`（FastAPI、uvicorn、multipart、httpx、soundfile、langid），约 19 MB | 随应用：`python/python.exe`，开发时 `runtime/windows/python/` | 依赖已锁定于 `backend/requirements-windows.lock`；打包属 P4 |
| PyTorch 运行库 | venv：torch `2.14.1+cu130`、transformers 5.20.2、accelerate、bitsandbytes 0.50.2、modelscope 及网关依赖 | `%LOCALAPPDATA%\\Yanmo\\runtime`，用户点击「准备运行环境」时安装 | 锁定于 `runtime/windows/requirements.lock`（60 个包） |

2026-10-23 测量：PyTorch 运行库下载约 2.1 GB，其中 Windows CUDA 版 torch 1.99 GB（PyPI 上的 Windows torch 只有 CPU 版，CUDA 版来自 PyTorch 官方索引及其镜像）。langid 只有源码包，pip 安装时现场构建（纯 Python）。

## 6. 验证

| 检查 | 方法 | 结果 |
|---|---|---|
| 状态判定与 Windows 探测矩阵 | `desktop/tests/precheck.test.ts`：非 x64、无 GPU、算力不足（含 Volta 7.0）、旧驱动无 `compute_cap`、运行库缺失或与锁文件不符、CUDA 不可用、运行库无法启动、全部通过；在线配置组合 | 通过（伪造命令输出） |
| Windows 在线门槛 | `desktop/tests/controller.test.ts`：未配置时不录音并指向设置，配置后按在线处理 | 通过 |
| 运行库安装流程 | `desktop/tests/windows-runtime.test.ts`：不支持的 GPU 不安装；以网关 Python 运行安装脚本并验证；已就绪不重复；锁文件更新后判为需更新；安装错误原样报告；模型检查参数与解析 | 通过（伪造命令） |
| 安装脚本 | `runtime/windows/test_setup_runtime.py`：镜像依次回退、`--require-hashes`、完成标记最后写入、清空 pip 缓存、重复运行跳过、全部失败不留标记 | 通过（伪造 pip） |
| 推理适配 | `engine/test_torch_provider.py`：SenseVoice 复核只在提供方实现时触发；原始解码去掉 `<|im_end|>` 等特殊符号并保留语言协议；音频转为 16 kHz 单声道 | 通过 |
| 推理实跑 | Mac MPS 上用 Windows 默认模型经真实后端运行 4 个合成用例，见 §8.3 | 4/4 通过（非 CUDA） |
| Windows 实机 | `npx tsx scripts/check-windows-runtime.mts` 与 `setup-windows-runtime.mts` | 待在实机运行 |

实机矩阵至少覆盖：无 NVIDIA GPU；算力 < 7.5 的 GPU；运行库未安装；运行库已安装但驱动过旧；8 GB 显存下两模型同时驻留的显存与延迟。

## 7. 待定

1. 8 GB 显存下两模型常驻的实际占用与延迟，需 Windows 实机测量。
2. 在线 API 首批服务与连通性检测方式，在真实服务验收时固定。
3. Windows 是否需要 SenseVoice 复核（需另加 FunASR 一类依赖），按实机识别质量决定。

## 8. Windows 运行环境与模型

Windows 本地模式分两步，界面依次给出「准备运行环境」和「下载模型」；前一步未就绪时不提供后一步。预检查结果为「不支持」时不安装任何组件，继续推荐在线处理。不需要管理员权限，也不需要重启。

### 8.1 运行库安装（`runtime/windows/setup_runtime.py`）

由应用以随附的网关 Python 运行，只用标准库：

1. 完成标记与当前锁文件哈希一致时直接结束。
2. 先删除完成标记，用网关 Python 创建 venv。
3. `pip install --require-hashes -r requirements.lock`，索引组合依次尝试：清华 PyPI + 南京大学 PyTorch 镜像、清华 PyPI + 上海交大 PyTorch 镜像、官方 PyPI + PyTorch 官方索引。
4. 成功后写入完成标记，清空 pip 缓存；全部失败时报下载失败，pip 缓存保留已下载的包供重试。

安装后由 §3 第 4 步再次验证 CUDA。中途退出时 pip 子进程可能继续运行直到完成；完成标记最后写入，未完成的安装不会被判为就绪。

### 8.2 模型准备

用运行库 Python 在应用资源目录运行现有 `backend.prepare_models --without-sensevoice`，写入 Windows 用户级全局缓存 `%USERPROFILE%\\.cache\\codex\\models\\modelscope`；状态检查用 `--check`，只查缓存、不下载。

Windows 默认模型按 8 GB 显存档位选择，用户仍可在设置中改填：

| 能力 | 默认 | 大小 | 说明 |
|---|---|---|---|
| ASR | `Qwen/Qwen3-ASR-0.6B-hf` | 1.58 GB | transformers 格式（原版 `Qwen/Qwen3-ASR-*` 为 vLLM/qwen-asr 格式）；12 GB 以上可改 `Qwen/Qwen3-ASR-1.7B-hf`（4.09 GB） |
| 文字 | `unsloth/Qwen3-4B-Instruct-2507-bnb-4bit` | 2.67 GB | 与 Mac 同一模型（Qwen3-4B-Instruct-2507）的 bitsandbytes 4-bit 预量化版，现有提示词与评测可直接沿用 |

### 8.3 推理适配（`engine/torch_provider.py`）

`Engine` 在 macOS 选 MLX，其他平台选 PyTorch；两者接口一致，提示词、正文协议、Markdown 保护与长度截断判定共用。

- ASR：`AutoProcessor.apply_transcription_request` + `Qwen3ASRForConditionalGeneration.generate`；保留原始解码中的 `language X<asr_text>` 协议，按 Mac 相同规则区分 detected/forced/unknown。上下文作为 `prompt` 传入。音频读为单声道 16 kHz（其他采样率线性重采样）。
- 文字：`AutoModelForCausalLM`（bitsandbytes 预量化配置随模型加载），关闭思考模式，贪心解码；最后一个 token 为 EOS 才算完整结束，否则按截断处理，不写入。
- 设备：CUDA 优先（支持时 BF16，否则 FP16），以 `device_map="cuda"` 直接加载；无 CUDA 时依次 MPS、CPU（仅用于开发验证），先在 CPU 加载再移动，因为直接以 `device_map` 加载到 MPS 会使进程崩溃（transformers 5.20 / torch 2.14 实测）。
- SenseVoice 复核只在提供方实现时触发；PyTorch 提供方没有，Windows 为单路识别加整理。

本机实跑（2026-10-23，Apple Silicon MPS，torch 2.14.1、transformers 5.20.2、bitsandbytes 0.50.2，Windows 默认模型；`say` 合成语音与合成文本，经真实 `backend.server` 与 `Engine`）：4/4 通过。

| 用例 | 结果 |
|---|---|
| 语音输入（ASR → 整理，无 SenseVoice 复核阶段） | 识别「额预算两千元，周五交付。」并检测为中文；整理输出「预算两千元，周五交付。」 |
| 整理口吃与数词卡顿 | 「呃，预算两三三千元…」→「预算两三千元，周五交付。」 |
| 划词翻译 | 「周五交付。」→「Deliver on Friday.」 |
| 口述翻译 | →「A budget of 2,000 yuan, delivered by Friday.」 |

文字模型确认以 bitsandbytes `Linear4bit`（nf4）加载，占用 2.59 GB。首次实跑发现原始解码末尾带 `<|im_end|>`，已修复并加测试。MPS 上的耗时不代表 CUDA；CUDA 上的速度与显存待实机测量。

### 8.4 边界

- Windows 版在 P2 系统桥接完成前不能启动；运行库与模型可先用 `npx tsx scripts/setup-windows-runtime.mts <网关 python.exe>` 在实机准备。
- 镜像与官方源均不可达时报下载失败；代理环境下的安装需实机确认。
- 新增的只是现有引导页按钮文字与说明；独立的安装进度界面若要增加，先按 `docs/design/` 流程做视觉确认。
