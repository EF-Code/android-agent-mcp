import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run test:package.');
const directory = await mkdtemp(join(tmpdir(), 'android-agent-mcp-package-'));
const installDirectory = join(directory, 'install');
let client;
let transport;

async function npm(args, cwd) {
  const result = await execute(process.execPath, [npmCli, ...args], {
    cwd,
    timeout: 120_000,
    maxBuffer: 4_000_000,
    encoding: 'utf8',
  });
  return result.stdout;
}

try {
  const [packed] = JSON.parse(
    await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], repository),
  );
  assert.equal(
    packed.files.some((file) => file.path === 'PROJECT_IMPROVEMENT_PLAN.md'),
    false,
  );
  assert.ok(packed.files.some((file) => file.path === 'dist/index.js'));
  await mkdir(installDirectory);
  await npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      join(directory, packed.filename),
    ],
    installDirectory,
  );
  const installedRoot = join(installDirectory, 'node_modules', 'android-agent-mcp');
  const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, packed.version);
  const binary = resolve(installedRoot, installed.bin['android-agent-mcp']);
  const preview = await execute(
    process.execPath,
    [binary, 'setup', '--client', 'generic', '--dry-run'],
    {
      cwd: installDirectory,
      timeout: 10_000,
    },
  );
  assert.match(preview.stdout, /mcpServers/u);

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [binary],
    cwd: installDirectory,
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: directory,
      ANDROID_AGENT_MCP_ADB_PATH: join(repository, 'tests', 'fixtures', 'fake-adb.mjs'),
      ANDROID_AGENT_MCP_MIRROR_AUTO_START: 'false',
      ANDROID_AGENT_MCP_ALLOWED_PACKAGES: 'com.example.app',
    },
  });
  client = new Client({ name: 'installed-package-smoke', version: '1.0.0' });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, packed.version);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'visual_control_action'));
  const selected = await client.callTool({
    name: 'device_select',
    arguments: { serial: 'protocol-test' },
  });
  assert.notEqual(selected.isError, true);
  const capture = await client.callTool({ name: 'screen_capture', arguments: {} });
  assert.notEqual(capture.isError, true);
  assert.ok(capture.content.some((item) => item.type === 'image' && item.mimeType === 'image/png'));
  process.stdout.write(
    `Installed package ${packed.name}@${packed.version}: setup preview, MCP initialization, tools, selection, and image capture passed.\n`,
  );
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
