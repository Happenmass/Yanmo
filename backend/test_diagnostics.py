import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
import unittest
from unittest.mock import patch
import httpx
from backend.pipeline import run_pipeline
from engine import diagnostics, online_provider


class DiagnosticsTests(unittest.TestCase):
    def test_api_timeout_is_correlated_without_recording_private_input(self):
        with TemporaryDirectory() as folder, patch.dict(os.environ, {'YANMO_DIAGNOSTICS_DIR': folder}), patch.object(diagnostics, '_logger', None):
            class Engine:
                def handle(self, request):
                    if request['command'] == 'transcribe':
                        return {'text': 'PRIVATE_TRANSCRIPT'}
                    return {'text': online_provider.generate({'base_url': 'https://example.test/private?key=SECRET', 'api_key': 'SECRET', 'model': 'test'}, 'PRIVATE_SYSTEM', {'text': 'PRIVATE_TRANSCRIPT'}, 512)[0]}
            events = []
            request = {'task_id': 'synthetic-task', 'operation': 'dictation', 'text': '', 'polish': True, 'style': '自然整理', 'context': {}, 'models': {}}
            with patch.object(online_provider.httpx, 'post', side_effect=httpx.ReadTimeout('SECRET PRIVATE_TRANSCRIPT')):
                run_pipeline(Engine(), request, 'PRIVATE_AUDIO.wav', Event(), events.append)
            self.assertEqual(events[-1]['event'], 'error')
            content = Path(folder, 'inference.jsonl').read_text()
            rows = [json.loads(line) for line in content.splitlines()]
            self.assertTrue(all(row['task_id'] == 'synthetic-task' for row in rows))
            self.assertTrue(any(row['event'] == 'api_error' and row['error_type'] == 'ReadTimeout' for row in rows))
            self.assertTrue(any(row['event'] == 'task_error' and row['stage'] == 'polishing' for row in rows))
            self.assertEqual(diagnostics.task_id.get(), '')
            for private in ('PRIVATE_', 'SECRET', 'example.test'):
                self.assertNotIn(private, content)
            for handler in diagnostics._logger.handlers:
                handler.close()

    def test_unwritable_diagnostics_does_not_fail_task(self):
        with patch.dict(os.environ, {'YANMO_DIAGNOSTICS_DIR': '/dev/null/logs'}), patch.object(diagnostics, '_logger', None):
            diagnostics.record('stage', stage='polishing')
