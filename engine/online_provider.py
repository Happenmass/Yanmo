"""OpenAI-compatible endpoints the user explicitly enabled. Only used when a request carries an online config."""
from contextlib import nullcontext
import io
import json
from time import monotonic
try:
    from .diagnostics import record
    from .usage import finish_call, start_call
except ImportError:
    from diagnostics import record
    from usage import finish_call, start_call
from pathlib import Path
from urllib.parse import urlsplit

import httpx

TIMEOUT = httpx.Timeout(120, connect=10)


def _post(config: dict, path: str, *, purpose=None, **kwargs) -> dict:
    headers = {"Authorization": "Bearer " + config["api_key"]} if config.get("api_key") else {}
    call = start_call(purpose, config["model"]) if purpose is not None else None
    started = monotonic()
    record("api_start", endpoint=path)
    # Redirects are not followed, so the key is only ever sent to the configured host.
    try:
        response = httpx.post(config["base_url"].rstrip("/") + path, headers=headers, timeout=TIMEOUT, **kwargs)
    except httpx.HTTPError as exc:
        finish_call(call, "request_error")
        record("api_error", endpoint=path, error_type=type(exc).__name__, elapsed_ms=round((monotonic()-started)*1000))
        raise ValueError("无法连接在线服务，已保留原文。") from None
    record("api_response", endpoint=path, status=response.status_code, elapsed_ms=round((monotonic()-started)*1000))
    try:
        result = response.json()
        valid_json = True
    except ValueError:
        result = None
        valid_json = False
    finish_call(call, "response" if response.status_code < 300 and valid_json else "request_error", result)
    if response.status_code in (401, 403):
        raise ValueError("在线服务拒绝了 API Key，请在设置中检查。")
    if response.status_code == 404:
        raise ValueError("在线服务没有这个接口或模型，请检查服务地址与模型 ID。")
    if response.status_code == 429:
        raise ValueError("在线服务请求过多或额度不足，请稍后重试。")
    if response.status_code >= 300:
        raise ValueError(f"在线服务返回错误（HTTP {response.status_code}），已保留原文。")
    if not valid_json:
        record("api_error", endpoint=path, error_type="InvalidJSON")
        raise ValueError("在线服务返回了无法识别的结果。") from None
    return result


def transcribe(config: dict, audio: Path | io.BytesIO, language=None, prompt: str | None = None) -> str:
    # OpenAI 兼容 /audio/transcriptions (如 Whisper / GPT-4o-transcribe) 仅支持 language 与纯文本 prompt 热词偏置；
    # 不支持结构化传入当前应用 (application/category) 或词条别名映射 (aliases)，因此仅将词库热词与上下文扁平化写入 prompt。
    data = {"model": config["model"], "response_format": "json"}
    if language:
        data["language"] = language
    if prompt:
        data["prompt"] = prompt
    if isinstance(audio, io.BytesIO):
        audio.seek(0)
        source, name = nullcontext(audio), "recording.wav"
    else:
        source, name = audio.open("rb"), audio.name
    with source as file:
        result = _post(config, "/audio/transcriptions", data=data, files={"file": (name, file, "audio/wav")})
    return str(result.get("text") or "").strip()


def generate(config: dict, system: str, payload: dict, max_tokens: int, *, purpose="polish"):
    messages = [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
    body = {"model": config["model"], "messages": messages, "temperature": 0, "max_tokens": max_tokens}
    # Keep vendor-specific parameters out of other OpenAI-compatible endpoints.
    if urlsplit(config["base_url"]).hostname == "api.deepseek.com":
        body["thinking"] = {"type": "enabled"}
        body["reasoning_effort"] = "low"
    result = _post(config, "/chat/completions", purpose=purpose, json=body)
    try:
        choice = result["choices"][0]
        content = choice["message"]["content"] or ""
        reason = choice.get("finish_reason")
        usage = result.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        details = usage.get("completion_tokens_details")
        details = details if isinstance(details, dict) else {}
        token_counts = {key: value for key, value in {
            "completion_tokens": usage.get("completion_tokens"),
            "reasoning_tokens": details.get("reasoning_tokens"),
            "prompt_cache_hit_tokens": usage.get("prompt_cache_hit_tokens"),
            "prompt_cache_miss_tokens": usage.get("prompt_cache_miss_tokens"),
        }.items() if isinstance(value, int)}
        record("api_generation", thinking_enabled=body.get("thinking") == {"type": "enabled"}, reasoning_effort=body.get("reasoning_effort"), **token_counts, finish_reason=reason if reason in ("stop", "length", "content_filter", "tool_calls", "insufficient_system_resource") else "other", output_chars=len(content), max_tokens=max_tokens)
        return content, reason
    except (KeyError, IndexError, TypeError):
        record("api_error", error_type="InvalidResponseShape")
        raise ValueError("在线服务返回了无法识别的结果。") from None
