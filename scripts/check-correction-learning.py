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
def command(action,text=''):
 id=str(time.monotonic()); p=folder/'command.json'; tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(dict(action=action,text=text,id=id)));tmp.replace(p)
 limit=time.monotonic()+3
 while time.monotonic()<limit:
  if (folder/'ack').exists() and (folder/'ack').read_text()==id:return
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
def run(name,change,expected,focus=False,stop=False,late=False):
 command('reset');time.sleep(.5)
 assert call('capture',{'readContext':False}).get('name')=='editor', 'Test editor lost focus; refusing synthetic paste'
 initial='明天联系沈言确认方案。'; started=time.monotonic()
 call('insert',dict(text=initial,observationId=name))
 assert (folder/'value.txt').read_text()==initial, 'paste failed; no input contents logged'
 if late: time.sleep(10)
 if name=='undo-edit':
  command('type','明天联系沈砚确认方案。');time.sleep(.6)
 command('type',change);time.sleep(.5)
 assert (folder/'value.txt').read_text()==change, ('typing failed',repr((folder/'value.txt').read_text()))
 if focus:command('focusOther')
 if stop:call('correction.stop')
 found=[]
 until=started+11.3 if not late else time.monotonic()+1
 while time.monotonic()<until:
  try:
   v=q.get(timeout=.2)
   if v.get('event')=='correction':found.append((time.monotonic()-started,v))
  except queue.Empty:pass
 assert bool(found)==expected,(name,found)
 if found:
  assert found[0][0]>=9.8,(name,found)
  assert found[0][1]['text']==change
 results.append(dict(case=name,passed=True,eventSeconds=round(found[0][0],2) if found else None))
 result_path.write_text(json.dumps(results,ensure_ascii=False,indent=2))
 print(results[-1],flush=True)
try:
 time.sleep(1)
 run('replacement','明天联系沈砚确认方案。',True)
 if not options.replacement_only:
  run('focus-switch','明天联系沈砚确认方案。',False,focus=True)
  run('cancel-observation','明天联系沈砚确认方案。',False,stop=True)
  run('undo-edit','明天联系沈言确认方案。',False)
  run('expired','明天联系沈砚确认方案。',False,late=True)
 result_path.write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 bridge.stdin.close();bridge.wait(timeout=5);editor.terminate();editor.wait(timeout=5);shutil.rmtree(folder)
