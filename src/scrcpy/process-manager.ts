import { spawn, type ChildProcess } from 'node:child_process';
import { kill } from 'node:process';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { redactLogText } from '../policy/redaction.js';
import { validateSerial } from '../validation/common.js';
import type { CommandRunner } from '../adb/client.js';
import {
  buildScrcpyArgs,
  detectScrcpyCapabilities,
  type ScrcpyCapabilities,
  type ScrcpyStartOptions,
} from './capabilities.js';

interface OwnedScrcpy {
  child: ChildProcess;
  pid: number;
  serial: string;
  args: string[];
  startedAt: string;
  stderr: string;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
  detached: boolean;
}

export interface ScrcpyStatus {
  owned: boolean;
  running: boolean;
  pid: number | null;
  deviceSerial: string | null;
  args: string[];
  startedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  diagnostic: string;
  diagnosticTruncated: boolean;
  capabilities: ScrcpyCapabilities | null;
  detached: boolean;
}

const MIRROR_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
] as const;

function environment(): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of MIRROR_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function isRunning(owner: OwnedScrcpy | null): owner is OwnedScrcpy {
  return owner !== null && owner.exitCode === null && owner.signal === null && owner.spawnError === null;
}

function terminate(owner: OwnedScrcpy): void {
  try {
    if (process.platform === 'win32') owner.child.kill('SIGTERM');
    else kill(-owner.pid, 'SIGTERM');
  } catch {
    try {
      owner.child.kill('SIGTERM');
    } catch {
      // The process already exited.
    }
  }
}

function forceTerminate(owner: OwnedScrcpy): void {
  try {
    if (process.platform === 'win32') owner.child.kill('SIGKILL');
    else kill(-owner.pid, 'SIGKILL');
  } catch {
    try {
      owner.child.kill('SIGKILL');
    } catch {
      // The process already exited.
    }
  }
}

export class ScrcpyProcessManager {
  private owner: OwnedScrcpy | null = null;
  private capabilities: ScrcpyCapabilities | null = null;

  constructor(
    private readonly scrcpyPath: string,
    private readonly leaveRunningOnExit: boolean,
    private readonly runner?: CommandRunner,
  ) {}

  async start(serial: string, options: ScrcpyStartOptions): Promise<{ alreadyRunning: boolean; status: ScrcpyStatus }> {
    validateSerial(serial);
    if (isRunning(this.owner)) return { alreadyRunning: true, status: this.status() };
    this.capabilities = await detectScrcpyCapabilities(this.scrcpyPath, this.runner?.run);
    const args = buildScrcpyArgs(serial, options, this.capabilities);
    const child = spawn(this.scrcpyPath, args, {
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      env: environment(),
    });
    if (child.pid === undefined) {
      throw new AppError(ErrorCode.CommandFailed, 'scrcpy process did not expose a PID.');
    }
    const owner: OwnedScrcpy = {
      child,
      pid: child.pid,
      serial,
      args,
      startedAt: new Date().toISOString(),
      stderr: '',
      stderrTruncated: false,
      exitCode: null,
      signal: null,
      spawnError: null,
      detached: false,
    };
    this.owner = owner;
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = owner.stderr + chunk.toString('utf8');
      if (Buffer.byteLength(next) > 32_000) {
        owner.stderr = next.slice(-32_000);
        owner.stderrTruncated = true;
      } else {
        owner.stderr = next;
      }
    });
    child.once('error', (error) => {
      owner.spawnError = error instanceof Error ? error.message : String(error);
    });
    child.once('close', (exitCode, signal) => {
      owner.exitCode = exitCode;
      owner.signal = signal;
    });
    return { alreadyRunning: false, status: this.status() };
  }

  status(): ScrcpyStatus {
    const owner = this.owner;
    return {
      owned: owner !== null,
      running: isRunning(owner),
      pid: owner?.pid ?? null,
      deviceSerial: owner?.serial ?? null,
      args: owner === undefined || owner === null ? [] : [...owner.args],
      startedAt: owner?.startedAt ?? null,
      exitCode: owner?.exitCode ?? null,
      signal: owner?.signal ?? null,
      diagnostic: owner === null ? '' : redactLogText(owner.spawnError ?? owner.stderr).slice(-32_000),
      diagnosticTruncated: owner?.stderrTruncated ?? false,
      capabilities: this.capabilities,
      detached: owner?.detached ?? false,
    };
  }

  markDetached(serial: string): void {
    if (this.owner?.serial === serial && isRunning(this.owner)) this.owner.detached = true;
  }

  async stop(): Promise<ScrcpyStatus> {
    const owner = this.owner;
    if (!isRunning(owner)) return this.status();
    terminate(owner);
    const deadline = Date.now() + 2_000;
    while (isRunning(owner) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (isRunning(owner)) forceTerminate(owner);
    return this.status();
  }

  async dispose(): Promise<void> {
    if (!this.leaveRunningOnExit) await this.stop();
  }
}
