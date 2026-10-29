"""Run synthetic bilingual ASR, full 256K LLM and OCR concurrently; record resource maxima."""
from concurrent.futures import ThreadPoolExecutor
import base64
import io
import json
from pathlib import Path
import ssl
import subprocess
import threading
import time
import urllib.request
import wave

ROOT=Path.home()/'yanmo-asr'
OUTPUT=ROOT/'acceptance-20261029'
OUTPUT.mkdir(exist_ok=True)
CTX=ssl.create_default_context(cafile=str(Path.home()/'.config/atlas-inference/ca.crt'))
URL='https://arti.local/v1'
stop=threading.Event()
samples=[]

def get(path):
    with urllib.request.urlopen(path,context=CTX,timeout=10) as r:return json.load(r)

def post(path,body,media='application/json',timeout=900):
    req=urllib.request.Request(URL+path,data=body,headers={'Content-Type':media})
    with urllib.request.urlopen(req,context=CTX,timeout=timeout) as r:return json.load(r)

def asr(audio):
    boundary='yanmo-acceptance-boundary'
    raw=(f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nQwen/Qwen3-ASR-1.7B\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()+audio+f'\r\n--{boundary}--\r\n'.encode())
    start=time.monotonic();value=post('/audio/transcriptions',raw,'multipart/form-data; boundary='+boundary)
    return {'seconds':round(time.monotonic()-start,3),**value}

def ocr():
    image=Path.home()/'atlas-inference/synthetic-receipt.png'
    url='data:image/png;base64,'+base64.b64encode(image.read_bytes()).decode()
    body={'model':'PaddlePaddle/PaddleOCR-VL-1.5','messages':[{'role':'user','content':[{'type':'text','text':'OCR:'},{'type':'image_url','image_url':{'url':url}}]}],'max_tokens':4096}
    start=time.monotonic();result=post('/chat/completions',json.dumps(body).encode())
    text=result['choices'][0]['message']['content']
    passed=all(x in text for x in ['120','180','300','2026'])
    assert passed,text
    return {'seconds':round(time.monotonic()-start,3),'passed':passed}

def monitor():
    while not stop.is_set():
        raw=subprocess.check_output(['nvidia-smi','--query-gpu=index,memory.used,memory.free,temperature.gpu,utilization.gpu','--format=csv,noheader,nounits'],text=True)
        row={'seconds':round(time.monotonic(),2),'gpu':[[int(v.strip()) for v in line.split(',')] for line in raw.strip().splitlines()]}
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemAvailable:'):row['mem_available_mib']=int(line.split()[1])//1024
        samples.append(row);stop.wait(1)

thread=threading.Thread(target=monitor,daemon=True);thread.start()
report={}
try:
    report['asr_health']=get('http://127.0.0.1:8103/health')
    report['models']=get(URL+'/models')
    zh=(ROOT/'zh.wav').read_bytes();en=(ROOT/'en.wav').read_bytes()
    report['chinese']=asr(zh);assert '周五' in report['chinese']['text'] and ('3500' in report['chinese']['text'] or '三千五百' in report['chinese']['text'])
    report['english']=asr(en);assert 'Friday' in report['english']['text'] and 'three' in report['english']['text'].lower()
    # A 299-second file exercises the whole client's advertised five-minute bound.
    with wave.open(io.BytesIO(zh),'rb') as audio:
        params=audio.getparams();frames=audio.readframes(audio.getnframes())
    rate=params.framerate;target=299*rate*params.sampwidth*params.nchannels
    repeated=(frames*((target//len(frames))+1))[:target]
    output=io.BytesIO()
    with wave.open(output,'wb') as audio:
        audio.setparams(params);audio.writeframes(repeated)
    long_audio=output.getvalue()
    full=subprocess.Popen([str(ROOT/'venv/bin/python'),'-u',str(Path.home()/'atlas-inference/probe-256k.py'),'--output',str(OUTPUT/'full-window.json')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    first=full.stdout.readline();print(first,end='',flush=True);assert json.loads(first)['event']=='START'
    with ThreadPoolExecutor(max_workers=3) as pool:
        future=pool.submit(asr,long_audio)
        ocr_future=pool.submit(ocr)
        report['concurrent_long_asr']=future.result(timeout=900)
        report['concurrent_ocr']=[ocr_future.result(timeout=900)]
        report['concurrent_ocr'].append(pool.submit(ocr).result(timeout=900))
        report['full_window_running_during_asr']=full.poll() is None
    log,_=full.communicate(timeout=1500);(OUTPUT/'full-window.log').write_text(first+log)
    assert full.returncode==0,log
    report['full_window']=json.loads((OUTPUT/'full-window.json').read_text())
    report['passed']=True
finally:
    if 'full' in locals() and full.poll() is None:
        full.terminate();full.wait(timeout=10)
    stop.set();thread.join()
    report['samples']=len(samples)
    report['gpu_peak_mib']=[max(s['gpu'][i][1] for s in samples) for i in range(2)] if samples else []
    report['gpu_min_free_mib']=[min(s['gpu'][i][2] for s in samples) for i in range(2)] if samples else []
    report['gpu_max_temperature']=[max(s['gpu'][i][3] for s in samples) for i in range(2)] if samples else []
    report['min_mem_available_mib']=min((s['mem_available_mib'] for s in samples),default=None)
    (OUTPUT/'resources.json').write_text(json.dumps(samples,indent=2))
    (OUTPUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False),flush=True)
