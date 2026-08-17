import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode } from '../../src/errors/codes.js';
import { mapVisualInputActions } from '../../src/visual-control.js';

test('maps Google-style normalized coordinates to native display pixels', () => {
  assert.deepEqual(
    mapVisualInputActions(
      [
        { type: 'tap', x: 0, y: 0 },
        { type: 'swipe', startX: 999, startY: 999, endX: 500, endY: 500, durationMs: 100 },
        { type: 'key', key: 'back' },
      ],
      'normalized_1000',
      1080,
      2400,
    ),
    [
      { type: 'tap', x: 0, y: 0 },
      { type: 'swipe', startX: 1079, startY: 2399, endX: 540, endY: 1201, durationMs: 100 },
      { type: 'key', key: 'back' },
    ],
  );
});

test('preserves validated native coordinates', () => {
  assert.deepEqual(
    mapVisualInputActions([{ type: 'tap', x: 100, y: 200 }], 'device_pixels', 1080, 2400),
    [{ type: 'tap', x: 100, y: 200 }],
  );
});

test('rejects normalized values outside the Google coordinate range', () => {
  assert.throws(
    () => mapVisualInputActions([{ type: 'tap', x: 1_000, y: 0 }], 'normalized_1000', 1080, 2400),
    { code: ErrorCode.InvalidCoordinates },
  );
});
