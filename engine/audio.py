"""Audio normalization and high-ratio Opus compression for persistent history."""
from __future__ import annotations

import io
from pathlib import Path

OPUS_SAMPLE_RATE = 16000
OPUS_COMPRESSION_LEVEL = 0.94


AudioInput = Path | str | io.BytesIO


def soundfile_source(audio: AudioInput):
    """Rewind in-memory recordings for each sequential consumer."""
    if isinstance(audio, io.BytesIO):
        audio.seek(0)
        return audio
    return str(audio)


def read_mono(audio: AudioInput):
    import soundfile as sf

    samples, rate = sf.read(soundfile_source(audio), dtype="float32", always_2d=True)
    return samples.mean(axis=1), rate


def resample_mono(samples, rate, target_rate):
    if rate != target_rate:
        from math import gcd
        from scipy.signal import resample_poly

        divisor = gcd(rate, target_rate)
        return resample_poly(samples, target_rate // divisor, rate // divisor).astype("float32")
    return samples


def encode_opus(audio: AudioInput) -> bytes:
    """Encode a valid recording; callers own reporting archival failures."""
    import soundfile as sf

    samples, rate = read_mono(audio)
    if len(samples) == 0:
        raise ValueError("录音没有音频帧。")
    samples = resample_mono(samples, rate, OPUS_SAMPLE_RATE)
    buffer = io.BytesIO()
    sf.write(buffer, samples, OPUS_SAMPLE_RATE, format="OGG", subtype="OPUS",
             compression_level=OPUS_COMPRESSION_LEVEL)
    return buffer.getvalue()
