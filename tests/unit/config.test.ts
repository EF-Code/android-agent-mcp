import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../../src/config/loader.js';

test('loads defaults and applies validated environment overrides', () => {
  const config = loadConfig({
    env: {
      ANDROID_DEVICE_MCP_ALLOWED_PACKAGES: 'com.example.app, com.example.test',
      ANDROID_DEVICE_MCP_DEFAULT_TIMEOUT_MS: '5000',
    },
  });
  assert.deepEqual(config.allowedPackages, ['com.example.app', 'com.example.test']);
  assert.equal(config.defaultTimeoutMs, 5_000);
  assert.equal(config.mirror.audio, false);
  assert.equal(config.mirror.leaveRunningOnExit, false);
});

test('uses the nested mirror exit policy as the canonical setting', async () => {
  const root = await mkdtemp(join('/tmp', 'android-device-config-'));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ mirror: { leaveRunningOnExit: true } }));
  const config = loadConfig({ configPath, env: {} });
  assert.equal(config.mirror.leaveRunningOnExit, true);
});

test('applies file config before environment overrides', async () => {
  const root = await mkdtemp(join('/tmp', 'android-device-config-'));
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({ allowedPackages: ['com.file.app'], defaultTimeoutMs: 8_000 }),
  );
  const config = loadConfig({
    configPath,
    env: { ANDROID_DEVICE_MCP_ALLOWED_PACKAGES: 'com.env.app' },
  });
  assert.deepEqual(config.allowedPackages, ['com.env.app']);
  assert.equal(config.defaultTimeoutMs, 8_000);
});

test('rejects relative APK roots in config', async () => {
  const root = await mkdtemp(join('/tmp', 'android-device-config-'));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ allowedApkRoots: ['relative/path'] }));
  assert.throws(() => loadConfig({ configPath, env: {} }));
});
