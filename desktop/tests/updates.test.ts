import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUpdate } from '../updates';

function release(version: string): typeof fetch {
  return async () => Response.json({
    tag_name: 'v' + version,
    assets: [{
      name: 'Yanmo-' + version + '-mac-arm64.zip',
      state: 'uploaded',
      browser_download_url: 'https://github.com/Happenmass/Yanmo/releases/download/v' + version + '/Yanmo-' + version + '-mac-arm64.zip',
      digest: 'sha256:' + 'a'.repeat(64),
      size: 123,
    }],
  });
}

test('本地测试版本按公开基础版本比较更新', async () => {
  assert.equal(await findUpdate('0.4.13+local.1', release('0.4.13')), undefined);
  assert.equal(await findUpdate('0.4.13+local.1', release('0.4.12')), undefined);
  assert.equal((await findUpdate('0.4.13+local.1', release('0.4.14')))?.version, '0.4.14');
});
