import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument, stringify } from 'yaml';

export const SETUP_CLIENTS = [
  'codex',
  'claude',
  'openclaw',
  'antigravity',
  'gemini',
  'opencode',
  'cursor',
  'windsurf',
  'vscode',
  'pi',
  'cline',
  'zed',
  'goose',
] as const;

export type SetupClient = (typeof SETUP_CLIENTS)[number];

type SetupRequest = 'auto' | 'all' | 'generic' | SetupClient;

export type SetupServerConfig = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type SetupPlan = {
  clients: SetupClient[];
  configPaths: Record<SetupClient, string>;
  entrypoint: string;
  projectRoot: string;
  server: SetupServerConfig;
};

type SetupPlanOptions = {
  commandAvailability?: Partial<Record<SetupClient, boolean>>;
  configPath?: string;
  entrypoint?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  projectRoot?: string;
  requestedClient?: SetupRequest;
};

type SetupOptions = {
  configPath?: string;
  dryRun: boolean;
  help: boolean;
  requestedClient: SetupRequest;
};

type JsonObject = Record<string, unknown>;

const PACKAGE_NAME = 'android-agent-mcp';
const SERVER_NAME = 'android-device';
const CONFIG_ENV_NAME = 'ANDROID_AGENT_MCP_CONFIG';

export function createStdioServerConfig(
  entrypoint: string,
  projectRoot: string,
  configPath?: string,
  platform: NodeJS.Platform = process.platform,
): SetupServerConfig {
  const env = configPath?.trim() ? { [CONFIG_ENV_NAME]: resolve(configPath) } : {};

  if (isNpxEntrypoint(entrypoint)) {
    return {
      command: platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--yes', `${PACKAGE_NAME}@${readPackageVersion(projectRoot, entrypoint) ?? 'latest'}`],
      cwd: process.cwd(),
      env,
    };
  }

  if (isInstalledPackageEntrypoint(entrypoint)) {
    return {
      command: platform === 'win32' ? `${PACKAGE_NAME}.cmd` : PACKAGE_NAME,
      args: [],
      cwd: process.cwd(),
      env,
    };
  }

  return {
    command: process.execPath,
    args: [entrypoint],
    cwd: projectRoot,
    env,
  };
}

export function buildSetupPlan(options: SetupPlanOptions = {}): SetupPlan {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const setupHome = resolve(options.home ?? setupHomeFromEnvironment(env));
  const entrypoint = normalizeEntrypoint(
    resolve(
      options.entrypoint ??
        process.argv[1] ??
        fileURLToPath(new URL('./index.js', import.meta.url)),
    ),
  );
  const projectRoot = resolve(
    options.projectRoot ?? findPackageRoot(entrypoint) ?? dirname(dirname(entrypoint)),
  );
  const configPath =
    options.configPath ??
    firstEnvironmentValue(env, CONFIG_ENV_NAME, 'ANDROID_MCP_CONFIG', 'ANDROID_DEVICE_MCP_CONFIG');
  const requestedClient = options.requestedClient ?? 'auto';

  return {
    clients: selectClients(requestedClient, options.commandAvailability),
    configPaths: getConfigPaths(setupHome, platform, env),
    entrypoint,
    projectRoot,
    server: createStdioServerConfig(entrypoint, projectRoot, configPath, platform),
  };
}

