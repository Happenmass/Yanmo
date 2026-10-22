"""Output delivery contract: model text is not judged or rewritten by rules."""
from pathlib import Path
from threading import Event
import unittest
from unittest.mock import patch

from backend.pipeline import run_pipeline
from engine.worker import Engine


class TranslationOutputTests(unittest.TestCase):
    def testNaturalArticleTranslationReachesDeliverableResult(self):
        engine, events = Engine(), []
        source = "我想做一个新的动画效果。"
        output = "I want to create a new animation effect."
        request = {"operation": "voiceTranslation", "target_language": "en", "polish": True,
                   "style": "自然整理", "models": {}, "context": {}}
        primary = {"text": source, "engine": "Qwen3-ASR", "language": "Chinese", "language_source": "detected"}
        secondary = {**primary, "engine": "SenseVoice Small", "language_source": "forced"}
        with patch.object(engine, "transcribe", return_value=primary), patch.object(engine, "transcribe_secondary", return_value=secondary), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value=output):
            run_pipeline(engine, request, "synthetic.wav", Event(), events.append)
        self.assertEqual(events[-1]["event"], "result", events[-1])
        self.assertEqual(events[-1]["text"], output)
        self.assertEqual(events[-1]["original"], source)
        self.assertTrue(events[-1]["processed"])

    def testModelBodyIsDeliveredWhenCandidatesDisagree(self):
        engine, events = Engine(), []
        output = "The budget is 101 yuan."
        request = {"operation": "voiceTranslation", "target_language": "en", "polish": True,
                   "style": "自然整理", "models": {}, "context": {}}
        primary = {"text": "预算100元。", "engine": "Qwen3-ASR", "language": "Chinese", "language_source": "detected"}
        secondary = {**primary, "text": "预算101元。", "engine": "SenseVoice Small"}
        with patch.object(engine, "transcribe", return_value=primary), patch.object(engine, "transcribe_secondary", return_value=secondary), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value=output):
            run_pipeline(engine, request, "synthetic.wav", Event(), events.append)
        self.assertEqual(events[-1]["event"], "result", events[-1])
        self.assertEqual(events[-1]["text"], output)
