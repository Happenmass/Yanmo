"""PyTorch/transformers compute adapter used on Windows. Importing this module loads neither torch nor weights."""
import gc
import json
from pathlib import Path
import re
import sys

if __package__:
    from .mlx_provider import parse_qwen_output
else:
    from mlx_provider import parse_qwen_output

SAMPLE_RATE = 16000


def load_audio(path: Path):
    """Mono float32 at 16 kHz. The native helpers record 16 kHz WAV; other rates are resampled linearly."""
    import numpy as np
    import soundfile as sf
    samples, rate = sf.read(str(path), dtype="float32", always_2d=True)
    samples = samples.mean(axis=1)
    if rate != SAMPLE_RATE:
        # ponytail: linear resampling, enough for speech; use a polyphase filter if imports of other rates matter.
        positions = np.arange(0, len(samples), rate / SAMPLE_RATE)
        samples = np.interp(positions, np.arange(len(samples)), samples).astype("float32")
    return samples


def parse_asr_output(raw: str):
    """Drop chat special tokens such as <|im_end|> (the <asr_text> marker is not one), then read the Qwen protocol."""
    return parse_qwen_output(re.sub(r"<\|[^|>]+\|>", "", raw))


class TorchProvider:
    def __init__(self):
        self.asr = self.processor = self.llm = self.tokenizer = None
        self.asr_path = self.llm_path = None

    @staticmethod
    def device():
        import torch
        return "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"

    def load(self, cls, path: Path, **options):
        device = self.device()
        if device == "cuda":
            return cls.from_pretrained(str(path), device_map="cuda", **options).eval()
        # ponytail: direct device_map loading onto MPS segfaults (transformers 5.20, torch 2.14); load on CPU, then move.
        return cls.from_pretrained(str(path), device_map="cpu", **options).to(device).eval()

    def unload(self):
        self.asr = self.processor = self.llm = self.tokenizer = None
        self.asr_path = self.llm_path = None
        gc.collect()
        if "torch" in sys.modules:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    def load_asr(self, path: Path):
        if self.asr_path == str(path):
            return
        import torch
        from transformers import AutoProcessor, Qwen3ASRForConditionalGeneration
        self.asr = self.processor = None
        gc.collect()
        device = self.device()
        dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float16 if device != "cpu" else torch.float32
        self.processor = AutoProcessor.from_pretrained(str(path))
        self.asr = self.load(Qwen3ASRForConditionalGeneration, path, dtype=dtype)
        self.asr_path = str(path)

    def transcribe(self, audio: Path, language=None, context=None):
        import torch
        inputs = self.processor.apply_transcription_request(audio=load_audio(audio), language=language, **({"prompt": context} if context else {}))
        inputs = inputs.to(self.asr.device, self.asr.dtype)
        with torch.inference_mode():
            output = self.asr.generate(**inputs, max_new_tokens=4096, do_sample=False)
        # The raw decode keeps the "language X<asr_text>" protocol, parsed the same way as on Mac.
        raw = self.processor.decode(output[:, inputs["input_ids"].shape[1]:])[0]
        value, text = parse_asr_output(raw)
        return {"text": text.strip(), "language": language or value,
                "language_source": "forced" if language else "detected" if value else "unknown"}

    def load_llm(self, path: Path):
        if self.llm_path == str(path):
            return
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.llm = self.tokenizer = None
        gc.collect()
        self.tokenizer = AutoTokenizer.from_pretrained(str(path))
        # Pre-quantized bitsandbytes checkpoints carry their quantization config and load as 4-bit.
        self.llm = self.load(AutoModelForCausalLM, path, dtype="auto")
        self.llm_path = str(path)

    def generate(self, system: str, payload: dict, max_tokens: int):
        import torch
        messages = [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
        prompt = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.llm.device)
        with torch.inference_mode():
            output = self.llm.generate(**inputs, max_new_tokens=max_tokens, do_sample=False, temperature=None, top_p=None, top_k=None)
        generated = output[0, inputs["input_ids"].shape[1]:]
        eos = self.llm.generation_config.eos_token_id
        eos = set(eos if isinstance(eos, list) else [eos])
        finish = "stop" if len(generated) and generated[-1].item() in eos else "length"
        return self.tokenizer.decode(generated, skip_special_tokens=True), finish
