#!/usr/bin/env node

const args = process.argv.slice(2);
const png = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
png.write('IHDR', 12, 'ascii');
png.writeUInt32BE(1080, 16);
png.writeUInt32BE(2400, 20);
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x09, 0x60, 0x04,
  0x38, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);

if (args[0] === 'devices') {
  process.stdout.write(
    'List of devices attached\nprotocol-test\tdevice model:Protocol_Test device:protocol\n',
  );
} else if (args.includes('screencap') && args.includes('-j')) {
  process.stdout.write(jpeg);
} else if (args.includes('screencap')) {
  process.stdout.write(png);
} else if (args.includes('dumpsys') && args.includes('activity')) {
  process.stdout.write('mResumedActivity: ActivityRecord{protocol com.example.app/.Main}\n');
} else if (args.includes('wm') && args.includes('size')) {
  process.stdout.write('Physical size: 1080x2400\n');
} else if (args.includes('wm') && args.includes('density')) {
  process.stdout.write('Physical density: 420\n');
} else if (args.includes('dumpsys') && args.includes('input')) {
  process.stdout.write('SurfaceOrientation: 0\n');
} else if (args.includes('getprop')) {
  process.stdout.write('test\n');
} else if (args.includes('dumpsys') && args.includes('battery')) {
  process.stdout.write('level: 90\nstatus: 2\nUSB powered: true\n\n');
} else if (args.includes('dumpsys') && args.includes('window')) {
  process.stdout.write('mShowingLockscreen=false\n');
} else {
  process.stdout.write('');
}
