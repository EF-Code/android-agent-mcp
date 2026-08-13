import { createHash } from 'node:crypto';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { AdbClient } from './client.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Screenshot {
  png: Buffer;
  width: number;
  height: number;
  sha256: string;
}

export function parsePngDimensions(png: Buffer): { width: number; height: number } {
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new AppError(ErrorCode.ScreenshotInvalid, 'ADB did not return a valid PNG screenshot.', {
      details: { bytes: png.length },
    });
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 100_000 || height > 100_000) {
    throw new AppError(
      ErrorCode.ScreenshotInvalid,
      'Screenshot dimensions are outside the supported range.',
      {
        details: { width, height },
      },
    );
  }
  return { width, height };
}

export class AdbScreenshots {
  constructor(
    private readonly adb: AdbClient,
    private readonly maxBytes: number,
  ) {}

  async capture(serial: string): Promise<Screenshot> {
    let output;
    try {
      output = await this.adb.device(serial, ['exec-out', 'screencap', '-p'], {
        maxOutputBytes: this.maxBytes,
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      if (appError?.code === ErrorCode.CommandOutputLimit) {
        const command = appError.details.command;
        const observedBytes =
          typeof command === 'object' &&
          command !== null &&
          'stdoutBytes' in command &&
          typeof command.stdoutBytes === 'number'
            ? command.stdoutBytes
            : null;
        throw new AppError(
          ErrorCode.ScreenshotTooLarge,
          'Screenshot exceeds the configured maximum byte size.',
          {
            retryable: true,
            details: { maxBytes: this.maxBytes, observedBytes, truncated: true },
            cause: error,
          },
        );
      }
      throw error;
    }
    if (output.stdout.length > this.maxBytes) {
      throw new AppError(
        ErrorCode.ScreenshotTooLarge,
        'Screenshot exceeds the configured maximum byte size.',
        {
          details: { bytes: output.stdout.length, maxBytes: this.maxBytes },
        },
      );
    }
    const dimensions = parsePngDimensions(output.stdout);
    return {
      png: output.stdout,
      ...dimensions,
      sha256: createHash('sha256').update(output.stdout).digest('hex'),
    };
  }
}
