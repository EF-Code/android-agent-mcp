import assert from 'node:assert/strict';
import test from 'node:test';

import { SnapshotStore } from '../../src/ui/snapshots.js';
import type { UiSnapshot } from '../../src/ui/types.js';

function makeSnapshot(overrides: Partial<UiSnapshot> = {}): UiSnapshot {
  return {
    snapshotId: 'snapshot-1',
    deviceSerial: 'serial-1',
    deviceSessionId: 'session-1',
    capturedAt: new Date().toISOString(),
    display: { width: 1080, height: 2400, rotation: 0 },
    foreground: { packageName: 'com.example.app', activity: '.Main', pid: 1 },
    nodes: [],
    rootIds: [],
    warnings: [],
    ...overrides,
  };
}

test('requires a fresh snapshot from the selected device session', () => {
  const store = new SnapshotStore(3_000);
  store.put(makeSnapshot());
  assert.doesNotThrow(() =>
    store.requireFresh('snapshot-1', {
      foreground: { packageName: 'com.example.app', activity: '.Main', pid: 1 },
      deviceSerial: 'serial-1',
      deviceSessionId: 'session-1',
    }),
  );
  assert.throws(() => store.requireFresh('snapshot-1', { deviceSerial: 'serial-2' }));
  assert.throws(() => store.requireFresh('snapshot-1', { deviceSessionId: 'session-2' }));
  assert.throws(() =>
    store.requireFresh('snapshot-1', {
      foreground: { packageName: 'com.example.other', activity: '.Main', pid: 1 },
    }),
  );
});

test('invalidating snapshots rejects retained node references', () => {
  const store = new SnapshotStore(3_000);
  store.put(makeSnapshot());
  store.invalidate();
  assert.throws(() => store.requireFresh('snapshot-1'), /missing or no longer retained/u);
});
