import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EvidenceManager } from '../../src/evidence/recorder.js';
import { AppError } from '../../src/errors/app-error.js';
import type { DeviceInfo } from '../../src/types.js';

const device: DeviceInfo = {
  serial: 'sensitive-serial-1234',
  manufacturer: 'Test',
  model: 'Phone',
  product: 'product',
  device: 'device',
  androidVersion: '14',
  apiLevel: 34,
  abiList: ['arm64-v8a'],
  resolution: { width: 1080, height: 2400 },
  density: 420,
  battery: { level: 80, status: 'charging', plugged: 'USB', temperatureC: 30 },
  lockState: 'unlocked',
  foreground: { packageName: 'com.example.app', activity: '.Main', pid: 123 },
  observedAt: new Date().toISOString(),
};

test('creates sanitized evidence manifest and summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-device-mcp-'));
  const manager = new EvidenceManager(root, 1_000_000, 20);
  const session = await manager.begin(
    {
      serverVersion: 'test',
      adbVersion: 'adb',
      scrcpyVersion: null,
      device,
      metadata: { token: 'secret-value' },
    },
    'test',
  );
  await session.note('password=secret-value');
  await session.saveLog('log', 'Authorization: Bearer secret-value');
  const summary = await manager.finish();
  const manifest = await readFile(summary.manifestPath, 'utf8');
  assert.ok(manifest.includes('…1234'));
  assert.ok(!manifest.includes('secret-value'));
  assert.ok(summary.files.length >= 2);
  const summaryText = await readFile(summary.summaryPath, 'utf8');
  assert.ok(summaryText.includes('# Android Device MCP Evidence'));
  assert.ok(summaryText.includes('including this summary'));
  assert.ok(summaryText.includes('self-referential digest'));
});

test('prevents a second active evidence session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-device-mcp-'));
  const manager = new EvidenceManager(root, 1_000_000, 20);
  await manager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'first',
  );
  await assert.rejects(() =>
    manager.begin(
      { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
      'second',
    ),
  );
  await manager.finish();
});

test('pauses recording and digests action and summary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-device-mcp-'));
  const manager = new EvidenceManager(root, 1_000_000, 20);
  const session = await manager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'pause',
  );
  await session.action('safe', { input: 'omitted' });
  session.pause('sensitive foreground');
  await session.action('blocked', { token: 'secret-value' });
  await assert.rejects(
    () => session.saveLog('blocked', 'secret-value'),
    (error: unknown) => error instanceof Error && error.message.includes('paused'),
  );
  const summary = await manager.finish();
  assert.ok(summary.files.some((file) => file.path === 'actions.jsonl'));
  assert.ok(summary.files.some((file) => file.path === 'summary.md'));
  assert.ok((await readFile(summary.summaryPath, 'utf8')).includes('EVIDENCE_PAUSED'));
});

test('prunes only expired evidence directories below the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-device-mcp-'));
  const oldDirectory = join(root, 'old-session');
  await mkdir(oldDirectory);
  const oldDate = new Date(Date.now() - 10_000);
  await utimes(oldDirectory, oldDate, oldDate);
  const manager = new EvidenceManager(root, 1_000_000, 20, 1_000);
  await manager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'new',
  );
  await assert.rejects(() => stat(oldDirectory));
  await manager.finish();
});

test('rejects evidence artifact parents that resolve outside the session directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-device-mcp-'));
  const outside = await mkdtemp(join(tmpdir(), 'android-device-mcp-outside-'));
  const manager = new EvidenceManager(root, 1_000_000, 20);
  const session = await manager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'symlink',
  );
  await symlink(outside, join(session.directory, 'logs'));
  await assert.rejects(
    () => session.saveLog('escape', 'must not be written'),
    (error: unknown) => error instanceof AppError && error.code === 'EVIDENCE_PATH_INVALID',
  );
  await manager.finish();
  await assert.rejects(() => stat(join(outside, 'escape.log')));
});
