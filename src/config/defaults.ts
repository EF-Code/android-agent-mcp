import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ServerConfig } from './types.js';

export function defaultConfig(): ServerConfig {
  return {
    adbPath: 'adb',
    scrcpyPath: 'scrcpy',
    autoSelectSingleDevice: true,
    allowedPackages: [],
    sensitivePackages: ['com.android.settings', '*.bank.*', '*.wallet.*', '*.password*'],
    allowedApkRoots: [join(homedir(), 'projects')],
    evidenceRoot: join(homedir(), 'android-device-mcp-evidence'),
    maxScreenshotBytes: 25_000_000,
    maxApkBytes: 500_000_000,
    maxLogBytes: 2_000_000,
    maxCommandOutputBytes: 4_000_000,
    maxEvidenceBytes: 100_000_000,
    maxEvidenceFiles: 500,
    defaultTimeoutMs: 15_000,
    uiSnapshotMaxAgeMs: 3_000,
    approvalMode: 'prompt',
    mirror: {
      maxSize: 1_600,
      maxFps: 30,
      audio: false,
      leaveRunningOnExit: false,
    },
  };
}
