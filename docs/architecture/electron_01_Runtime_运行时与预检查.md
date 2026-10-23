# 言墨 P0：运行时与预检查

版本：v0.2；日期：2026-10-23；上游：[双平台重构方案](electron_00_Overview_顶层架构.md) §8.5、§10、§12 P0。

本文固定 P0 的预检查顺序、状态判定、Windows 无 CUDA 分流和两类 Windows 运行时组件的边界。Mac 内置 MLX 最小包已在 [Mac 实施记录](../electron-mac-2026-10-21.md) 完成，本文只补充其状态映射。

实施状态（2026-10-23）：预检查模块、状态判定、Windows 下的在线分流与网关依赖锁定已实现，并有单元测试覆盖；v0.2 增加 Windows 运行环境安装与 CUDA 模型下载（§8）。Windows 实机矩阵与 vLLM 推理（P1）尚未完成。Windows 系统桥接属于 P2，在其接入前 Windows 版不能启动，预检查先通过独立脚本在实机运行。

## 1. 范围

| 本阶段做 | 本阶段不做 |
|---|---|
| Windows 宿主与 WSL 内 CUDA 的分步检查，输出可操作状态 | vLLM Provider 与 CUDA 模型准备（P1） |
| 无可用 CUDA 时推荐在线 API，配置前不上传、不加载本地模型 | Win32 helper、快捷键与写入（P2） |
| 网关 Python 依赖锁定与体积记录 | 新的设置界面；沿用现有在线配置区，新增界面先做视觉确认 |
| 可在 Windows 实机运行的只读检查脚本 | 替用户执行 `wsl --install`、更新驱动或关闭其他 WSL 发行版 |

## 2. 状态

两平台共用一个状态值，挂在 `AppState.runtime`；判定为纯函数 `decideRuntime`（`desktop/precheck.ts`）。

| 状态 | 含义 | 用户可见处理 |
|---|---|---|
| `checking` | 尚未得到环境结果 | 等待，不阻断已启用的在线处理 |
| `local-ready` | 两项能力均在本机可用 | 正常使用 |
| `models-pending` | 本地环境通过，模型未准备 | 提供准备模型入口 |
| `local-repair` | 有受支持的 GPU，但 WSL2、运行环境或 WSL 内 CUDA 未就绪 | 列出具体修复项，同时可配置在线 API |
| `recommend-online` | 本机不具备受支持的本地推理条件，且未启用在线 | 引导到设置配置在线识别与文字处理 |
| `api-pending` | 无本地条件，只启用了其中一项在线能力 | 指出仍缺的能力 |
| `online-ready` | 两项能力均可处理，其中至少一项在线 | 正常使用，界面显示「已开启在线处理」 |

能力逐项判定（ASR、文字生成）：用户已启用在线 → `online`；否则本地环境通过且该项模型就绪 → `local`；其余为 `unavailable`。Mac 的本地 ASR 需要 Qwen3-ASR 与 SenseVoice 两份缓存。语音输入和口述翻译需要两项能力（整理与「保留原话」都会调用文字模型）；划词翻译与手动整理只需文字生成。

预检查只改变状态，不修改用户的在线/本地选择。

## 3. Windows 检查顺序

每步失败即停止并给出该步结论，后续步骤不执行。命令均为只读查询，最后一步只启动言墨自己的发行版。

