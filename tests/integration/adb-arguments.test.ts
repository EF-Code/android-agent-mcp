import assert from 'node:assert/strict';
import test from 'node:test';

import { AdbClient, type CommandRunner } from '../../src/adb/client.js';
import { AdbInput, buildInputSequenceScript } from '../../src/adb/input.js';
import { AdbLogcat } from '../../src/adb/logcat.js';
import { AdbPackages } from '../../src/adb/packages.js';
import { AdbProperties } from '../../src/adb/properties.js';
import { AdbScreenshots } from '../../src/adb/screenshots.js';
import { AdbUiAutomator } from '../../src/adb/ui-automator.js';
import { AppError } from '../../src/errors/app-error.js';
import { ErrorCode } from '../../src/errors/codes.js';
import { AdbForeground, parseForegroundActivity } from '../../src/adb/foreground.js';
import type { CommandOutput } from '../../src/types.js';

function output(stdout: string | Buffer = ''): CommandOutput {
  const bytes = typeof stdout === 'string' ? Buffer.from(stdout) : stdout;
  return {
    stdout: bytes,
    stderr: Buffer.alloc(0),
    record: {
      executable: 'fake-adb',
      args: [],
      exitCode: 0,
      signal: null,
      durationMs: 0,
      stdoutBytes: bytes.length,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  };
}

function png(): Buffer {
  const image = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image, 0);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(1080, 16);
  image.writeUInt32BE(2400, 20);
  return image;
}

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{
    executable: string;
    args: readonly string[];
    options: { captureDurationMs?: number };
  }> = [];

  async run(
    executable: string,
    args: readonly string[],
    options: { captureDurationMs?: number },
  ): Promise<CommandOutput> {
    this.calls.push({ executable, args: [...args], options });
    if (args.includes('screencap')) return output(png());
    if (args.includes('wm') && args.includes('size')) return output('Physical size: 1080x2400\n');
    if (args.includes('uiautomator'))
      return output('UI hier dumped to: /sdcard/android_agent_mcp_ui.xml');
    if (args.includes('exec-out') && args.includes('cat'))
      return output('<hierarchy><node bounds="[0,0][10,10]" enabled="true"/></hierarchy>');
    if (args.includes('logcat') && args.includes('epoch'))
      return output('1770000000.000 1 1 I tag: baseline');
    if (args.includes('logcat')) return output('01-01 00:00:01.000 1 1 I tag: line');
    if (args.includes('pidof')) return output('1234');
    if (args.includes('pm') && args.includes('list')) return output('package:com.example.app\n');
    if (args.includes('rm')) return output('');
    return output('');
  }
}

