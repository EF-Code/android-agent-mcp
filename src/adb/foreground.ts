import type { ForegroundApp } from '../types.js';
import { AdbClient } from './client.js';

function parseComponent(output: string): ForegroundApp {
  const focused = /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.$]+)\/([A-Za-z0-9_.$]+)\}/u.exec(
    output,
  );
  const resumed =
    /(?:topResumedActivity|mFocusedApp)=ActivityRecord\{[^}]*\s(?:u\d+\s+)?([A-Za-z0-9_.$]+)\/([A-Za-z0-9_.$]+)(?:\s|\}|$)/u.exec(
      output,
    );
  const legacyResumed =
    /(?:mResumedActivity|ResumedActivity):.*?\s([A-Za-z0-9_.$]+)\/([A-Za-z0-9_.$]+)/u.exec(output);
  const match = focused ?? resumed ?? legacyResumed;
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
    // Samsung and other OEM builds can emit more than 256 KiB for
    // `dumpsys activity activities`. The focused window dump is smaller and
    // contains the same foreground package/activity signal in a bounded form.
    const windows = await this.adb.text(
      this.adb.shell(serial, ['dumpsys', 'window', 'windows'], { maxOutputBytes: 512_000 }),
    );
    const parsed = parseComponent(windows);
    if (parsed.packageName !== null) return parsed;
    const activity = await this.adb.text(
      this.adb.shell(serial, ['dumpsys', 'activity', 'activities'], { maxOutputBytes: 1_000_000 }),
    );
    return parseComponent(activity);
  }
}

export { parseComponent as parseForegroundActivity };
