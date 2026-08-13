import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAdbDevices } from '../../src/adb/devices.js';

test('parses authorized, unauthorized, offline, and no-permissions devices', () => {
  const devices = parseAdbDevices(`List of devices attached
authorized123\tdevice usb:1-2 product:demo model:Pixel_7 device:panther transport_id:1
unauthorized\tunauthorized usb:1-3
offline-one\toffline usb:1-4
permissions\tno permissions usb:1-5
`);

  assert.deepEqual(devices.map((device) => [device.serial, device.state, device.authorized]), [
    ['authorized123', 'device', true],
    ['unauthorized', 'unauthorized', false],
    ['offline-one', 'offline', false],
    ['permissions', 'no permissions', false],
  ]);
  assert.equal(devices[0]?.model, 'Pixel_7');
  assert.equal(devices[0]?.transportId, '1');
});
