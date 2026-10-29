"""Fetch official ModelScope files once into the user-global model cache, checking every SHA-256."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import subprocess
from pathlib import Path
import urllib.request

MODEL='Qwen/Qwen3-ASR-1.7B'
ROOT=Path.home()/'.cache/codex/models/Qwen3-ASR-1.7B'
ROOT.mkdir(parents=True,exist_ok=True)
url=f'https://modelscope.cn/api/v1/models/{MODEL}/repo/files?Revision=master&Recursive=true'
with urllib.request.urlopen(url,timeout=30) as response:
    manifest=json.load(response)
(ROOT/'modelscope-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
files=[f for f in manifest['Data']['Files'] if f['Path'].endswith(('.json','.txt','.safetensors'))]

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(8*1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def download(item):
    name=item['Path']
    if '/' in name or name.startswith('.'):
        raise ValueError('Unexpected model filename')
    target=ROOT/name
    if target.exists() and target.stat().st_size==item['Size'] and digest(target)==item['Sha256']:
        print(json.dumps({'event':'reused','file':name}),flush=True);return
    temporary=target.with_suffix(target.suffix+'.part')
    url=f'https://modelscope.cn/api/v1/models/{MODEL}/repo?Revision=master&FilePath={name}'
    subprocess.run(['curl','--fail','--location','--silent','--show-error','--retry','2',
        '--connect-timeout','10','--speed-limit','1024','--speed-time','60',
        '--continue-at','-','--output',str(temporary),url],check=True)
    if temporary.stat().st_size!=item['Size'] or digest(temporary)!=item['Sha256']:
        raise ValueError('Model size or SHA-256 mismatch: '+name)
    temporary.replace(target)
    print(json.dumps({'event':'downloaded','file':name,'bytes':item['Size']}),flush=True)

with ThreadPoolExecutor(max_workers=3) as executor:
    list(executor.map(download,files))
config=Path.home()/'.config/yanmo-asr'
config.mkdir(parents=True,exist_ok=True)
(config/'service.env').write_text(f'YANMO_ASR_MODEL_PATH={ROOT}\nYANMO_ASR_SPLIT_LAYER=10\n')
(config/'service.env').chmod(0o600)
print(json.dumps({'event':'model_prepared','model_path':str(ROOT),'bytes':sum(f['Size'] for f in files)}),flush=True)
