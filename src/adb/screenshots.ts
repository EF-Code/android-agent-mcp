import { createHash } from 'node:crypto';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { AdbClient } from './client.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OBSERVATION_MARKER_TEXT = '__ANDROID_AGENT_MCP_FOREGROUND__';
const OBSERVATION_MARKER = Buffer.from(`\n${OBSERVATION_MARKER_TEXT}\n`, 'ascii');

export interface Screenshot {
  png: Buffer;
  width: number;
  height: number;
  sha256: string;
}

export type VisualFrameFormat = 'jpeg' | 'png';
export type ScreenshotMimeType = 'image/jpeg' | 'image/png';

export interface EncodedScreenshot {
  data: Buffer;
  mimeType: ScreenshotMimeType;
  width: number;
  height: number;
  sha256: string;
}

export interface VisualObservation {
  screenshot: EncodedScreenshot;
  foregroundOutput: string;
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

export function parseJpegDimensions(jpeg: Buffer): { width: number; height: number } {
  if (jpeg.length < 12 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new AppError(ErrorCode.ScreenshotInvalid, 'ADB did not return a valid JPEG screenshot.', {
      details: { bytes: jpeg.length },
    });
  }
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    while (offset < jpeg.length && jpeg[offset] === 0xff) offset += 1;
    if (offset >= jpeg.length) break;
    const marker = jpeg[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > jpeg.length) break;
    const segmentLength = jpeg.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > jpeg.length) break;
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      const height = jpeg.readUInt16BE(offset + 3);
      const width = jpeg.readUInt16BE(offset + 5);
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += segmentLength;
  }
  throw new AppError(
    ErrorCode.ScreenshotInvalid,
    'JPEG screenshot dimensions could not be determined.',
    { details: { bytes: jpeg.length } },
  );
}

export class AdbScreenshots {
  private readonly jpegSupport = new Map<string, boolean>();

  constructor(
    private readonly adb: AdbClient,
    private readonly maxBytes: number,
  ) {}

  private async captureBytes(serial: string, args: readonly string[]): Promise<Buffer> {
    let output;
    try {
      output = await this.adb.device(serial, args, {
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
    return output.stdout;
  }

  async capture(serial: string): Promise<Screenshot> {
    const png = await this.captureBytes(serial, ['exec-out', 'screencap', '-p']);
    const dimensions = parsePngDimensions(png);
    return {
      png,
      ...dimensions,
      sha256: createHash('sha256').update(png).digest('hex'),
    };
  }

  private async captureJpeg(serial: string): Promise<EncodedScreenshot> {
    const data = await this.captureBytes(serial, ['exec-out', 'screencap', '-j']);
    return this.encode(data, 'jpeg');
  }

  private encode(data: Buffer, format: VisualFrameFormat): EncodedScreenshot {
    return {
      data,
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      ...(format === 'jpeg' ? parseJpegDimensions(data) : parsePngDimensions(data)),
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }

  private async captureObservationFormat(
    serial: string,
    format: VisualFrameFormat,
  ): Promise<VisualObservation> {
    const option = format === 'jpeg' ? '-j' : '-p';
    const script = `screencap ${option}; printf "\\n${OBSERVATION_MARKER_TEXT}\\n"; dumpsys window windows | grep -m 1 "mCurrentFocus=" || dumpsys activity activities | grep -m 1 -E "topResumedActivity=|mFocusedApp=|mResumedActivity|ResumedActivity:" || true`;
    const output = await this.adb.device(serial, ['exec-out', 'sh', '-c', script], {
      maxOutputBytes: this.maxBytes + 16_000,
    });
    const markerOffset = output.stdout.lastIndexOf(OBSERVATION_MARKER);
    if (markerOffset < 0) {
      throw new AppError(
        ErrorCode.ScreenshotInvalid,
        'ADB visual observation did not contain its foreground-state boundary.',
        { details: { bytes: output.stdout.length, format } },
      );
    }
    const data = output.stdout.subarray(0, markerOffset);
    if (data.length > this.maxBytes) {
      throw new AppError(
        ErrorCode.ScreenshotTooLarge,
        'Screenshot exceeds the configured maximum byte size.',
        { details: { bytes: data.length, maxBytes: this.maxBytes } },
      );
    }
    return {
      screenshot: this.encode(data, format),
      foregroundOutput: output.stdout.subarray(markerOffset + OBSERVATION_MARKER.length).toString(),
    };
  }

  async captureVisual(
    serial: string,
    preferredFormat: VisualFrameFormat = 'jpeg',
  ): Promise<EncodedScreenshot> {
    if (preferredFormat === 'jpeg' && this.jpegSupport.get(serial) !== false) {
      try {
        const screenshot = await this.captureJpeg(serial);
        this.jpegSupport.set(serial, true);
        return screenshot;
      } catch (error) {
        if (this.jpegSupport.get(serial) === true) throw error;
        const appError = error instanceof AppError ? error : null;
        const diagnostic = JSON.stringify(appError?.details ?? {});
        const unsupported =
          appError?.code === ErrorCode.ScreenshotInvalid ||
          (appError?.code === ErrorCode.CommandFailed &&
            /(?:invalid|unknown|unsupported|usage).*(?:argument|option|screencap)|usage:/iu.test(
              diagnostic,
            ));
        if (!unsupported) throw error;
        this.jpegSupport.set(serial, false);
      }
    }
    const screenshot = await this.capture(serial);
    return {
      data: screenshot.png,
      mimeType: 'image/png',
      width: screenshot.width,
      height: screenshot.height,
      sha256: screenshot.sha256,
    };
  }

  async captureVisualObservation(
    serial: string,
    preferredFormat: VisualFrameFormat = 'jpeg',
  ): Promise<VisualObservation> {
    if (preferredFormat === 'jpeg' && this.jpegSupport.get(serial) !== false) {
      try {
        const observation = await this.captureObservationFormat(serial, 'jpeg');
        this.jpegSupport.set(serial, true);
        return observation;
      } catch (error) {
        if (this.jpegSupport.get(serial) === true) throw error;
        const appError = error instanceof AppError ? error : null;
        if (appError?.code !== ErrorCode.ScreenshotInvalid) throw error;
        this.jpegSupport.set(serial, false);
      }
    }
    return this.captureObservationFormat(serial, 'png');
  }
}
