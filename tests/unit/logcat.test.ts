import assert from 'node:assert/strict';
import test from 'node:test';

import { AdbClient } from '../../src/adb/client.js';
import { AdbLogcat } from '../../src/adb/logcat.js';
import { parseCrashBlocks } from '../../src/adb/logcat.js';
import { normalizeInstallFailure } from '../../src/adb/installer.js';
import { redactLogText } from '../../src/policy/redaction.js';

test('normalizes common Android package installation failures', () => {
  assert.equal(normalizeInstallFailure('INSTALL_FAILED_NO_MATCHING_ABIS'), 'ABI_MISMATCH');
  assert.equal(normalizeInstallFailure('INSTALL_FAILED_MISSING_SPLIT'), 'MISSING_SPLIT');
  assert.equal(normalizeInstallFailure('INSTALL_FAILED_UPDATE_INCOMPATIBLE'), 'SIGNATURE_MISMATCH');
  assert.equal(normalizeInstallFailure('INSTALL_FAILED_VERSION_DOWNGRADE'), 'DOWNGRADE');
  assert.equal(normalizeInstallFailure('INSTALL_FAILED_OLDER_SDK'), 'SDK_INCOMPATIBLE');
});

test('parses crash evidence and redacts sensitive log values', () => {
  const crash = parseCrashBlocks(`06-01 12:00:00.000 E/AndroidRuntime: FATAL EXCEPTION: main
Process: com.example.app, PID: 4321
java.lang.IllegalStateException: token=secret-value
  at com.example.app.Main.onCreate(Main.java:42)
`);
  assert.equal(crash.length, 1);
  assert.equal(crash[0]?.processPackage, 'com.example.app');
  assert.equal(crash[0]?.pid, 4321);
  assert.equal(crash[0]?.exceptionType, 'java.lang.IllegalStateException');
  assert.ok(!redactLogText('password=secret-value').includes('secret-value'));
});

test('returns crash evidence only when package attribution is exact', async () => {
  const runner = {
    run: async () => ({
      stdout: Buffer.from(`FATAL EXCEPTION: main
Process: com.example.app, PID: 4321
java.lang.IllegalStateException: target

FATAL EXCEPTION: main
Process: com.other.app, PID: 9876
java.lang.IllegalStateException: unrelated

ANR in unknown.process
`),
      stderr: Buffer.alloc(0),
      record: {
        executable: 'adb',
        args: [],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    }),
  };
  const logcat = new AdbLogcat(
    new AdbClient({ adbPath: 'adb', defaultTimeoutMs: 1_000, maxOutputBytes: 64_000, runner }),
    64_000,
  );
  const crashes = await logcat.crashes('serial', 'com.example.app');
  assert.equal(crashes.length, 1);
  assert.equal(crashes[0]?.processPackage, 'com.example.app');
});

test('filters optional crash-buffer text to the requested package', async () => {
  let calls = 0;
  const runner = {
    run: async () => {
      calls += 1;
      const stdout =
        calls === 1
          ? Buffer.from('')
          : Buffer.from(`FATAL EXCEPTION: main
Process: com.example.app, PID: 4321
java.lang.IllegalStateException: target

FATAL EXCEPTION: main
Process: com.other.app, PID: 9876
java.lang.IllegalStateException: unrelated
`);
      return {
        stdout,
        stderr: Buffer.alloc(0),
        record: {
          executable: 'adb',
          args: [],
          exitCode: 0,
          signal: null,
          durationMs: 1,
          stdoutBytes: stdout.length,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      };
    },
  };
  const logcat = new AdbLogcat(
    new AdbClient({ adbPath: 'adb', defaultTimeoutMs: 1_000, maxOutputBytes: 64_000, runner }),
    64_000,
  );

  const capture = await logcat.capture('serial', {
    packageName: 'com.example.app',
    pid: 4321,
    since: '09-05 10:00:00.000',
    includeCrashBuffer: true,
  });
  assert.match(capture.text, /target/u);
  assert.doesNotMatch(capture.text, /unrelated|com\.other\.app/u);
});

test('rejects crash-buffer capture without a package identity', async () => {
  const logcat = new AdbLogcat(undefined as never, 64_000);
  await assert.rejects(
    () => logcat.capture('serial', { pid: 4321, includeCrashBuffer: true }),
    /requires an authorized package name/u,
  );
});
