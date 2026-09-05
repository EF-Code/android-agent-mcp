import { spawn } from 'node:child_process';
import { kill } from 'node:process';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { redactCommandArgs, redactLogText } from '../policy/redaction.js';
import type { CommandOutput, CommandRecord } from '../types.js';

const SAFE_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  captureDurationMs?: number;
  signal?: AbortSignal;
  secretArgIndexes?: ReadonlySet<number>;
  env?: Record<string, string | undefined>;
  environmentKeys?: readonly string[];
}

function selectEnvironment(options: RunOptions): NodeJS.ProcessEnv {
  const keys = options.environmentKeys ?? SAFE_ENVIRONMENT_KEYS;
  const environment: NodeJS.ProcessEnv = {};

  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }

  return environment;
}

function terminateChild(child: ReturnType<typeof spawn>): NodeJS.Timeout | undefined {
  if (child.pid === undefined) return undefined;

  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // The process may have exited between the checks.
    }
  }

  const forceTimer = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else kill(-child.pid!, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited between the checks.
      }
    }
  }, 500);
  forceTimer.unref();
  return forceTimer;
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: RunOptions,
): Promise<CommandOutput> {
  if (options.timeoutMs < 50 || options.timeoutMs > 120_000) {
    throw new AppError(ErrorCode.InvalidInput, 'Command timeout is outside the safe range.');
  }
  if (options.maxOutputBytes < 1_024 || options.maxOutputBytes > 100_000_000) {
    throw new AppError(ErrorCode.InvalidInput, 'Command output limit is outside the safe range.');
  }
  if (
    options.captureDurationMs !== undefined &&
    (options.captureDurationMs < 0 || options.captureDurationMs > 120_000)
  ) {
    throw new AppError(ErrorCode.InvalidInput, 'Capture duration is outside the safe range.');
  }
  if (options.signal?.aborted) {
    throw new AppError(ErrorCode.CommandTimeout, 'Command was aborted before it started.', {
      retryable: true,
    });
  }

  const startedAt = performance.now();
  const child = spawn(executable, [...args], {
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: selectEnvironment(options),
  });

  const stdoutParts: Buffer[] = [];
  const stderrParts: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutStoredBytes = 0;
  let stderrStoredBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let failure: AppError | undefined;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let captureTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let captureEnded = false;

  const stopChild = (): void => {
    forceTimer ??= terminateChild(child);
  };

  const record = (exitCode: number | null, signal: NodeJS.Signals | null): CommandRecord => ({
    executable,
    args: redactCommandArgs([...args], options.secretArgIndexes),
    exitCode,
    signal,
    durationMs: Math.round(performance.now() - startedAt),
    stdoutBytes,
    stderrBytes,
    stdoutTruncated,
    stderrTruncated,
  });

  const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (target === 'stdout') {
      stdoutBytes += chunk.length;
      if (stdoutStoredBytes < options.maxOutputBytes) {
        const remaining = options.maxOutputBytes - stdoutStoredBytes;
        stdoutParts.push(chunk.subarray(0, remaining));
        stdoutStoredBytes += Math.min(chunk.length, remaining);
      }
      if (stdoutBytes > options.maxOutputBytes) stdoutTruncated = true;
    } else {
      stderrBytes += chunk.length;
      if (stderrStoredBytes < options.maxOutputBytes) {
        const remaining = options.maxOutputBytes - stderrStoredBytes;
        stderrParts.push(chunk.subarray(0, remaining));
        stderrStoredBytes += Math.min(chunk.length, remaining);
      }
      if (stderrBytes > options.maxOutputBytes) stderrTruncated = true;
    }

    if (stdoutTruncated || stderrTruncated) {
      failure ??= new AppError(
        ErrorCode.CommandOutputLimit,
        'Command output exceeded the configured limit.',
        {
          retryable: true,
          details: { maxOutputBytes: options.maxOutputBytes },
        },
      );
      stopChild();
    }
  };

  const abortListener = (): void => {
    failure ??= new AppError(ErrorCode.CommandTimeout, 'Command was aborted.', { retryable: true });
    stopChild();
  };

  options.signal?.addEventListener('abort', abortListener, { once: true });

  return await new Promise<CommandOutput>((resolve, reject) => {
    timeout = setTimeout(() => {
      failure ??= new AppError(ErrorCode.CommandTimeout, 'Command timed out.', {
        retryable: true,
        details: { timeoutMs: options.timeoutMs },
      });
      stopChild();
    }, options.timeoutMs);
    if (options.captureDurationMs !== undefined) {
      captureTimer = setTimeout(() => {
        captureEnded = true;
        stopChild();
      }, options.captureDurationMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        failure ??= new AppError(
          ErrorCode.ExecutableNotFound,
          `Executable was not found: ${executable}`,
          {
            details: { executable },
          },
        );
      } else {
        failure ??= new AppError(
          ErrorCode.CommandFailed,
          `Unable to start executable: ${executable}`,
          {
            details: { executable },
            cause: error,
          },
        );
      }
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (captureTimer !== undefined) clearTimeout(captureTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abortListener);
      const commandRecord = record(exitCode, signal);

      if (failure !== undefined) {
        failure = new AppError(failure.code, failure.message, {
          retryable: failure.retryable,
          details: {
            ...failure.details,
            command: commandRecord,
            stderr: redactLogText(Buffer.concat(stderrParts).toString('utf8').slice(-4_000)),
          },
          cause: failure,
        });
        reject(failure);
        return;
      }

      if (exitCode !== 0 && !captureEnded) {
        reject(
          new AppError(
            ErrorCode.CommandFailed,
            `Command exited with code ${exitCode ?? 'unknown'}.`,
            {
              retryable: false,
              details: {
                command: commandRecord,
                stderr: redactLogText(Buffer.concat(stderrParts).toString('utf8').slice(-4_000)),
              },
            },
          ),
        );
        return;
      }

      resolve({
        stdout: Buffer.concat(stdoutParts),
        stderr: Buffer.concat(stderrParts),
        record: commandRecord,
      });
    });
  });
}
