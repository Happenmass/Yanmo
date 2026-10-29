import io
import json
import os
import unittest
import wave
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.server import create_app
from engine import online_provider
from engine.worker import Engine

class APIDistributionTests(unittest.TestCase):
    def test_api_runtime_rejects_local_fallback_and_runs_whole_online_pipeline(self):
        with patch.dict(os.environ, {'YANMO_API_ONLY':'1'}):
            engine = Engine()
            self.assertEqual(type(engine.provider).__name__, 'APIOnlyProvider')
            with self.assertRaises(ValueError):
                engine.provider.load_asr('unused')
            with patch.object(online_provider,'transcribe',return_value='合成口述'), patch.object(online_provider,'generate',return_value=('合成正文。','stop')), TestClient(create_app(engine,token='test-only')) as client:
                headers={'Authorization':'Bearer test-only'}
                self.assertEqual(client.post('/v1/warmup',headers=headers,json={}).status_code,400)
                payload={'task_id':'fixture','operation':'dictation'}
                response=client.post('/v1/tasks',headers=headers,data={'request':json.dumps(payload)})
                self.assertEqual(response.status_code,422)
                output=io.BytesIO()
                with wave.open(output,'wb') as f:
                    f.setparams((1,2,16000,16000,'NONE','')); f.writeframes(b'\0\0'*16000)
                endpoint={'base_url':'https://arti.local/v1','model':'test'}
                payload['online']={'asr':endpoint,'text':endpoint}
                response=client.post('/v1/tasks',headers=headers,data={'request':json.dumps(payload)},files={'audio':('test.wav',output.getvalue(),'audio/wav')})
                events=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
                self.assertEqual(events[-1]['text'],'合成正文。')
                self.assertFalse(any(e['event']=='error' for e in events))
