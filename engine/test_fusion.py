import unittest
from pathlib import Path
from unittest.mock import patch

from engine.fusion import build_fusion_payload
from engine.worker import Engine


class FusionTests(unittest.TestCase):
    def testCandidatesContextAndUserEditsReachTheModel(self):
        request = {"asr_results": [{"transcript": "预算100元。", "language": "Chinese"}, {"transcript": "预算101元。", "language": "Chinese"}], "before": "甲" * 350, "after": "乙" * 350}
        payload = build_fusion_payload(request, "polish")
        self.assertEqual(payload["SOURCE_LANGUAGES"], ["Chinese"])
        self.assertEqual([item["transcript"] for item in payload["ASR_RESULTS"]], [item["transcript"] for item in request["asr_results"]])
        self.assertEqual(payload["CONTEXT"]["before"], "甲" * 300)
        self.assertEqual(payload["CONTEXT"]["after"], "乙" * 300)
        edited = build_fusion_payload({**request, "user_text": "The budget is 102 yuan."}, "polish")
        self.assertEqual(edited["USER_TEXT"], "The budget is 102 yuan.")
        self.assertEqual(edited["SOURCE_LANGUAGES"], [])
        self.assertEqual(request["asr_results"][0]["transcript"], "预算100元。")

    def testTranscriptionGetsSameLanguagePromptAndNoTranslationTarget(self):
        engine = Engine()
        for task in ("polish", "verbatim", "translate"):
            with self.subTest(task=task), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value="今日は晴れです。") as generate:
                engine.polish({"text": "今日は晴れです。", "task": task, "target_language": "zh-Hans"})
                system, payload = generate.call_args.args[:2]
                self.assertIn("same-language transcription", system)
                self.assertIn("Source language code: ja", system)
                self.assertNotEqual(payload["TASK"], "translate")
                self.assertNotIn("TARGET_LANGUAGE", payload)
                self.assertIn("transcription, not translation", payload["OUTPUT_LANGUAGE"])

    def testTranslationGetsExplicitTargetInstruction(self):
        engine = Engine()
        with patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value="今天天气很好。") as generate:
            result = engine.translate({"text": "今日はいい天気です。", "target_language": "zh-Hans", "asr_results": [{"transcript": "今日はいい天気です。", "language": "Japanese"}]})
            self.assertEqual(result["text"], "今天天气很好。")
            self.assertEqual(generate.call_args.args[1]["TASK"], "translate")
            self.assertEqual(generate.call_args.args[1]["TARGET_LANGUAGE"], "Simplified Chinese")
            self.assertIn("Simplified Chinese", generate.call_args.args[1]["OUTPUT_LANGUAGE"])

    def testModelBodyPassesThroughWithoutContentChanges(self):
        engine = Engine()
        # These deliberately imperfect generations test delivery, not model quality.
        for output in ("今天有101人。", "今日は一百人です。", "  exact model text\n", '{"literal": 1}'):
            with self.subTest(output=output), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine.provider, "generate", return_value=(output, "stop")):
                self.assertEqual(engine.polish({"text": "今日は100人です。"})["text"], output)

    def testEmptyOrTruncatedGenerationIsATechnicalFailure(self):
        engine = Engine()
        for output, finish in (("", "stop"), (" ", "stop"), ("partial", "length")):
            with self.subTest(output=output, finish=finish), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine.provider, "generate", return_value=(output, finish)), self.assertRaises(ValueError):
                engine.polish({"text": "合成原文"})


if __name__ == "__main__":
    unittest.main()
