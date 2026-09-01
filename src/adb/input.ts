import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { validateCoordinate, validateDuration, validatePackageName } from '../validation/common.js';
import { AdbClient } from './client.js';

export const KEY_CODES = {
  back: 4,
  home: 3,
  enter: 66,
  tab: 61,
  escape: 111,
  delete: 67,
  arrow_up: 19,
  arrow_down: 20,
  arrow_left: 21,
  arrow_right: 22,
  menu: 82,
  app_switch: 187,
  volume_up: 24,
  volume_down: 25,
  wake: 224,
  power: 26,
} as const;

export type AllowedKey = keyof typeof KEY_CODES;

export type InputSequenceAction =
  | { type: 'tap'; x: number; y: number }
  | {
      type: 'swipe';
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      durationMs: number;
    }
  | { type: 'key'; key: Exclude<AllowedKey, 'power' | 'wake'> };

function formatSleepSeconds(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const remainder = milliseconds % 1_000;
  return `${seconds}.${String(remainder).padStart(3, '0')}`;
}

export function buildInputSequenceScript(
  actions: readonly InputSequenceAction[],
  interActionDelayMs = 0,
): string {
  if (actions.length === 0 || actions.length > 32) {
    throw new AppError(
      ErrorCode.InvalidInput,
      'Input sequences must contain between 1 and 32 actions.',
    );
  }
  validateDuration(interActionDelayMs, 'interActionDelayMs', 1_000);

  const commands = actions.map((action) => {
    if (action.type === 'tap') {
      validateCoordinate(action.x, 'x');
      validateCoordinate(action.y, 'y');
      return `input tap ${action.x} ${action.y}`;
    }
    if (action.type === 'swipe') {
      validateCoordinate(action.startX, 'startX');
      validateCoordinate(action.startY, 'startY');
      validateCoordinate(action.endX, 'endX');
      validateCoordinate(action.endY, 'endY');
      validateDuration(action.durationMs, 'durationMs', 30_000);
      return `input swipe ${action.startX} ${action.startY} ${action.endX} ${action.endY} ${action.durationMs}`;
    }
    const key = action.key as string;
    if (
      !Object.prototype.hasOwnProperty.call(KEY_CODES, key) ||
      key === 'power' ||
      key === 'wake'
    ) {
      throw new AppError(ErrorCode.InvalidInput, 'Input sequence key is not allowlisted.', {
        details: { key },
      });
    }
    return `input keyevent ${KEY_CODES[key as AllowedKey]}`;
  });

  const separator =
    interActionDelayMs === 0 ? '; ' : `; sleep ${formatSleepSeconds(interActionDelayMs)}; `;
  return commands.join(separator);
}

function quoteRemoteShellScript(script: string): string {
  if (script.includes("'")) {
    throw new AppError(
      ErrorCode.InvalidInput,
      'Generated input sequence contains an unsupported shell quote.',
    );
  }
  return `'${script}'`;
}

export function assertInputSequenceOutput(stdout: Buffer, stderr: Buffer): void {
  // Input diagnostics are emitted before any binary screenshot payload. Bound the
  // decoding work so fast visual actions do not UTF-8 decode an entire frame.
  const startsWithFrame =
    (stdout[0] === 0xff && stdout[1] === 0xd8) ||
    (stdout[0] === 0x89 && stdout.subarray(1, 4).toString('ascii') === 'PNG');
  const diagnostic = Buffer.concat([
    startsWithFrame ? Buffer.alloc(0) : stdout.subarray(0, 4_096),
    stderr.subarray(0, 4_096),
  ])
    .toString('utf8')
    .trim();
  const mismatch = /__ANDROID_AGENT_MCP_FOREGROUND_MISMATCH__([^\r\n]*)/u.exec(diagnostic);
  if (mismatch !== null) {
    throw new AppError(
      ErrorCode.StaleUiSnapshot,
      'Foreground changed before the visual input sequence could execute.',
      {
        retryable: true,
        details: { currentPackage: mismatch[1] || null },
      },
    );
  }
  if (!/(?:^|\n)Usage: input\b/u.test(diagnostic)) return;
  throw new AppError(ErrorCode.CommandFailed, 'Android rejected the generated input sequence.', {
    retryable: true,
    details: { diagnostic: diagnostic.slice(0, 2_000) },
  });
}

