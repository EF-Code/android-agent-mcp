import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ErrorCode } from '../../src/errors/codes.js';
import { ScrcpyProcessManager } from '../../src/scrcpy/process-manager.js';
import { buildScrcpyArgs, parseVersion } from '../../src/scrcpy/capabilities.js';

test('parses installed scrcpy versions', () => {
  assert.deepEqual(parseVersion('scrcpy 4.1 <https://github.com/Genymobile/scrcpy>'), {
    version: '4.1',
    major: 4,
    minor: 1,
  });
});

test('maps bounded mirror options to explicit scrcpy flags', () => {
  const args = buildScrcpyArgs(
    'serial-1',
    {
      maxSize: 1600,
      maxFps: 30,
      audio: false,
      control: false,
      stayAwake: true,
      turnScreenOff: true,
      windowTitle: 'Android Device MCP',
    },
    {
      version: '4.1',
      major: 4,
      minor: 1,
      supportsNoAudio: true,
      supportsNoControl: true,
      supportsTurnScreenOff: true,
      supportsStayAwake: true,
    },
  );
  assert.deepEqual(args, [
    '--serial',
    'serial-1',
    '--max-size',
    '1600',
    '--max-fps',
    '30',
    '--window-title',
    'Android Device MCP',
    '--no-audio',
    '--no-control',
    '--stay-awake',
    '--turn-screen-off',
  ]);
});

test('stops only the owned scrcpy child and preserves an unrelated process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'android-device-scrcpy-'));
  const fixture = join(directory, 'fake-scrcpy.mjs');
  await writeFile(fixture, '#!/usr/bin/env node\nsetInterval(() => undefined, 1000);\n');
  await chmod(fixture, 0o755);
  const runner = {
    run: async () => ({
      stdout: Buffer.from('scrcpy 4.1\n'),
      stderr: Buffer.alloc(0),
      record: {
        executable: fixture,
        args: ['--version'],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutBytes: 12,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    }),
  };
  const manager = new ScrcpyProcessManager(fixture, false, runner);
  const unrelated = (await import('node:child_process')).spawn(
    process.execPath,
    ['-e', 'setInterval(() => undefined, 1000)'],
    { detached: true, stdio: 'ignore' },
  );
  assert.ok(unrelated.pid !== undefined);
  const started = await manager.start('serial-1', {
    maxSize: 1_600,
    maxFps: 30,
    audio: false,
    control: false,
    stayAwake: false,
    turnScreenOff: false,
    windowTitle: 'test',
  });
  assert.equal(started.status.running, true);
  assert.equal(started.status.args[0], '--serial');
  const stopped = await manager.stop();
  assert.equal(stopped.owned, true);
  assert.equal(stopped.running, false);
  assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  process.kill(unrelated.pid!, 'SIGTERM');
});

test('marks an owned mirror detached without changing its bound serial', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'android-device-scrcpy-'));
  const fixture = join(directory, 'fake-scrcpy.mjs');
  await writeFile(fixture, '#!/usr/bin/env node\nsetInterval(() => undefined, 1000);\n');
  await chmod(fixture, 0o755);
  const runner = {
    run: async () => ({
      stdout: Buffer.from('scrcpy 4.1\n'),
      stderr: Buffer.alloc(0),
      record: {
        executable: fixture,
        args: [],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutBytes: 12,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    }),
  };
  const manager = new ScrcpyProcessManager(fixture, false, runner);
  await manager.start('serial-2', {
    maxSize: 1_600,
    maxFps: 30,
    audio: false,
    control: false,
    stayAwake: false,
    turnScreenOff: false,
    windowTitle: 'test',
  });
  manager.markDetached('serial-2');
  assert.equal(manager.status().detached, true);
  assert.equal(manager.status().deviceSerial, 'serial-2');
  await manager.stop();
});

test('starts an owned mirror with control enabled when requested', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'android-device-scrcpy-visible-'));
  const fixture = join(directory, 'fake-scrcpy.mjs');
  await writeFile(fixture, '#!/usr/bin/env node\nsetInterval(() => undefined, 1000);\n');
  await chmod(fixture, 0o755);
  const runner = {
    run: async () => ({
      stdout: Buffer.from('scrcpy 4.1\n'),
      stderr: Buffer.alloc(0),
      record: {
        executable: fixture,
        args: [],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutBytes: 12,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    }),
  };
  const manager = new ScrcpyProcessManager(fixture, false, runner);
  const started = await manager.start('serial-visible', {
    maxSize: 1_600,
    maxFps: 30,
    audio: false,
    control: true,
    stayAwake: false,
    turnScreenOff: false,
    windowTitle: 'Android Device MCP',
  });
  assert.equal(started.status.running, true);
  assert.equal(started.status.args.includes('--no-control'), false);
  await manager.stop();
});
