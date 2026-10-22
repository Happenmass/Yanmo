import io
import json
import unittest
import wave
from fastapi.testclient import TestClient
from backend.server import create_app


class FakeEngine:
    def handle(self, request):
        return {"text": "合成结果"}
    def unload(self):
        pass


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
        output = io.BytesIO()
        with wave.open(output, "wb") as audio:
            audio.setparams((1, 2, 16000, 16000, "NONE", ""))
            audio.writeframes(b"\0\0" * 16000)
        request = {"task_id": "fixture", "operation": "dictation", "polish": False}
        with TestClient(create_app(FakeEngine(), token="test-only")) as client:
            response = client.post("/v1/tasks", data={"request": json.dumps(request)}, files={"audio": ("recording.wav", output.getvalue(), "audio/wav")}, headers={"Authorization": "Bearer test-only"})
            self.assertEqual(response.status_code, 200)
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            self.assertEqual([event["event"] for event in events], ["stage", "transcript", "stage", "result"])
            self.assertTrue(all(event["task_id"] == "fixture" for event in events))
            self.assertEqual(events[-1]["text"], "合成结果")
