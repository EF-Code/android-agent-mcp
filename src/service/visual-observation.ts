import type { EncodedScreenshot } from '../adb/screenshots.js';
import type { ForegroundApp } from '../types.js';

export interface VisualFrameSignature {
  screenshot: Pick<EncodedScreenshot, 'sha256' | 'mimeType' | 'width' | 'height'>;
  frameTransport: 'scrcpy' | 'adb';
}

export interface VisualObservationFrame extends VisualFrameSignature {
  screenshot: EncodedScreenshot;
  foreground: ForegroundApp;
  frameTransport: 'scrcpy' | 'adb';
}

export function comparableFrames(left: VisualFrameSignature, right: VisualFrameSignature): boolean {
  return (
    left.frameTransport === right.frameTransport &&
    left.screenshot.mimeType === right.screenshot.mimeType &&
    left.screenshot.width === right.screenshot.width &&
    left.screenshot.height === right.screenshot.height
  );
}

export async function waitForVisualObservation(options: {
  baseline: VisualFrameSignature;
  initial: VisualObservationFrame;
  waitForChangeMs: number;
  stableMs: number;
  pollMs: number;
  capture: () => Promise<VisualObservationFrame>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<
  VisualObservationFrame & {
    changed: boolean | null;
    changeReason: 'capture_pipeline_changed' | null;
    stable: boolean | null;
    timedOut: boolean;
    elapsedMs: number;
  }
> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const deadline = started + options.waitForChangeMs;
  let frame = options.initial;
  let stableSince = started;
  let changed: boolean | null = null;
  let stable: boolean | null = null;
  while (true) {
    changed = comparableFrames(options.baseline, frame)
      ? options.baseline.screenshot.sha256 !== frame.screenshot.sha256
      : null;
    if (changed === null) {
      stable = null;
      break;
    }
    if (options.waitForChangeMs === 0) break;
    if (changed === true && options.stableMs === 0) break;
    if (changed === true && options.stableMs > 0) {
      stable = now() - stableSince >= options.stableMs;
      if (stable) break;
    }
    if (now() >= deadline) break;
    const stableRemaining = changed === true ? options.stableMs - (now() - stableSince) : Infinity;
    await sleep(Math.min(options.pollMs, deadline - now(), stableRemaining));
    if (now() >= deadline) break;
    const next = await options.capture();
    if (!comparableFrames(frame, next) || next.screenshot.sha256 !== frame.screenshot.sha256) {
      stableSince = now();
    }
    frame = next;
  }
  return {
    ...frame,
    changed,
    changeReason: changed === null ? 'capture_pipeline_changed' : null,
    stable,
    timedOut:
      options.waitForChangeMs > 0 && now() >= deadline && (changed !== true || stable === false),
    elapsedMs: Math.round(now() - started),
  };
}