| 步骤 | 命令 | 判定 | 失败时状态 |
|---|---|---|---|
| 1 架构 | `os.arch()` | `x64` | 不支持（→ 推荐在线） |
| 2 GPU | `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits`；旧驱动不支持 `compute_cap` 时去掉该字段重试 | 至少一块 NVIDIA GPU；已知算力需 ≥ 7.5（锁定的 PyTorch 使用 CUDA 13 运行库，CUDA 13 不再支持 Maxwell/Pascal/Volta）。多卡取符合条件中显存最大者 | 不支持（→ 推荐在线） |
| 3 WSL | `wsl.exe --status` | 退出码 0 | 待修复：由用户在管理员终端运行 `wsl --install`，可能需要重启 |
| 4 运行环境 | `wsl.exe --list --verbose` | 存在名为 `Yanmo` 的发行版且为 WSL 2 | 待修复：言墨本地运行环境未安装 / 需要 WSL 2 |
| 5 WSL 内 CUDA | `wsl.exe --distribution Yanmo --exec /opt/yanmo/venv/bin/python3 -c …` | 安装完成标记 `/opt/yanmo/lock.sha256` 存在、能导入 vLLM，且 `cuda` 为真 | 待修复：更新 NVIDIA Windows 驱动后重新检测 |
| 通过 | — | 环境就绪；CUDA 模型准备在 P1 之前不存在 | `models-pending` |

说明：

- 宿主 `nvidia-smi` 只用于判断「有没有值得尝试的 GPU」；驱动是否满足捆绑 CUDA 以第 5 步的实际执行为准，不在宿主比较驱动版本号，也不以系统是否安装 CUDA Toolkit 判定。
- `wsl.exe` 默认输出 UTF-16LE。调用时设置 `WSL_UTF8=1`，并在输出含 NUL 字节时按 UTF-16LE 解码。发行版列表只取每行首列名称与末列版本数字，不解析本地化的表头和说明文字。
- 第 5 步的探测代码只含单引号，避免 Windows 命令行转义影响 `wsl.exe` 的参数传递；导入 vLLM 与发行版冷启动可能需要数十秒，超时设为 120 秒。
- 系统版本不作为阻断条件；Windows 11 x64 仍是首批验证目标，版本在实机矩阵中记录。

## 4. 无 CUDA → 在线分流

| 规则 | 实现位置 |
|---|---|
| Windows 不调用 MLX 状态检查，不启动 Python 后端做缓存探测 | `Controller.checkModels` |
| 本地 ASR 不是 `local` 时不发起后台预加载 | `Controller.perform` |
| 所需能力为 `unavailable` 时不开始录音或翻译，打开设置页并说明缺少哪一项，提示配置前不会上传 | `Controller.begin` |
| Windows 上拒绝「准备模型」，不下载 MLX 权重 | `main.ts prepareModels` |
| 在线任务继续使用现有协议：任务载荷携带已启用端点，后端跳过本地加载 | `engine/worker.py`（未改动） |

在线端点「已启用且填写了地址与模型」即视为已配置；连通性在第一次任务中验证，失败时按现有错误语义保留原文、不写入。独立的「检测连接」动作留到在线 API 实测时决定，因为不同服务对探测接口的支持不一致。

Mac 不受这些门槛影响：仍按原流程在任务中报告缺失模型，只增加 `runtime` 状态与 Metal 不可用时的 `local-repair`。

## 5. Windows 运行时组件

| 组件 | 内容 | 位置 | 状态 |
|---|---|---|---|
| 原生网关 | 独立 Python 3.12 + `backend/requirements-gateway.in`（FastAPI、uvicorn、multipart、httpx、soundfile、langid），不含 MLX | 应用资源 `python/python.exe`，开发时 `runtime/windows/python/` | 依赖已锁定于 `backend/requirements-windows.lock` |
| WSL 运行时 | 专用发行版 `Yanmo`，内含 `/opt/yanmo/venv`（Python、PyTorch CUDA、vLLM） | 用户明确启用本地模式时导入 | 未构建 |

2026-10-23 测量：网关依赖按 `win_amd64`/CPython 3.12 解析为 23 个包，下载合计约 19 MB，其中 numpy（soundfile 依赖）约 12.6 MB。langid 1.1.6 只有源码包（1.9 MB），构建运行时需先打成 wheel。独立 Python 发行版、WSL 运行时组件的压缩体积和导入耗时在构建时补测。Mac 的 `requirements.in` 改为引用网关清单后，解析结果与原清单逐项一致。