export function renderCodexConfig(server: SetupServerConfig): string {
  const lines = [
    '# Added by android-agent-mcp setup.',
    '[mcp_servers.android-device]',
    `command = ${tomlString(server.command)}`,
    `args = ${tomlArray(server.args)}`,
    `cwd = ${tomlString(server.cwd)}`,
  ];
  if (Object.keys(server.env).length > 0) {
    lines.push('', '[mcp_servers.android-device.env]');
    for (const [key, value] of Object.entries(server.env)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderClaudeConfig(server: SetupServerConfig): JsonObject {
  return { type: 'stdio', command: server.command, args: server.args, env: server.env };
}

export function renderOpenClawConfig(server: SetupServerConfig): JsonObject {
  return { command: server.command, args: server.args, cwd: server.cwd, env: server.env };
}

export function renderAntigravityConfig(server: SetupServerConfig): JsonObject {
  return renderOpenClawConfig(server);
}

export function renderStandardStdioConfig(server: SetupServerConfig): JsonObject {
  return { command: server.command, args: server.args, env: server.env };
}

export function renderOpenCodeConfig(server: SetupServerConfig): JsonObject {
  return {
    type: 'local',
    command: [server.command, ...server.args],
    cwd: server.cwd,
    environment: server.env,
    enabled: true,
  };
}

export function renderVsCodeConfig(server: SetupServerConfig): JsonObject {
  return { type: 'stdio', command: server.command, args: server.args, env: server.env };
}

export function renderPiConfig(server: SetupServerConfig): JsonObject {
  return {
    command: server.command,
    args: server.args,
    transport: 'stdio',
    lifecycle: 'lazy',
    env: server.env,
  };
}

export function renderClineConfig(server: SetupServerConfig): JsonObject {
  return {
    command: server.command,
    args: server.args,
    env: server.env,
    transportType: 'stdio',
  };
}

export function renderZedConfig(server: SetupServerConfig): JsonObject {
  return renderStandardStdioConfig(server);
}

export function renderGooseConfig(server: SetupServerConfig): JsonObject {
  return {
    name: SERVER_NAME,
    type: 'stdio',
    enabled: true,
    cmd: server.command,
    args: server.args,
    envs: server.env,
    timeout: 300,
  };
}

export function parseSetupOptions(args: readonly string[]): SetupOptions {
  let requestedClient: SetupRequest = 'auto';
  let configPath: string | undefined;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--client') {
      const value = args[index + 1];
      if (!value) throw new Error('--client requires a value.');
      requestedClient = parseSetupRequest(value);
      index += 1;
      continue;
    }
    if (argument === '--config' || argument === '--config-path') {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a path.`);
      configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown setup option: ${argument}`);
  }

  return {
    requestedClient,
    dryRun,
    help,
    ...(configPath === undefined ? {} : { configPath }),
  };
}

export async function runSetup(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseSetupOptions(args);
  if (options.help) {
    printSetupHelp();
    return;
  }

  const plan = buildSetupPlan({
    requestedClient: options.requestedClient,
    env,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  printSetupHeader(plan, options.dryRun);

  if (plan.clients.length === 0) {
    printGenericConfig(plan);
    return;
  }
  if (options.dryRun) {
    printDryRunConfigs(plan);
    return;
  }

  const failures: string[] = [];
  for (const client of plan.clients) {
    try {
      configureClient(client, plan);
      printLine(`Configured ${clientLabel(client)}.`);
      printClientNote(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      failures.push(`${client}: ${message}`);
      printLine(`Could not configure ${client}: ${message}`);
    }
  }

  printLine('');
  printLine('Restart the configured agent or harness so it reloads its MCP servers.');
  if (plan.clients.length > 1) {
    printLine(
      'Several hosts were configured. Each host should launch its own Android Agent MCP process, or use one shared process only when you deliberately manage that lifecycle.',
    );
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
}

export function runDoctor(): void {
  const plan = buildSetupPlan();
  printLine('android-agent-mcp doctor');
  printLine(`Node: ${process.version}`);
  printLine(`Entrypoint: ${plan.entrypoint}`);
  printLine(
    plan.clients.length > 0
      ? `Detected hosts: ${plan.clients.map(clientLabel).join(', ')}`
      : 'Detected hosts: none',
  );
  printLine('Run `android-agent-mcp setup` to configure detected hosts.');
}

export function printSetupHelp(): void {
  printLine('Usage: android-agent-mcp setup [options]');
  printLine('');
  printLine('Configure detected MCP hosts for local Android Agent MCP stdio use.');
  printLine('');
  printLine('Options:');
  printLine('  --client VALUE                                      Host to configure');
  printLine(
    `                                                     auto, all, generic, or: ${SETUP_CLIENTS.join(', ')}`,
  );
  printLine(
    '  --config PATH                                      Optional Android Agent MCP JSON config',
  );
  printLine(
    '  --dry-run                                          Print changes without writing files',
  );
  printLine('  --help                                             Show this help');
}

function setupHomeFromEnvironment(env: NodeJS.ProcessEnv): string {
  const configured = env.ANDROID_AGENT_MCP_SETUP_HOME?.trim();
  return configured || homedir();
}

function firstEnvironmentValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function getConfigPaths(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Record<SetupClient, string> {
  const configRoot =
    platform === 'win32'
      ? env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  const vscodeConfigRoot =
    platform === 'darwin' ? join(home, 'Library', 'Application Support') : configRoot;
  const gooseConfigRoot =
    platform === 'win32'
      ? join(env.APPDATA?.trim() || join(home, 'AppData', 'Roaming'), 'Block', 'goose', 'config')
      : join(configRoot, 'goose');
  const clineDataRoot = env.CLINE_DATA_DIR?.trim() || join(home, '.cline', 'data');

  return {
    codex: join(home, '.codex', 'config.toml'),
    claude: join(home, '.claude.json'),
    openclaw: join(home, '.openclaw', 'openclaw.json'),
    antigravity: join(home, '.gemini', 'config', 'mcp_config.json'),
    gemini: join(home, '.gemini', 'settings.json'),
    opencode: join(configRoot, 'opencode', 'opencode.json'),
    cursor: join(home, '.cursor', 'mcp.json'),
    windsurf: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    vscode: join(vscodeConfigRoot, 'Code', 'User', 'mcp.json'),
    pi: join(home, '.pi', 'agent', 'mcp.json'),
    cline: join(clineDataRoot, 'settings', 'cline_mcp_settings.json'),
    zed: join(configRoot, 'zed', 'settings.json'),
    goose: join(gooseConfigRoot, 'config.yaml'),
  };
}

function selectClients(
  requestedClient: SetupRequest,
  commandAvailability?: Partial<Record<SetupClient, boolean>>,
): SetupClient[] {
  if (requestedClient === 'all') return [...SETUP_CLIENTS];
  if (requestedClient === 'generic') return [];
  if (requestedClient !== 'auto') return [requestedClient];

  return SETUP_CLIENTS.filter((client) => {
    const explicitlyAvailable = commandAvailability?.[client];
    if (explicitlyAvailable !== undefined) return explicitlyAvailable;
    return clientCommandAvailable(client);
  });
}

function clientLabel(client: SetupClient): string {
  return {
    codex: 'Codex',
    claude: 'Claude Code',
    openclaw: 'OpenClaw',
    antigravity: 'Antigravity',
    gemini: 'Gemini CLI',
    opencode: 'OpenCode',
    cursor: 'Cursor',
    windsurf: 'Windsurf',
    vscode: 'VS Code',
    pi: 'Pi',
    cline: 'Cline',
    zed: 'Zed',
    goose: 'Goose',
  }[client];
}

function clientCommands(client: SetupClient): string[] {
  return {
    codex: ['codex'],
    claude: ['claude'],
    openclaw: ['openclaw'],
    antigravity: ['antigravity', 'agy'],
    gemini: ['gemini'],
    opencode: ['opencode'],
    cursor: ['cursor', 'cursor-agent'],
    windsurf: ['windsurf'],
    vscode: ['code', 'code-insiders'],
    pi: ['pi'],
    cline: ['cline'],
    zed: ['zed'],
    goose: ['goose'],
  }[client];
}

function clientCommandAvailable(client: SetupClient): boolean {
  return clientCommands(client).some((command) => executableOnPath(command));
}

function executableOnPath(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function configureClient(client: SetupClient, plan: SetupPlan): void {
  switch (client) {
    case 'codex':
      writeCodexConfig(plan.configPaths.codex, plan.server);
      return;
    case 'claude':
      updateJsonConfig(
        plan.configPaths.claude,
        ['mcpServers', SERVER_NAME],
        renderClaudeConfig(plan.server),
      );
      return;
    case 'openclaw':
      configureOpenClaw(plan);
      return;
    case 'antigravity':
      updateJsonConfig(
        plan.configPaths.antigravity,
        ['mcpServers', SERVER_NAME],
        renderAntigravityConfig(plan.server),
      );
      return;
    case 'gemini':
      updateJsonConfig(
        plan.configPaths.gemini,
        ['mcpServers', SERVER_NAME],
        renderStandardStdioConfig(plan.server),
      );
      return;
    case 'opencode':
      configureOpenCode(plan);
      return;
    case 'cursor':
    case 'windsurf':
    case 'pi':
      updateJsonConfig(
        plan.configPaths[client],
        ['mcpServers', SERVER_NAME],
        client === 'pi' ? renderPiConfig(plan.server) : renderStandardStdioConfig(plan.server),
      );
      return;
    case 'vscode':
      configureVsCode(plan);
      return;
    case 'cline':
      updateJsonConfig(
        plan.configPaths.cline,
        ['mcpServers', SERVER_NAME],
        renderClineConfig(plan.server),
      );
      return;
    case 'zed':
      updateJsonConfig(
        plan.configPaths.zed,
        ['context_servers', SERVER_NAME],
        renderZedConfig(plan.server),
      );
      return;
    case 'goose':
      updateYamlConfig(
        plan.configPaths.goose,
        ['extensions', SERVER_NAME],
        renderGooseConfig(plan.server),
      );
      return;
  }
}

function configureOpenCode(plan: SetupPlan): void {
  const path = plan.configPaths.opencode;
  const root = readJsonObject(path);
  const existingMcp = root.mcp;
  if (existingMcp !== undefined && !isJsonObject(existingMcp)) {
    throw new Error(`${path} has a non-object mcp value.`);
  }
  const mcp = existingMcp ?? {};
  const existingServers = mcp.servers;
  if (existingServers !== undefined) {
    if (!isJsonObject(existingServers)) {
      throw new Error(`${path} has a non-object mcp.servers value.`);
    }
    const otherServers = Object.keys(existingServers).filter((name) => name !== SERVER_NAME);
    if (otherServers.length > 0) {
      throw new Error(
        `${path} uses OpenCode's legacy mcp.servers format for other servers; migrate those entries before running setup.`,
      );
    }
    delete mcp.servers;
  }
  mcp[SERVER_NAME] = renderOpenCodeConfig(plan.server);
  root.mcp = mcp;
  writeTextFile(path, `${JSON.stringify(root, null, 2)}\n`);
}

function configureVsCode(plan: SetupPlan): void {
  const command = ['code', 'code-insiders'].find((candidate) => executableOnPath(candidate));
  if (command) {
    try {
      execFileSync(
        command,
        ['--add-mcp', JSON.stringify({ name: SERVER_NAME, ...renderVsCodeConfig(plan.server) })],
        { stdio: 'ignore' },
      );
      return;
    } catch {
      // Fall back to the documented user mcp.json location below.
    }
  }
  updateJsonConfig(
    plan.configPaths.vscode,
    ['servers', SERVER_NAME],
    renderVsCodeConfig(plan.server),
  );
}

function configureOpenClaw(plan: SetupPlan): void {
  const config = renderOpenClawConfig(plan.server);
  if (executableOnPath('openclaw')) {
    execFileSync('openclaw', ['mcp', 'set', SERVER_NAME, JSON.stringify(config)], {
      stdio: 'ignore',
    });
    return;
  }
  updateJsonConfig(plan.configPaths.openclaw, ['mcp', 'servers', SERVER_NAME], config);
}

function writeCodexConfig(path: string, server: SetupServerConfig): void {
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeTextFile(
    path,
    upsertTomlTable(source, 'mcp_servers.android-device', renderCodexConfig(server)),
  );
}

function upsertTomlTable(source: string, tableName: string, replacement: string): string {
  const lines = source.split(/\r?\n/u);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line)?.[1];
    if (header !== undefined) {
      skipping = header === tableName || header.startsWith(`${tableName}.`);
      if (!skipping) kept.push(line);
      continue;
    }
    if (!skipping) kept.push(line);
  }

  const prefix = kept.join('\n').replace(/\n*$/u, '');
  return `${prefix ? `${prefix}\n\n` : ''}${replacement}`;
}

function updateJsonConfig(path: string, segments: string[], value: JsonObject): void {
  const root = readJsonObject(path);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (existing === undefined) {
      const child: JsonObject = {};
      current[segment] = child;
      current = child;
    } else if (isJsonObject(existing)) {
      current = existing;
    } else {
      throw new Error(`${path} has a non-object ${segment} value.`);
    }
  }
  const finalSegment = segments.at(-1);
  if (!finalSegment) throw new Error('A JSON configuration path is required.');
  current[finalSegment] = value;
  writeTextFile(path, `${JSON.stringify(root, null, 2)}\n`);
}

function updateYamlConfig(path: string, segments: string[], value: JsonObject): void {
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const document = parseDocument(source || '{}\n');
  if (document.errors.length > 0) {
    throw new Error(
      `${path} is not valid YAML; use Goose's configuration screen to add android-device.`,
    );
  }
  document.setIn(segments, value);
  writeTextFile(path, document.toString());
}

function readJsonObject(path: string): JsonObject {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `${path} is not plain JSON; use the host's MCP command to add android-device.`,
      { cause: error },
    );
  }
  if (!isJsonObject(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  backupConfigOnce(path);
  const existingMode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: existingMode });
  renameSync(temporaryPath, path);
  chmodSync(path, existingMode);
}

function backupConfigOnce(path: string): void {
  if (!existsSync(path)) return;
  const backupPath = `${path}.android-agent-mcp.bak`;
  if (!existsSync(backupPath)) copyFileSync(path, backupPath);
}

function printSetupHeader(plan: SetupPlan, dryRun: boolean): void {
  printLine(`android-agent-mcp ${dryRun ? 'setup preview' : 'setup'}`);
  printLine(
    plan.clients.length > 0
      ? `Hosts: ${plan.clients.map(clientLabel).join(', ')}`
      : 'Hosts: none will be configured; printing a generic MCP config',
  );
  printLine('');
}

function printDryRunConfigs(plan: SetupPlan): void {
  for (const client of plan.clients) {
    printLine(`--- ${client}: ${plan.configPaths[client]} ---`);
    if (client === 'codex') {
      printLine(renderCodexConfig(plan.server));
    } else if (client === 'goose') {
      printLine(
        `extensions:\n  ${SERVER_NAME}:\n${indentText(toYaml(renderGooseConfig(plan.server)), 4)}`,
      );
    } else {
      printLine(JSON.stringify(renderClientConfig(client, plan.server), null, 2));
    }
  }
}

function renderClientConfig(
  client: Exclude<SetupClient, 'codex' | 'goose'>,
  server: SetupServerConfig,
): JsonObject {
  switch (client) {
    case 'claude':
      return renderClaudeConfig(server);
    case 'openclaw':
      return renderOpenClawConfig(server);
    case 'antigravity':
      return renderAntigravityConfig(server);
    case 'gemini':
    case 'cursor':
    case 'windsurf':
      return renderStandardStdioConfig(server);
    case 'opencode':
      return renderOpenCodeConfig(server);
    case 'vscode':
      return renderVsCodeConfig(server);
    case 'pi':
      return renderPiConfig(server);
    case 'cline':
      return renderClineConfig(server);
    case 'zed':
      return renderZedConfig(server);
  }
  throw new Error(`Unsupported setup client: ${client}`);
}

function printGenericConfig(plan: SetupPlan): void {
  printLine('No host will be configured. Add this MCP server manually:');
  printLine(
    JSON.stringify(
      {
        mcpServers: {
          [SERVER_NAME]: {
            command: plan.server.command,
            args: plan.server.args,
            cwd: plan.server.cwd,
            env: plan.server.env,
          },
        },
      },
      null,
      2,
    ),
  );
}

function printClientNote(client: SetupClient): void {
  if (client === 'pi') {
    printLine(
      'Pi note: install `pi install npm:pi-mcp-extension` if Pi does not already have MCP support enabled.',
    );
  }
  if (client === 'goose') {
    printLine('Goose exposes this MCP server as a stdio extension.');
  }
}

function toYaml(value: JsonObject): string {
  return stringify(value).trimEnd();
}

function indentText(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function printLine(value = ''): void {
  process.stdout.write(`${value}\n`);
}

function parseSetupRequest(value: string): SetupRequest {
  if (
    value === 'auto' ||
    value === 'all' ||
    value === 'generic' ||
    SETUP_CLIENTS.includes(value as SetupClient)
  ) {
    return value as SetupRequest;
  }
  throw new Error(`--client must be auto, all, generic, ${SETUP_CLIENTS.join(', ')}.`);
}

function isNpxEntrypoint(entrypoint: string): boolean {
  const normalized = entrypoint.replaceAll('\\', '/');
  return (
    normalized.includes('/.npm/_npx/') ||
    normalized.includes('/node_modules/.bin/android-agent-mcp')
  );
}

function isInstalledPackageEntrypoint(entrypoint: string): boolean {
  const normalized = entrypoint.replaceAll('\\', '/');
  return normalized.includes(`/node_modules/${PACKAGE_NAME}/`);
}

function normalizeEntrypoint(entrypoint: string): string {
  try {
    return realpathSync(entrypoint);
  } catch {
    return entrypoint;
  }
}

function findPackageRoot(entrypoint: string): string | undefined {
  let current = dirname(resolve(entrypoint));
  while (true) {
    const manifestPath = join(current, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
        if (isJsonObject(parsed) && parsed.name === PACKAGE_NAME) return current;
      } catch {
        // Continue walking when an unrelated or incomplete manifest is encountered.
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readPackageVersion(projectRoot: string, entrypoint: string): string | undefined {
  const roots = [projectRoot, findPackageRoot(entrypoint)].filter(
    (value, index, values): value is string =>
      value !== undefined && values.indexOf(value) === index,
  );
  for (const root of roots) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown;
      if (isJsonObject(parsed) && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // A source checkout or unusual launcher may not have a readable manifest.
    }
  }
  return undefined;
}
