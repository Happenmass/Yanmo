import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, validateSettings, validateWindowsShortcuts, migrateWindowsShortcuts, shortcutLabel } from '../shared';
import { Controller } from '../controller';
import { LibraryStore } from '../store';
import { NativeBridge, BackendClient } from '../processes';

test('Windows API defaults are complete, require no key, and do not alter Mac defaults', () => {
  const windows = defaultSettings('windows'); validateSettings(windows);
  assert.deepEqual(Object.values(windows.online).map(x => x.baseURL), ['https://arti.local/v1', 'https://arti.local/v1']);
  assert.equal(windows.online.asr.model, 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(windows.online.text.model, 'Qwen/Qwen3.6-35B-A3B');
  assert.equal(defaultSettings().online.asr.enabled, false);
  validateWindowsShortcuts(windows);
  assert.deepEqual(Object.values(windows.shortcuts).flat().map(key => shortcutLabel(key, 'windows')), ['Control', 'Control + Shift', 'Control + 空格']);
});

test('API distribution checks service reachability without probing GPU or warming models', async () => {
  const directory=mkdtempSync(join(tmpdir(), 'yanmo-arti-'));
  const native=Object.assign(new EventEmitter(), { start: async () => {}, stop() {}, call: async () => ({ accessibility:true,eventTap:true,microphone:0,devices:[] }) });
  const backend={ status: async () => ({ service_error:'合成服务未就绪' }), stop: async () => {} };
  const controller=new Controller(new LibraryStore(directory,defaultSettings('windows')), native as unknown as NativeBridge,backend as unknown as BackendClient);
  controller.state.apiOnly=true; controller.state.platform='windows';
  controller.windowsPrecheck=async () => { throw new Error('GPU must never be probed'); };
  try {
    await controller.updateSettings({ shortcuts: defaultSettings('windows').shortcuts });
    await controller.checkModels();
    assert.equal(controller.state.notice,'合成服务未就绪');
    assert.equal(controller.state.modelsChecked,true);
    assert.equal(controller.state.runtime.capabilities.asr,'online');
    await assert.rejects(controller.updateSettings({ online: { ...controller.state.settings.online, asr:{ ...controller.state.settings.online.asr,enabled:false } } }),/API/);
    await assert.rejects(controller.updateSettings({ shortcuts:defaultSettings().shortcuts }),/Windows/);
  } finally { await controller.shutdown(); rmSync(directory,{recursive:true,force:true}); }
});

test('Windows upgrade replaces shipped defaults, retains custom bindings, and is idempotent', () => {
  const settings = defaultSettings('windows');
  settings.shortcuts = {
    dictation: [{ keyCode:49, modifiers:6144, keyLabel:'Space' }],
    voiceTranslation: [{ keyCode:49, modifiers:4608, keyLabel:'Space' }],
    selectionTranslation: [{ keyCode:17, modifiers:6144, keyLabel:'T' }],
  };
  assert.equal(migrateWindowsShortcuts(settings), true);
  assert.deepEqual(settings.shortcuts, defaultSettings('windows').shortcuts);
  assert.equal(migrateWindowsShortcuts(settings), false);
  const custom = { keyCode:0, modifiers:6144, keyLabel:'A' };
  settings.shortcuts.dictation = [custom];
  assert.equal(migrateWindowsShortcuts(settings), false);
  assert.deepEqual(settings.shortcuts.dictation, [custom]);
  validateWindowsShortcuts(settings);
});

test('Windows accepts modifier capture but refuses Mac keys and preserves conflicting custom bindings', () => {
  const settings = defaultSettings('windows');
  settings.shortcuts.dictation = [{ keyCode:0, modifiers:0, keyLabel:'Right Control', modifierKeys:[62] }];
  validateSettings(settings); validateWindowsShortcuts(settings);
  settings.shortcuts.dictation[0].modifierKeys = [55];
  assert.throws(() => validateWindowsShortcuts(settings), /Windows/);
  settings.shortcuts = { dictation:[{ keyCode:49,modifiers:6144,keyLabel:'Space' }], voiceTranslation:[{ keyCode:49,modifiers:4096,keyLabel:'Space' }], selectionTranslation:[{ keyCode:17,modifiers:6144,keyLabel:'T' }] };
  migrateWindowsShortcuts(settings);
  validateSettings(settings); validateWindowsShortcuts(settings);
  assert.equal(settings.shortcuts.voiceTranslation[0].modifiers, 4096);
  assert.equal(settings.shortcuts.selectionTranslation[0].keyCode, 17);
});