后端在 Windows 网关上仅走在线路径：`Engine` 仅在调用本地能力时才导入 MLX，在线 ASR 不会触发 SenseVoice 复核（该复核只跟随本地 Qwen3-ASR）。已在只装网关依赖、不含 MLX 的环境中，用真实 `Engine` 跑通双项在线的语音输入流程，并确认 MLX 未被导入；该测试首次运行即发现整理路径依赖 langid，已补入网关清单。

## 6. 验证

| 检查 | 方法 | 结果 |
|---|---|---|
| 状态判定与 Windows 探测矩阵 | `desktop/tests/precheck.test.ts`：x64/非 x64、无 GPU、算力不足、旧驱动无 `compute_cap`、WSL 缺失、发行版缺失/WSL1、WSL 内 CUDA 失败、全部通过；UTF-16 输出；在线配置组合 | 通过（伪造命令输出） |
| Windows 在线门槛 | `desktop/tests/controller.test.ts`：未配置时不录音并指向设置，配置后按在线处理 | 通过 |
| 无 MLX 网关 | 只装网关依赖的临时环境运行 `backend.test_server`（含在线语音输入流程）及引擎在线/融合/语言提示测试 | 通过 |
| 环境安装流程 | `desktop/tests/windows-runtime.test.ts`：不支持的 GPU 不安装；WSL 缺失走 UAC 并要求重启；导入参数、root 运行安装脚本、验证与镜像清理；已就绪不重复；安装脚本错误原样报告；下载换源、断点续传、校验不符丢弃；WSL 路径映射与模型检查解析 | 通过（伪造命令与下载） |
| 模型准备参数 | `backend/test_prepare_models.py`：`--check` 不下载，Windows 不准备 SenseVoice | 通过 |
| 安装脚本 | 真实 Ubuntu WSL rootfs（校验通过）以 Docker（amd64 仿真）运行 `provision.sh`：apt 已切到清华镜像，204 包从清华 PyPI 按哈希安装；第二次运行跳过；删除标记后重装走缓存并清空 pip 缓存；探测所需导入成功 | 通过（无 GPU，CUDA 未验证；不经过 wsl.exe） |
| 回归 | 桌面 33 项、引擎 31 项、后端 18 项、类型检查与构建 | 通过 |
| Windows 实机 | `npx tsx scripts/check-windows-runtime.mts`，记录 GPU、WSL 状态与判定 | 待在实机运行 |

实机矩阵至少覆盖：无 NVIDIA GPU；算力 < 7.5 的 GPU；有 GPU 但未启用 WSL；WSL 已启用但无 `Yanmo` 发行版。安装 WSL 运行时组件后再补「WSL 内 CUDA 通过/失败」两项。

## 7. 待定

1. 首批 GPU 与显存档位（沿用上游 §13-1），决定 vLLM 显存预算和双模型能否常驻。
2. WSL 运行时组件的分发方式（随安装包或首次启用时下载）以实测体积决定。
3. 在线 API 首批服务与连通性检测方式，在真实服务验收时固定。

## 8. Windows 运行环境安装与模型准备

用户确认（2026-10-23）：采用在线安装而非预制镜像；下载优先国内镜像，失败回退官方源；首台实测机为 8 GB 显存 NVIDIA 显卡。

Windows 本地模式分两步，界面依次给出「准备运行环境」和「下载模型」；前一步未就绪时不提供后一步。预检查结果为「不支持」时不安装任何组件，继续推荐在线处理。

### 8.1 运行环境安装（`desktop/windows-runtime.ts`）

每一步可重复执行，已完成的步骤会跳过；中途失败或退出后再次点击即从未完成处继续。

