import io
import json
import sys
import unittest
from unittest.mock import patch
import wave
from fastapi.testclient import TestClient
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
        request = {"task_id": "fixture", "operation": "dictation", "polish": False, "online": {"text": ENDPOINT}}
        with TestClient(create_app(FakeEngine(), token="test-only")) as client:
            response = client.post("/v1/tasks", data={"request": json.dumps(request)}, files={"audio": ("recording.wav", synthetic_wav(), "audio/wav")}, headers={"Authorization": "Bearer test-only"})
            self.assertEqual(response.status_code, 200)
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            self.assertEqual([event["event"] for event in events], ["stage", "transcript", "stage", "result"])
            self.assertTrue(all(event["task_id"] == "fixture" for event in events))
            self.assertEqual(events[-1]["text"], "合成结果")

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
        with patch.object(online_provider, "transcribe", lambda *_: "合成在线识别"), patch.object(online_provider, "generate", lambda *_: ("合成在线正文", "stop")), \
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
            self.assertEqual(speech.call_count, 2)
            self.assertTrue(all("asr" not in call.args[0]["online"] for call in speech.call_args_list))
