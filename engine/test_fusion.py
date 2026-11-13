import json
import unittest
from pathlib import Path
from unittest.mock import patch

from engine.fusion import build_fusion_payload, build_polish_payload
from engine.worker import Engine, POLISH_PROMPT


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
        engine = Engine(allow_local_text=True)
        for task in ("verbatim",):
            with self.subTest(task=task), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value="今日は晴れです。") as generate:
                engine.polish({"text": "今日は晴れです。", "task": task, "target_language": "zh-Hans"})
                system, payload = generate.call_args.args[:2]
                self.assertIn("same-language transcription", system)
                self.assertIn("Source language code: ja", system)
                self.assertNotEqual(payload["TASK"], "translate")
                self.assertNotIn("TARGET_LANGUAGE", payload)
                self.assertIn("transcription, not translation", payload["OUTPUT_LANGUAGE"])

    def testTranslationGetsExplicitTargetInstruction(self):
        engine = Engine(allow_local_text=True)
        with patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value="今天天气很好。") as generate:
            result = engine.translate({"text": "今日はいい天気です。", "target_language": "zh-Hans", "asr_results": [{"transcript": "今日はいい天気です。", "language": "Japanese"}]})
            self.assertEqual(result["text"], "今天天气很好。")
            self.assertEqual(generate.call_args.args[1]["TASK"], "translate")
            self.assertEqual(generate.call_args.args[1]["TARGET_LANGUAGE"], "Simplified Chinese")
            self.assertIn("Simplified Chinese", generate.call_args.args[1]["OUTPUT_LANGUAGE"])

    def testModelBodyPassesThroughWithoutContentChanges(self):
        engine = Engine(allow_local_text=True)
        # These deliberately imperfect generations test delivery, not model quality.
        for output in ("今天有101人。", "今日は一百人です。", "  exact model text\n", '{"literal": 1}'):
            with self.subTest(output=output), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine.provider, "generate", return_value=(output, "stop")):
                self.assertEqual(engine.polish({"text": "今日は100人です。"})["text"], output)

    def testProvidedPromptReplacesBothLocalAndOnlinePolish(self):
        engine = Engine(allow_local_text=True)
        for online in (False, True):
            with self.subTest(online=online), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value="  exact output\n") as generate:
                request = {"text": "合成口述", "instruction": "整理为即时消息。"}
                if online:
                    request["online"] = {"text": {"model": "fixture"}}
                self.assertEqual(engine.polish(request)["text"], "  exact output\n")
                system, payload = generate.call_args.args[:2]
                self.assertEqual(system, POLISH_PROMPT)
                self.assertEqual(payload["INSTRUCTION"], request["instruction"])
                self.assertEqual(set(payload), {"INSTRUCTION", "AUDIO_CONTEXT", "context", "ASR_RESULTS"})

    def testEditedSourceReplacesStaleASRCandidatesAndControlsTokenBudget(self):
        engine = Engine(allow_local_text=True)
        request = {"asr_results": [{"engine_name": "Qwen", "transcript": "旧稿"}], "user_text": "当前修改后的正文。" * 100}
        with patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value="正文") as generate:
            engine.polish(request)
        payload = generate.call_args.args[1]
        self.assertEqual(payload["ASR_RESULTS"], [{"engine_name": "用户编辑正文", "transcript": request["user_text"]}])
        self.assertEqual(generate.call_args.args[2], len(request["user_text"]))
        self.assertEqual(request["asr_results"][0]["transcript"], "旧稿")

    def testPolishPayloadPreservesEnginesTermsAndCursorContext(self):
        request = {
            "asr_results": [{"engine_name": "Qwen", "transcript": "言墨"}, {"engine_name": "SenseVoice", "transcript": "研墨"}],
            "application": "微信", "category": "messaging", "before": "甲" * 350, "after": "乙" * 350,
            "key_terms": ["言墨"], "background_screen_text": ["言墨项目"],
        }
        payload = build_polish_payload(request)
        self.assertEqual(payload["ASR_RESULTS"], request["asr_results"])
        self.assertEqual(payload["AUDIO_CONTEXT"], {
            "key_terms": ["言墨"], "application": {"categories": ["messaging"], "name": "微信"},
            "background_screen_text": ["言墨项目"],
        })
        self.assertEqual(payload["context"], {"text_before_cursor": "甲" * 300, "text_after_cursor": "乙" * 300})
        self.assertEqual(payload["INSTRUCTION"], "")

    def testEmptyOrTruncatedGenerationIsATechnicalFailure(self):
        engine = Engine(allow_local_text=True)
        for output, finish in (("", "stop"), (" ", "stop"), ("partial", "length")):
            with self.subTest(output=output, finish=finish), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine.provider, "generate", return_value=(output, finish)), self.assertRaises(ValueError):
                engine.polish({"text": "合成原文"})

    def testOnlinePolishKeepsSystemStableAcrossDynamicInputs(self):
        engine = Engine(allow_local_text=True)
        systems, payloads = [], []
        requests = [
            {"text": "明天再检查。", "before": "中文上下文", "application": "应用甲", "key_terms": ["术语甲"], "instruction": "输出适合即时通讯的自然短句，不添加问候。"},
            {"text": "Please review tomorrow.", "before": "English context", "application": "App B", "key_terms": ["Term B"], "instruction": "按语义分段，不增加标题或信息。"},
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
            self.assertEqual(payload["context"]["text_before_cursor"], request["before"])
            self.assertIn(request["instruction"], payload["INSTRUCTION"])

    def testOnlineWireMessagesEndWithVariableJSON(self):
        engine = Engine(allow_local_text=True)
        wire = []
        def post(_config, _path, **kwargs):
            wire.append(kwargs["json"])
            return {"choices": [{"message": {"content": "原样返回"}, "finish_reason": "stop"}]}
        config = {"base_url": "https://example.test", "model": "fixture"}
        with patch("engine.online_provider._post", side_effect=post):
            for text in ("合成中文", "Synthetic English"):
                self.assertEqual(engine.polish({"text": text, "online": {"text": config}})["text"], "原样返回")
        self.assertEqual(wire[0]["messages"][0], {"role": "system", "content": POLISH_PROMPT})
        self.assertEqual(wire[0]["messages"][0], wire[1]["messages"][0])
        for body, source in zip(wire, ("合成中文", "Synthetic English")):
            messages = body["messages"]
            self.assertEqual([m["role"] for m in messages], ["system", "user"])
            payload = json.loads(messages[-1]["content"])
            self.assertEqual(payload["ASR_RESULTS"][0]["transcript"], source)
            self.assertEqual(list(payload)[-1], "ASR_RESULTS")
            self.assertEqual(messages[-1]["content"], json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
