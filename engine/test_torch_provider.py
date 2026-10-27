import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
import soundfile as sf

from torch_provider import load_audio, parse_asr_output
from worker import Engine


class Local:
    def load_asr(self, path): pass
    def transcribe(self, audio, language, context): return {"text": "合成", "language": "Chinese", "language_source": "detected"}
    def unload(self): pass


class Reviewing(Local):
    def transcribe_secondary(self, *_): return {"text": "合成"}


class TorchProviderTests(unittest.TestCase):
    def testSenseVoiceReviewOnlyWhereTheProviderHasIt(self):
        with TemporaryDirectory() as directory, patch("worker.resolve_model", lambda *_: Path(directory)):
            audio = Path(directory, "a.wav"); audio.write_bytes(b"RIFF")
            request = {"command": "transcribe", "audio": str(audio)}
            self.assertFalse(Engine(Local()).handle(request)["secondary"])
            self.assertTrue(Engine(Reviewing()).handle(request)["secondary"])

    def testRawDecodeKeepsLanguageProtocolAndDropsSpecialTokens(self):
        self.assertEqual(parse_asr_output("language Chinese<asr_text>预算两千元。<|im_end|>"), ("Chinese", "预算两千元。"))
        self.assertEqual(parse_asr_output("预算两千元。<|im_end|><|endoftext|>"), (None, "预算两千元。"))

    def testAudioIsMono16kFloat(self):
        with TemporaryDirectory() as directory:
            path = Path(directory, "stereo.wav")
            sf.write(path, np.zeros((48000, 2), dtype="float32"), 48000)
            samples = load_audio(path)
            self.assertEqual((samples.ndim, samples.dtype, len(samples)), (1, np.float32, 16000))


if __name__ == "__main__":
    unittest.main()
