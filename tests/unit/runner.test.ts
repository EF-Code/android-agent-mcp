import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { ErrorCode } from '../../src/errors/codes.js';
import { AppError } from '../../src/errors/app-error.js';
import { runCommand } from '../../src/process/runner.js';

test('runs commands with argument arrays and records them', async () => {
  const result = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', 'safe-value'],
    {
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    },
  );
  assert.equal(result.stdout.toString(), 'safe-value');
  assert.equal(result.record.executable, process.execPath);
  assert.deepEqual(result.record.args, [
    '-e',
    'process.stdout.write(process.argv[1])',
    'safe-value',
  ]);
});

test('redacts configured secret arguments in command records', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.exit(0)', 'secret-value'], {
    timeoutMs: 5_000,
    maxOutputBytes: 16_000,
    secretArgIndexes: new Set([2]),
  });
  assert.equal(result.record.args[2], '[REDACTED]');
});

test('enforces output limits and timeouts', async () => {
  await assert.rejects(
    () =>
      runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
      }),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CommandOutputLimit,
  );
  await assert.rejects(
    () =>
      runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
        timeoutMs: 100,
        maxOutputBytes: 1_024,
      }),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CommandTimeout,
  );
});

test('ends a bounded live capture without turning the intentional stop into an error', async () => {
  const result = await runCommand(
    process.execPath,
    [
      '-e',
      'process.stdout.write("start\\n"); setInterval(() => process.stdout.write("tick\\n"), 10)',
    ],
    {
      timeoutMs: 5_000,
      captureDurationMs: 500,
      maxOutputBytes: 16_000,
    },
  );
  assert.ok(result.stdout.length > 0);
  assert.ok(result.record.durationMs >= 250);
  assert.equal(result.record.stdoutTruncated, false);
});

test('does not invoke a shell for metacharacter arguments', async () => {
  const directory = await mkdtemp(join('/tmp', 'android-device-runner-'));
  const marker = join(directory, 'marker');
  await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', `$(touch ${marker})`],
    {
      timeoutMs: 5_000,
      maxOutputBytes: 16_000,
    },
  );
  await assert.rejects(() => access(marker));
});

test('collects many output chunks without changing byte accounting', async () => {
  const chunks = 2_000;
  const result = await runCommand(
    process.execPath,
    ['-e', `for (let i = 0; i < ${chunks}; i += 1) process.stdout.write('x')`],
    { timeoutMs: 5_000, maxOutputBytes: 16_000 },
  );
  assert.equal(result.stdout.length, chunks);
  assert.equal(result.record.stdoutBytes, chunks);
  assert.equal(result.record.stdoutTruncated, false);
});
