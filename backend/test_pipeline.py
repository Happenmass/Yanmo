import base64
import io
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from unittest.mock import patch
from backend.pipeline import run_pipeline
from engine.worker import Engine


class PipelineTests(unittest.TestCase):
    def testArchiveFailureWarnsWithoutLosingTextAndTranscriptPrecedesEncoding(self):
        events = []
        class StubEngine:
            def handle(self, request):
                return {"text": "合成原文" if request["command"] == "transcribe" else "合成正文"}
        def broken_encoder(_audio):
            self.assertTrue(any(e["event"] == "transcript" for e in events))
            raise RuntimeError("synthetic codec error")
        request = self.request("dictation")
        request["archive_audio"] = True
        with patch("backend.pipeline.encode_opus", side_effect=broken_encoder):
            run_pipeline(StubEngine(), request, "fixture.wav", Event(), events.append)
        self.assertEqual(events[-1]["event"], "result")
        self.assertEqual(events[-1]["text"], "合成正文")
        warning = next(e for e in events if e["event"] == "audio")
        self.assertIn("录音未保存", warning["audio_warning"])
        self.assertNotIn("synthetic", warning["audio_warning"])

    def testDisabledHistoryAndCancellationDoNotEncodeAudio(self):
        class StubEngine:
            def handle(self, request): return {"text": "合成正文"}
        for enabled in (False, True):
            cancelled, events = Event(), []
            request = self.request("dictation")
            request["archive_audio"] = enabled
            def emit(event):
                events.append(event)
                if enabled and event["event"] == "transcript": cancelled.set()
            with patch("backend.pipeline.encode_opus") as encode:
                run_pipeline(StubEngine(), request, "fixture.wav", cancelled, emit)
                encode.assert_not_called()
            self.assertEqual(events[-1]["event"], "cancelled" if enabled else "result")

    def request(self, operation="voiceTranslation"):
        return {"operation": operation, "text": "合成文本", "target_language": "en", "polish": True, "style": "自然整理", "models": {}, "context": {}}

    def testDictationUsesPromptForLanguageAndDeliversModelOutputAsIs(self):
        original = "今日はいい天気ですね。散歩に行きましょう。"
        translated = "今天天气真好。我们去散步吧。"
        engine, events = Engine(allow_local_text=True), []
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

    def testNaturalPolishDoesNotInjectOldEditingRules(self):
        engine = Engine(allow_local_text=True)
        for style, instruction in (("自然整理", ""), ("即时消息", "整理为即时消息。"), ("文档段落", "整理为文档段落。")):
            with self.subTest(style=style), patch.object(engine, "load_llm", return_value=Path("fixture")), patch.object(engine, "generate_text", return_value="整理后的正文") as generate:
                request = self.request("polish")
                request["style"] = style
                events = []
                run_pipeline(engine, request, None, Event(), events.append)
                self.assertEqual(events[-1]["event"], "result")
                self.assertEqual(generate.call_args.args[1]["INSTRUCTION"], instruction)

    def testDictationForwardsApplicationLexiconAndOpusAudio(self):
        calls, events = [], []
        class StubEngine:
            def handle(self, request):
                calls.append(request)
                if request["command"] == "transcribe":
                    return {"text": "言墨识别", "engine": "Qwen3-ASR", "secondary": False, "language": "Chinese", "language_source": "detected"}
                return {"text": "言墨正文"}
        request = self.request("dictation")
        request["archive_audio"] = True
        request["asr_hotwords"] = ["言墨"]
        request["context"] = {"application": "微信", "category": "messaging", "lexicon": [{"term": "言墨", "hint": "输入法", "aliases": ["研墨"]}, {"term": "只给整理"}]}
        with TemporaryDirectory() as directory:
            wav_path = Path(directory, "speech.wav")
            with wave.open(str(wav_path), "wb") as audio:
                audio.setparams((1, 2, 16000, 16000, "NONE", ""))
                audio.writeframes(b"\x01\x00" * 16000)
            run_pipeline(StubEngine(), request, wav_path, Event(), events.append)
        self.assertEqual(calls[0]["application"], "微信")
        self.assertEqual(calls[0]["lexicon"], ["言墨"])
        self.assertEqual(calls[1]["lexicon"], request["context"]["lexicon"])
        audio_event = next(event for event in events if event["event"] == "audio")
        self.assertTrue(base64.b64decode(audio_event["audio_opus"]).startswith(b"OggS"))

    def testEmptyASRSelectionAndLegacyScopeStaySeparateFromTextGlossary(self):
        lexicon = [{"term": f"词条{i}", "hint": "备注", "aliases": [f"误识别{i}"]} for i in range(80)]
        for selection, expected in ((None, [f"词条{i}" for i in range(64)]), ([], [])):
            with self.subTest(selection=selection):
                calls, events = [], []

                class StubEngine:
                    def handle(self, request):
                        calls.append(request)
                        return {"text": "正文"}

                request = self.request("dictation")
                request["context"]["lexicon"] = lexicon
                request["asr_hotwords"] = selection
                run_pipeline(StubEngine(), request, Path("fixture.wav"), Event(), events.append)
                self.assertEqual(calls[0]["lexicon"], expected)
                self.assertEqual(calls[-1]["lexicon"], lexicon)
                self.assertEqual(events[-1]["event"], "result")
