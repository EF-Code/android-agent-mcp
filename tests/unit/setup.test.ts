import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SETUP_CLIENTS,
  buildSetupPlan,
  createStdioServerConfig,
  parseSetupOptions,
  renderClaudeConfig,
  renderCodexConfig,
  renderGooseConfig,
  renderOpenCodeConfig,
  renderPiConfig,
  runSetup,
} from '../../src/setup.js';
import type { SetupClient } from '../../src/setup.js';

const unavailableClients = Object.fromEntries(
  SETUP_CLIENTS.map((client) => [client, false]),
) as Record<SetupClient, boolean>;

test('setup options support automatic, targeted, generic, and preview modes', () => {
  assert.deepEqual(parseSetupOptions([]), {
    requestedClient: 'auto',
    dryRun: false,
    help: false,
  });
  assert.deepEqual(parseSetupOptions(['--client', 'codex', '--dry-run']), {
    requestedClient: 'codex',
    dryRun: true,
    help: false,
  });
  assert.deepEqual(
    parseSetupOptions(['--client', 'generic', '--config-path', '/tmp/android.json']),
    {
      requestedClient: 'generic',
      dryRun: false,
      help: false,
      configPath: '/tmp/android.json',
    },
  );
  assert.deepEqual(parseSetupOptions(['--help']), {
    requestedClient: 'auto',
    dryRun: false,
    help: true,
  });
  assert.throws(() => parseSetupOptions(['--client', 'unknown']), /--client must be/u);
});

test('automatic host detection uses commands and stable per-host config paths', () => {
  const plan = buildSetupPlan({
    requestedClient: 'auto',
    home: '/home/tester',
    platform: 'linux',
    env: { XDG_CONFIG_HOME: '/config', CLINE_DATA_DIR: '/cline' },
    entrypoint: '/opt/android-agent-mcp/dist/index.js',
    projectRoot: '/opt/android-agent-mcp',
    commandAvailability: {
      ...unavailableClients,
      codex: true,
      openclaw: true,
    },
  });

  assert.deepEqual(plan.clients, ['codex', 'openclaw']);
  assert.deepEqual(plan.configPaths, {
    codex: '/home/tester/.codex/config.toml',
    claude: '/home/tester/.claude.json',
    openclaw: '/home/tester/.openclaw/openclaw.json',
    antigravity: '/home/tester/.gemini/config/mcp_config.json',
    gemini: '/home/tester/.gemini/settings.json',
    opencode: '/config/opencode/opencode.json',
    cursor: '/home/tester/.cursor/mcp.json',
    windsurf: '/home/tester/.codeium/windsurf/mcp_config.json',
    vscode: '/config/Code/User/mcp.json',
    pi: '/home/tester/.pi/agent/mcp.json',
    cline: '/cline/settings/cline_mcp_settings.json',
    zed: '/config/zed/settings.json',
    goose: '/config/goose/config.yaml',
  });
  assert.equal(plan.server.command, process.execPath);
  assert.deepEqual(plan.server.args, ['/opt/android-agent-mcp/dist/index.js']);
  assert.equal(plan.server.cwd, '/opt/android-agent-mcp');

  const allPlan = buildSetupPlan({
    requestedClient: 'all',
    home: '/home/tester',
    platform: 'linux',
    env: {},
    entrypoint: '/opt/android-agent-mcp/dist/index.js',
    projectRoot: '/opt/android-agent-mcp',
    commandAvailability: unavailableClients,
  });
  assert.deepEqual(allPlan.clients, [...SETUP_CLIENTS]);
});

