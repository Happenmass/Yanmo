# arti.local ASR 与 Windows API 版验收（2026-10-29）

## 环境与交付范围

- Ubuntu 24.04，双 RTX 2080 Ti，各 22528MiB；两卡的 Paddle 与 PyTorch FP16 矩阵运算通过，CUDA P2P 仍不可用。
- 保留 Qwen3.6-35B-A3B Q4_K_M 与完整 PaddleOCR 管线。ASR 为官方 Qwen3-ASR-1.7B 原权重、FP16、不量化、不 CPU 卸载；PyTorch 2.10.0+cu128、qwen-asr 0.0.6、Transformers 4.57.6。
- ASR 启用用户服务自启，监听回环 8103，由门户 HTTPS 443 转发。音频编码器、共享词嵌入/输出头及前 10 个解码层在 GPU0，后 18 层在 GPU1；两卡按 UUID 固定。
- Windows 专用分支：`codex/arti-windows-api`。语音、整理、两种翻译默认调用 `https://arti.local/v1`，不需要 key；内置公开 CA 保留 TLS 验证；无本地模型回退。

## 首轮单槽与长音频边界

初始 ASR 采用 14/14 解码层；整段 299 秒重复合成音频与 262016 输入+128输出的 LLM 请求、OCR 同时运行。满窗检索和 OCR 均完成，但这仅表示容量链路通过：

- LLM 满窗 193.44 秒，输入 1380.95 tokens/s、生成 36.07 tokens/s。
- OCR 6.956 / 0.650 秒，两次金额与日期检查通过。
- 两卡峰值 21645 / 19095MiB，最低剩余 541 / 3091MiB；最高 68 / 69°C；最低可用内存 23915MiB。
- 短中文 2.667 秒、短英文 1.464 秒，均正确。
- 299 秒重复音频耗时 374.904 秒，出现 273 次“会议”，而输入约 54 次；长音频准确率不通过，不能把这轮标成识别质量合格。

最终改用 Qwen 官方 `split_audio_into_chunks`：目标 30 秒，前后 5 秒内找低能量边界，无重叠、无遗漏；每段单批次、1024 输出 tokens，分段后原样组合。ASR 改为 10/18 层以改善整机显存平衡。没有进行数字替换、语义筛选或原文回退。

首轮原始证据：服务器 `~/yanmo-asr/acceptance-20261029/`；本机 `.local/arti-acceptance-20261029/server/single-baseline.json`。

## 最终两路满窗与 ASR/OCR 共存

用户要求将并发从 1 增至 2，已将正式配置改为 `--parallel 2 --ctx-size 524288`，每槽仍是 262144 tokens；权重、F16 KV、分层方式及批量大小不变。服务端两槽实际 `n_ctx` 均检查为 262144，测试后保留配置，自启配置同步。

| 检查 | 结果 |
| --- | --- |
| 满窗 0 | 262016 输入 + 128 输出；三处检索正确；386.75 秒 |
| 满窗 1 | 262016 输入 + 128 输出；三处检索正确；395.28 秒 |
| 299 秒合成重复音频 | 166.938 秒；预期约 53.77 次，输出 54 次；通过 |
| 同期 OCR | 2.338 秒；金额、日期检查通过 |
| 两卡峰值 | 21321 / 19517MiB |
| 两卡最低可用显存 | 865 / 2669MiB |
| 两卡最高温度 | 67 / 69°C |

冷请求的预填充会阻塞/拖慢另一槽的输出：满窗 0 本轮平均生成速度只有 0.618 token/s，满窗 1 为 28.509 token/s。这是冷输入相互干扰的实测，不表示两路稳定生成都只有该速度，也不能把历史热缓存的吞吐代入本轮。第三个 LLM 请求仍排队。GPU0 余量不足 1GiB，不再提高并发或额外加载模型。

文字服务维持 llama.cpp，未重新部署 vLLM；ASR 使用独立的 Transformers 服务，不占 LLM 槽位。上述结论覆盖当前两路满窗、一个 ASR 执行槽与一个 OCR 执行槽；合成音频检查不代替真实口述质量验收。

服务器完整证据：`~/atlas-inference/two-full-asr-20261029/`，本机 `.local/arti-acceptance-20261029/server/two-full*.json`。`report.json` 的 `passed=true`；临时覆盖及自动回退计时器已清，正式 50-production.conf 保留 2 路。

## 客户端实际 API 链路

用桌面相同 BackendClient 启动 API-only Python 后端，经过认证回环 HTTP、SSE、公开 CA 校验，真实调用 arti.local：

- 语音输入 → ASR → 文字整理通过；包含等待两路满窗的时间，276.522 秒。
- 口述翻译通过，3.537 秒。
- 划词翻译通过，4.688 秒。

原生录音和粘贴不在该检查中；输入为 say 生成的合成音频。结果在 `.local/arti-acceptance-20261029/pipeline.json`。arti 的模型 API 与桌面 SSE 超时分别留 1 小时/61 分钟，以容纳满窗排队；连接失败仍由较短的连接超时返回。用户取消仍终止桌面任务，不写入迟到结果。

## Windows 验证

- 桌面 32 项、后端 21 项、引擎 41 项测试通过；TypeScript、.NET Windows x64 交叉编译、PowerShell 解析通过。
- Windows API 设置页渲染检查通过，两个默认接口正确，无本地模型下载/切回按钮，显示数据发送到 arti.local。
- NSIS 交叉打包通过，约 178.6MiB；三个可执行文件均检查为 Windows x64 PE。Python 运行库不含 torch、transformers、MLX，不含权重和业务数据。
- 实际 Windows 安装、麦克风、键盘钩子、选区、粘贴、退出再启动留给用户验收；交叉打包不能代替实机检查。打包与验收步骤见 `windows-arti-api.md`。
- 门户仅预留下载文件白名单，未展示未经 Windows 实机验收的下载按钮。

## 复现入口

- ASR 服务与模型准备：`deployment/arti/README.md`。
- 两路满窗加 ASR/OCR：Atlas 分支 `codex/yanmo-asr-gateway` 的 `deployment/lan-inference/probe-two-full-with-asr.py`。
- 桌面相同 Python 后端/SSE/模型链路：设置 `YANMO_API_ONLY=1`、`YANMO_PYTHON` 和 `YANMO_CA_CERT`，运行 `node --import tsx scripts/check-arti-api.mts <合成WAV> <报告JSON>`。
