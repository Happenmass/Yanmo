import subprocess,json,time,pathlib,queue,threading,tempfile,shutil,argparse
parser=argparse.ArgumentParser()
parser.add_argument("--bridge")
parser.add_argument("--replacement-only",action="store_true")
options=parser.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
output=root/'.local/correction-learning'; output.mkdir(parents=True,exist_ok=True)
subprocess.run(['swiftc',str(root/'desktop/e2e/fixtures/CorrectionEditor.swift'),'-o',str(output/'editor')],check=True)
folder=pathlib.Path(tempfile.mkdtemp(prefix='yanmo-correction-'))
editor=subprocess.Popen([str(root/'.local/correction-learning/editor'),str(folder)])
bridge=subprocess.Popen([options.bridge or str(root/'.build/release/YanmoBridge')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=None,text=True)
q=queue.Queue();threading.Thread(target=lambda:[q.put(json.loads(x)) for x in bridge.stdout],daemon=True).start()
results=[]
result_path=output/('package-native-results.json' if options.bridge else 'native-results.json')
def command(action,text='',target=folder):
 id=str(time.monotonic()); p=target/'command.json'; tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(dict(action=action,text=text,id=id)));tmp.replace(p)
 limit=time.monotonic()+3
 while time.monotonic()<limit:
  if (target/'ack').exists() and (target/'ack').read_text()==id:return
  time.sleep(.05)
 raise RuntimeError('fixture command timeout')
def call(command,args={}):
 id=str(time.monotonic()); bridge.stdin.write(json.dumps(dict(id=id,command=command,args=args))+'\n');bridge.stdin.flush()
 until=time.monotonic()+4
 while time.monotonic()<until:
  v=q.get(timeout=4)
  if v.get('id')==id:
   assert v['ok'],v
   return v['result']
def run(name,change,expected,focus=False,stop=False,late=False,send=True,target=folder):
 command('reset');time.sleep(.5)
 assert call('capture',{'readContext':False}).get('name')=='editor', 'Test editor lost focus; refusing synthetic paste'
 initial='明天联系沈言确认方案。'; started=time.monotonic()
 transcript='明天联系沈言确认方案'
 call('insert',dict(text=initial,observationId=name,transcript=transcript))
 assert (folder/'value.txt').read_text()==initial, 'paste failed; no input contents logged'
 if late: time.sleep(10)
 if name=='undo-edit':
  command('type','明天联系沈砚确认方案。');time.sleep(.6)
 command('type',change);time.sleep(.5)
 assert (folder/'value.txt').read_text()==change, ('typing failed',repr((folder/'value.txt').read_text()))
 if focus:command('focusOther',change)
 other=None
 if stop:call('correction.stop')
 try:
  if target!=folder:
   other=subprocess.Popen([str(output/'editor'),str(target)])
   command('reset',change,target)
  if send:
   command('enter',target=target)
   time.sleep(.25)
   assert (target/'sent.txt').read_text()==change, 'Enter did not reach the editor'
 finally:
  if other:other.terminate();other.wait(timeout=5)
 found=[]
 until=time.monotonic()+1 if send else started+10.5
 while time.monotonic()<until:
  try:
   v=q.get(timeout=.2)
   if v.get('event')=='correction':found.append((time.monotonic()-started,v))
  except queue.Empty:pass
 assert bool(found)==expected,(name,found)
 if found:
  assert found[0][0]<10,(name,found)
  assert found[0][1]['original']==initial
  assert found[0][1]['text']==change
  assert found[0][1]['transcript']==transcript
 results.append(dict(case=name,passed=True,eventSeconds=round(found[0][0],2) if found else None))
 result_path.write_text(json.dumps(results,ensure_ascii=False,indent=2))
 print(results[-1],flush=True)
try:
 time.sleep(1)
 status=call('status')
 assert status['accessibility'] and status['eventTap'], 'The test bridge needs macOS Accessibility and an active event tap'
 run('replacement','明天联系沈砚确认方案。',True)
 if not options.replacement_only:
  run('focus-switch','草稿：明天联系沈砚确认方案。',True,focus=True)
  with tempfile.TemporaryDirectory(prefix='yanmo-correction-other-') as other_folder:
   run('app-switch','草稿：明天联系沈砚确认方案。',True,target=pathlib.Path(other_folder))
  run('cancel-observation','明天联系沈砚确认方案。',False,stop=True)
  run('undo-edit','明天联系沈言确认方案。',False)
  run('no-enter','明天联系沈砚确认方案。',False,send=False)
  run('expired','明天联系沈砚确认方案。',False,late=True)
 result_path.write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 bridge.stdin.close();bridge.wait(timeout=5);editor.terminate();editor.wait(timeout=5);shutil.rmtree(folder)
