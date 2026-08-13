import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { redactLogText, REDACTED } from '../policy/redaction.js';
import { validateLabel, validateNonEmpty } from '../validation/common.js';
import type { DeviceInfo, Warning } from '../types.js';
import type { UiSnapshot } from '../ui/types.js';

export interface EvidenceManifestInput {
  serverVersion: string;
  adbVersion: string | null;
  scrcpyVersion: string | null;
  device: DeviceInfo;
  metadata?: Record<string, unknown>;
}

export interface EvidenceFileDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EvidenceSummary {
  evidenceId: string;
  directory: string;
  manifestPath: string;
  summaryPath: string;
  startedAt: string;
  finishedAt: string | null;
  files: EvidenceFileDigest[];
}

function withinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function sanitizeValue(value: unknown, key = ''): unknown {
  if (/password|secret|token|cookie|authorization|credential|private.?key|input.?text/iu.test(key)) return REDACTED;
  if (typeof value === 'string') return redactLogText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeValue(entryValue, entryKey)]));
  }
  return value;
}

function maskSerial(serial: string): string {
  return serial.length <= 4 ? '…' : `…${serial.slice(-4)}`;
}

function sanitizedManifest(input: EvidenceManifestInput, startedAt: string): Record<string, unknown> {
  return {
    formatVersion: 1,
    startedAt,
    serverVersion: input.serverVersion,
    adbVersion: input.adbVersion,
    scrcpyVersion: input.scrcpyVersion,
    device: {
      ...input.device,
      serial: maskSerial(input.device.serial),
      serialSha256: createHash('sha256').update(input.device.serial).digest('hex'),
    },
    metadata: sanitizeValue(input.metadata ?? {}),
  };
}

async function digestFile(path: string, bytes: Buffer): Promise<EvidenceFileDigest> {
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export class EvidenceSession {
  private readonly files: EvidenceFileDigest[] = [];
  private readonly actions: string[] = [];
  private readonly warnings: Warning[] = [];
  private finishedAt: string | null = null;

  constructor(
    readonly evidenceId: string,
    readonly directory: string,
    readonly startedAt: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {}

  get summary(): EvidenceSummary {
    return {
      evidenceId: this.evidenceId,
      directory: this.directory,
      manifestPath: join(this.directory, 'manifest.json'),
      summaryPath: join(this.directory, 'summary.md'),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      files: [...this.files],
    };
  }

  async writeManifest(input: EvidenceManifestInput): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(sanitizedManifest(input, this.startedAt), null, 2)}\n`);
    this.files.push(await this.writeFile('manifest.json', bytes));
  }

  async action(name: string, details: Record<string, unknown> = {}): Promise<void> {
    this.actions.push(JSON.stringify({ at: new Date().toISOString(), name, details: sanitizeValue(details) }));
    await appendFile(join(this.directory, 'actions.jsonl'), `${this.actions.at(-1)}\n`, 'utf8');
  }

  async note(message: string, details: Record<string, unknown> = {}): Promise<void> {
    const safeMessage = redactLogText(validateNonEmpty(message, 'message'));
    await this.action('note', { message: safeMessage, ...details });
  }

  async saveScreenshot(label: string, png: Buffer): Promise<EvidenceFileDigest> {
    return this.saveBytes(`screenshots/${validateLabel(label)}.png`, png);
  }

  async saveUi(label: string, snapshot: UiSnapshot): Promise<EvidenceFileDigest> {
    const safe = Buffer.from(`${JSON.stringify(sanitizeValue(snapshot), null, 2)}\n`);
    return this.saveBytes(`ui/${validateLabel(label)}.json`, safe);
  }

  async saveLog(label: string, text: string): Promise<EvidenceFileDigest> {
    return this.saveBytes(`logs/${validateLabel(label)}.log`, Buffer.from(redactLogText(text)));
  }

  addWarning(warning: Warning): void {
    this.warnings.push(warning);
  }

  async finish(): Promise<EvidenceSummary> {
    if (this.finishedAt !== null) return this.summary;
    this.finishedAt = new Date().toISOString();
    const lines = [
      `# Android Device MCP Evidence ${this.evidenceId}`,
      '',
      `- Started: ${this.startedAt}`,
      `- Finished: ${this.finishedAt}`,
      `- Actions: ${this.actions.length}`,
      `- Files: ${this.files.length}`,
      '',
      '## Files',
      '',
      ...this.files.map((file) => `- \`${file.path}\` — ${file.bytes} bytes — SHA-256 \`${file.sha256}\``),
      '',
      '## Warnings',
      '',
      ...(this.warnings.length === 0 ? ['None recorded.'] : this.warnings.map((warning) => `- ${warning.code}: ${warning.message}`)),
    ];
    await this.writeFile('summary.md', Buffer.from(`${lines.join('\n')}\n`));
    return this.summary;
  }

  private async saveBytes(relativePath: string, bytes: Buffer): Promise<EvidenceFileDigest> {
    const digest = await this.writeFile(relativePath, bytes);
    this.files.push(digest);
    return digest;
  }

  private async writeFile(relativePath: string, bytes: Buffer): Promise<EvidenceFileDigest> {
    const target = resolve(this.directory, relativePath);
    if (!withinRoot(target, this.directory)) {
      throw new AppError(ErrorCode.EvidencePathInvalid, 'Evidence path escapes the session directory.');
    }
    if (this.files.length >= this.maxFiles) {
      throw new AppError(ErrorCode.EvidencePathInvalid, 'Evidence file count limit was reached.');
    }
    const currentBytes = this.files.reduce((total, file) => total + file.bytes, 0);
    if (currentBytes + bytes.length > this.maxBytes) {
      throw new AppError(ErrorCode.EvidencePathInvalid, 'Evidence byte limit was reached.');
    }
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    return digestFile(relativePath, bytes);
  }
}

export class EvidenceManager {
  private active: EvidenceSession | null = null;

  constructor(private readonly evidenceRoot: string, private readonly maxBytes: number, private readonly maxFiles: number) {}

  async begin(input: EvidenceManifestInput, label = 'session'): Promise<EvidenceSession> {
    if (this.active !== null) {
      throw new AppError(ErrorCode.SessionConflict, 'An evidence session is already active.', {
        details: { evidenceId: this.active.evidenceId },
      });
    }
    const safeLabel = validateLabel(label);
    const evidenceId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}-${randomUUID().slice(0, 8)}`;
    const directory = resolve(this.evidenceRoot, evidenceId);
    if (!withinRoot(directory, resolve(this.evidenceRoot))) throw new AppError(ErrorCode.EvidencePathInvalid, 'Evidence session path is invalid.');
    await mkdir(this.evidenceRoot, { recursive: true });
    await mkdir(directory, { recursive: false });
    const session = new EvidenceSession(evidenceId, directory, new Date().toISOString(), this.maxBytes, this.maxFiles);
    this.active = session;
    try {
      await session.writeManifest(input);
    } catch (error) {
      this.active = null;
      throw error;
    }
    return session;
  }

  requireActive(): EvidenceSession {
    if (this.active === null) throw new AppError(ErrorCode.InvalidInput, 'No evidence session is active.');
    return this.active;
  }

  async finish(): Promise<EvidenceSummary> {
    const session = this.requireActive();
    const summary = await session.finish();
    this.active = null;
    return summary;
  }
}

export { sanitizeValue };
