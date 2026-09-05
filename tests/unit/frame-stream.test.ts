import assert from 'node:assert/strict';
import test from 'node:test';

import { ScrcpyFrameStream } from '../../src/scrcpy/frame-stream.js';

test('missing FFmpeg fails without an uncaught spawn error', async () => {
  const stream = new ScrcpyFrameStream('/definitely/missing/ffmpeg');
  try {
    stream.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(stream.diagnostic ?? '', /ENOENT|spawn/u);
    assert.equal(await stream.waitForFrame(0, 10), null);
  } finally {
    stream.dispose();
  }
});

test('disposing a frame stream is idempotent and resolves waiters', async () => {
  const stream = new ScrcpyFrameStream(process.execPath);
  stream.start();
  const waiting = stream.waitForFrame(0, 5_000);
  stream.dispose();
  stream.dispose();
  assert.equal(await waiting, null);
  assert.equal(stream.current(), null);
});
