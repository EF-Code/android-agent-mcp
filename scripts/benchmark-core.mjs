import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import * as frames from '../dist/scrcpy/frame-stream.js';
import { parseUiAutomatorXml } from '../dist/ui/parse.js';
import { findMatches } from '../dist/ui/selectors.js';

// Fixed synthetic workloads: no device, host configuration, or network access.
const jpeg = Buffer.alloc(512 * 1024, 0x31);
Buffer.from([0xff, 0xd8]).copy(jpeg);
Buffer.from([0xff, 0xd9]).copy(jpeg, jpeg.length - 2);
const chunks = [];
for (let offset = 0; offset < jpeg.length; offset += 256) {
  chunks.push(jpeg.subarray(offset, offset + 256));
}

const branches = Array.from(
  { length: 1500 },
  (_, index) =>
    `<node text="Group ${index}" bounds="[0,0][10,10]"><node text="Item ${index}" bounds="[0,0][10,10]"/></node>`,
).join('');
const snapshot = parseUiAutomatorXml(
  `<hierarchy><node text="Root" bounds="[0,0][10,10]">${branches}</node></hierarchy>`,
  {
    snapshotId: 'benchmark',
    capturedAt: new Date().toISOString(),
    display: { width: 1080, height: 2400, rotation: 0 },
    foreground: { packageName: 'com.example.app', activity: '.Main', pid: 1 },
  },
);

function measure(name, work) {
  for (let index = 0; index < 3; index += 1) work();
  const samples = [];
  for (let index = 0; index < 15; index += 1) {
    const started = performance.now();
    work();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return { name, median_ms: samples[7], p95_ms: samples[14] };
}

const results = [
  measure('fragmented_jpeg_512k_256byte_chunks', () => {
    let pending = Buffer.alloc(0);
    const assembler = frames.JpegFrameAssembler ? new frames.JpegFrameAssembler() : null;
    let count = 0;
    for (const chunk of chunks) {
      if (assembler !== null) count += assembler.push(chunk).length;
      else {
        const extracted = frames.extractJpegFrames(Buffer.concat([pending, chunk]));
        pending = extracted.remainder;
        count += extracted.frames.length;
      }
    }
    assert.equal(count, 1);
  }),
  measure('ancestor_regex_3001_nodes', () => {
    assert.equal(
      findMatches(snapshot, {
        text: '^Item ',
        textMode: 'regex',
        ancestor: { text: 'Root' },
      }).length,
      1500,
    );
  }),
  measure('descendant_no_match_3001_nodes', () => {
    assert.equal(findMatches(snapshot, { descendant: { text: 'Missing' } }).length, 0);
  }),
];
process.stdout.write(`${JSON.stringify({ node: process.version, results }, null, 2)}\n`);
