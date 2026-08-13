export type ApprovalMode = 'prompt' | 'allow' | 'deny';

export interface MirrorConfig {
  maxSize: number;
  maxFps: number;
  audio: boolean;
  leaveRunningOnExit: boolean;
}

export interface ServerConfig {
  adbPath: string;
  scrcpyPath: string;
  autoSelectSingleDevice: boolean;
  allowedPackages: string[];
  sensitivePackages: string[];
  allowedApkRoots: string[];
  evidenceRoot: string;
  maxScreenshotBytes: number;
  maxApkBytes: number;
  maxLogBytes: number;
  maxCommandOutputBytes: number;
  maxEvidenceBytes: number;
  maxEvidenceFiles: number;
  evidenceRetentionMaxAgeMs: number;
  defaultTimeoutMs: number;
  uiSnapshotMaxAgeMs: number;
  approvalMode: ApprovalMode;
  mirror: MirrorConfig;
}
