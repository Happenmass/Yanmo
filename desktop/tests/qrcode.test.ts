import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQrMatrix } from '../renderer/qrcode';

function assertFinderPattern(matrix: boolean[][], top: number, left: number) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const expected = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      assert.equal(matrix[top + r][left + c], expected, `Finder mismatch at (${top + r},${left + c})`);
    }
  }
}

test('纯 TypeScript QR 编码器正确生成 V1 与长配对链接高版本矩阵', () => {
  const short = encodeQrMatrix('hello');
  assert.equal(short.length, 21);
  assert.equal(short[0].length, 21);
  assertFinderPattern(short, 0, 0);
  assertFinderPattern(short, 0, short.length - 7);
  assertFinderPattern(short, short.length - 7, 0);

  // Typical ~320-char yanmo-pair://v1 URI
  const sampleUri = `yanmo-pair://v1?data=${'A'.repeat(300)}`;
  const pairQr = encodeQrMatrix(sampleUri);
  assert.ok(pairQr.length >= 57, `Expected Version >= 10 size >= 57, got ${pairQr.length}`);
  assert.equal((pairQr.length - 17) % 4, 0);
  assert.equal(pairQr[0].length, pairQr.length);
  assertFinderPattern(pairQr, 0, 0);
  assertFinderPattern(pairQr, 0, pairQr.length - 7);
  assertFinderPattern(pairQr, pairQr.length - 7, 0);

  // Timing patterns alternate on row 6 and col 6
  for (let i = 8; i < pairQr.length - 8; i++) {
    assert.equal(pairQr[6][i], i % 2 === 0);
    assert.equal(pairQr[i][6], i % 2 === 0);
  }
});
