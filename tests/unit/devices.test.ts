import assert from 'node:assert/strict';
import test from 'node:test';

import { AdbClient } from '../../src/adb/client.js';
import { DeviceManager, parseAdbDevices } from '../../src/adb/devices.js';
import { ErrorCode } from '../../src/errors/codes.js';
import { AppError } from '../../src/errors/app-error.js';

test('parses authorized, unauthorized, offline, and no-permissions devices', () => {
  const devices = parseAdbDevices(`List of devices attached
authorized123\tdevice usb:1-2 product:demo model:Pixel_7 device:panther transport_id:1
unauthorized\tunauthorized usb:1-3
offline-one\toffline usb:1-4
permissions\tno permissions usb:1-5
`);

  assert.deepEqual(
    devices.map((device) => [device.serial, device.state, device.authorized]),
    [
      ['authorized123', 'device', true],
      ['unauthorized', 'unauthorized', false],
      ['offline-one', 'offline', false],
      ['permissions', 'no permissions', false],
    ],
  );
  assert.equal(devices[0]?.model, 'Pixel_7');
  assert.equal(devices[0]?.transportId, '1');
});

test('requires explicit reselection after disconnect and same-serial reconnect', async () => {
  const outputs = [
    'List of devices attached\nphone-a\tdevice model:Test\n',
    'List of devices attached\n',
    'List of devices attached\nphone-a\tdevice model:Test\n',
    'List of devices attached\nphone-a\tdevice model:Test\n',
    'List of devices attached\nphone-a\tdevice model:Test\n',
  ];
  const runner = {
    run: async () => ({
      stdout: Buffer.from(outputs.shift() ?? ''),
      stderr: Buffer.alloc(0),
      record: {
        executable: 'adb',
        args: ['devices', '-l'],
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
  const manager = new DeviceManager(
    new AdbClient({ adbPath: 'adb', defaultTimeoutMs: 1_000, maxOutputBytes: 10_000, runner }),
    false,
  );

  const initial = await manager.select('phone-a');
  assert.equal((await manager.requireSelected({ checkConnection: false })).serial, 'phone-a');
  await assert.rejects(
    () => manager.requireSelected(),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.DeviceDisconnected,
  );
  const reconnected = await manager.list();
  assert.equal(reconnected[0]?.selected, false);
  await assert.rejects(
    () => manager.requireSelected(),
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.DeviceDisconnected,
  );

  const reselection = await manager.select('phone-a');
  assert.notEqual(reselection.session.sessionId, initial.session.sessionId);
  assert.equal(reselection.device.selected, true);
  assert.equal((await manager.requireSelected()).sessionId, reselection.session.sessionId);
});
