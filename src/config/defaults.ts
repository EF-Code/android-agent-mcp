import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ServerConfig } from './types.js';

export function defaultConfig(): ServerConfig {
  return {
    adbPath: 'adb',
    scrcpyPath: 'scrcpy',
    autoSelectSingleDevice: true,
    // An Android-control agent should work with ordinary installed apps without
    // requiring a new package entry for every task. Sensitive patterns remain a
    // separate fail-closed boundary for credentials and financial applications.
    allowedPackages: ['*'],
    sensitivePackages: ['*.bank.*', '*.wallet.*', '*.password*'],
    allowedRuntimePermissions: [],
    allowedApkRoots: [join(homedir(), 'projects')],
    evidenceRoot: join(homedir(), 'android-agent-mcp-evidence'),
    maxScreenshotBytes: 25_000_000,
    maxApkBytes: 500_000_000,
    maxLogBytes: 2_000_000,
    maxCommandOutputBytes: 4_000_000,
    maxEvidenceBytes: 100_000_000,
    maxEvidenceFiles: 500,
    evidenceRetentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
    defaultTimeoutMs: 15_000,
    uiSnapshotMaxAgeMs: 3_000,
    displayGeometryMaxAgeMs: 10_000,
    approvalMode: 'prompt',
    mirror: {
      autoStart: true,
      maxSize: 1_600,
      maxFps: 30,
      audio: false,
      leaveRunningOnExit: false,
    },
  };
}
