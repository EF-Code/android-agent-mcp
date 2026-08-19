import type { ForegroundApp } from '../types.js';
import { AdbClient } from './client.js';

const FOCUSED_WINDOW_SCRIPT = '\'dumpsys window windows | grep -m 1 "mCurrentFocus=" || true\'';

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
    // Filter on-device before crossing the ADB transport. OEM window dumps can
    // exceed hundreds of KiB even though the focused component is one line.
    const windows = await this.adb.text(
      this.adb.shell(serial, ['sh', '-c', FOCUSED_WINDOW_SCRIPT], {
        maxOutputBytes: 16_000,
      }),
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
