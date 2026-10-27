import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendClient } from '../processes';
import { defaultSettings } from '../shared';

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function exited(pid: number) {
  for (let attempt = 0; attempt < 200 && alive(pid); attempt++) await delay(10);
  assert.equal(alive(pid), false, '空闲后应退出子进程');
}

test('Electron 后端空闲退出、录音保护、长 SSE 保护及自动重启', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yanmo-lifecycle-'));
  await mkdir(join(directory, 'backend'));
  // A real child process and HTTP stream exercise supervision without loading weights.
  await writeFile(join(directory, 'backend/server.py'), `
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os, sys, time
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer ' + os.environ['YANMO_BACKEND_TOKEN']:
            self.send_error(401); return
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({'pid': os.getpid(), 'dont_write_bytecode': sys.dont_write_bytecode}).encode())
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        for event in [{'event':'stage','stage':'polishing'}, {'event':'result','text':'合成结果'}]:
            event['task_id'] = 'fixture'
            self.wfile.write(('data: ' + json.dumps(event) + '\\n\\n').encode()); self.wfile.flush()
            if event['event'] == 'stage': time.sleep(.4)
server = HTTPServer(('127.0.0.1', 0), Handler)
print(json.dumps({'event':'ready','protocol':1,'port':server.server_port}),flush=True)
server.serve_forever()
`);
  const client = new BackendClient(process.env.YANMO_TEST_PYTHON || 'python3', directory, 150, join(directory, "diagnostics"));
  try {
    const status = await client.status(defaultSettings());
    assert.equal(status.dont_write_bytecode, true, '后端不可写入缓存修改签名资源');
    const first = status.pid;
    await exited(first);
    client.setActive(true);
    const second = (await client.status(defaultSettings())).pid;
    assert.notEqual(second, first);
    await delay(350); assert.equal(alive(second), true, '录音期间不应卸载');
    const events: string[] = [];
    const running = client.run({ task_id: 'fixture' }, undefined, event => events.push(event.event));
    client.setActive(false);
    await running;
    assert.deepEqual(events, ['stage', 'result']);
    assert.equal((await client.status(defaultSettings())).pid, second, '长流完成前保留进程，完成后可复用');
    await assert.rejects(client.run({ task_id: "other", text: "PRIVATE_INPUT" }, undefined, () => {}), /任务编号不匹配/);
    const log = await readFile(join(directory, "diagnostics", "desktop.jsonl"), "utf8");
    assert.ok(log.includes("task_transport_error"));
    assert.ok(log.includes("polishing"));
    assert.ok(!log.includes("PRIVATE_INPUT"));
    assert.ok(!log.includes("合成结果"));
    await exited(second);
  } finally { await client.stop(); await rm(directory, { recursive: true, force: true }); }
});
