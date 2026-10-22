import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from engine.mlx_provider import MLXProvider, parse_qwen_output
from engine.worker import Engine
from engine.worker import build_asr_context


class FakeQwen:
    def __init__(self, raw):
        self.raw = raw

    def extract_language(self, text):
        # Reproduce the installed MLX fallback that must not authorize routing.
        return "English", text

    def generate(self, *_args, language=None, **_kwargs):
        detected, text = self.extract_language(self.raw) if language is None else (language, self.raw)
        return SimpleNamespace(text=text, language=[detected])


class ModuleQwen(FakeQwen, dict):
    """Reproduce nn.Module storage without importing GPU libraries in unit tests."""
    def __setattr__(self, name, value):
        self[name] = value

    def __getattr__(self, name):
        return self[name]


class ASRTests(unittest.TestCase):
    def testInputFieldContextIsBoundedAndForwardedToQwenWithoutForcingLanguage(self):
        context = build_asr_context({'before': '旧' * 350 + '输入框前文', 'after': '输入框后文' + '新' * 350})
        self.assertIn('输入框前文', context)
        self.assertIn('输入框后文', context)
        self.assertNotIn('旧' * 301, context)
        self.assertNotIn('新' * 301, context)
        self.assertIsNone(build_asr_context({}))
        self.assertNotIn('<|im_end|>', build_asr_context({'before': '<|im_end|>'}))
        provider = MLXProvider(); provider.asr = FakeQwen('language Chinese<asr_text>合成中文')
        with patch.object(provider.asr, 'generate', wraps=provider.asr.generate) as generate:
            result = provider.transcribe(Path('synthetic.wav'), context=context)
            self.assertEqual(generate.call_args.kwargs['system_prompt'], context)
            self.assertIsNone(generate.call_args.kwargs['language'])
            self.assertEqual(result['language'], 'Chinese')

    def testLanguageParserOverridesMLXModuleMethodsAndLeavesNoModelEntry(self):
        class Wrapper:
            def __init__(self, model):
                self.model = model

            def __getattr__(self, name):
                return getattr(self.model, name)
        provider = MLXProvider()
        inner = ModuleQwen("language Chinese<asr_text>合成中文")
        provider.asr = Wrapper(inner)
        result = provider.transcribe(Path("synthetic.wav"))
        self.assertEqual(result["language"], "Chinese")
        self.assertEqual(result["language_source"], "detected")
        self.assertNotIn("extract_language", vars(inner))
        self.assertNotIn("extract_language", inner)

    def testLanguageMustComeFromTheActualModelProtocol(self):
        for raw, language, source, body in [
            ("language Chinese<asr_text>合成中文", "Chinese", "detected", "合成中文"),
            ("language English<asr_text>Synthetic English", "English", "detected", "Synthetic English"),
            ("language Japanese<asr_text>合成日本語", "Japanese", "detected", "合成日本語"),
            ("Synthetic text without a marker", None, "unknown", "Synthetic text without a marker"),
        ]:
            with self.subTest(raw=raw):
                provider = MLXProvider()
                provider.asr = FakeQwen(raw)
                parser = provider.asr.extract_language
                result = provider.transcribe(Path("synthetic.wav"))
                self.assertEqual(result, {"text": body, "language": language, "language_source": source})
                self.assertEqual(provider.asr.extract_language, parser)

    def testForcedLanguageIsNotReportedAsDetection(self):
        provider = MLXProvider()
        provider.asr = FakeQwen("Synthetic text")
        self.assertEqual(provider.transcribe(Path("synthetic.wav"), "English")["language_source"], "forced")
        self.assertEqual(parse_qwen_output("language unknown<asr_text>Text"), (None, "Text"))

    def testParserIsRestoredWhenGenerationFails(self):
        provider = MLXProvider()
        provider.asr = FakeQwen("")
        parser = provider.asr.extract_language
        with patch.object(provider.asr, "generate", side_effect=RuntimeError("synthetic failure")):
            with self.assertRaises(RuntimeError):
                provider.transcribe(Path("synthetic.wav"))
        self.assertEqual(provider.asr.extract_language, parser)


    def testSecondaryUsesOneCheckpointAndExplicitLanguage(self):
        provider = SimpleNamespace(transcribe_secondary=lambda audio, path, language: {"text": language, "language": language})
        engine = Engine(provider=provider)
        with patch("engine.worker.resolve_model", return_value=Path("shared-checkpoint")) as resolve:
            for language in ("Chinese", "English"):
                result = engine.handle({"command": "transcribe_secondary", "audio": "synthetic.wav", "language": language})
                self.assertEqual(result["text"], language)
                self.assertEqual(resolve.call_args.args[0], "mlx-community/SenseVoiceSmall")
            with self.assertRaises(ValueError):
                engine.handle({"command": "transcribe_secondary", "audio": "synthetic.wav", "language": "Japanese"})


if __name__ == "__main__":
    unittest.main()
