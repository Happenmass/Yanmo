"""OpenAI-compatible endpoints the user explicitly enabled. Only used when a request carries an online config."""
import json
from pathlib import Path

import httpx

TIMEOUT = httpx.Timeout(120, connect=10)


def _post(config: dict, path: str, **kwargs) -> dict:
    headers = {"Authorization": "Bearer " + config["api_key"]} if config.get("api_key") else {}
    # Redirects are not followed, so the key is only ever sent to the configured host.
    try:
        response = httpx.post(config["base_url"].rstrip("/") + path, headers=headers, timeout=TIMEOUT, **kwargs)
    except httpx.HTTPError:
        raise ValueError("无法连接在线服务，已保留原文。") from None
    if response.status_code in (401, 403):
        raise ValueError("在线服务拒绝了 API Key，请在设置中检查。")
    if response.status_code == 404:
        raise ValueError("在线服务没有这个接口或模型，请检查服务地址与模型 ID。")
    if response.status_code == 429:
        raise ValueError("在线服务请求过多或额度不足，请稍后重试。")
    if response.status_code >= 300:
        raise ValueError(f"在线服务返回错误（HTTP {response.status_code}），已保留原文。")
    try:
        return response.json()
    except ValueError:
        raise ValueError("在线服务返回了无法识别的结果。") from None


def transcribe(config: dict, audio: Path, language=None) -> str:
    data = {"model": config["model"], "response_format": "json"}
    if language:
        data["language"] = language
    with audio.open("rb") as file:
        result = _post(config, "/audio/transcriptions", data=data, files={"file": (audio.name, file, "audio/wav")})
    return str(result.get("text") or "").strip()


def generate(config: dict, system: str, payload: dict, max_tokens: int):
    messages = [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
    result = _post(config, "/chat/completions", json={"model": config["model"], "messages": messages, "temperature": 0, "max_tokens": max_tokens})
    try:
        choice = result["choices"][0]
        return choice["message"]["content"] or "", choice.get("finish_reason")
    except (KeyError, IndexError, TypeError):
        raise ValueError("在线服务返回了无法识别的结果。") from None
