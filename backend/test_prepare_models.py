import contextlib
import io
import json
import unittest
from unittest.mock import patch

from backend import prepare_models


def run(argv, resolve=None, prepare=None):
    output = io.StringIO()
    with patch.object(prepare_models, "resolve_cached_model", resolve or (lambda *_: None)), \
            patch.object(prepare_models, "prepare_model", prepare or (lambda model, _source: (model, False))), contextlib.redirect_stdout(output):
        prepare_models.main(argv)
    return [json.loads(line) for line in output.getvalue().splitlines()]


class PrepareModelsTests(unittest.TestCase):
    def testCheckReportsCacheWithoutDownloading(self):
        def resolve(model, _source):
            if model == "missing":
                raise ValueError("未找到")
        def prepare(*_):
            raise AssertionError("--check must not download")
        events = run(["--check", "--asr", "present", "--sensevoice", "missing"], resolve, prepare)
        self.assertEqual(events, [{"event": "checked", "model": "present", "ready": True}, {"event": "checked", "model": "missing", "ready": False}])

    def testWindowsPreparationSkipsSenseVoice(self):
        events = run(["--without-sensevoice", "--asr", "a"])
        self.assertEqual([event["model"] for event in events if event["event"] == "prepared"], ["a"])
        self.assertIn("mlx-community/SenseVoiceSmall", [event["model"] for event in run(["--asr", "a"]) if event["event"] == "prepared"])


if __name__ == "__main__":
    unittest.main()
