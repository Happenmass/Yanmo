import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx

import online_provider
from worker import Engine

CONFIG = {"base_url": "https://api.example.test/v1/", "model": "remote-model", "api_key": "sk-test"}


class Response:
    def __init__(self, status, body):
        self.status_code, self.body = status, body

    def json(self):
        return self.body


class OnlineProviderTests(unittest.TestCase):
    def testChatRequestShapeAndAuthorization(self):
        calls = []
        def post(url, **kwargs):
            calls.append((url, kwargs))
            return Response(200, {"choices": [{"message": {"content": "done"}, "finish_reason": "stop"}]})
        with patch.object(online_provider.httpx, "post", post):
            self.assertEqual(online_provider.generate(CONFIG, "system", {"x": 1}, 64), ("done", "stop"))
        url, kwargs = calls[0]
        self.assertEqual(url, "https://api.example.test/v1/chat/completions")
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer sk-test"})
        self.assertEqual(kwargs["json"]["model"], "remote-model")
        self.assertNotIn("follow_redirects", kwargs)

    def testErrorsAreReadableAndNeverEchoTheKey(self):
        for status, body in [(401, {}), (404, {}), (429, {}), (500, {}), (302, {}), (200, {"unexpected": True})]:
            with patch.object(online_provider.httpx, "post", lambda *_a, **_k: Response(status, body)):
                with self.assertRaises(ValueError) as caught:
                    online_provider.generate(CONFIG, "s", {}, 8)
                self.assertNotIn("sk-test", str(caught.exception))
        def fail(*_a, **_k):
            raise httpx.ConnectError("refused sk-test")
        with patch.object(online_provider.httpx, "post", fail):
            with self.assertRaises(ValueError) as caught:
                online_provider.generate(CONFIG, "s", {}, 8)
            self.assertNotIn("sk-test", str(caught.exception))

    def testEngineRoutesOnlyEnabledCapabilitiesOnline(self):
        class Local:
            def __init__(self): self.calls = []
            def load_asr(self, path): self.calls.append("load_asr")
            def transcribe(self, audio, language): self.calls.append("transcribe"); return "本地"
            def load_llm(self, path): self.calls.append("load_llm")
            def generate(self, system, payload, tokens): self.calls.append("generate"); return "本地", "stop"
            def unload(self): pass
        local = Local()
        engine = Engine(local)
        with TemporaryDirectory() as directory, patch.object(online_provider, "transcribe", lambda c, a, l: "在线识别"), \
                patch.object(online_provider, "generate", lambda c, s, p, t: ("Online text", "stop")), \
                patch("worker.resolve_model", lambda *_: Path(directory)):
            audio = Path(directory, "a.wav"); audio.write_bytes(b"RIFF")
            asr_only = {"asr": CONFIG}
            self.assertEqual(engine.handle({"command": "transcribe", "audio": str(audio), "online": asr_only})["text"], "在线识别")
            self.assertEqual(engine.handle({"command": "translate", "text": "你好", "target_language": "en", "online": asr_only})["text"], "本地")
            self.assertEqual(local.calls, ["load_llm", "generate"])
            result = engine.handle({"command": "translate", "text": "你好", "target_language": "en", "online": {"text": CONFIG}})
            self.assertEqual((result["text"], result["engine"]), ("Online text", "remote-model"))
            self.assertEqual(local.calls, ["load_llm", "generate"])


if __name__ == "__main__":
    unittest.main()
