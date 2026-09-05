import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EvidenceManager, EvidenceSession } from '../../src/evidence/recorder.js';
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
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
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
  assert.ok(summaryText.includes('# Android Agent MCP Evidence'));
  assert.ok(summaryText.includes('including this summary'));
  assert.ok(summaryText.includes('self-referential digest'));
});

test('prevents a second active evidence session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
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
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
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

test('prunes only recognized completed evidence and preserves unrelated directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
  const oldDirectory = join(root, 'old-session');
  await mkdir(oldDirectory);
  const oldDate = new Date(Date.now() - 10_000);
  await utimes(oldDirectory, oldDate, oldDate);
  const seed = new EvidenceManager(root, 1_000_000, 20, 1_000);
  const completed = await seed.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'expired',
  );
  await seed.finish();
  const statePath = join(completed.directory, '.android-agent-mcp-session.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  const manifestPath = join(completed.directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const oldStartedAt = new Date(Date.now() - 20_000).toISOString();
  await writeFile(
    statePath,
    `${JSON.stringify(
      { ...state, startedAt: oldStartedAt, completedAt: oldDate.toISOString() },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, startedAt: oldStartedAt }, null, 2)}\n`,
  );
  const manager = new EvidenceManager(root, 1_000_000, 20, 1_000);
  await manager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'new',
  );
  assert.equal((await stat(oldDirectory)).isDirectory(), true);
  await assert.rejects(() => stat(completed.directory));
  await manager.finish();
});

test('preserves incomplete and malformed marked evidence directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
  const incompleteManager = new EvidenceManager(root, 1_000_000, 20, 1_000);
  const incomplete = await incompleteManager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'incomplete',
  );
  const malformed = join(root, 'malformed');
  await mkdir(malformed);
  await writeFile(join(malformed, '.android-agent-mcp-session.json'), '{"producer":"other"}\n');
  const oldDate = new Date(Date.now() - 10_000);
  await utimes(incomplete.directory, oldDate, oldDate);
  await utimes(malformed, oldDate, oldDate);

  const pruningManager = new EvidenceManager(root, 1_000_000, 20, 1_000);
  await pruningManager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'new',
  );
  assert.equal((await stat(incomplete.directory)).isDirectory(), true);
  assert.equal((await stat(malformed)).isDirectory(), true);
  await pruningManager.finish();
});

test('preserves a completed marker without its matching owned manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
  const candidate = join(root, 'forged');
  await mkdir(candidate);
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  await writeFile(
    join(candidate, '.android-agent-mcp-session.json'),
    JSON.stringify({
      producer: 'android-agent-mcp',
      schemaVersion: 1,
      evidenceId: 'forged',
      state: 'completed',
      startedAt,
      completedAt: new Date(Date.now() - 10_000).toISOString(),
    }),
  );
  await writeFile(join(candidate, 'summary.md'), 'unrelated');

  const manager = new EvidenceManager(root, 1_000_000, 20, 1_000);
  await manager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'new',
  );
  assert.equal((await stat(candidate)).isDirectory(), true);
  await manager.finish();
});

test('keeps one completion timestamp when finalization is retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
  const completionTimes: string[] = [];
  const session = new EvidenceSession(
    'test',
    root,
    new Date().toISOString(),
    100_000,
    10,
    async (completedAt) => {
      completionTimes.push(completedAt);
      if (completionTimes.length === 1) throw new Error('marker unavailable');
    },
  );
  await assert.rejects(() => session.finish(), /marker unavailable/u);
  const summary = await session.finish();
  assert.equal(completionTimes[0], completionTimes[1]);
  assert.equal(summary.finishedAt, completionTimes[0]);
  assert.match(await readFile(summary.summaryPath, 'utf8'), new RegExp(completionTimes[0]!, 'u'));
});

test('rejects manager sessions whose file limit cannot hold required metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
  const manager = new EvidenceManager(root, 1_000_000, 2);
  await assert.rejects(
    () =>
      manager.begin(
        { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
        'too-small',
      ),
    /must reserve space/u,
  );
});

test('rejects evidence artifact parents that resolve outside the session directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
  const outside = await mkdtemp(join(tmpdir(), 'android-agent-mcp-outside-'));
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

test('does not report completion after summary finalization fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
  const session = new EvidenceSession('test', root, new Date().toISOString(), 100_000, 1);
  await session.saveLog('one', 'hello');

  await assert.rejects(() => session.finish(), /file count limit/u);
  assert.equal(session.summary.finishedAt, null);
  await assert.rejects(() => session.finish(), /file count limit/u);
  assert.equal(session.summary.finishedAt, null);
  await assert.rejects(() => stat(join(root, 'summary.md')));
});

test('shares concurrent finalization and rejects later artifact writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'android-agent-mcp-'));
  const manager = new EvidenceManager(root, 1_000_000, 20);
  const session = await manager.begin(
    { serverVersion: 'test', adbVersion: null, scrcpyVersion: null, device },
    'finish-once',
  );

  const [first, second] = await Promise.all([session.finish(), session.finish()]);
  assert.deepEqual(first, second);
  await assert.rejects(() => session.saveLog('late', 'late'), /already finished/u);
});
