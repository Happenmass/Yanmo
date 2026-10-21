#!/usr/bin/env python3
"""Explicit opt-in model download into the user's shared Hugging Face cache."""
import argparse
from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--asr", default="mlx-community/Qwen3-ASR-1.7B-8bit")
parser.add_argument("--llm", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
args = parser.parse_args()
patterns = ["*.json", "*.safetensors", "*.txt", "*.model", "*.tiktoken", "*.jinja"]
for model in [args.asr, args.llm]:
    try:
        path = snapshot_download(model, local_files_only=True, allow_patterns=patterns)
        print(f"复用缓存：{path}")
    except Exception:
        print(f"准备模型：{model}（仅此步骤联网，使用全局缓存）")
        print(snapshot_download(model, allow_patterns=patterns))
