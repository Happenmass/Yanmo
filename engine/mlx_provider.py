"""Mac-only compute adapter. Importing this module does not load MLX or weights."""
import gc
import json
import re
import sys
from pathlib import Path


def parse_qwen_output(text):
    """Missing model protocol means unknown, never the upstream English fallback."""
    match = re.match(r"^language\s+([^<]+)<asr_text>(.*)$", text.strip(), re.S)
    if not match:
        return None, text
    language, transcript = match.groups()
    language = language.strip()
    language = {"chinese": "Chinese", "english": "English"}.get(language.lower(), language)
    return (language if language.lower() not in ("", "none", "unknown") else None), transcript


class MLXProvider:
    def __init__(self):
        self.asr = self.sensevoice = self.llm = self.tokenizer = None
        self.asr_path = self.sensevoice_path = self.llm_path = None
        self.large_llm = False

    def unload(self):
        self.asr = self.sensevoice = self.llm = self.tokenizer = None
        self.asr_path = self.sensevoice_path = self.llm_path = None
        gc.collect()
        if "mlx.core" in sys.modules:
            import mlx.core as mx
            mx.clear_cache()

    def load_asr(self, path: Path):
        if self.asr_path != str(path):
            if self.large_llm:
                self.llm = self.tokenizer = self.llm_path = None
            self.asr = None
            gc.collect()
            from mlx_audio.stt.utils import load_model
            self.asr = load_model(str(path))
            self.asr_path = str(path)

    def transcribe(self, audio: Path, language=None, context=None):
        detected = []
        parser = getattr(self.asr, "extract_language", None)
        # MLX Audio may expose generate/parser through a forwarding wrapper.
        owner = getattr(parser, "__self__", self.asr)
        previous = vars(owner).get("extract_language")
        def extract(text):
            value, text = parse_qwen_output(text)
            detected.append(value)
            return value, text
        # Observe the actual protocol before MLX strips it. Keep vendor files intact.
        # nn.Module.__setattr__ stores values as model entries; method overrides
        # must be real instance attributes to take precedence over class methods.
        if parser and language is None:
            object.__setattr__(owner, "extract_language", extract)
        try:
            result = self.asr.generate(str(audio), language=language, verbose=False, **({"system_prompt": context} if context else {}))
        finally:
            if parser and language is None:
                if previous is None:
                    object.__delattr__(owner, "extract_language")
                else:
                    object.__setattr__(owner, "extract_language", previous)
        value = detected[0] if detected and all(item == detected[0] for item in detected) else None
        return {"text": result.text.strip(), "language": language or value,
                "language_source": "forced" if language else "detected" if value else "unknown"}

    def transcribe_secondary(self, audio: Path, path: Path, language: str):
        options = {"Chinese": "zh", "English": "en"}
        if language not in options:
            raise ValueError("SenseVoice 复核仅用于 Qwen 已识别的中文或英文。")
        if self.sensevoice_path != str(path):
            from mlx_audio.stt.utils import load_model
            self.sensevoice = load_model(str(path))
            self.sensevoice_path = str(path)
        from mlx_audio.stt.utils import load_audio
        import mlx.core as mx
        audio_data = load_audio(str(audio), sr=16000)
        texts = []
        # Bound encoder memory on the existing five-minute import path.
        for start in range(0, len(audio_data), 30 * 16000):
            result = self.sensevoice.generate(audio_data[start:start + 30 * 16000], language=options[language], use_itn=True, verbose=False)
            if result.text.strip():
                texts.append(result.text.strip())
            mx.clear_cache()
        text = (" " if language == "English" else "").join(texts)
        if not text:
            raise ValueError("SenseVoice 复核未识别到正文，已保留 Qwen 原文。")
        return {"text": text, "language": language, "language_source": "forced"}

    def load_llm(self, path: Path):
        if self.llm_path != str(path):
            self.llm = self.tokenizer = None
            self.large_llm = sum(p.stat().st_size for p in path.glob("*.safetensors")) > 6_000_000_000
            if self.large_llm:
                self.asr = self.asr_path = self.sensevoice = self.sensevoice_path = None
            gc.collect()
            from mlx_lm import load
            self.llm, self.tokenizer = load(str(path))
            self.llm_path = str(path)

    def generate(self, system: str, payload: dict, max_tokens: int):
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler
        messages = [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
        prompt = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        pieces, last = [], None
        for last in stream_generate(self.llm, self.tokenizer, prompt, max_tokens=max_tokens, sampler=make_sampler(temp=0)):
            pieces.append(last.text)
        return "".join(pieces), last.finish_reason if last is not None else None
