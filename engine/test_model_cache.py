import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from engine.model_cache import prepare_model, resolve_cached_model, validate_model, PATTERNS


class ModelCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.weights = self.root / "fixture"
        self.weights.mkdir()
        (self.weights / "config.json").write_text("{}")
        (self.weights / "model.safetensors").write_bytes(b"synthetic")
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.ms = Mock(return_value=str(self.weights))
        self.hf = Mock(side_effect=FileNotFoundError())
        patches = [
            patch("engine.model_cache.modelscope_cache", return_value=self.cache),
            patch("pathlib.Path.home", return_value=self.root),
            patch.dict(sys.modules, {
                "modelscope.hub.snapshot_download": SimpleNamespace(snapshot_download=self.ms),
                "huggingface_hub": SimpleNamespace(snapshot_download=self.hf),
            }),
        ]
        for context in patches:
            context.start()
            self.addCleanup(context.stop)

    def testRuntimeAndPreparationReuseCacheWithoutDownloading(self):
        self.assertEqual(resolve_cached_model("fixture/model"), self.weights)
        self.assertEqual(prepare_model("fixture/model"), (self.weights, True))
        self.assertTrue(all(call.kwargs["local_files_only"] for call in self.ms.call_args_list))
        self.hf.assert_not_called()

    def testOnlyExplicitPreparationDownloadsAndDefaultsToModelScope(self):
        self.ms.side_effect = lambda *_args, **kwargs: (_ for _ in ()).throw(FileNotFoundError()) if kwargs.get("local_files_only") else str(self.weights)
        with self.assertRaises(ValueError):
            resolve_cached_model("fixture/model")
        self.assertTrue(all(call.kwargs["local_files_only"] for call in self.ms.call_args_list))
        self.assertEqual(prepare_model("fixture/model"), (self.weights, False))
        self.assertNotIn("local_files_only", self.ms.call_args.kwargs)
        self.assertEqual(self.ms.call_args.kwargs["cache_dir"], str(self.cache))

    def testExistingHuggingFaceCachePreventsDuplicateDownload(self):
        self.ms.side_effect = FileNotFoundError()
        self.hf.side_effect = None
        self.hf.return_value = str(self.weights)
        self.assertEqual(prepare_model("fixture/model"), (self.weights, True))
        self.assertTrue(self.hf.call_args.kwargs["local_files_only"])
        self.assertTrue(all(call.kwargs["local_files_only"] for call in self.ms.call_args_list))

    def testSenseVoiceAncillaryFilesAreIncludedAndRequired(self):
        import json
        self.assertIn("*.mvn", PATTERNS)
        (self.weights / "config.json").write_text(json.dumps({"model_type": "sensevoice"}))
        with self.assertRaises(ValueError):
            validate_model(self.weights, "fixture")
        (self.weights / "am.mvn").write_text("synthetic statistics")
        (self.weights / "tokens.json").write_text("[]")
        self.assertEqual(validate_model(self.weights, "fixture"), self.weights)


if __name__ == "__main__":
    unittest.main()
