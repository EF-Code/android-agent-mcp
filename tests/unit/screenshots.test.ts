import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePngDimensions } from '../../src/adb/screenshots.js';
import { AdbScreenshots } from '../../src/adb/screenshots.js';
import { AdbClient } from '../../src/adb/client.js';
import { ErrorCode } from '../../src/errors/codes.js';
import { AppError } from '../../src/errors/app-error.js';

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

test('normalizes bounded screenshot output overflow', async () => {
  const adb = new AdbClient({
    adbPath: 'fake-adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 16_000,
    runner: {
      run: async () => {
        throw new AppError(ErrorCode.CommandOutputLimit, 'bounded output exceeded', {
          details: { command: { stdoutBytes: 2_049, stdoutTruncated: true } },
        });
      },
    },
  });
  const screenshots = new AdbScreenshots(adb, 2_048);
  await assert.rejects(
    () => screenshots.capture('serial-1'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === ErrorCode.ScreenshotTooLarge &&
      error.details.observedBytes === 2_049,
  );
});
