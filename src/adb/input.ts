import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { validateCoordinate, validateDuration } from '../validation/common.js';
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

  async longPress(serial: string, x: number, y: number, durationMs: number): Promise<void> {
    validateCoordinate(x, 'x');
    validateCoordinate(y, 'y');
    validateDuration(durationMs, 'durationMs', 30_000);
    await this.swipe(serial, x, y, x, y, durationMs);
  }

  async key(serial: string, key: AllowedKey, allowPower = false): Promise<void> {
    if (!(key in KEY_CODES)) {
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
