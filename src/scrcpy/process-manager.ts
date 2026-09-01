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
import { ScrcpyFrameStream, type StreamedFrame } from './frame-stream.js';

interface OwnedScrcpy {
  child: ChildProcess;
  pid: number;
  serial: string;
  args: string[];
  requestedArgs: string[];
  startedAt: string;
  stderr: string;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
  detached: boolean;
  frameStream: ScrcpyFrameStream | null;
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
  fastFrames: boolean;
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
  return (
    owner !== null && owner.exitCode === null && owner.signal === null && owner.spawnError === null
  );
}

function sameArguments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

  async start(
    serial: string,
    options: ScrcpyStartOptions,
  ): Promise<{ alreadyRunning: boolean; status: ScrcpyStatus }> {
    validateSerial(serial);
    const capabilities =
      this.capabilities ?? (await detectScrcpyCapabilities(this.scrcpyPath, this.runner?.run));
    const args = buildScrcpyArgs(serial, options, capabilities);
    if (isRunning(this.owner)) {
      if (this.owner.serial === serial && sameArguments(this.owner.requestedArgs, args)) {
        return { alreadyRunning: true, status: this.status() };
      }
      await this.stop();
    }
    this.capabilities = capabilities;
    let frameStream: ScrcpyFrameStream | null = null;
    if (this.runner === undefined && !this.leaveRunningOnExit && process.platform !== 'win32') {
      try {
        frameStream = new ScrcpyFrameStream();
        frameStream.start();
        args.push(
          '--record',
          frameStream.pipePath,
          '--record-format',
          'mkv',
          '--video-buffer',
          '0',
        );
      } catch {
        frameStream?.dispose();
        frameStream = null;
      }
    }
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
      requestedArgs: buildScrcpyArgs(serial, options, capabilities),
      startedAt: new Date().toISOString(),
      stderr: '',
      stderrTruncated: false,
      exitCode: null,
      signal: null,
      spawnError: null,
      detached: false,
      frameStream,
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
      owner.frameStream?.dispose();
      owner.frameStream = null;
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
      diagnostic:
        owner === null ? '' : redactLogText(owner.spawnError ?? owner.stderr).slice(-32_000),
      diagnosticTruncated: owner?.stderrTruncated ?? false,
      capabilities: this.capabilities,
      detached: owner?.detached ?? false,
      fastFrames: owner?.frameStream?.current() !== null,
    };
  }

  markDetached(serial: string): void {
    if (this.owner?.serial === serial && isRunning(this.owner)) this.owner.detached = true;
  }

  latestFrame(): StreamedFrame | null {
    return this.owner?.frameStream?.current() ?? null;
  }

  async waitForFrame(afterSequence: number, timeoutMs = 1_000): Promise<StreamedFrame | null> {
    return (await this.owner?.frameStream?.waitForFrame(afterSequence, timeoutMs)) ?? null;
  }

  async stop(): Promise<ScrcpyStatus> {
    const owner = this.owner;
    if (owner === null) return this.status();
    if (owner.exitCode !== null || owner.signal !== null || owner.spawnError !== null) {
      owner.frameStream?.dispose();
      owner.frameStream = null;
      return this.status();
    }
    terminate(owner);
    const deadline = Date.now() + 2_000;
    while (isRunning(owner) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (isRunning(owner)) forceTerminate(owner);
    owner.frameStream?.dispose();
    owner.frameStream = null;
    return this.status();
  }

  async dispose(): Promise<void> {
    if (!this.leaveRunningOnExit) await this.stop();
  }
}