test('published, globally installed, and source launchers produce stable server configs', () => {
  const source = createStdioServerConfig(
    '/opt/android-agent-mcp/dist/index.js',
    '/opt/android-agent-mcp',
    '/tmp/android-agent.json',
    'linux',
  );
  assert.deepEqual(source, {
    command: process.execPath,
    args: ['/opt/android-agent-mcp/dist/index.js'],
    cwd: '/opt/android-agent-mcp',
    env: { ANDROID_AGENT_MCP_CONFIG: '/tmp/android-agent.json' },
  });

  const root = mkdtempSync(join(tmpdir(), 'android-agent-npx-'));
  const npxEntrypoint = join(
    root,
    '.npm',
    '_npx',
    'cache',
    'node_modules',
    'android-agent-mcp',
    'dist',
    'index.js',
  );
  mkdirSync(join(root, '.npm', '_npx', 'cache', 'node_modules', 'android-agent-mcp'), {
    recursive: true,
  });
  writeFileSync(
    join(root, '.npm', '_npx', 'cache', 'node_modules', 'android-agent-mcp', 'package.json'),
    JSON.stringify({ name: 'android-agent-mcp', version: '0.2.0' }),
  );
  try {
    const npx = createStdioServerConfig(npxEntrypoint, root, undefined, 'linux');
    assert.equal(npx.command, 'npx');
    assert.deepEqual(npx.args, ['--yes', 'android-agent-mcp@0.2.0']);
    assert.equal(npx.cwd, process.cwd());

    const global = createStdioServerConfig(
      '/usr/lib/node_modules/android-agent-mcp/dist/index.js',
      '/usr/lib/node_modules/android-agent-mcp',
      undefined,
      'linux',
    );
    assert.deepEqual(global, {
      command: 'android-agent-mcp',
      args: [],
      cwd: process.cwd(),
      env: {},
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native renderers preserve the stdio contract', () => {
  const server = {
    command: 'node',
    args: ['/opt/android-agent-mcp/dist/index.js'],
    cwd: '/opt/android-agent-mcp',
    env: { ANDROID_AGENT_MCP_CONFIG: '/tmp/android-agent.json' },
  };

  assert.deepEqual(renderClaudeConfig(server), {
    type: 'stdio',
    command: 'node',
    args: ['/opt/android-agent-mcp/dist/index.js'],
    env: { ANDROID_AGENT_MCP_CONFIG: '/tmp/android-agent.json' },
  });
  assert.match(renderCodexConfig(server), /\[mcp_servers\.android-device\]/u);
  assert.match(renderCodexConfig(server), /ANDROID_AGENT_MCP_CONFIG = "/u);
  assert.deepEqual(renderOpenCodeConfig(server), {
    type: 'local',
    command: ['node', '/opt/android-agent-mcp/dist/index.js'],
    cwd: '/opt/android-agent-mcp',
    environment: { ANDROID_AGENT_MCP_CONFIG: '/tmp/android-agent.json' },
    enabled: true,
  });
  assert.equal(renderPiConfig(server).lifecycle, 'lazy');
  assert.equal(renderGooseConfig(server).type, 'stdio');
});

test('targeted setup writes JSON and TOML files with one-time backups', async () => {
  const home = mkdtempSync(join(tmpdir(), 'android-agent-setup-'));
  const configRoot = join(home, 'config');
  const codexPath = join(home, '.codex', 'config.toml');
  const claudePath = join(home, '.claude.json');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(codexPath, '[mcp_servers.other]\ncommand = "other"\n');
  try {
    const env = {
      ...process.env,
      ANDROID_AGENT_MCP_SETUP_HOME: home,
      XDG_CONFIG_HOME: configRoot,
      ANDROID_AGENT_MCP_CONFIG: join(home, 'android-agent.json'),
    };
    await runSetup(['--client', 'codex'], env);
    const firstCodex = readFileSync(codexPath, 'utf8');
    assert.match(firstCodex, /\[mcp_servers\.other\]/u);
    assert.match(firstCodex, /\[mcp_servers\.android-device\]/u);
    assert.match(firstCodex, /ANDROID_AGENT_MCP_CONFIG/u);
    assert.equal(
      readFileSync(`${codexPath}.android-agent-mcp.bak`, 'utf8'),
      '[mcp_servers.other]\ncommand = "other"\n',
    );

    await runSetup(['--client', 'claude'], env);
    const claude = JSON.parse(readFileSync(claudePath, 'utf8')) as {
      mcpServers: Record<string, { type: string; command: string }>;
    };
    assert.equal(claude.mcpServers['android-device']?.type, 'stdio');
    assert.equal(claude.mcpServers['android-device']?.command, process.execPath);
    assert.equal(existsSync(`${claudePath}.android-agent-mcp.bak`), false);

    await runSetup(['--client', 'codex'], env);
    assert.equal(
      readFileSync(`${codexPath}.android-agent-mcp.bak`, 'utf8'),
      '[mcp_servers.other]\ncommand = "other"\n',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Goose setup writes YAML and OpenCode setup migrates an Android-only legacy entry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'android-agent-hosts-'));
  const configRoot = join(home, 'config');
  const openCodePath = join(configRoot, 'opencode', 'opencode.json');
  const goosePath = join(configRoot, 'goose', 'config.yaml');
  mkdirSync(join(configRoot, 'opencode'), { recursive: true });
  writeFileSync(
    openCodePath,
    JSON.stringify({ mcp: { servers: { 'android-device': { type: 'local', command: ['old'] } } } }),
  );
  try {
    const env = { ...process.env, ANDROID_AGENT_MCP_SETUP_HOME: home, XDG_CONFIG_HOME: configRoot };
    await runSetup(['--client', 'opencode'], env);
    const openCode = JSON.parse(readFileSync(openCodePath, 'utf8')) as {
      mcp: { servers?: unknown; 'android-device': { type: string; enabled: boolean } };
    };
    assert.equal(openCode.mcp.servers, undefined);
    assert.equal(openCode.mcp['android-device'].type, 'local');
    assert.equal(openCode.mcp['android-device'].enabled, true);

    await runSetup(['--client', 'goose'], env);
    const goose = readFileSync(goosePath, 'utf8');
    assert.match(goose, /extensions:/u);
    assert.match(goose, /android-device:/u);
    assert.match(goose, /type: stdio/u);
    assert.equal(existsSync(`${goosePath}.android-agent-mcp.bak`), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dry-run never creates a host configuration file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'android-agent-dry-run-'));
  try {
    await runSetup(['--client', 'claude', '--dry-run'], {
      ...process.env,
      ANDROID_AGENT_MCP_SETUP_HOME: home,
    });
    assert.equal(existsSync(join(home, '.claude.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
