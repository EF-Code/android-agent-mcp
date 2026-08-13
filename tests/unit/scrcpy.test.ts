import assert from 'node:assert/strict';
import test from 'node:test';

import { buildScrcpyArgs, parseVersion } from '../../src/scrcpy/capabilities.js';

test('parses installed scrcpy versions', () => {
  assert.deepEqual(parseVersion('scrcpy 4.1 <https://github.com/Genymobile/scrcpy>'), { version: '4.1', major: 4, minor: 1 });
});

test('maps bounded mirror options to explicit scrcpy flags', () => {
  const args = buildScrcpyArgs('serial-1', { maxSize: 1600, maxFps: 30, audio: false, control: false, stayAwake: true, turnScreenOff: true, windowTitle: 'Android Device MCP' }, {
    version: '4.1',
    major: 4,
    minor: 1,
    supportsNoAudio: true,
    supportsNoControl: true,
    supportsTurnScreenOff: true,
    supportsStayAwake: true,
  });
  assert.deepEqual(args, ['--serial', 'serial-1', '--max-size', '1600', '--max-fps', '30', '--window-title', 'Android Device MCP', '--no-audio', '--no-control', '--stay-awake', '--turn-screen-off']);
});
