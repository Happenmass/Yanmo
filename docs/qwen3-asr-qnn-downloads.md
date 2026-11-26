# Qwen3-ASR 安卓 NPU 模型下载

发布于 2026-11-25，适用于 Qualcomm QNN/HTP 推理。

| 模型 | Hugging Face | 魔搭 ModelScope |
| --- | --- | --- |
| Qwen3-ASR 0.6B | [下载 0.6B](https://huggingface.co/Happenmasss/Qwen3-ASR-0.6B-QNN-HTP) | [下载 0.6B](https://modelscope.cn/models/Happenmass/Qwen3-ASR-0.6B-QNN-HTP) |
| Qwen3-ASR 1.7B | [下载 1.7B](https://huggingface.co/Happenmasss/Qwen3-ASR-1.7B-QNN-HTP) | [下载 1.7B](https://modelscope.cn/models/Happenmass/Qwen3-ASR-1.7B-QNN-HTP) |

两种模型共用目录命名。按手机 SoC 选择下载目录，运行说明见仓库的 `README.md` 和 `README_zh.md`，文件校验值见各目录的 `SHA256SUMS`。QAIRT 运行库按下表版本另行获取。

| SoC | Hexagon | 下载目录 | QAIRT |
| --- | --- | --- | --- |
| SM8975 | V85 | `sm8975-o3/` | 2.52.0.261104 |
| SM8950 | V85 | `sm8950-o3/` | 2.52.0.261104 |
| SM8850 | V81 | `sm8850-o3/` | 2.50.0.260828 |
| SM8750 | V79 | `sm8750-o3/` | 2.50.0.260828 |
| SM8650 | V75 | `sm8650-o3/` | 2.50.0.260828 |

两种模型各有五个定制包，均已通过编译和二进制核验。荣耀 Magic V6 真机实测使用 `sm8850-magic-v6-verified/`，对应 QAIRT 2.50.0.260828。转写同一段 24 秒音频，0.6B 热态中位数为 **2.04 秒**，模型文件约 **0.97 GB**。1.7B 为 **4.84 秒**和 **2.40 GB**。
