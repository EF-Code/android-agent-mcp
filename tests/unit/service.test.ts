import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../../src/config/loader.js';
import { AndroidDeviceService, uiStateFingerprint } from '../../src/service.js';
import type { UiSnapshot } from '../../src/ui/types.js';

test('keeps ADB discovery usable when visible scrcpy auto-start fails', async () => {
  const service = new AndroidDeviceService(
    loadConfig({
      env: {
        ANDROID_MCP_ADB_PATH: join(process.cwd(), 'tests', 'fixtures', 'fake-adb.mjs'),
        ANDROID_MCP_SCRCPY_PATH: '/definitely/missing/scrcpy',
        ANDROID_MCP_MIRROR_AUTO_START: 'true',
      },
    }),
  );
  try {
    const devices = await service.listDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0]!.authorized, true);
    assert.equal(service.devices.selected?.serial, 'protocol-test');
    assert.equal(service.scrcpy.status().running, false);
    assert.equal(service.autoMirrorWarning?.code, 'SCRCPY_NOT_FOUND');
  } finally {
    await service.close();
  }
});

test('attempts visible auto-start only once per selected-device session', async () => {
  const service = new AndroidDeviceService(
    loadConfig({
      env: {
        ANDROID_MCP_ADB_PATH: join(process.cwd(), 'tests', 'fixtures', 'fake-adb.mjs'),
        ANDROID_MCP_SCRCPY_PATH: '/definitely/missing/scrcpy',
        ANDROID_MCP_MIRROR_AUTO_START: 'true',
      },
    }),
  );
  try {
    await service.listDevices();
    const warning = service.autoMirrorWarning;
    assert.ok(warning !== null);
    await service.selectedSerial();
    assert.deepEqual(service.autoMirrorWarning, warning);
    assert.equal(service.scrcpy.status().running, false);
  } finally {
    await service.close();
  }
});

test('fingerprints UI state without snapshot-local identity and includes node flags', () => {
  const snapshot: UiSnapshot = {
    snapshotId: 'snapshot-a',
    capturedAt: '2026-08-13T00:00:00.000Z',
    display: { width: 720, height: 1600, rotation: 0 },
    foreground: { packageName: 'com.example.app', activity: '.Main', pid: 10 },
    rootIds: ['node-0'],
    warnings: [],
    nodes: [
      {
        nodeId: 'node-0',
        className: 'android.widget.Button',
        packageName: 'com.example.app',
        text: 'Continue',
        contentDescription: null,
        resourceId: 'com.example.app:id/continue',
        flags: {
          clickable: true,
          enabled: true,
          focusable: true,
          focused: false,
          scrollable: false,
          selected: false,
          checked: false,
          password: false,
          visibleToUser: true,
        },
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        center: { x: 50, y: 50 },
        parentId: null,
        childIds: [],
      },
    ],
  };
  const recaptured = {
    ...snapshot,
    snapshotId: 'snapshot-b',
    capturedAt: '2026-08-13T00:00:01.000Z',
    rootIds: ['other-root-id'],
    nodes: [{ ...snapshot.nodes[0]!, nodeId: 'other-node-id' }],
  };
  assert.equal(uiStateFingerprint(snapshot), uiStateFingerprint(recaptured));
  const disabled = {
    ...recaptured,
    nodes: [
      {
        ...recaptured.nodes[0]!,
        flags: { ...recaptured.nodes[0]!.flags, enabled: false },
      },
    ],
  };
  assert.notEqual(uiStateFingerprint(snapshot), uiStateFingerprint(disabled));
});
