import assert from 'node:assert/strict';
import test from 'node:test';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { JpegFrameAssembler, ScrcpyFrameStream } from '../../src/scrcpy/frame-stream.js';

test('assembles JPEG markers split at every possible chunk boundary', () => {
  const frame = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const input = Buffer.concat([Buffer.from([0, 0xff, 0]), frame, frame, Buffer.from([0xff])]);
  for (let split = 0; split <= input.length; split += 1) {
    const assembler = new JpegFrameAssembler();
    assert.deepEqual(
      [...assembler.push(input.subarray(0, split)), ...assembler.push(input.subarray(split))],
      [frame, frame],
    );
  }
});

test('assembles thousands of tiny chunks without retaining mutable frame storage', () => {
  const assembler = new JpegFrameAssembler();
  const frame = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(10_000, 0x31),
    Buffer.from([0xff, 0xd9]),
  ]);
  const extracted = [...frame].flatMap((byte) => assembler.push(Buffer.from([byte])));
  assert.deepEqual(extracted, [frame]);
  assembler.push(Buffer.from([0xff, 0xd8, 9, 8, 0xff, 0xd9]));
  assert.deepEqual(extracted, [frame]);
});

test('bounds each incomplete frame while accepting noise and multiple bounded frames', () => {
  const assembler = new JpegFrameAssembler(6);
  const frame = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  assert.deepEqual(assembler.push(Buffer.concat([Buffer.alloc(100), frame, frame])), [
    frame,
    frame,
  ]);
  assembler.push(Buffer.from([0xff, 0xd8, 1, 2, 3, 4]));
  assert.throws(() => assembler.push(Buffer.from([5])), /limit/u);
  assert.deepEqual(assembler.push(frame), [frame]);
  assembler.push(frame.subarray(0, 3));
  assembler.reset();
  assert.deepEqual(assembler.push(frame), [frame]);
});

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

test('decoder exit invalidates cached frames, releases waiters, and ignores late output', async () => {
  const decoder = new ChildProcess();
  decoder.stdout = new PassThrough();
  const stream = new ScrcpyFrameStream('fake-decoder', () => decoder);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 10, 0, 20, 0xff, 0xd9]);
  try {
    stream.start();
    decoder.stdout.emit('data', jpeg);
    const first = stream.current();
    assert.equal(first?.width, 20);
    assert.equal(first?.height, 10);
    const waiting = stream.waitForFrame(first!.sequence, 5000);
    decoder.emit('close', 0, null);
    assert.equal(await waiting, null);
    assert.equal(stream.current(), null);
    assert.equal(await stream.waitForFrame(0), null);
    decoder.stdout.emit('data', jpeg);
    assert.equal(stream.current(), null);
    assert.match(stream.diagnostic ?? '', /exited/u);
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
