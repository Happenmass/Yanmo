// Read-only OS capability smoke test: never reads text or inserts into the app.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { NativeBridge } from '../desktop/processes.ts';
import type { Destination } from '../desktop/shared.ts';

const bundleID = process.argv[2];
assert.ok(bundleID, 'Pass the bundle ID of an already-running test application');
const native = new NativeBridge(resolve(process.env.YANMO_QA_BRIDGE || '.build/release/YanmoBridge'));
try {
  const target = await native.call<Destination>('capture', { applicationBundleID: bundleID, readContext: false });
  assert.ok(target.id, 'An opaque application can still provide an optional context snapshot');
  assert.equal(target.before, ''); assert.equal(target.after, '');
  await native.call('release', { destinationId: target.id });
  console.log('PASS: capture completed without requiring a readable field; context disabled');
} finally { native.stop(); }
