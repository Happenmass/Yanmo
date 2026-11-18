import asyncio
import base64
import io
import json
import sys
import unittest
from unittest.mock import patch
import wave
import httpx
from fastapi import Request
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect
from backend.server import create_app
from engine import online_provider
from engine.worker import Engine

ENDPOINT = {"base_url": "https://api.example.test/v1", "model": "remote", "api_key": ""}


class FakeEngine:
    def handle(self, request):
        return {"text": "合成结果"}
    def unload(self):
        pass


def synthetic_wav():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((1, 2, 16000, 16000, "NONE", ""))
        audio.writeframes(b"\0\0" * 16000)
    return output.getvalue()


class ServerTests(unittest.TestCase):
    def testCorrectionTermsUseDedicatedPromptAndOnlyTheTwoVersions(self):
        from engine.worker import CORRECTION_PROMPT

        headers = {"Authorization": "Bearer test-only"}
        request = {"original": "联系沈燕。", "corrected": "联系沈砚。", "online": ENDPOINT}
        with patch.object(online_provider, "generate", return_value=('["沈砚", "沈砚", "编造词"]', "stop")) as generate, \
                TestClient(create_app(Engine(), token="test-only")) as client:
            response = client.post("/v1/corrections/terms", json=request, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"terms": ["沈砚"]})
            self.assertEqual(generate.call_args.args[:3], (ENDPOINT, CORRECTION_PROMPT, {"ORIGINAL": "联系沈燕。", "CORRECTED": "联系沈砚。"}))
            self.assertEqual(generate.call_args.kwargs["purpose"], "hotword_extract")
            request.update(corrected="草稿：联系沈砚。", transcript="联系沈燕")
            response = client.post("/v1/corrections/terms", json=request, headers=headers)
            self.assertEqual(response.json(), {"terms": ["沈砚"]})
            self.assertEqual(generate.call_args.args[2], {"ORIGINAL": "联系沈燕。", "CORRECTED": "草稿：联系沈砚。", "ASR": "联系沈燕"})
            request["corrected"] = request["original"]
            self.assertEqual(client.post("/v1/corrections/terms", json=request, headers=headers).json(), {"terms": []})
            self.assertEqual(generate.call_count, 2)
            request["corrected"] = "联系沈砚。"
            generate.return_value = ('{"terms": ["沈砚"]}', "stop")
            self.assertEqual(client.post("/v1/corrections/terms", json=request, headers=headers).status_code, 502)

    def testAuthorizationAndInvalidRequestsNeverReachProvider(self):
        with TestClient(create_app(FakeEngine(), token="test-only")) as client:
            self.assertEqual(client.post("/v1/warmup", json={}).status_code, 401)
            headers = {"Authorization": "Bearer test-only"}
            invalid = {"task_id": "fixture", "operation": "polish", "audio_path": "/private/file"}
            response = client.post("/v1/tasks", data={"request": json.dumps(invalid)}, headers=headers)
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("/private/file", response.text)

    def testAudioUploadStreamsOriginalAndCompleteResult(self):
        request = {
            "task_id": "fixture",
            "operation": "dictation",
            "polish": False,
            "archive_audio": True,
            "online": {"text": ENDPOINT},
            "context": {
                "application": "微信",
                "category": "messaging",
                "lexicon": [{"term": "言墨", "hint": "输入法", "aliases": ["研墨"]}],
            },
        }
        with TestClient(create_app(FakeEngine(), token="test-only")) as client:
            response = client.post("/v1/tasks", data={"request": json.dumps(request)}, files={"audio": ("recording.wav", synthetic_wav(), "audio/wav")}, headers={"Authorization": "Bearer test-only"})
            self.assertEqual(response.status_code, 200)
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            self.assertEqual([event["event"] for event in events], ["stage", "transcript", "audio", "stage", "result"])
            self.assertTrue(all(event["task_id"] == "fixture" for event in events))
            self.assertTrue(base64.b64decode(events[2]["audio_opus"]).startswith(b"OggS"))
            self.assertEqual(events[-1]["text"], "合成结果")

            invalid = {**request, "context": {"key_terms": ["言墨"]}}
            rejected = client.post("/v1/tasks", data={"request": json.dumps(invalid)}, files={"audio": ("recording.wav", synthetic_wav(), "audio/wav")}, headers={"Authorization": "Bearer test-only"})
            self.assertEqual(rejected.status_code, 422)

            too_many = {**request, "asr_hotwords": [f"词条{i}" for i in range(65)]}
            rejected = client.post("/v1/tasks", data={"request": json.dumps(too_many)}, files={"audio": ("recording.wav", synthetic_wav(), "audio/wav")}, headers={"Authorization": "Bearer test-only"})
            self.assertEqual(rejected.status_code, 422)

    def testMemoryWavStreamsFragmentedUploadAndSameEvents(self):
        request = {"task_id": "memory", "operation": "dictation",
                   "archive_audio": True, "online": {"text": ENDPOINT}, "context": {"application": "言墨"}}
        audio = synthetic_wav()
        metadata = json.dumps(request, ensure_ascii=False).encode("utf-8")
        body = len(metadata).to_bytes(4, "big") + metadata + audio

        async def fragments(_request):
            for start, end in [(0, 1), (1, 4), (4, 13), (13, len(metadata) + 15), (len(metadata) + 15, len(body))]:
                yield body[start:end]
            yield b""

        sources = []

        class MemoryEngine(FakeEngine):
            def handle(self, request):
                if request["command"] in ("transcribe", "transcribe_secondary"):
                    source = request["audio"]
                    assert isinstance(source, io.BytesIO)
                    assert source.getvalue() == audio
                    sources.append(source)
                    return {"text": "合成识别", "language": "Chinese", "language_source": "detected", "secondary": True}
                return super().handle(request)

        headers = {"Authorization": "Bearer test-only", "Content-Type": "application/octet-stream"}
        with patch.object(Request, "stream", fragments), TestClient(create_app(MemoryEngine(), token="test-only")) as client:
            response = client.post("/v1/tasks/audio", headers=headers)
        self.assertEqual(response.status_code, 200)
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        self.assertEqual([event["event"] for event in events], ["stage", "transcript", "audio", "stage", "transcript", "stage", "result"])
        self.assertTrue(all(event["task_id"] == "memory" for event in events))
        self.assertTrue(base64.b64decode(events[2]["audio_opus"]).startswith(b"OggS"))
        self.assertEqual(events[-1]["text"], "合成结果")
        self.assertEqual(len(sources), 2)
        self.assertIs(sources[0], sources[1])
        self.assertTrue(sources[0].closed)

    def testMemoryWavRejectsMalformedAndOversizedUploadWithoutHoldingSlot(self):
        metadata = json.dumps({"task_id": "memory", "operation": "dictation", "online": {"text": ENDPOINT}}).encode()
        prefix = len(metadata).to_bytes(4, "big") + metadata
        headers = {"Authorization": "Bearer test-only", "Content-Type": "application/octet-stream"}
        with TestClient(create_app(FakeEngine(), token="test-only")) as client:
            self.assertEqual(client.post("/v1/tasks/audio", content=prefix + b"audio").status_code, 401)
            self.assertEqual(client.post("/v1/tasks/audio", headers={"Authorization": "Bearer test-only"}).status_code, 415)
            for body, code in [(b"x", 422), (b"\x00" * 4, 422), (prefix[:-1], 422), (prefix, 422),
                               ((1024 * 1024 + 1).to_bytes(4, "big"), 413)]:
                self.assertEqual(client.post("/v1/tasks/audio", content=body, headers=headers).status_code, code)
            with patch("backend.server.MAX_TASK_AUDIO", 2):
                self.assertEqual(client.post("/v1/tasks/audio", content=prefix + b"abc", headers=headers).status_code, 413)
            corrupt = client.post("/v1/tasks/audio", content=prefix + b"not a WAV", headers=headers)
            self.assertIn('"event": "error"', corrupt.text)
            self.assertNotIn("transcribing", corrupt.text)

            async def disconnected(_request):
                yield prefix + b"part"
                raise ClientDisconnect()

            with patch.object(Request, "stream", disconnected):
                with self.assertRaises(ClientDisconnect):
                    client.post("/v1/tasks/audio", headers=headers)
            response = client.post("/v1/tasks/audio", content=prefix + synthetic_wav(), headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertIn('"event": "result"', response.text)

    def testMemoryUploadCancellationDoesNotInferAndAllowsRetry(self):
        metadata = json.dumps({"task_id": "cancel-me", "operation": "dictation", "online": {"text": ENDPOINT}}).encode()
        prefix = len(metadata).to_bytes(4, "big") + metadata
        headers = {"Authorization": "Bearer test-only", "Content-Type": "application/octet-stream"}
        engine = FakeEngine()

        async def exchange():
            app = create_app(engine, token="test-only")
            async with app.router.lifespan_context(app), httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://testserver"
            ) as client:
                async def chunks():
                    yield prefix + b"first-audio-chunk"
                    blocked = await client.post("/v1/tasks/audio", content=prefix, headers=headers)
                    self.assertEqual(blocked.status_code, 409)
                    cancelled = await client.post("/v1/tasks/cancel-me/cancel", headers=headers)
                    self.assertEqual(cancelled.json(), {"cancelled": True})
                    yield b"late-chunk"

                with patch.object(engine, "handle", side_effect=AssertionError("must not infer")) as handle:
                    response = await client.post("/v1/tasks/audio", content=chunks(), headers=headers)
                    self.assertIn('"event": "cancelled"', response.text)
                    handle.assert_not_called()
                retry = await client.post("/v1/tasks/audio", content=prefix + synthetic_wav(), headers=headers)
                self.assertIn('"event": "result"', retry.text)

        asyncio.run(exchange())

    def testMemoryWavOnlineUploadOnlyWhenExplicitlyEnabled(self):
        audio = synthetic_wav()
        metadata = json.dumps({"task_id": "explicit", "operation": "dictation",
                               "online": {"text": ENDPOINT, "asr": ENDPOINT}}).encode()
        prefix = len(metadata).to_bytes(4, "big") + metadata
        headers = {"Authorization": "Bearer test-only", "Content-Type": "application/octet-stream"}
        conn = []

        def capture(config, path, *, files, **kwargs):
            self.assertEqual(config, ENDPOINT)
            self.assertEqual(path, "/audio/transcriptions")
            filename, file, mime = files["file"]
            self.assertEqual((filename, mime), ("recording.wav", "audio/wav"))
            self.assertIsInstance(file, io.BytesIO)
            self.assertEqual(file.read(), audio)
            conn.append(file)
            return {"text": "合成在线识别"}

        with patch.object(online_provider, "_post", side_effect=capture), \
                patch.object(online_provider, "generate", return_value=("合成在线文字", "stop")), \
                TestClient(create_app(Engine(), token="test-only")) as client:
            result = client.post("/v1/tasks/audio", content=prefix + audio, headers=headers)
        self.assertIn('"event": "result"', result.text)
        self.assertEqual(len(conn), 1)
        self.assertTrue(conn[0].closed)

    def testTasksWithoutTextEndpointAreRejectedBeforeInference(self):
        engine = FakeEngine()
        with patch.object(engine, "handle", side_effect=AssertionError("must not infer")), TestClient(create_app(engine, token="test-only")) as client:
            for operation in ("dictation", "voiceTranslation", "selectionTranslation", "polish"):
                request = {"task_id": "fixture", "operation": operation}
                response = client.post("/v1/tasks", data={"request": json.dumps(request)}, headers={"Authorization": "Bearer test-only"})
                self.assertEqual(response.status_code, 422)
                self.assertIn("文字处理 API", response.json()["detail"])

    def testOnlineOnlyDictationNeverImportsMLX(self):
        """The Windows gateway path: the real Engine with both capabilities online."""
        request = {"task_id": "online", "operation": "dictation", "online": {"asr": ENDPOINT, "text": ENDPOINT}}
        with patch.object(online_provider, "transcribe", lambda *_: "合成在线识别"), patch.object(online_provider, "generate", lambda *_, **_kwargs: ("合成在线正文", "stop")), \
                TestClient(create_app(Engine(), token="test-only")) as client:
            response = client.post("/v1/tasks", data={"request": json.dumps(request)}, files={"audio": ("recording.wav", synthetic_wav(), "audio/wav")}, headers={"Authorization": "Bearer test-only"})
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        self.assertEqual([event["event"] for event in events], ["stage", "transcript", "stage", "result"])
        self.assertEqual(events[-1]["text"], "合成在线正文")
        self.assertFalse(any(name == "mlx" or name.startswith(("mlx.", "mlx_")) for name in sys.modules))

    def testAllTextTasksUseOneSharedEndpointAndPreserveLocalSpeechRecognition(self):
        class LocalSpeech:
            def unload(self):
                pass
        engine = Engine(LocalSpeech())
        primary = {"text": "合成语音", "engine": "Qwen3-ASR", "language": "Chinese", "language_source": "detected"}
        headers = {"Authorization": "Bearer test-only"}
        with patch.object(engine, "transcribe", return_value=primary) as speech, \
                patch.object(online_provider, "generate", return_value=("合成 API 结果", "stop")) as generate, \
                TestClient(create_app(engine, token="test-only")) as client:
            for operation in ("dictation", "voiceTranslation", "selectionTranslation", "polish"):
                with self.subTest(operation=operation):
                    generate.reset_mock()
                    audio = {"audio": ("recording.wav", synthetic_wav(), "audio/wav")} if operation in ("dictation", "voiceTranslation") else None
                    request = {"task_id": "fixture", "operation": operation, "text": "合成文字", "online": {"text": ENDPOINT}}
                    response = client.post("/v1/tasks", data={"request": json.dumps(request)}, files=audio, headers=headers)
                    self.assertEqual(response.status_code, 200)
                    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
                    self.assertEqual(events[-1]["event"], "result")
                    self.assertEqual(events[-1]["text"], "合成 API 结果")
                    self.assertEqual(generate.call_count, 1)
                    self.assertEqual(generate.call_args.args[0], ENDPOINT)
                    self.assertEqual(generate.call_args.kwargs["purpose"], "translate" if operation.endswith("Translation") else "polish")
            self.assertEqual(speech.call_count, 2)
            self.assertTrue(all("asr" not in call.args[0]["online"] for call in speech.call_args_list))
