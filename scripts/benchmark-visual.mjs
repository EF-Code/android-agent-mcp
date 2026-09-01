#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  process.stdout.write(`Usage: npm run benchmark:visual -- [options]

Options:
  --serial <adb-serial>     Select an exact device; defaults to the sole authorized device.
  --iterations <count>      Measured actions after warmup (default: 5, max: 100).
  --warmup <count>          Unmeasured warmup actions (default: 1, max: 10).
  --frame-format <format>   jpeg or png (default: jpeg).
  --actions <count>         One alternating key or a two-key batch (default: 2).
  --wait-ms <milliseconds>  Wait for a changed frame (default: 0, max: 15000).
  --stable-ms <milliseconds> Require a stable frame window (default: 0, max: 2000).
  --help                    Show this help.

The benchmark uses reversible volume keys, either as one alternating key per
sample or as an up/down pair. Keep a non-sensitive app in the foreground. No
UI hierarchy dump is performed between actions.
`);
}

function integer(value, name, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return parsed;
}

function parseOptions(argv) {
  const values = new Map();
  const allowed = new Set([
    '--serial',
    '--iterations',
    '--warmup',
    '--frame-format',
    '--actions',
    '--wait-ms',
    '--stable-ms',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value.`);
    values.set(key, value);
    index += 1;
  }
  const frameFormat = values.get('--frame-format') ?? 'jpeg';
  if (frameFormat !== 'jpeg' && frameFormat !== 'png') {
    throw new Error('--frame-format must be jpeg or png.');
  }
  const iterations = integer(values.get('--iterations'), '--iterations', 5, 100);
  if (iterations < 1) throw new Error('--iterations must be at least 1.');
  const actions = integer(values.get('--actions'), '--actions', 2, 2);
  if (actions < 1) throw new Error('--actions must be 1 or 2.');
  return {
    help: false,
    serial: values.get('--serial'),
    iterations,
    warmup: integer(values.get('--warmup'), '--warmup', 1, 10),
    frameFormat,
    actions,
    waitMs: integer(values.get('--wait-ms'), '--wait-ms', 0, 15_000),
    stableMs: integer(values.get('--stable-ms'), '--stable-ms', 0, 2_000),
  };
}

function envelope(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (text === undefined) throw new Error('MCP result did not contain structured text.');
  const parsed = JSON.parse(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.data;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, 'dist', 'index.js')],
    cwd: packageRoot,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client({ name: 'visual-latency-benchmark', version: '1.0.0' });
  let visualSessionId;
  try {
    await client.connect(transport);
    const devices = envelope(await client.callTool({ name: 'device_list', arguments: {} }));
    const authorized = devices.filter((device) => device.authorized);
    const serial =
      options.serial ??
      (authorized.length === 1
        ? authorized[0].serial
        : (() => {
            throw new Error(`Expected one authorized device; found ${authorized.length}.`);
          })());
    envelope(await client.callTool({ name: 'device_select', arguments: { serial } }));
    const started = envelope(
      await client.callTool({
        name: 'visual_control_start',
        arguments: { frame_format: options.frameFormat },
      }),
    );
    visualSessionId = started.session_id;
    const samples = [];
    const totalRuns = options.warmup + options.iterations;
    for (let index = 0; index < totalRuns; index += 1) {
      const actions =
        options.actions === 1
          ? [{ type: 'key', key: index % 2 === 0 ? 'volume_up' : 'volume_down' }]
          : [
              { type: 'key', key: 'volume_up' },
              { type: 'key', key: 'volume_down' },
            ];
      const action = envelope(
        await client.callTool({
          name: 'visual_control_action',
          arguments: {
            session_id: visualSessionId,
            actions,
            inter_action_delay_ms: options.actions === 1 ? 0 : 75,
            wait_for_change_ms: options.waitMs,
            stable_ms: options.stableMs,
          },
        }),
      );
      if (index >= options.warmup) samples.push(action);
    }
    if (options.actions === 1 && totalRuns % 2 !== 0) {
      envelope(
        await client.callTool({
          name: 'visual_control_action',
          arguments: {
            session_id: visualSessionId,
            actions: [{ type: 'key', key: 'volume_down' }],
          },
        }),
      );
    }
    const totals = samples.map((sample) => sample.elapsed_ms);
    process.stdout.write(
      `${JSON.stringify(
        {
          serial,
          foreground: started.foreground,
          frame: started.screen,
          actions_per_sample: options.actions,
          iterations: options.iterations,
          p50_ms: percentile(totals, 0.5),
          p95_ms: percentile(totals, 0.95),
          min_ms: Math.min(...totals),
          max_ms: Math.max(...totals),
          samples: samples.map((sample) => ({
            elapsed_ms: sample.elapsed_ms,
            changed: sample.changed,
            input_transport: sample.input_transport,
            frame_transport: sample.frame_transport,
            timing_ms: sample.timing_ms,
            frame: sample.screen,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (visualSessionId !== undefined) {
      await client
        .callTool({ name: 'visual_control_stop', arguments: { session_id: visualSessionId } })
        .catch(() => undefined);
    }
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
