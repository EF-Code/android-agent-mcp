export type RiskClass = 'read_only' | 'interactive' | 'approval_required' | 'prohibited';

export interface Warning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SuccessEnvelope<T> {
  ok: true;
  device_serial?: string;
  observed_at: string;
  data: T;
  warnings: Warning[];
}

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export interface ErrorEnvelope {
  ok: false;
  error: ErrorBody;
}

export type ResultEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface CommandRecord {
  executable: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface CommandOutput {
  stdout: Buffer;
  stderr: Buffer;
  record: CommandRecord;
}

export interface DeviceSummary {
  serial: string;
  transport: string | null;
  state: 'device' | 'unauthorized' | 'offline' | 'no permissions' | 'unknown';
  authorized: boolean;
  selected: boolean;
  model: string | null;
  manufacturer: string | null;
  product: string | null;
  device: string | null;
  usb: string | null;
  transportId: string | null;
  rawAttributes: Record<string, string>;
}

export interface DeviceInfo {
  serial: string;
  manufacturer: string | null;
  model: string | null;
  product: string | null;
  device: string | null;
  androidVersion: string | null;
  apiLevel: number | null;
  abiList: string[];
  resolution: { width: number; height: number } | null;
  density: number | null;
  battery: {
    level: number | null;
    status: string | null;
    plugged: string | null;
    temperatureC: number | null;
  };
  lockState: 'locked' | 'unlocked' | 'unknown';
  foreground: ForegroundApp;
  observedAt: string;
}

export interface ForegroundApp {
  packageName: string | null;
  activity: string | null;
  pid: number | null;
}

export interface DisplayInfo {
  width: number;
  height: number;
  rotation: 0 | 1 | 2 | 3;
}

export interface ScreenObservation {
  display: DisplayInfo;
  foreground: ForegroundApp;
  screenshotSha256?: string;
  observedAt: string;
}
