import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EvidenceManager } from '../../src/evidence/recorder.js';
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
  const session = await manager.begin({ serverVersion: 'test', adbVersion: 'adb', scrcpyVersion: null, device, metadata: { token: 'secret-value' } }, 'test');
  await session.note('password=secret-value');
  await session.saveLog('log', 'Authorization: Bearer secret-value');
  const summary = await manager.finish();
  const manifest = await readFile(summary.manifestPath, 'utf8');
  assert.ok(manifest.includes('…1234'));
  assert.ok(!manifest.includes('secret-value'));
  assert.ok(summary.files.length >= 2);
  assert.ok((await readFile(summary.summaryPath, 'utf8')).includes('# Android Device MCP Evidence'));
});

test('prevents a second active evidence session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-device-mcp-'));
  const manager = new EvidenceManager(root, 1_000_000, 20);
  await manager.begin({ serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device }, 'first');
  await assert.rejects(() => manager.begin({ serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device }, 'second'));
  await manager.finish();
});
