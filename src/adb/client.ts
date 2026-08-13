import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { runCommand, type RunOptions } from '../process/runner.js';
import { validateSerial } from '../validation/common.js';
import type { CommandOutput } from '../types.js';

export interface CommandRunner {
  run(executable: string, args: readonly string[], options: RunOptions): Promise<CommandOutput>;
}

export interface AdbClientOptions {
  adbPath: string;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  runner?: CommandRunner;
}

export class AdbClient {
  private readonly runner: CommandRunner;

  constructor(private readonly options: AdbClientOptions) {
    this.runner = options.runner ?? { run: runCommand };
  }

  async host(args: readonly string[], options: Partial<RunOptions> = {}): Promise<CommandOutput> {
    const runOptions: RunOptions = {
      timeoutMs: options.timeoutMs ?? this.options.defaultTimeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? this.options.maxOutputBytes,
    };
    if (options.signal !== undefined) runOptions.signal = options.signal;
    if (options.secretArgIndexes !== undefined) runOptions.secretArgIndexes = options.secretArgIndexes;
    if (options.env !== undefined) runOptions.env = options.env;
    if (options.environmentKeys !== undefined) runOptions.environmentKeys = options.environmentKeys;
    if (options.captureDurationMs !== undefined) runOptions.captureDurationMs = options.captureDurationMs;
    return this.runner.run(this.options.adbPath, args, runOptions);
  }

  async device(serial: string, args: readonly string[], options: Partial<RunOptions> = {}): Promise<CommandOutput> {
    validateSerial(serial);
    return this.host(['-s', serial, ...args], options);
  }

  async shell(serial: string, args: readonly string[], options: Partial<RunOptions> = {}): Promise<CommandOutput> {
    if (args.length === 0) {
      throw new AppError(ErrorCode.InvalidInput, 'ADB shell argument list must not be empty.');
    }
    return this.device(serial, ['shell', ...args], options);
  }

  async text(output: Promise<CommandOutput>): Promise<string> {
    return (await output).stdout.toString('utf8').replace(/\r\n/g, '\n');
  }

  async version(): Promise<string> {
    return this.text(this.host(['version'], { timeoutMs: 5_000, maxOutputBytes: 32_000 }));
  }
}
