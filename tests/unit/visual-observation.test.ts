import assert from 'node:assert/strict';
import test from 'node:test';

import {
  waitForVisualObservation,
  type VisualObservationFrame,
} from '../../src/service/visual-observation.js';

function frame(hash: string, transport: 'adb' | 'scrcpy' = 'adb'): VisualObservationFrame {
  return {
    screenshot: {
      data: Buffer.from(hash),
      mimeType: 'image/jpeg',
      width: 720,
      height: 1600,
      sha256: hash,
    },
    foreground: { packageName: 'com.example.app', activity: '.Main', pid: 1 },
    frameTransport: transport,
  };
}

async function run(options: {
  baseline?: VisualObservationFrame;
  initial?: VisualObservationFrame;
  frames?: VisualObservationFrame[];
  waitForChangeMs?: number;
  stableMs?: number;
  pollMs?: number;
}) {
  let clock = 0;
  let captures = 0;
  const sleeps: number[] = [];
  const result = await waitForVisualObservation({
    baseline: options.baseline ?? frame('before'),
    initial: options.initial ?? frame('before'),
    waitForChangeMs: options.waitForChangeMs ?? 250,
    stableMs: options.stableMs ?? 0,
    pollMs: options.pollMs ?? 50,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    capture: async () => {
      captures += 1;
      return options.frames?.[captures - 1] ?? options.frames?.at(-1) ?? frame('before');
    },
  });
  return { result, captures, sleeps };
}

test('returns immediate observations without redundant capture', async () => {
  const { result, captures } = await run({ initial: frame('after'), waitForChangeMs: 0 });
  assert.equal(result.changed, true);
  assert.equal(result.stable, null);
  assert.equal(result.timedOut, false);
  assert.equal(captures, 0);
});

test('caps polling sleeps at the remaining budget and starts no capture after expiry', async () => {
  const { result, sleeps, captures } = await run({ pollMs: 200 });
  assert.deepEqual(sleeps, [200, 50]);
  assert.equal(captures, 1);
  assert.equal(result.changed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.elapsedMs, 250);
});

test('requires observed quiet frames after a change before reporting stability', async () => {
  const { result, captures, sleeps } = await run({ frames: [frame('after')], stableMs: 80 });
  assert.equal(result.changed, true);
  assert.equal(result.stable, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.elapsedMs, 130);
  assert.equal(captures, 3);
  assert.deepEqual(sleeps, [50, 50, 30]);
});

test('never reports an animating or unobserved quiet window as stable', async () => {
  const animated = await run({
    initial: frame('after'),
    frames: [frame('a'), frame('b'), frame('c'), frame('d')],
    stableMs: 80,
  });
  assert.equal(animated.result.changed, true);
  assert.equal(animated.result.stable, false);
  assert.equal(animated.result.timedOut, true);
  const deadline = await run({ initial: frame('after'), frames: [frame('after')], stableMs: 250 });
  assert.equal(deadline.result.stable, false);
  assert.equal(deadline.result.timedOut, true);
});

test('reports incomparable pipelines without spending the polling budget', async () => {
  for (const initial of [
    frame('after', 'scrcpy'),
    { ...frame('after'), screenshot: { ...frame('after').screenshot, width: 1080 } },
    {
      ...frame('after'),
      screenshot: { ...frame('after').screenshot, mimeType: 'image/png' as const },
    },
  ]) {
    const { result, captures } = await run({ initial, stableMs: 100 });
    assert.equal(result.changed, null);
    assert.equal(result.changeReason, 'capture_pipeline_changed');
    assert.equal(result.stable, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.elapsedMs, 0);
    assert.equal(captures, 0);
  }
});

test('reports the actual final transport when polling switches to ADB', async () => {
  const { result } = await run({
    baseline: frame('before', 'scrcpy'),
    initial: frame('before', 'scrcpy'),
    frames: [frame('after', 'adb')],
  });
  assert.equal(result.frameTransport, 'adb');
  assert.equal(result.changed, null);
  assert.equal(result.changeReason, 'capture_pipeline_changed');
});

test('clears an incomplete stability assessment when polling changes pipelines', async () => {
  const { result } = await run({
    baseline: frame('before', 'scrcpy'),
    initial: frame('after', 'scrcpy'),
    frames: [frame('after', 'adb')],
    stableMs: 100,
  });
  assert.equal(result.changed, null);
  assert.equal(result.stable, null);
  assert.equal(result.timedOut, false);
});
