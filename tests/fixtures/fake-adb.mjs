#!/usr/bin/env node

const args = process.argv.slice(2);
const png = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
png.write('IHDR', 12, 'ascii');
png.writeUInt32BE(1080, 16);
png.writeUInt32BE(2400, 20);

if (args[0] === 'devices') {
  process.stdout.write('List of devices attached\nprotocol-test\tdevice model:Protocol_Test device:protocol\n');
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
