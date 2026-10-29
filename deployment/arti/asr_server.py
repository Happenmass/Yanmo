"""Loopback Qwen3-ASR 1.7B service. FP16, explicitly split decoder layers over two GPUs."""
import asyncio
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

MODEL_ID = 'Qwen/Qwen3-ASR-1.7B'
MAX_BYTES = 20 * 1024 * 1024
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='qwen-asr')
model = None
placement = {}


def load_model():
    import torch
    from qwen_asr import Qwen3ASRModel
    if torch.cuda.device_count() != 2:
        raise RuntimeError('Exactly two GPUs are required for the verified layer split.')
    path = os.environ['YANMO_ASR_MODEL_PATH']
    config = json.loads((Path(path) / 'config.json').read_text())
    layers = config['thinker_config']['text_config']['num_hidden_layers']
    # Audio encoder and tied embeddings/output head on GPU0; final decoder layers on GPU1.
    # No tensor parallelism, quantization, CPU offload or second model replica.
    split = int(os.environ.get('YANMO_ASR_SPLIT_LAYER', '10'))
    device_map = {'thinker.audio_tower': 0, 'thinker.model.embed_tokens': 0,
                  'thinker.model.rotary_emb': 0, 'thinker.model.norm': 1, 'thinker.lm_head': 0}
    device_map.update({f'thinker.model.layers.{i}': 0 if i < split else 1 for i in range(layers)})
    instance = Qwen3ASRModel.from_pretrained(path, dtype=torch.float16, device_map=device_map,
        attn_implementation='sdpa', max_inference_batch_size=1, max_new_tokens=1024,
        local_files_only=True)
    actual = instance.model.hf_device_map
    if set(actual.values()) != {0, 1}:
        raise RuntimeError(f'Unexpected model placement: {actual}')
    print(json.dumps({'event': 'model_ready', 'model': MODEL_ID, 'dtype': 'float16', 'device_map': actual}), flush=True)
    return instance, actual


@asynccontextmanager
async def lifespan(app):
    global model, placement
    model, placement = await asyncio.get_running_loop().run_in_executor(executor, load_model)
    try:
        yield
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
        model = None


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get('/health')
def health():
    if model is None:
        raise HTTPException(503, 'ASR is loading')
    return {'asr_ready': True, 'model': MODEL_ID, 'precision': 'FP16', 'device_map': placement}


@app.get('/v1/models')
def models():
    return {'object': 'list', 'data': [{'id': MODEL_ID, 'object': 'model', 'owned_by': 'local'}]}


def infer(raw, language):
    import soundfile as sf
    import torch
    try:
        samples, rate = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
    except Exception:
        raise ValueError('Unsupported or invalid audio file') from None
    if not 0.35 <= len(samples) / rate <= 300:
        raise ValueError('Audio must be between 0.35 and 300 seconds')
    samples = samples.mean(axis=1)
    aliases = {'zh': 'Chinese', 'zh-Hans': 'Chinese', 'en': 'English', 'ja': 'Japanese', 'de': 'German', 'yue': 'Cantonese'}
    language = aliases.get(language, language) if language else None
    for i in range(2):
        torch.cuda.reset_peak_memory_stats(i)
    started = time.monotonic()
    try:
        from qwen_asr.inference.utils import split_audio_into_chunks
        chunks = split_audio_into_chunks(samples, rate, max_chunk_sec=30, search_expand_sec=5)
        results = []
        with torch.inference_mode():
            for chunk, _offset in chunks:
                results.append(model.transcribe(audio=(chunk, rate), language=language)[0])
                torch.cuda.empty_cache()
        return {'text': '\n'.join(r.text for r in results), 'language': ','.join(dict.fromkeys(r.language for r in results if r.language))}
    finally:
        print(json.dumps({'event': 'inference_complete', 'seconds': round(time.monotonic()-started,3),
            'peak_allocated_mib': [round(torch.cuda.max_memory_allocated(i)/2**20) for i in range(2)]}), flush=True)
        # Return inactive allocator blocks to the other resident model services.
        torch.cuda.empty_cache()


@app.post('/v1/audio/transcriptions')
async def transcribe(file: UploadFile = File(...), model_name: str = Form(MODEL_ID, alias='model'),
                     language: str | None = Form(None), response_format: str = Form('json')):
    if model_name != MODEL_ID:
        raise HTTPException(400, 'Unknown ASR model')
    if response_format not in ('json', 'verbose_json', 'text'):
        raise HTTPException(400, 'Use json, verbose_json or text')
    try:
        raw = await file.read(MAX_BYTES + 1)
    finally:
        await file.close()
    if not raw or len(raw) > MAX_BYTES:
        raise HTTPException(413, 'Audio upload must be between 1 byte and 20 MiB')
    try:
        result = await asyncio.get_running_loop().run_in_executor(executor, infer, raw, language)
    except ValueError as error:
        raise HTTPException(400, str(error)) from None
    except Exception:
        # Do not echo input or stack traces to clients.
        import traceback
        traceback.print_exc()
        raise HTTPException(503, 'ASR inference failed') from None
    if response_format == 'text':
        return PlainTextResponse(result['text'])
    return result if response_format == 'verbose_json' else {'text': result['text']}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8103, access_log=False)
