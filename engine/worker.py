#!/usr/bin/env python3
"""Offline MLX worker. One JSON request/response per line; stdout is protocol only."""
from __future__ import annotations

import contextlib
import gc
import json
import os
from pathlib import Path
import re
import sys
import time

# Set before importing any model library. Runtime never downloads missing models.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

DEFAULT_ASR = "mlx-community/Qwen3-ASR-1.7B-8bit"
DEFAULT_LLM = "mlx-community/Qwen3-4B-4bit"
SYSTEM_PROMPT = Path(__file__).with_name("prompt.txt").read_text(encoding="utf-8")


def resolve_model(model: str) -> Path:
    path = Path(model).expanduser()
    if path.is_dir():
        resolved = path.resolve()
    else:
        from huggingface_hub import snapshot_download
        resolved = Path(snapshot_download(model, local_files_only=True, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "*.tiktoken", "*.jinja"]))
    weights = list(resolved.glob("*.safetensors"))
    if not (resolved / "config.json").is_file() or not weights or any(not p.is_file() for p in weights):
        raise ValueError(f"模型缓存不完整：{model}。请在设置中选择完整模型目录，或先运行模型准备命令。")
    return resolved


def build_payload(request: dict) -> dict:
    # Deliberately build the schema rather than merging arbitrary request keys.
    return {
        "INSTRUCTION": request.get("instruction", "保留原意，清理无意义填充，修正标点。"),
        "AUDIO_CONTEXT": {
            "application": {"name": request.get("application", "言墨"), "categories": [request.get("category", "general")]},
            "key_terms": request.get("key_terms", []),
            "background_screen_text": [],
        },
        "ASR_RESULTS": request.get("asr_results") or [{"engine_name": "Qwen3-ASR", "transcript": request.get("text", "")}],
        "context": {"text_before_cursor": request.get("before", ""), "text_after_cursor": request.get("after", "")},
    }


def clean_output(output: str) -> str:
    output = re.sub(r"<think>.*?</think>", "", output, flags=re.S).strip()
    if "<think>" in output or "</think>" in output:
        raise ValueError("模型没有返回完整正文；已保留原始转写。")
    if output.startswith("```"):
        lines = output.splitlines()
        if len(lines) > 2 and lines[-1].strip() == "```":
            output = "\n".join(lines[1:-1]).strip()
    if not output:
        raise ValueError("模型返回空正文；已保留原始转写。")
    return output


class Engine:
    def __init__(self):
        self.model = None
        self.tokenizer = None
        self.loaded = None

    def unload(self):
        self.model = self.tokenizer = self.loaded = None
        gc.collect()
        if "mlx.core" in sys.modules:
            import mlx.core as mx
            mx.clear_cache()

    def transcribe(self, request: dict) -> dict:
        model_path = resolve_model(request.get("asr_model") or DEFAULT_ASR)
        key = ("asr", str(model_path))
        if self.loaded != key:
            self.unload()
            from mlx_audio.stt.utils import load_model
            self.model = load_model(str(model_path))
            self.loaded = key
        audio = Path(request["audio"]).expanduser()
        if not audio.is_file():
            raise ValueError("音频文件不存在。")
        result = self.model.generate(str(audio), language=request.get("language") or None, verbose=False)
        text = result.text.strip()
        if not text:
            raise ValueError("没有识别到语音，请靠近麦克风后重试。")
        return {"text": text, "engine": "Qwen3-ASR"}

    def polish(self, request: dict) -> dict:
        path = resolve_model(request.get("llm_model") or DEFAULT_LLM)
        key = ("llm", str(path))
        if self.loaded != key:
            self.unload()
            from mlx_lm import load
            self.model, self.tokenizer = load(str(path))
            self.loaded = key
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler
        payload = build_payload(request)
        messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
        prompt = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        original = "\n".join(r["transcript"] for r in payload["ASR_RESULTS"])
        # Reaching the token cap is an error, never silently deliver a cut-off draft.
        max_tokens = min(4096, max(512, len(original) * 3 + 128))
        pieces = []
        last = None
        for last in stream_generate(self.model, self.tokenizer, prompt, max_tokens=max_tokens, sampler=make_sampler(temp=0)):
            pieces.append(last.text)
        if last is None or last.finish_reason != "stop":
            raise ValueError("整理超出长度上限；已保留原始转写，可分段后重试。")
        return {"text": clean_output("".join(pieces)), "engine": path.name}

    def handle(self, request: dict) -> dict:
        command = request.get("command")
        if command == "check":
            models = {}
            for kind, default in [("asr", DEFAULT_ASR), ("llm", DEFAULT_LLM)]:
                try:
                    models[kind] = {"ready": True, "path": str(resolve_model(request.get(f"{kind}_model") or default))}
                except Exception:
                    models[kind] = {"ready": False, "message": "未找到完整本地缓存"}
            return {"models": models, "offline": True}
        if command == "transcribe":
            return self.transcribe(request)
        if command == "polish":
            return self.polish(request)
        if command == "unload":
            self.unload()
            return {"text": "模型已卸载"}
        raise ValueError(f"未知命令：{command}")


def main():
    engine = Engine()
    for line in sys.stdin:
        request = {}
        started = time.monotonic()
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = engine.handle(request)
            response = {"id": request.get("id"), "ok": True, **result}
        except Exception as exc:
            # No transcript, cursor context, or input payload in diagnostic logs.
            response = {"id": request.get("id"), "ok": False, "error": str(exc)}
        response["elapsed"] = round(time.monotonic() - started, 3)
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
