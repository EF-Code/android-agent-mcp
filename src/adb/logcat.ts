import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { redactLogText } from '../policy/redaction.js';
import { validateDuration, validatePackageName } from '../validation/common.js';
import { AdbClient } from './client.js';

export type LogSeverity = 'V' | 'D' | 'I' | 'W' | 'E' | 'F';

export interface LogCaptureOptions {
  packageName?: string;
  pid?: number;
  severity?: LogSeverity;
  tags?: string[];
  durationMs?: number;
  since?: string;
  maxLines?: number;
  maxBytes?: number;
  includeCrashBuffer?: boolean;
}

export interface LogCapture {
  lines: string[];
  text: string;
  truncated: boolean;
  durationMs: number;
}

export interface CrashEvidence {
  processPackage: string | null;
  pid: number | null;
  exceptionType: string | null;
  message: string | null;
  stackFrames: string[];
  time: string | null;
  nativeTombstoneReference: string | null;
}

function validateTags(tags: string[]): string[] {
  if (tags.length > 20 || tags.some((tag) => !/^[A-Za-z0-9_.-]{1,64}$/u.test(tag))) {
    throw new AppError(ErrorCode.InvalidInput, 'Logcat tags must be up to 20 simple tag names.');
  }
  return tags;
}

function splitLines(text: string, maxLines: number, maxBytes: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const lineBytes = Buffer.byteLength(line) + (lines.length === 0 ? 0 : 1);
    if (lines.length >= maxLines || bytes + lineBytes > maxBytes) {
      truncated = true;
      break;
    }
    lines.push(redactLogText(line));
    bytes += lineBytes;
  }
  return { lines, truncated };
}

function parseCrashBlocks(text: string): CrashEvidence[] {
  const redacted = redactLogText(text);
  const blocks = redacted.split(/(?=FATAL EXCEPTION|ANR in )/u).filter((block) => /FATAL EXCEPTION|ANR in /u.test(block));
  return blocks.map((block) => {
    const process = /Process:\s*([^,\s]+),\s*PID:\s*(\d+)/u.exec(block);
    const exception = /^\s*([A-Za-z_$][\w.$]*(?:Exception|Error|Failure|Throwable))(?::\s*(.*))?$/mu.exec(block);
    const frames = block
      .split(/\r?\n/u)
      .filter((line) => /^\s*at\s+/u.test(line))
      .slice(0, 50);
    return {
      processPackage: process?.[1] ?? (/ANR in\s+([^\s{]+)/u.exec(block)?.[1] ?? null),
      pid: process?.[2] === undefined ? null : Number(process[2]),
      exceptionType: exception?.[1] ?? (block.startsWith('ANR') ? 'ANR' : null),
      message: exception?.[2]?.trim() ?? null,
      stackFrames: frames,
      time: /^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)/mu.exec(block)?.[1] ?? null,
      nativeTombstoneReference: /tombstone[_-]?([\w-]+)/iu.exec(block)?.[1] ?? null,
    };
  });
}

export class AdbLogcat {
  constructor(private readonly adb: AdbClient, private readonly defaultMaxBytes: number) {}

  private async pidForPackage(serial: string, packageName: string): Promise<number | null> {
    validatePackageName(packageName);
    const output = await this.adb.text(this.adb.shell(serial, ['pidof', packageName], { timeoutMs: 5_000, maxOutputBytes: 4_096 }));
    const pid = Number(output.trim().split(/\s+/u)[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }

  async capture(serial: string, options: LogCaptureOptions = {}): Promise<LogCapture> {
    const durationMs = validateDuration(options.durationMs ?? 1_000, 'durationMs', 30_000);
    const maxLines = Math.min(Math.max(options.maxLines ?? 500, 1), 20_000);
    const maxBytes = Math.min(Math.max(options.maxBytes ?? this.defaultMaxBytes, 1_024), this.defaultMaxBytes);
    const severity = options.severity ?? 'I';
    if (!/^[VDIWEF]$/u.test(severity)) throw new AppError(ErrorCode.InvalidInput, 'Unsupported log severity.');
    const tags = validateTags(options.tags ?? []);
    const pid = options.pid ?? (options.packageName === undefined ? undefined : await this.pidForPackage(serial, options.packageName));
    if (pid !== undefined && pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) throw new AppError(ErrorCode.InvalidInput, 'PID is invalid.');
    if (options.packageName !== undefined && pid === null) {
      return { lines: [], text: '', truncated: false, durationMs: 0 };
    }
    if (options.since !== undefined && !/^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(options.since)) {
      throw new AppError(ErrorCode.InvalidInput, 'Logcat since timestamp must use logcat timestamp format.');
    }

    const args = ['logcat', '-v', 'threadtime', '-T', options.since ?? '1'];
    if (pid !== undefined && pid !== null) args.push(`--pid=${pid}`);
    args.push('*:' + severity);
    for (const tag of tags) args.push(`${tag}:${severity}`);
    const started = performance.now();
    const output = await this.adb.device(serial, args, {
      timeoutMs: Math.max(durationMs + 2_000, 5_000),
      maxOutputBytes: maxBytes,
    });
    const primary = splitLines(output.stdout.toString('utf8'), maxLines, maxBytes);
    let lines = primary.lines;
    let truncated = primary.truncated || output.record.stdoutTruncated;
    if (options.includeCrashBuffer === true) {
      const crash = await this.adb.device(serial, ['logcat', '-b', 'crash', '-v', 'threadtime', '-t', String(Math.min(maxLines, 500))], {
        timeoutMs: 10_000,
        maxOutputBytes: Math.min(maxBytes, 500_000),
      });
      const crashLines = splitLines(crash.stdout.toString('utf8'), maxLines - lines.length, maxBytes - Buffer.byteLength(lines.join('\n')));
      lines = [...lines, ...crashLines.lines];
      truncated ||= crashLines.truncated || crash.record.stdoutTruncated;
    }
    return {
      lines,
      text: lines.join('\n'),
      truncated,
      durationMs: Math.round(performance.now() - started),
    };
  }

  async crashes(serial: string, packageName: string, maxLines = 500): Promise<CrashEvidence[]> {
    validatePackageName(packageName);
    const capture = await this.capture(serial, {
      packageName,
      durationMs: 1_000,
      maxLines,
      includeCrashBuffer: true,
      severity: 'W',
    });
    return parseCrashBlocks(capture.text).filter((crash) => crash.processPackage === packageName || crash.processPackage === null);
  }
}

export { parseCrashBlocks };
