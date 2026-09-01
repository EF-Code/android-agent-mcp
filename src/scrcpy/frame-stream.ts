import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

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

export class ScrcpyFrameStream {
  readonly directory: string;
  readonly pipePath: string;
  private decoder: ChildProcess | null = null;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private latest: StreamedFrame | null = null;
  private sequence = 0;
  private readonly waiters = new Set<FrameWaiter>();

  constructor(private readonly ffmpegPath = 'ffmpeg') {
    this.directory = mkdtempSync(join(tmpdir(), 'android-agent-mcp-stream-'));
    this.pipePath = join(this.directory, 'video.mkv');
    const fifo = spawnSync('mkfifo', [this.pipePath], { stdio: 'ignore' });
    if (fifo.status !== 0) {
      this.dispose();
      throw new Error('Unable to create the scrcpy video pipe.');
    }
  }

  start(): void {
    if (this.decoder !== null) return;
    const decoder = spawn(
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
      { shell: false, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    this.decoder = decoder;
    decoder.stdout?.on('data', (chunk: Buffer) => this.consume(chunk));
    decoder.once('close', () => {
      if (this.decoder === decoder) this.decoder = null;
      this.resolveWaiters(null);
    });
  }

  private consume(chunk: Buffer): void {
    const extracted = extractJpegFrames(Buffer.concat([this.pending, chunk]));
    this.pending = extracted.remainder;
    for (const data of extracted.frames) {
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

  async waitForFrame(afterSequence: number, timeoutMs = 1_000): Promise<StreamedFrame | null> {
    if (this.latest !== null && this.latest.sequence > afterSequence) return this.latest;
    return await new Promise((resolve) => {
      const waiter: FrameWaiter = {
        afterSequence,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(this.latest?.sequence !== afterSequence ? this.latest : null);
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.waiters.add(waiter);
    });
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
    if (this.decoder?.pid !== undefined) this.decoder.kill('SIGTERM');
    this.decoder = null;
    this.resolveWaiters(null);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
