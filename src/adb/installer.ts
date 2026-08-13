import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { ErrorCode } from '../errors/codes.js';
import { AppError, asAppError } from '../errors/app-error.js';
import { AdbClient } from './client.js';

export type InstallFailureCode =
  | 'ABI_MISMATCH'
  | 'MISSING_SPLIT'
  | 'SIGNATURE_MISMATCH'
  | 'DOWNGRADE'
  | 'SDK_INCOMPATIBLE'
  | 'INSUFFICIENT_STORAGE'
  | 'INVALID_APK'
  | 'INSTALL_FAILED';

export interface ValidatedApk {
  requestedPath: string;
  realPath: string;
  bytes: number;
  sha256: string;
}

function withinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

export function normalizeInstallFailure(message: string): InstallFailureCode {
  if (/NO_MATCHING_ABIS|CPU_ABI_INCOMPATIBLE/u.test(message)) return 'ABI_MISMATCH';
  if (/MISSING_SPLIT/u.test(message)) return 'MISSING_SPLIT';
  if (/UPDATE_INCOMPATIBLE|BAD_SIGNATURE|SIGNATURE/u.test(message)) return 'SIGNATURE_MISMATCH';
  if (/VERSION_DOWNGRADE/u.test(message)) return 'DOWNGRADE';
  if (/OLDER_SDK|NEWER_SDK|SDK/u.test(message)) return 'SDK_INCOMPATIBLE';
  if (/INSUFFICIENT_STORAGE|NO_SPACE/u.test(message)) return 'INSUFFICIENT_STORAGE';
  if (/INVALID_APK|PARSE_FAILED|BAD_PACKAGE_NAME/u.test(message)) return 'INVALID_APK';
  return 'INSTALL_FAILED';
}

export class AdbInstaller {
  constructor(
    private readonly adb: AdbClient,
    private readonly allowedRoots: string[],
    private readonly maxBytes: number,
  ) {}

  async validate(path: string): Promise<ValidatedApk> {
    if (!isAbsolute(path) || !path.toLowerCase().endsWith('.apk')) {
      throw new AppError(ErrorCode.FileNotAllowed, 'APK path must be absolute and end with .apk.');
    }
    const requestedPath = resolve(path);
    let realPath: string;
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      realPath = await realpath(requestedPath);
      fileStat = await stat(realPath);
    } catch (error) {
      throw new AppError(ErrorCode.ApkInvalid, 'APK path does not resolve to an accessible file.', {
        details: { requestedPath },
        cause: error,
      });
    }
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > this.maxBytes) {
      throw new AppError(
        ErrorCode.ApkInvalid,
        'APK is not a regular file within the configured size limit.',
        {
          details: { bytes: fileStat.size, maxBytes: this.maxBytes },
        },
      );
    }

    let matchedRoot = false;
    for (const root of this.allowedRoots) {
      try {
        const rootStat = await lstat(root);
        if (!rootStat.isDirectory()) continue;
        const rootRealPath = await realpath(root);
        if (withinRoot(realPath, rootRealPath)) {
          matchedRoot = true;
          break;
        }
      } catch {
        // A missing configured root simply cannot authorize this file.
      }
    }
    if (!matchedRoot) {
      throw new AppError(
        ErrorCode.FileNotAllowed,
        'APK path is outside every configured allowed APK root.',
        {
          details: { requestedPath, allowedRoots: this.allowedRoots },
        },
      );
    }

    return {
      requestedPath,
      realPath,
      bytes: fileStat.size,
      sha256: await sha256File(realPath),
    };
  }

  async install(
    serial: string,
    apk: ValidatedApk,
    replace: boolean,
  ): Promise<{ output: string; replace: boolean }> {
    const args = ['install'];
    if (replace) args.push('-r');
    args.push(apk.realPath);
    try {
      const output = await this.adb.text(
        this.adb.device(serial, args, { timeoutMs: 120_000, maxOutputBytes: 64_000 }),
      );
      return { output, replace };
    } catch (error) {
      const appError = asAppError(error);
      const stderr =
        typeof appError.details.stderr === 'string' ? appError.details.stderr : appError.message;
      throw new AppError(ErrorCode.ApkInstallFailed, 'APK installation failed.', {
        details: {
          failureCode: normalizeInstallFailure(stderr),
          stderr,
          apkSha256: apk.sha256,
        },
        cause: error,
      });
    }
  }
}
