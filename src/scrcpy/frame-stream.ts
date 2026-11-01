import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { parseJpegDimensions, type EncodedScreenshot } from '../adb/screenshots.js';

export interface StreamedFrame extends EncodedScreenshot {
  sequence: number;
  capturedAt: number;
}

interface FrameWaiter {
  afterSequence: number;
  resolve: (frame: StreamedFrame | null) => void;
  timer: NodeJS.Timeout;
}

const MAX_PENDING_BYTES = 25_000_000;
const MAX_WAITERS = 64;
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const DECODER_ENVIRONMENT_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

function decoderEnvironment(): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of DECODER_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

export function extractJpegFrames(buffer: Buffer): { frames: Buffer[]; remainder: Buffer } {
  const frames: Buffer[] = [];
  let remainder = buffer;
  while (true) {
    const start = remainder.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      return { frames, remainder: remainder.subarray(Math.max(0, remainder.length - 1)) };
    }
    const end = remainder.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) return { frames, remainder: start > 0 ? remainder.subarray(start) : remainder };
    frames.push(Buffer.from(remainder.subarray(start, end + 2)));
    remainder = remainder.subarray(end + 2);
  }
}

// Scan each incoming byte once and grow storage geometrically. A partial frame
// must not be recopied and rescanned on every decoder chunk.
export class JpegFrameAssembler {
  private buffer: Buffer = Buffer.alloc(0);
  private length = 0;
  private trailingFF = false;

  constructor(private readonly maxBytes = MAX_PENDING_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
      throw new RangeError('JPEG frame limit must be an integer of at least four bytes.');
    }
  }

  private append(chunk: Buffer): void {
    const required = this.length + chunk.length;
    if (required > this.maxBytes) {
      this.reset();
      throw new Error('FFmpeg frame output exceeded the pending-byte limit.');
    }
    if (required > this.buffer.length) {
      const capacity = Math.min(this.maxBytes, Math.max(required, this.buffer.length * 2, 4096));
      const next = Buffer.allocUnsafe(capacity);
      this.buffer.copy(next, 0, 0, this.length);
      this.buffer = next;
    }
    chunk.copy(this.buffer, this.length);
    this.length = required;
  }

  push(chunk: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.length === 0) {
        if (this.trailingFF && chunk[offset] === 0xd8) {
          this.append(JPEG_START);
          offset += 1;
        } else {
          const start = chunk.indexOf(JPEG_START, offset);
          if (start < 0) {
            this.trailingFF = chunk[chunk.length - 1] === 0xff;
            break;
          }
          this.append(JPEG_START);
          offset = start + JPEG_START.length;
        }
        this.trailingFF = false;
      }
      // EOI can straddle two chunks, just like SOI.
      const end =
        this.buffer[this.length - 1] === 0xff && chunk[offset] === 0xd9
          ? offset + 1
          : (() => {
              const found = chunk.indexOf(JPEG_END, offset);
              return found < 0 ? -1 : found + JPEG_END.length;
            })();
      if (end < 0) {
        this.append(chunk.subarray(offset));
        break;
      }
      this.append(chunk.subarray(offset, end));
      frames.push(Buffer.from(this.buffer.subarray(0, this.length)));
      this.length = 0;
      offset = end;
    }
    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.length = 0;
    this.trailingFF = false;
  }
}

export class ScrcpyFrameStream {
  readonly directory: string;
  readonly pipePath: string;
  private decoder: ChildProcess | null = null;
  private readonly assembler = new JpegFrameAssembler();
  private latest: StreamedFrame | null = null;
  private sequence = 0;
  private readonly waiters = new Set<FrameWaiter>();
  private failure: string | null = null;
  private disposed = false;

  constructor(
    private readonly ffmpegPath = 'ffmpeg',
    private readonly spawnDecoder: (
      executable: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => ChildProcess = spawn,
  ) {
    this.directory = mkdtempSync(join(tmpdir(), 'android-agent-mcp-stream-'));
    this.pipePath = join(this.directory, 'video.mkv');
    const fifo = spawnSync('mkfifo', [this.pipePath], { stdio: 'ignore' });
    if (fifo.status !== 0) {
      this.dispose();
      throw new Error('Unable to create the scrcpy video pipe.');
    }
  }

  start(): void {
    if (this.decoder !== null || this.disposed || this.failure !== null) return;
    const decoder = this.spawnDecoder(
      this.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        this.pipePath,
        '-an',
        '-vf',
        'scale=720:-2:force_original_aspect_ratio=decrease,fps=15',
        '-q:v',
        '5',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: decoderEnvironment() },
    );
    this.decoder = decoder;
    decoder.stdout?.on('data', (chunk: Buffer) => {
      if (this.decoder !== decoder || this.disposed) return;
      try {
        this.consume(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error), decoder);
      }
    });
    let stderr = '';
    decoder.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000);
    });
    decoder.once('error', (error) => this.fail(error.message, decoder));
    decoder.once('close', () => {
      if (this.decoder === decoder && !this.disposed) {
        this.fail(stderr || 'FFmpeg decoder exited before disposal.', decoder);
      }
    });
  }

  private consume(chunk: Buffer): void {
    for (const data of this.assembler.push(chunk)) {
      const dimensions = parseJpegDimensions(data);
      const frame: StreamedFrame = {
        data,
        mimeType: 'image/jpeg',
        ...dimensions,
        sha256: createHash('sha256').update(data).digest('hex'),
        sequence: ++this.sequence,
        capturedAt: performance.now(),
      };
      this.latest = frame;
      this.resolveWaiters(frame);
    }
  }

  current(): StreamedFrame | null {
    return this.latest;
  }

  get diagnostic(): string | null {
    return this.failure;
  }

  async waitForFrame(afterSequence: number, timeoutMs = 1_000): Promise<StreamedFrame | null> {
    if (this.latest !== null && this.latest.sequence > afterSequence) return this.latest;
    if (this.decoder === null || this.waiters.size >= MAX_WAITERS) return null;
    return await new Promise((resolve) => {
      const waiter: FrameWaiter = {
        afterSequence,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(
            this.latest !== null && this.latest.sequence > afterSequence ? this.latest : null,
          );
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.waiters.add(waiter);
    });
  }

  private fail(reason: string, decoder: ChildProcess): void {
    if (this.failure === null) this.failure = reason.slice(-4_000);
    if (this.decoder === decoder) this.decoder = null;
    this.assembler.reset();
    this.latest = null;
    this.resolveWaiters(null);
    if (decoder.pid !== undefined) decoder.kill('SIGTERM');
  }

  private resolveWaiters(frame: StreamedFrame | null): void {
    for (const waiter of this.waiters) {
      if (frame !== null && frame.sequence <= waiter.afterSequence) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(frame);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.decoder?.pid !== undefined) this.decoder.kill('SIGTERM');
    this.decoder = null;
    this.assembler.reset();
    this.latest = null;
    this.resolveWaiters(null);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