| 步骤 | 动作 | 说明 |
|---|---|---|
| 1 预检查 | 复用 §3 | 已就绪直接结束；「不支持」直接报错 |
| 2 WSL | `wsl --install --no-distribution`，经 UAC 以管理员身份运行 | 只在用户点击后发起；完成后提示重启电脑，重启后再点一次继续 |
| 3 系统镜像 | 下载 Ubuntu 24.04 WSL rootfs（`20240423`，356,739,129 字节，SHA-256 `8251e27f…315ea`） | 依次尝试中科大、南京大学镜像与 Ubuntu 官方；支持断点续传，校验不符即删除并换下一个源 |
| 4 导入 | `wsl --import Yanmo %LOCALAPPDATA%\Yanmo\wsl\Yanmo <rootfs> --version 2` | 不安装到用户已有发行版，不改变默认发行版；导入后删除下载的镜像 |
| 5 运行库 | 以 root 在发行版内运行 `runtime/windows/provision.sh` | apt 先改用清华镜像，失败恢复官方源；安装 `python3-venv`、`python3-dev`、`gcc`（Triton 运行时编译需要）；创建 `/opt/yanmo/venv`，按带哈希的 `wsl-requirements.lock` 安装，PyPI 先清华后官方；全部完成后写入 `lock.sha256` 作为完成标记 |
| 6 验证 | 再跑 §3 | 未通过时报出具体问题 |

运行库锁定（2026-10-23 解析，Docker 实装确认 torch `2.13.0+cu130`，编译架构 sm_75–sm_120）：`vllm[audio]==0.32.0`（已注册 `Qwen3ASRForConditionalGeneration`）、`modelscope==1.40.2`，共 204 个包，PyPI 下载约 4.0 GB，最大为 torch 2.13.0（527 MB）及 CUDA 13 的 cuBLAS、cuDNN。加上系统镜像，首次准备约下载 4.4 GB；安装后 `/opt/yanmo/venv` 占用 8.7 GB，安装完成即清空 pip 缓存（实测 3.9 GB → 10 MB）。连同模型，本地模式约需 15 GB 磁盘。锁文件更新后，安装脚本按哈希差异重新安装。

退出言墨时若安装仍在进行，只执行 `wsl --terminate Yanmo`，不关闭其他发行版；下次准备从未完成处继续，pip 缓存保留已下载的包。

### 8.2 模型准备

模型下载在 Yanmo 发行版内运行现有 `backend.prepare_models`（代码目录经 `--cd` 直接使用应用资源），写入 Windows 用户级全局缓存 `%USERPROFILE%\.cache\codex\models\modelscope`（WSL 内为 `/mnt/c/Users/<用户>/.cache/codex/models/modelscope`）；Hugging Face 来源使用 `%USERPROFILE%\.cache\huggingface`。状态检查以同一方式运行 `prepare_models --check`，只查缓存、不下载。Windows 不准备 SenseVoice（vLLM 路径不使用双路复核）。

Windows 默认模型按 8 GB 显存档位选择，用户仍可在设置中改填：

| 能力 | 默认 | 大小 | 说明 |
|---|---|---|---|
| ASR | `Qwen/Qwen3-ASR-0.6B` | 1.9 GB | BF16；12 GB 以上可改 `Qwen/Qwen3-ASR-1.7B` |
| 文字 | `Qwen/Qwen3-4B-AWQ` | 2.7 GB | 4-bit；ModelScope 未提供 2507 Instruct 的 4-bit 版。它是混合思考模型，P1 需以非思考模式调用，并按 Mac 现有评测重新验收；12 GB 以上可改 `Qwen/Qwen3-4B-Instruct-2507-FP8`（5.2 GB，需算力 ≥ 8.0） |

两模型权重合计约 4.6 GB，为 8 GB 卡留出 KV cache 与桌面占用；实际显存预算在 P1 实测后固定。

### 8.3 边界

- 环境与模型准备完成后状态为 `local-ready`，但 Windows 本地推理（vLLM Provider）属于 P1，尚未接入。P1 完成前不应发布带本地模式的 Windows 版。
- 发行版内 pip 不经过 Windows 系统代理；镜像与官方源均不可达时报下载失败。
- 新增的只是现有引导页按钮文字与说明；独立的安装进度界面若要增加，先按 `docs/design/` 流程做视觉确认。
- 实机执行入口：`npx tsx scripts/setup-windows-runtime.mts`（先环境、后模型）。
