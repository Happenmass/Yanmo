"""Shared, user-level model cache. Resolution is strictly local; preparation is explicit."""
import os
from pathlib import Path

DEFAULT_SOURCE = "modelscope"
PATTERNS = ["*.json", "*.safetensors", "*.txt", "*.model", "*.mvn", "*.tiktoken", "*.jinja"]


def modelscope_cache():
    return Path(os.environ.get("MODELSCOPE_CACHE", str(Path.home() / ".cache/codex/models/modelscope"))).expanduser()


def validate_model(path, model):
    path = Path(path).resolve()
    weights = list(path.glob("*.safetensors"))
    if not (path / "config.json").is_file() or not weights or any(not item.is_file() or item.stat().st_size == 0 for item in weights):
        raise ValueError(f"模型缓存不完整：{model}。请在设置中准备模型，或选择完整的本地模型目录。")
    import json
    config = json.loads((path / "config.json").read_text())
    if config.get("model_type") == "sensevoice":
        cmvn = (path / "am.mvn").is_file() or (config.get("cmvn_means") and config.get("cmvn_istd"))
        tokenizer = (path / "chn_jpn_yue_eng_ko_spectok.bpe.model").is_file() or (path / "tokens.json").is_file()
        if not cmvn or not tokenizer:
            raise ValueError(f"SenseVoice 缓存缺少音频归一化或分词文件：{model}。请重新准备模型。")
    for index in path.glob("*.safetensors.index.json"):
        required = set(json.loads(index.read_text())["weight_map"].values())
        if not required or any(not (path / file).is_file() for file in required):
            raise ValueError(f"模型分片不完整：{model}。请重新准备模型。")
    return path


def resolve_cached_model(model: str, source: str = DEFAULT_SOURCE):
    if source not in ("modelscope", "huggingface"):
        raise ValueError("模型下载源无效。")
    path = Path(model).expanduser()
    if path.is_dir():
        return validate_model(path, model)

    def cached(provider):
        if provider == "modelscope":
            # Also reuse SDK caches created before Yanmo selected a global cache
            # location. Preparation must not download a second copy of weights.
            caches = dict.fromkeys([modelscope_cache(), Path.home() / ".cache/modelscope/hub"])
            for cache in caches:
                if not cache.exists():
                    continue
                try:
                    from modelscope.hub.snapshot_download import snapshot_download
                    candidate = snapshot_download(model, cache_dir=str(cache), local_files_only=True, allow_patterns=PATTERNS)
                    return validate_model(candidate, model)
                except Exception:
                    continue
            return None
        from huggingface_hub import snapshot_download
        return snapshot_download(model, local_files_only=True, allow_patterns=PATTERNS)

    for provider in [source, "huggingface" if source == "modelscope" else "modelscope"]:
        try:
            candidate = cached(provider)
            if candidate:
                return validate_model(candidate, model)
        except Exception:
            continue
    raise ValueError(f"未找到完整的本地模型缓存：{model}。请在设置中准备模型（默认来源 ModelScope）。")


def prepare_model(model: str, source: str = DEFAULT_SOURCE):
    try:
        return resolve_cached_model(model, source), True
    except ValueError:
        pass
    if Path(model).expanduser().is_absolute():
        raise ValueError("本地模型目录不完整，请选择已有目录或填写模型 ID。")
    if source == "modelscope":
        from modelscope.hub.snapshot_download import snapshot_download
        path = snapshot_download(model, cache_dir=str(modelscope_cache()), allow_patterns=PATTERNS)
    elif source == "huggingface":
        from huggingface_hub import snapshot_download
        path = snapshot_download(model, allow_patterns=PATTERNS)
    else:
        raise ValueError("模型下载源无效。")
    return validate_model(path, model), False
