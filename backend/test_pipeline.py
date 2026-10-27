import unittest
from pathlib import Path
from threading import Event
from unittest.mock import patch
from backend.pipeline import run_pipeline
from engine.worker import Engine


class PipelineTests(unittest.TestCase):
    def request(self, operation="voiceTranslation"):
        return {"operation": operation, "text": "合成文本", "target_language": "en", "polish": True, "style": "自然整理", "models": {}, "context": {}}

    def testDictationUsesPromptForLanguageAndDeliversModelOutputAsIs(self):
        original = "今日はいい天気ですね。散歩に行きましょう。"
        translated = "今天天气真好。我们去散步吧。"
        engine, events = Engine(), []
        request = self.request("dictation")
        request["target_language"] = "zh-Hans"
        request["context"] = {"before": "这是一段中文上下文。"}
        with patch.object(engine, "transcribe", return_value={"text": original, "engine": "Qwen3-ASR", "secondary": True, "language": "Japanese", "language_source": "detected"}), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value=translated):
            run_pipeline(engine, request, "synthetic.wav", Event(), events.append)
        self.assertEqual(events[-1]["event"], "result")
        self.assertEqual(events[-1]["text"], translated)
        self.assertTrue(events[-1]["processed"])

    def testVoiceTranslationDoesNotPolishAndPublishesOriginalFirst(self):
        commands, events = [], []
        class Engine:
            def handle(self, request):
                commands.append(request["command"])
                return {"text": "识别原文" if request["command"] == "transcribe" else "translation"}
        run_pipeline(Engine(), self.request(), "synthetic.wav", Event(), events.append)
        self.assertEqual(commands, ["transcribe", "translate"])
        self.assertEqual([item["event"] for item in events], ["stage", "transcript", "stage", "result"])
        self.assertEqual(events[-1]["original"], "识别原文")

    def testPostASRFailureIncludesOriginalWithoutSuccess(self):
        class Engine:
            def handle(self, request):
                if request["command"] == "transcribe":
                    return {"text": "预算3500元"}
                raise ValueError("synthetic failure")
        events = []
        run_pipeline(Engine(), self.request(), "synthetic.wav", Event(), events.append)
        self.assertEqual(events[-1]["event"], "error")
        self.assertEqual(events[-1]["original"], "预算3500元")
        self.assertFalse(any(event["event"] == "result" for event in events))

    def testCancellationBeforeGenerationNeverStartsNextStage(self):
        cancelled = Event()
        class Engine:
            def handle(self, request):
                cancelled.set()
                return {"text": "识别原文"}
        events = []
        run_pipeline(Engine(), self.request(), "synthetic.wav", cancelled, events.append)
        self.assertEqual(events[-1]["event"], "cancelled")
        self.assertFalse(any(event["event"] == "result" for event in events))

    def testChineseAndEnglishRunSecondaryAfterPublishingPrimary(self):
        for language in ("Chinese", "English"):
            commands, events = [], []
            class Engine:
                def handle(self, request):
                    commands.append(request["command"])
                    if request["command"] == "transcribe":
                        return {"text": "Primary fixture", "engine": "Qwen3-ASR", "secondary": True, "language": language, "language_source": "detected"}
                    if request["command"] == "transcribe_secondary":
                        self_case.assertTrue(any(event["event"] == "transcript" for event in events))
                        self_case.assertEqual(request["language"], language)
                        self_case.assertEqual(request["audio"], "synthetic.wav")
                        return {"text": "Secondary fixture", "engine": "SenseVoice Small", "language": language}
                    self_case.assertEqual([item["transcript"] for item in request["asr_results"]], ["Primary fixture", "Secondary fixture"])
                    return {"text": "Translated fixture"}
            self_case = self
            run_pipeline(Engine(), self.request(), "synthetic.wav", Event(), events.append)
            self.assertEqual(commands, ["transcribe", "transcribe_secondary", "translate"])
            self.assertEqual(events[-1]["original"], "Primary fixture")

    def testOtherLanguagesUnknownForcedAndOnlineResultsStaySinglePass(self):
        for language, source, engine in [("Japanese", "detected", "Qwen3-ASR"), ("Cantonese", "detected", "Qwen3-ASR"), (None, "unknown", "Qwen3-ASR"), ("English", "unknown", "Qwen3-ASR"), ("Chinese", "forced", "Qwen3-ASR"), ("Chinese,English", "detected", "Qwen3-ASR"), ("English", "detected", "online-model"), ("Chinese", "detected", "Qwen3-ASR (PyTorch, no review)")]:
            commands, events = [], []
            class Engine:
                def handle(self, request):
                    commands.append(request["command"])
                    return {"text": "Fixture", "engine": engine, "secondary": engine == "Qwen3-ASR", "language": language, "language_source": source}
            run_pipeline(Engine(), self.request(), "synthetic.wav", Event(), events.append)
            self.assertEqual(commands, ["transcribe", "translate"])

    def testSecondaryFailurePreservesPrimaryAndNeverGeneratesResult(self):
        class Engine:
            def handle(self, request):
                if request["command"] == "transcribe":
                    return {"text": "预算3500元", "engine": "Qwen3-ASR", "secondary": True, "language": "Chinese", "language_source": "detected"}
                raise RuntimeError("secondary fixture failure")
        events = []
        run_pipeline(Engine(), self.request(), "synthetic.wav", Event(), events.append)
        self.assertEqual(events[-1]["event"], "error")
        self.assertEqual(events[-1]["original"], "预算3500元")
        self.assertFalse(any(event["event"] == "result" for event in events))

    def testCancelAfterPrimaryDoesNotStartSecondary(self):
        commands, events, cancelled = [], [], Event()
        class Engine:
            def handle(self, request):
                commands.append(request["command"])
                return {"text": "Primary fixture", "engine": "Qwen3-ASR", "secondary": True, "language": "English", "language_source": "detected"}
        def emit(event):
            events.append(event)
            if event["event"] == "transcript":
                cancelled.set()
        run_pipeline(Engine(), self.request(), "synthetic.wav", cancelled, emit)
        self.assertEqual(commands, ["transcribe"])
        self.assertEqual(events[-1]["event"], "cancelled")

    def testVerbatimStillAggregatesWithoutStylisticPolishing(self):
        commands, events = [], []
        class Engine:
            def handle(self, request):
                commands.append(request["command"])
                if request["command"] == "polish":
                    self_case.assertEqual(request["task"], "verbatim")
                    self_case.assertEqual(len(request["asr_results"]), 2)
                    return {"text": "Fused fixture"}
                return {"text": "Primary fixture" if request["command"] == "transcribe" else "Secondary fixture", "engine": "Qwen3-ASR", "secondary": True, "language": "English", "language_source": "detected"}
        self_case = self
        request = self.request("dictation")
        request["style"] = "保留原话"
        run_pipeline(Engine(), request, "synthetic.wav", Event(), events.append)
        self.assertEqual(commands, ["transcribe", "transcribe_secondary", "polish"])
        self.assertEqual(events[-1]["text"], "Fused fixture")
        self.assertFalse(events[-1]["processed"])

    def testEmptyModelBodyIsAnOutputFailureAndRetainsOriginal(self):
        class Engine:
            def handle(self, request):
                if request["command"] == "transcribe":
                    return {"text": "预算100元", "engine": "Qwen3-ASR", "secondary": True, "language": "Chinese", "language_source": "detected"}
                if request["command"] == "transcribe_secondary":
                    return {"text": "预算101元", "engine": "SenseVoice Small"}
                return {"text": None}
        events = []
        run_pipeline(Engine(), self.request("dictation"), "synthetic.wav", Event(), events.append)
        self.assertEqual(events[-1]["event"], "error")
        self.assertEqual(events[-1]["original"], "预算100元")
        self.assertFalse(any(event["event"] == "result" for event in events))

    def testManualPolishKeepsBothHistoricalCandidatesAndUserCorrection(self):
        requests, events = [], []
        class Engine:
            def handle(self, request):
                requests.append(request)
                return {"text": "预算102元"}
        request = self.request("polish")
        request["asr_results"] = [{"transcript": "预算100元"}, {"transcript": "预算101元"}]
        request["text"] = request["context"]["user_text"] = "预算102元"
        run_pipeline(Engine(), request, None, Event(), events.append)
        self.assertEqual(requests[0]["asr_results"], request["asr_results"])
        self.assertEqual(requests[0]["user_text"], "预算102元")
