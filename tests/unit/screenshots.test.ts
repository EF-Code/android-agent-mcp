import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJpegDimensions, parsePngDimensions } from '../../src/adb/screenshots.js';
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

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

test('reads native PNG dimensions', () => {
  assert.deepEqual(parsePngDimensions(png(1080, 2400)), { width: 1080, height: 2400 });
});

test('rejects invalid PNG signatures and dimensions', () => {
  assert.throws(() => parsePngDimensions(Buffer.from('not-a-png')));
  assert.throws(() => parsePngDimensions(png(0, 100)));
});

test('reads native JPEG dimensions', () => {
  assert.deepEqual(parseJpegDimensions(jpeg(720, 1600)), { width: 720, height: 1600 });
  assert.throws(() => parseJpegDimensions(Buffer.from('not-a-jpeg')));
});

test('uses JPEG for visual frames when Android supports it', async () => {
  const frame = jpeg(720, 1600);
  const calls: string[][] = [];
  const adb = new AdbClient({
    adbPath: 'fake-adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 16_000,
    runner: {
      run: async (_executable, args) => {
        calls.push([...args]);
        return {
          stdout: frame,
          stderr: Buffer.alloc(0),
          record: {
            executable: 'fake-adb',
            args: [...args],
            exitCode: 0,
            signal: null,
            durationMs: 0,
            stdoutBytes: frame.length,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        };
      },
    },
  });
  const screenshot = await new AdbScreenshots(adb, 2_048).captureVisual('serial-1');
  assert.equal(screenshot.mimeType, 'image/jpeg');
  assert.equal(screenshot.width, 720);
  assert.equal(screenshot.height, 1600);
  assert.deepEqual(calls[0], ['-s', 'serial-1', 'exec-out', 'screencap', '-j']);
});

test('captures a visual frame and foreground state in one ADB round trip', async () => {
  const frame = jpeg(720, 1600);
  const foreground = 'mCurrentFocus=Window{123 u0 com.example.app/com.example.app.MainActivity}\n';
  const combined = Buffer.concat([
    frame,
    Buffer.from(`\n__ANDROID_AGENT_MCP_FOREGROUND__\n${foreground}`),
  ]);
  const calls: string[][] = [];
  const adb = new AdbClient({
    adbPath: 'fake-adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 16_000,
    runner: {
      run: async (_executable, args) => {
        calls.push([...args]);
        return {
          stdout: combined,
          stderr: Buffer.alloc(0),
          record: {
            executable: 'fake-adb',
            args: [...args],
            exitCode: 0,
            signal: null,
            durationMs: 0,
            stdoutBytes: combined.length,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        };
      },
    },
  });
  const observation = await new AdbScreenshots(adb, 2_048).captureVisualObservation('serial-1');
  assert.equal(observation.screenshot.mimeType, 'image/jpeg');
  assert.equal(observation.screenshot.width, 720);
  assert.equal(observation.foregroundOutput, foreground);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.slice(0, 5), ['-s', 'serial-1', 'exec-out', 'sh', '-c']);
  assert.match(calls[0]?.[5] ?? '', /screencap -j/u);
  assert.match(calls[0]?.[5] ?? '', /mCurrentFocus=/u);
});

test('executes guarded input and captures its result in one ADB round trip', async () => {
  const frame = jpeg(720, 1600);
  const foreground = 'mCurrentFocus=Window{123 u0 com.example.app/.MainActivity}\n';
  const combined = Buffer.concat([
    frame,
    Buffer.from(`\n__ANDROID_AGENT_MCP_FOREGROUND__\n${foreground}`),
  ]);
  const calls: string[][] = [];
  const adb = new AdbClient({
    adbPath: 'fake-adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 16_000,
    runner: {
      run: async (_executable, args) => {
        calls.push([...args]);
        return {
          stdout: combined,
          stderr: Buffer.alloc(0),
          record: {
            executable: 'fake-adb',
            args: [...args],
            exitCode: 0,
            signal: null,
            durationMs: 0,
            stdoutBytes: combined.length,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        };
      },
    },
  });

  const observation = await new AdbScreenshots(adb, 2_048).captureVisualAction(
    'serial-1',
    [{ type: 'tap', x: 100, y: 200 }],
    'com.example.app',
    0,
    75,
  );

  assert.equal(observation.screenshot.mimeType, 'image/jpeg');
  assert.equal(observation.foregroundOutput, foreground);
  assert.equal(calls.length, 1);
  const script = calls[0]?.[5] ?? '';
  assert.deepEqual(calls[0]?.slice(0, 5), ['-s', 'serial-1', 'exec-out', 'sh', '-c']);
  assert.match(script, /current_package/u);
  assert.match(script, /input tap 100 200/u);
  assert.match(script, /sleep 0\.075/u);
  assert.match(script, /screencap -j/u);
  assert.match(script, /__ANDROID_AGENT_MCP_FOREGROUND__/u);
});

test('caches PNG fallback when Android does not support JPEG screencap', async () => {
  const frame = png(720, 1600);
  const calls: string[][] = [];
  const adb = new AdbClient({
    adbPath: 'fake-adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 16_000,
    runner: {
      run: async (_executable, args) => {
        calls.push([...args]);
        return {
          stdout: frame,
          stderr: Buffer.alloc(0),
          record: {
            executable: 'fake-adb',
            args: [...args],
            exitCode: 0,
            signal: null,
            durationMs: 0,
            stdoutBytes: frame.length,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        };
      },
    },
  });
  const screenshots = new AdbScreenshots(adb, 2_048);
  assert.equal((await screenshots.captureVisual('serial-1')).mimeType, 'image/png');
  assert.equal((await screenshots.captureVisual('serial-1')).mimeType, 'image/png');
  assert.deepEqual(
    calls.map((args) => args.at(-1)),
    ['-j', '-p', '-p'],
  );
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
