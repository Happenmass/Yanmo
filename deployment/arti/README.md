# arti.local Qwen3-ASR

服务器 Ubuntu 24.04、双 RTX 2080 Ti 22GiB。此服务独立于现有 Atlas 35B/OCR，只监听 `127.0.0.1:8103`，由门户统一转发 HTTPS `POST /v1/audio/transcriptions`。

模型 `Qwen/Qwen3-ASR-1.7B`；官方原始权重，不量化。2080 Ti 使用 FP16，`qwen-asr==0.0.6` 的 Transformers 后端，SDPA、单请求/单批次。长录音使用官方静音边界切分器，目标每段 30 秒、前后 5 秒内寻找低能量边界，不丢样本、不重叠；每段输出上限 1024 tokens。音频编码器、共享权重的词嵌入/输出头和前 10 个解码层放 GPU0，后 18 层及归一化放 GPU1；按 UUID 固定物理卡。不使用 vLLM、张量并行或 CPU 卸载。模型的实际放置写入启动日志并由 `/health` 返回。

权重由 `prepare_model.py` 从官方 ModelScope 读取，逐文件核对元数据中的 SHA-256，保存于用户全局 `~/.cache/codex/models/Qwen3-ASR-1.7B/`，服务配置写入 `~/.config/yanmo-asr/service.env`。已有匹配缓存复用，未完成下载保留 `.part` 供续传。运行服务开启 Hugging Face/Transformers 离线模式，不在推理时联网下载权重。

部署使用独立 `~/yanmo-asr/venv`；固定 PyTorch `2.10.0+cu128` 与 qwen-asr `0.0.6`，后者要求 Transformers `4.57.6`。运行环境安装完成后在服务器保存 `~/yanmo-asr/requirements.lock.txt`。仓库 `requirements-server.lock` 保存本次已验版本，包含固定 CUDA 12.8 PyTorch wheel；新建独立 venv 后可用 `python -m pip install -r requirements-server.lock` 复现。完整现场证据与容量结论见 `docs/arti-asr-acceptance-2026-10-29.md`。

```bash
scp deployment/arti/{asr_server.py,prepare_model.py} arti:yanmo-asr/
scp deployment/arti/yanmo-asr.service arti:.config/systemd/user/
ssh arti 'python3 ~/yanmo-asr/prepare_model.py'
ssh arti 'systemctl --user daemon-reload; systemctl --user enable --now yanmo-asr.service'
ssh arti 'curl -fsS http://127.0.0.1:8103/health'
```

调用格式为 OpenAI 音频转录 multipart，字段 `model`、`file`、可选 `language`，支持 `json`、`verbose_json`、`text`。上传最多 20MiB、音频 0.35～300 秒；单执行线程排队，执行后释放未使用的 CUDA allocator 缓存供 LLM/OCR 使用。上传临时文件读取后即关闭清理，不保留录音，访问日志关闭，运维日志只写模型放置、耗时与显存数据。识别质量需实际口述验收，合成语音只证明链路和容量。

回退：`systemctl --user disable --now yanmo-asr`，恢复门户备份 `~/atlas-inference/backups/yanmo-asr-20261029/portal-server.py` 后按现行门户服务流程重启；LLM/OCR 配置不变。不要用旧首页覆盖当前下载版本。Windows 安装包已于2026-10-29按用户要求上架；实际下载完整性已验，Windows原生验收仍按 `docs/windows-arti-api.md` 执行。

官方接口与结构依据：[Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)、[Qwen3-ASR-1.7B](https://modelscope.cn/models/Qwen/Qwen3-ASR-1.7B)。
