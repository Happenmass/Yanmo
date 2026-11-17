"""Audio normalization and high-ratio Opus compression for persistent history."""
from __future__ import annotations

import io
from pathlib import Path

OPUS_SAMPLE_RATE = 16000
OPUS_COMPRESSION_LEVEL = 0.94


def encode_opus(audio: Path | str) -> bytes:
    """Encode a valid recording; callers own reporting archival failures."""
    import numpy as np
    import soundfile as sf

    samples, rate = sf.read(str(audio), dtype="float32", always_2d=True)
    samples = samples.mean(axis=1)
    if len(samples) == 0:
        raise ValueError("录音没有音频帧。")
    if rate != OPUS_SAMPLE_RATE:
        # Polyphase resampling avoids aliasing when imported audio is downsampled.
        from math import gcd
        from scipy.signal import resample_poly
        divisor = gcd(rate, OPUS_SAMPLE_RATE)
        samples = resample_poly(samples, OPUS_SAMPLE_RATE // divisor, rate // divisor).astype("float32")
    buffer = io.BytesIO()
    sf.write(buffer, samples, OPUS_SAMPLE_RATE, format="OGG", subtype="OPUS",
             compression_level=OPUS_COMPRESSION_LEVEL)
    return buffer.getvalue()
