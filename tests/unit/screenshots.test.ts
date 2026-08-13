import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePngDimensions } from '../../src/adb/screenshots.js';

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('reads native PNG dimensions', () => {
  assert.deepEqual(parsePngDimensions(png(1080, 2400)), { width: 1080, height: 2400 });
});

test('rejects invalid PNG signatures and dimensions', () => {
  assert.throws(() => parsePngDimensions(Buffer.from('not-a-png')));
  assert.throws(() => parsePngDimensions(png(0, 100)));
});
