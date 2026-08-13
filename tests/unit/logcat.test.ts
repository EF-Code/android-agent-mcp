import assert from 'node:assert/strict';
import test from 'node:test';

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