export function encodeSafeAsciiText(value: string): string {
  if (value.length === 0 || value.length > 1_024) {
    throw new AppError(
      ErrorCode.InvalidInput,
      'Text input must contain between 1 and 1024 characters.',
      {
        details: { length: value.length },
      },
    );
  }
  if (
    ![...value].every(
      (character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) <= 0x7e,
    )
  ) {
    throw new AppError(
      ErrorCode.UnsupportedOperation,
      'Only printable ASCII text is supported by the default ADB keyboard path.',
      {
        details: { characterCount: value.length },
      },
    );
  }
  return value
    .replace(/%/g, '%25')
    .replace(/ /g, '%s')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/&/g, '\\&')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/[()|;`$]/g, '\\$&');
}

export class AdbInput {
  constructor(private readonly adb: AdbClient) {}

  async tap(serial: string, x: number, y: number): Promise<void> {
    validateCoordinate(x, 'x');
    validateCoordinate(y, 'y');
    await this.adb.shell(serial, ['input', 'tap', String(x), String(y)]);
  }

  async swipe(
    serial: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number,
  ): Promise<void> {
    validateCoordinate(startX, 'startX');
    validateCoordinate(startY, 'startY');
    validateCoordinate(endX, 'endX');
    validateCoordinate(endY, 'endY');
    validateDuration(durationMs, 'durationMs', 30_000);
    await this.adb.shell(serial, [
      'input',
      'swipe',
      String(startX),
      String(startY),
      String(endX),
      String(endY),
      String(durationMs),
    ]);
  }

  async sequence(
    serial: string,
    actions: readonly InputSequenceAction[],
    interActionDelayMs = 0,
  ): Promise<void> {
    const script = buildInputSequenceScript(actions, interActionDelayMs);
    const action = actions.length === 1 && interActionDelayMs === 0 ? actions[0] : undefined;
    if (action?.type === 'tap') {
      await this.tap(serial, action.x, action.y);
      return;
    }
    if (action?.type === 'swipe') {
      await this.swipe(
        serial,
        action.startX,
        action.startY,
        action.endX,
        action.endY,
        action.durationMs,
      );
      return;
    }
    if (action?.type === 'key') {
      await this.key(serial, action.key);
      return;
    }
    const output = await this.adb.shell(serial, ['sh', '-c', quoteRemoteShellScript(script)]);
    assertInputSequenceOutput(output.stdout, output.stderr);
  }

  async guardedSequence(
    serial: string,
    actions: readonly InputSequenceAction[],
    expectedPackage: string,
    interActionDelayMs = 0,
  ): Promise<void> {
    validatePackageName(expectedPackage);
    const inputScript = buildInputSequenceScript(actions, interActionDelayMs);
    const foregroundScript =
      'foreground_line=$(dumpsys window windows | grep -m 1 "mCurrentFocus=" || dumpsys activity activities | grep -m 1 -E "topResumedActivity=|mFocusedApp=|mResumedActivity|ResumedActivity:"); current_package=$(printf "${foreground_line}\\n" | sed -E "s@.* ([A-Za-z0-9_.$]+)/.*@\\\\1@"); ';
    const guardScript = `${foregroundScript}if [ "$current_package" = "${expectedPackage}" ]; then ${inputScript}; else printf "__ANDROID_AGENT_MCP_FOREGROUND_MISMATCH__%s\\n" "$current_package"; fi`;
    const output = await this.adb.shell(serial, ['sh', '-c', quoteRemoteShellScript(guardScript)]);
    assertInputSequenceOutput(output.stdout, output.stderr);
  }

  async longPress(serial: string, x: number, y: number, durationMs: number): Promise<void> {
    validateCoordinate(x, 'x');
    validateCoordinate(y, 'y');
    validateDuration(durationMs, 'durationMs', 30_000);
    await this.swipe(serial, x, y, x, y, durationMs);
  }

  async key(serial: string, key: AllowedKey, allowPower = false): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(KEY_CODES, key)) {
      throw new AppError(ErrorCode.InvalidInput, 'Android key is not allowlisted.', {
        details: { key },
      });
    }
    if ((key === 'power' || key === 'wake') && !allowPower) {
      throw new AppError(
        ErrorCode.ApprovalRequired,
        'Power and wake keys require explicit policy configuration.',
        {
          details: { key },
        },
      );
    }
    await this.adb.shell(serial, ['input', 'keyevent', String(KEY_CODES[key])]);
  }

  async text(serial: string, value: string): Promise<number> {
    const encoded = encodeSafeAsciiText(value);
    await this.adb.shell(serial, ['input', 'text', encoded], {
      secretArgIndexes: new Set([5]),
    });
    return [...value].length;
  }
}
