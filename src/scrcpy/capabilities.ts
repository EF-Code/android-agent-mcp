import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { runCommand, type RunOptions } from '../process/runner.js';

export interface ScrcpyCapabilities {
  version: string;
  major: number;
  minor: number;
  supportsNoAudio: boolean;
  supportsNoControl: boolean;
  supportsTurnScreenOff: boolean;
  supportsStayAwake: boolean;
}

function parseVersion(output: string): { version: string; major: number; minor: number } {
  const match = /scrcpy\s+(\d+)\.(\d+)(?:\.(\d+))?/iu.exec(output);
  if (match === null) throw new AppError(ErrorCode.ScrcpyNotFound, 'Unable to determine the installed scrcpy version.');
  return {
    version: `${match[1]}.${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`,
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

export async function detectScrcpyCapabilities(
  scrcpyPath: string,
  runner: (executable: string, args: readonly string[], options: RunOptions) => ReturnType<typeof runCommand> = runCommand,
): Promise<ScrcpyCapabilities> {
  let output;
  try {
    output = await runner(scrcpyPath, ['--version'], { timeoutMs: 5_000, maxOutputBytes: 32_000 });
  } catch (error) {
    if (error instanceof AppError && error.code === ErrorCode.ExecutableNotFound) throw new AppError(ErrorCode.ScrcpyNotFound, 'scrcpy is not installed or not on PATH.');
    throw error;
  }
  const version = parseVersion(`${output.stdout.toString('utf8')}\n${output.stderr.toString('utf8')}`);
  return {
    ...version,
    supportsNoAudio: version.major >= 2,
    supportsNoControl: version.major >= 2,
    supportsTurnScreenOff: version.major >= 1,
    supportsStayAwake: version.major >= 1,
  };
}

export interface ScrcpyStartOptions {
  maxSize: number;
  maxFps: number;
  audio: boolean;
  control: boolean;
  stayAwake: boolean;
  turnScreenOff: boolean;
  windowTitle: string;
}

export function buildScrcpyArgs(serial: string, options: ScrcpyStartOptions, capabilities: ScrcpyCapabilities): string[] {
  const args = ['--serial', serial, '--max-size', String(options.maxSize), '--max-fps', String(options.maxFps), '--window-title', options.windowTitle];
  if (!options.audio) {
    if (!capabilities.supportsNoAudio) throw new AppError(ErrorCode.UnsupportedOperation, 'Installed scrcpy does not support disabling audio.');
    args.push('--no-audio');
  }
  if (!options.control) {
    if (!capabilities.supportsNoControl) throw new AppError(ErrorCode.UnsupportedOperation, 'Installed scrcpy does not support read-only control mode.');
    args.push('--no-control');
  }
  if (options.stayAwake) {
    if (!capabilities.supportsStayAwake) throw new AppError(ErrorCode.UnsupportedOperation, 'Installed scrcpy does not support stay-awake.');
    args.push('--stay-awake');
  }
  if (options.turnScreenOff) {
    if (!capabilities.supportsTurnScreenOff) throw new AppError(ErrorCode.UnsupportedOperation, 'Installed scrcpy does not support turn-screen-off.');
    args.push('--turn-screen-off');
  }
  return args;
}

export { parseVersion };