test('passes validated serials and exact input argument arrays', async () => {
  const runner = new RecordingRunner();
  const adb = new AdbClient({
    adbPath: '/opt/android/platform-tools/adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  await new AdbInput(adb).tap('serial-1', 10, 20);
  assert.deepEqual(runner.calls[0]?.args, ['-s', 'serial-1', 'shell', 'input', 'tap', '10', '20']);
  assert.equal(runner.calls[0]?.executable, '/opt/android/platform-tools/adb');
});

test('batches safe input actions into one generated remote script', async () => {
  const runner = new RecordingRunner();
  const adb = new AdbClient({
    adbPath: 'adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  await new AdbInput(adb).sequence(
    'serial-1',
    [
      { type: 'tap', x: 10, y: 20 },
      { type: 'swipe', startX: 10, startY: 20, endX: 30, endY: 40, durationMs: 100 },
      { type: 'key', key: 'back' },
    ],
    50,
  );
  assert.deepEqual(runner.calls[0]?.args, [
    '-s',
    'serial-1',
    'shell',
    'sh',
    '-c',
    "'input tap 10 20; sleep 0.050; input swipe 10 20 30 40 100; sleep 0.050; input keyevent 4'",
  ]);
  assert.equal(buildInputSequenceScript([{ type: 'tap', x: 1, y: 2 }]), 'input tap 1 2');
  assert.throws(() => buildInputSequenceScript([{ type: 'key', key: 'toString' } as never]));
});

test('uses direct ADB input arguments for a one-action sequence', async () => {
  const runner = new RecordingRunner();
  const adb = new AdbClient({
    adbPath: 'adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  await new AdbInput(adb).sequence('serial-1', [{ type: 'tap', x: 10, y: 20 }]);
  assert.deepEqual(runner.calls[0]?.args, ['-s', 'serial-1', 'shell', 'input', 'tap', '10', '20']);
});

test('rejects Android input usage output instead of reporting false success', async () => {
  const runner: CommandRunner = {
    async run() {
      return output('Usage: input [<source>] <command> [<arg>...]\n');
    },
  };
  const adb = new AdbClient({
    adbPath: 'adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  await assert.rejects(
    new AdbInput(adb).sequence('serial-1', [
      { type: 'tap', x: 10, y: 20 },
      { type: 'tap', x: 30, y: 40 },
    ]),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CommandFailed,
  );
});

test('uses direct ADB argument arrays for screenshots and UIAutomator', async () => {
  const runner = new RecordingRunner();
  const adb = new AdbClient({
    adbPath: 'adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  await new AdbScreenshots(adb, 100_000).capture('serial-2');
  await new AdbUiAutomator(adb).dump('serial-2');
  assert.deepEqual(runner.calls[0]?.args, ['-s', 'serial-2', 'exec-out', 'screencap', '-p']);
  assert.deepEqual(
    runner.calls.slice(1).map((call) => call.args),
    [
      [
        '-s',
        'serial-2',
        'shell',
        'uiautomator',
        'dump',
        '--compressed',
        '/sdcard/android_agent_mcp_ui.xml',
      ],
      ['-s', 'serial-2', 'exec-out', 'cat', '/sdcard/android_agent_mcp_ui.xml'],
      ['-s', 'serial-2', 'shell', 'rm', '-f', '/sdcard/android_agent_mcp_ui.xml'],
    ],
  );
});

test('reads only native resolution when an input action needs coordinate bounds', async () => {
  const runner = new RecordingRunner();
  const adb = new AdbClient({
    adbPath: 'adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  assert.deepEqual(await new AdbProperties(adb).resolution('serial-2'), {
    width: 1080,
    height: 2400,
  });
  assert.deepEqual(runner.calls[0]?.args, ['-s', 'serial-2', 'shell', 'wm', 'size']);
});

test('uses bounded live logcat arguments and does not interpolate shell text', async () => {
  const runner = new RecordingRunner();
  const adb = new AdbClient({
    adbPath: 'adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  const logcat = new AdbLogcat(adb, 100_000);
  await logcat.capture('serial-3', {
    packageName: 'com.example.app',
    durationMs: 250,
    tags: ['ActivityManager'],
  });
  const pidCall = runner.calls.find((call) => call.args.includes('pidof'));
  const logCall = runner.calls.find(
    (call) => call.args.includes('logcat') && !call.args.includes('epoch'),
  );
  assert.deepEqual(pidCall?.args, ['-s', 'serial-3', 'shell', 'pidof', 'com.example.app']);
  assert.deepEqual(logCall?.args, [
    '-s',
    'serial-3',
    'logcat',
    '-v',
    'threadtime',
    '--pid=1234',
    '*:I',
    'ActivityManager:I',
  ]);
  assert.equal(logCall?.options.captureDurationMs, 250);
  assert.equal(
    logCall?.args.some((arg) => arg.includes('$(')),
    false,
  );
});

test('uses all-package metadata commands instead of fabricating classifications', async () => {
  const runner = new RecordingRunner();
  const adb = new AdbClient({
    adbPath: 'adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  await new AdbPackages(adb).list('serial-4', { limit: 10 });
  const packageCalls = runner.calls.filter((call) => call.args.includes('pm'));
  assert.deepEqual(packageCalls.map((call) => call.args.slice(-1)[0]).sort(), [
    '-3',
    '-d',
    '-e',
    '-f',
    '-s',
  ]);
});

test('parses modern Android foreground activity records', () => {
  const foreground = parseForegroundActivity(
    'topResumedActivity=ActivityRecord{123 u0 com.example.app/.MainActivity t1}',
  );
  assert.deepEqual(foreground, {
    packageName: 'com.example.app',
    activity: '.MainActivity',
    pid: null,
  });
});

test('filters the focused window on-device before transferring foreground state', async () => {
  const runner: CommandRunner = {
    async run(executable, args) {
      assert.equal(executable, 'adb');
      assert.deepEqual(args, [
        '-s',
        'serial-5',
        'shell',
        'sh',
        '-c',
        '\'dumpsys window windows | grep -m 1 "mCurrentFocus=" || true\'',
      ]);
      return output('mCurrentFocus=Window{123 u0 com.example.app/com.example.app.MainActivity}\n');
    },
  };
  const adb = new AdbClient({
    adbPath: 'adb',
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 100_000,
    runner,
  });
  assert.deepEqual(await new AdbForeground(adb).read('serial-5'), {
    packageName: 'com.example.app',
    activity: 'com.example.app.MainActivity',
    pid: null,
  });
});
