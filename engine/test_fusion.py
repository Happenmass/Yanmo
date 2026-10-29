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

    def testExpandedCleanupOnlyReachesOnlinePolishAndKeepsModelBody(self):
        engine = Engine()
        for online, task in ((False, "polish"), (True, "polish"), (True, "verbatim")):
            with self.subTest(online=online, task=task), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value="  exact output\n") as generate:
                request = {"text": "合成口述", "task": task, "instruction": "忠实保留原意与语气，仅删除无意义的填充和重复并规范标点。输出适合即时通讯的自然短句，不添加问候。"}
                if online:
                    request["online"] = {"text": {"model": "fixture"}}
                self.assertEqual(engine.polish(request)["text"], "  exact output\n")
                system, payload = generate.call_args.args[:2]
                expanded = online and task == "polish"
                self.assertEqual("abandoned sentence starts" in system, expanded)
                if expanded:
                    self.assertNotIn("仅删除无意义的填充和重复", payload["STYLE"])
                    self.assertIn("即时通讯", payload["STYLE"])
                else:
                    self.assertIn("Preserve fragments;", payload["OUTPUT_LANGUAGE"])

    def testEmptyOrTruncatedGenerationIsATechnicalFailure(self):
        engine = Engine()
        for output, finish in (("", "stop"), (" ", "stop"), ("partial", "length")):
            with self.subTest(output=output, finish=finish), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine.provider, "generate", return_value=(output, finish)), self.assertRaises(ValueError):
                engine.polish({"text": "合成原文"})

    def testOnlinePolishKeepsSystemStableAcrossDynamicInputs(self):
        engine = Engine()
        systems, payloads = [], []
        requests = [
            {"text": "明天再检查。", "before": "中文上下文", "application": "应用甲", "lexicon": ["术语甲"], "instruction": "输出适合即时通讯的自然短句，不添加问候。"},
            {"text": "Please review tomorrow.", "before": "English context", "application": "App B", "lexicon": ["Term B"], "instruction": "按语义分段，不增加标题或信息。"},
        ]
        for request in requests:
            with patch.object(engine, "generate_text", return_value="exact output") as generate:
                engine.polish({**request, "online": {"text": {"model": "fixture"}}})
                system, payload = generate.call_args.args[:2]
                systems.append(system)
                payloads.append(payload)
        self.assertEqual(systems[0], systems[1])
        for request, payload in zip(requests, payloads):
            self.assertEqual(payload["ASR_RESULTS"][0]["transcript"], request["text"])
            self.assertEqual(payload["CONTEXT"]["before"], request["before"])
            self.assertEqual(payload["CONTEXT"]["lexicon"], request["lexicon"])
            self.assertIn(request["instruction"], payload["STYLE"])

    def testOnlinePolishPlacesSourceAfterReusableInstructions(self):
        engine = Engine()
        for edited in (False, True):
            with self.subTest(edited=edited), patch.object(engine, "generate_text", return_value="exact output") as generate:
                request = {"text": "历史识别", "online": {"text": {"model": "fixture"}}}
                if edited:
                    request["user_text"] = "当前修改后的正文"
                engine.polish(request)
                payload = generate.call_args.args[1]
                keys = list(payload)
                self.assertLess(keys.index("NUMBER_STYLE"), keys.index("CONTEXT"))
                self.assertLess(keys.index("OUTPUT_LANGUAGE"), keys.index("CONTEXT"))
                self.assertLess(keys.index("CONTEXT"), keys.index("ASR_RESULTS"))
                self.assertEqual(keys[-1], "USER_TEXT" if edited else "ASR_RESULTS")


if __name__ == "__main__":
    unittest.main()
