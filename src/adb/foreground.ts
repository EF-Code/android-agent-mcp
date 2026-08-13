import type { ForegroundApp } from '../types.js';
import { AdbClient } from './client.js';

function parseComponent(output: string): ForegroundApp {
  const resumed = /mResumedActivity:.*?\s([A-Za-z0-9_.$]+)\/([A-Za-z0-9_.$]+)/u.exec(output);
  const focused = /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.$]+)\/([A-Za-z0-9_.$]+)\}/u.exec(output);
  const match = resumed ?? focused;
  if (match === null) return { packageName: null, activity: null, pid: null };
  const pidMatch = /\bpid=(\d+)\b/u.exec(output);
  return {
    packageName: match[1] ?? null,
    activity: match[2] ?? null,
    pid: pidMatch === null ? null : Number(pidMatch[1]),
  };
}

export class AdbForeground {
  constructor(private readonly adb: AdbClient) {}

  async read(serial: string): Promise<ForegroundApp> {
    const activity = await this.adb.text(this.adb.shell(serial, ['dumpsys', 'activity', 'activities'], { maxOutputBytes: 256_000 }));
    const parsed = parseComponent(activity);
    if (parsed.packageName !== null) return parsed;
    const windows = await this.adb.text(this.adb.shell(serial, ['dumpsys', 'window', 'windows'], { maxOutputBytes: 256_000 }));
    return parseComponent(windows);
  }
}

export { parseComponent as parseForegroundActivity };
