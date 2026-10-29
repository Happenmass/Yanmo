import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, validateSettings } from '../shared';
import { Controller } from '../controller';
import { LibraryStore } from '../store';
import { NativeBridge, BackendClient } from '../processes';

test('Windows API defaults are complete, require no key, and do not alter Mac defaults', () => {
  const windows = defaultSettings('windows'); validateSettings(windows);
  assert.deepEqual(Object.values(windows.online).map(x => x.baseURL), ['https://arti.local/v1', 'https://arti.local/v1']);
  assert.equal(windows.online.asr.model, 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(windows.online.text.model, 'Qwen/Qwen3.6-35B-A3B');
  assert.equal(defaultSettings().online.asr.enabled, false);
  assert.ok(Object.values(windows.shortcuts).flat().every(x => x.keyCode !== 63 && (x.modifiers & 4096)));
});

test('API distribution checks service reachability without probing GPU or warming models', async () => {
  const directory=mkdtempSync(join(tmpdir(), 'yanmo-arti-'));
  const native=Object.assign(new EventEmitter(), { start: async () => {}, stop() {}, call: async () => ({ accessibility:true,eventTap:true,microphone:0,devices:[] }) });
  const backend={ status: async () => ({ service_error:'合成服务未就绪' }), stop: async () => {} };
  const controller=new Controller(new LibraryStore(directory,defaultSettings('windows')), native as unknown as NativeBridge,backend as unknown as BackendClient);
  controller.state.apiOnly=true; controller.state.platform='windows';
  controller.windowsPrecheck=async () => { throw new Error('GPU must never be probed'); };
  try {
    await controller.checkModels();
    assert.equal(controller.state.notice,'合成服务未就绪');
    assert.equal(controller.state.modelsChecked,true);
    assert.equal(controller.state.runtime.capabilities.asr,'online');
    await assert.rejects(controller.updateSettings({ online: { ...controller.state.settings.online, asr:{ ...controller.state.settings.online.asr,enabled:false } } }),/API/);
    await assert.rejects(controller.updateSettings({ shortcuts:defaultSettings().shortcuts }),/Windows/);
  } finally { await controller.shutdown(); rmSync(directory,{recursive:true,force:true}); }
});
