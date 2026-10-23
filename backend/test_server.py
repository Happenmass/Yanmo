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
    def testAuthorizationAndInvalidRequestsNeverReachProvider(self):
        with TestClient(create_app(FakeEngine(), token="test-only")) as client:
            self.assertEqual(client.post("/v1/warmup", json={}).status_code, 401)
            headers = {"Authorization": "Bearer test-only"}
            invalid = {"task_id": "fixture", "operation": "polish", "audio_path": "/private/file"}
            response = client.post("/v1/tasks", data={"request": json.dumps(invalid)}, headers=headers)
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("/private/file", response.text)

    def testAudioUploadStreamsOriginalAndCompleteResult(self):
        request = {"task_id": "fixture", "operation": "dictation", "polish": False}
        with TestClient(create_app(FakeEngine(), token="test-only")) as client:
            response = client.post("/v1/tasks", data={"request": json.dumps(request)}, files={"audio": ("recording.wav", synthetic_wav(), "audio/wav")}, headers={"Authorization": "Bearer test-only"})
            self.assertEqual(response.status_code, 200)
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            self.assertEqual([event["event"] for event in events], ["stage", "transcript", "stage", "result"])
            self.assertTrue(all(event["task_id"] == "fixture" for event in events))
            self.assertEqual(events[-1]["text"], "合成结果")

    def testOnlineOnlyDictationNeverImportsMLX(self):
        """The Windows gateway path: the real Engine with both capabilities online."""
        endpoint = {"base_url": "https://api.example.test/v1", "model": "remote", "api_key": ""}
        request = {"task_id": "online", "operation": "dictation", "online": {"asr": endpoint, "text": endpoint}}
        with patch.object(online_provider, "transcribe", lambda *_: "合成在线识别"), patch.object(online_provider, "generate", lambda *_: ("合成在线正文", "stop")), \
                TestClient(create_app(Engine(), token="test-only")) as client:
            response = client.post("/v1/tasks", data={"request": json.dumps(request)}, files={"audio": ("recording.wav", synthetic_wav(), "audio/wav")}, headers={"Authorization": "Bearer test-only"})
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        self.assertEqual([event["event"] for event in events], ["stage", "transcript", "stage", "result"])
        self.assertEqual(events[-1]["text"], "合成在线正文")
        self.assertFalse(any(name == "mlx" or name.startswith(("mlx.", "mlx_")) for name in sys.modules))
