// Opt-in real macOS paste regression. Creates only an isolated synthetic editor.
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeBridge } from '../desktop/processes.ts';
import type { Destination } from '../desktop/shared.ts';

const root = await mkdtemp(join(tmpdir(), 'yanmo-opaque-input-'));
const contents = join(root, 'YanmoInputFixture.app', 'Contents');
const binary = join(contents, 'MacOS', 'YanmoInputFixture');
const output = join(root, 'synthetic-output.txt');
const native = new NativeBridge(resolve(process.env.YANMO_QA_BRIDGE || '.build/release/YanmoBridge'));
let fixture: ChildProcess | undefined;
async function until<T>(probe: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await probe(); if (ready(value)) return value;
    await delay(50);
  }
  throw new Error('Synthetic editor readiness timed out');
}
try {
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>YanmoInputFixture</string>
    <key>CFBundleIdentifier</key><string>org.yanmo.qa.opaque</string>
    <key>CFBundleName</key><string>YanmoInputFixture</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSUIElement</key><true/></dict></plist>`);
  execFileSync('swiftc', ['desktop/e2e/fixtures/OpaqueEditor.swift', '-o', binary]);
  const status = await native.call('status');
  assert.ok(status.accessibility && status.eventTap, 'This opt-in test needs existing accessibility permission');
  fixture = spawn(binary, [output], { stdio: 'ignore' });
  const capture = () => native.call<Destination>('capture', { applicationBundleID: 'org.yanmo.qa.opaque', readContext: true });
  await until(() => access(join(root, 'fixture-ready')).then(() => true, () => false), Boolean);
  const target = await capture();
  assert.ok(target.id);
  assert.equal(target.before, ''); assert.equal(target.after, '');
  const text = 'Synthetic opaque paste 100.';
  const result = await native.call('insert', { text });
  assert.equal(result.delivery, 'attempted_unverified');
  assert.equal(await readFile(output, 'utf8'), text, 'Normal paste reaches the opaque editor exactly once');
  await writeFile(join(root, 'switch-window'), 'switch');
  await until(() => access(join(root, 'switch-window.ready')).then(() => true, () => false), Boolean);
  const switchedText = 'Paste into the focus at delivery time.';
  await native.call('insert', { text: switchedText });
  assert.equal(await readFile(output, 'utf8'), text, 'The old window remains untouched after focus moves');
  assert.equal(await readFile(join(root, 'other-output.txt'), 'utf8'), switchedText, 'Delivery uses the newly focused editor');
  console.log('PASS: opaque editor accepts one paste; switching focus redirects the next paste to the current editor');
} finally {
  native.stop(); fixture?.kill();
  if (fixture && fixture.exitCode === null) await new Promise(resolve => fixture!.once('exit', resolve));
  await rm(root, { recursive: true, force: true });
}
