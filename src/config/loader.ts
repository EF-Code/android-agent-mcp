import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { defaultConfig } from './defaults.js';
import type { MirrorConfig, ServerConfig } from './types.js';

const configInputSchema = z
  .object({
    adbPath: z.string().min(1),
    scrcpyPath: z.string().min(1),
    autoSelectSingleDevice: z.boolean(),
    allowedPackages: z.array(z.string().min(1)),
    sensitivePackages: z.array(z.string().min(1)),
    allowedRuntimePermissions: z.array(z.string().regex(/^android\.permission\.[A-Z0-9_]+$/u)),
    allowedApkRoots: z.array(z.string().min(1).refine(isAbsolute, 'must be absolute')),
    evidenceRoot: z.string().min(1).refine(isAbsolute, 'must be absolute'),
    maxScreenshotBytes: z.number().int().min(1_024).max(100_000_000),
    maxApkBytes: z.number().int().min(1_024).max(2_000_000_000),
    maxLogBytes: z.number().int().min(1_024).max(50_000_000),
    maxCommandOutputBytes: z.number().int().min(1_024).max(100_000_000),
    maxEvidenceBytes: z.number().int().min(1_024).max(1_000_000_000),
    maxEvidenceFiles: z.number().int().min(1).max(10_000),
    evidenceRetentionMaxAgeMs: z
      .number()
      .int()
      .min(60 * 60 * 1_000)
      .max(365 * 24 * 60 * 60 * 1_000),
    defaultTimeoutMs: z.number().int().min(250).max(120_000),
    uiSnapshotMaxAgeMs: z.number().int().min(250).max(60_000),
    displayGeometryMaxAgeMs: z.number().int().min(250).max(60_000),
    approvalMode: z.enum(['prompt', 'allow', 'deny']),
    mirror: z
      .object({
        autoStart: z.boolean(),
        maxSize: z.number().int().min(240).max(8_000),
        maxFps: z.number().int().min(1).max(120),
        audio: z.boolean(),
        leaveRunningOnExit: z.boolean(),
      })
      .strict()
      .partial(),
  })
  .partial()
  .strict();

type ConfigInput = z.infer<typeof configInputSchema>;

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function numberEnv(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new AppError(ErrorCode.ConfigurationInvalid, `Environment variable ${name} is invalid.`, {
      details: { name, expected: 'finite integer' },
    });
  }
  return parsed;
}

function booleanEnv(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AppError(ErrorCode.ConfigurationInvalid, `Environment variable ${name} is invalid.`, {
    details: { name, expected: 'true or false' },
  });
}

function environmentValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    if (env[name] !== undefined) return env[name];
  }
  return undefined;
}

function environmentOverrides(env: NodeJS.ProcessEnv): ConfigInput {
  const overrides: ConfigInput = {};
  const value = (name: string): string | undefined =>
    environmentValue(
      env,
      `ANDROID_AGENT_MCP_${name}`,
      `ANDROID_MCP_${name}`,
      `ANDROID_DEVICE_MCP_${name}`,
    );
  const allowedPackages = splitList(value('ALLOWED_PACKAGES'));
  const sensitivePackages = splitList(value('SENSITIVE_PACKAGES'));
  const allowedRuntimePermissions = splitList(value('ALLOWED_RUNTIME_PERMISSIONS'));
  const allowedApkRoots = splitList(value('ALLOWED_APK_ROOTS'));
  const mirrorAutoStart = booleanEnv(
    value('MIRROR_AUTO_START'),
    'ANDROID_AGENT_MCP_MIRROR_AUTO_START',
  );

  const adbPath = value('ADB_PATH');
  const scrcpyPath = value('SCRCPY_PATH');
  const autoSelect = value('AUTO_SELECT');
  const evidenceRoot = value('EVIDENCE_ROOT');
  const approvalMode = value('APPROVAL_MODE');
  if (adbPath !== undefined) overrides.adbPath = adbPath;
  if (scrcpyPath !== undefined) overrides.scrcpyPath = scrcpyPath;
  if (autoSelect !== undefined) {
    overrides.autoSelectSingleDevice = booleanEnv(autoSelect, 'ANDROID_AGENT_MCP_AUTO_SELECT')!;
  }
  if (allowedPackages !== undefined) overrides.allowedPackages = allowedPackages;
  if (sensitivePackages !== undefined) overrides.sensitivePackages = sensitivePackages;
  if (allowedRuntimePermissions !== undefined)
    overrides.allowedRuntimePermissions = allowedRuntimePermissions;
  if (allowedApkRoots !== undefined) overrides.allowedApkRoots = allowedApkRoots;
  if (evidenceRoot !== undefined) overrides.evidenceRoot = evidenceRoot;
  if (approvalMode !== undefined) {
    overrides.approvalMode = approvalMode as ConfigInput['approvalMode'];
  }
  if (mirrorAutoStart !== undefined) overrides.mirror = { autoStart: mirrorAutoStart };

  const numericFields: Array<[keyof ConfigInput, string]> = [
    ['maxScreenshotBytes', 'MAX_SCREENSHOT_BYTES'],
    ['maxApkBytes', 'MAX_APK_BYTES'],
    ['maxLogBytes', 'MAX_LOG_BYTES'],
    ['maxCommandOutputBytes', 'MAX_COMMAND_OUTPUT_BYTES'],
    ['maxEvidenceBytes', 'MAX_EVIDENCE_BYTES'],
    ['maxEvidenceFiles', 'MAX_EVIDENCE_FILES'],
    ['evidenceRetentionMaxAgeMs', 'EVIDENCE_RETENTION_MAX_AGE_MS'],
    ['defaultTimeoutMs', 'DEFAULT_TIMEOUT_MS'],
    ['uiSnapshotMaxAgeMs', 'UI_SNAPSHOT_MAX_AGE_MS'],
    ['displayGeometryMaxAgeMs', 'DISPLAY_GEOMETRY_MAX_AGE_MS'],
  ];

  for (const [field, variable] of numericFields) {
    const numericValue = numberEnv(value(variable), `ANDROID_AGENT_MCP_${variable}`);
    if (numericValue !== undefined) {
      overrides[field] = numericValue as never;
    }
  }

  return overrides;
}

function readJsonConfig(configPath: string): unknown {
  if (!existsSync(configPath)) {
    throw new AppError(
      ErrorCode.ConfigurationInvalid,
      `Configuration file does not exist: ${configPath}`,
      {
        details: { configPath },
      },
    );
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new AppError(
      ErrorCode.ConfigurationInvalid,
      `Configuration file is not valid JSON: ${configPath}`,
      {
        details: { configPath },
        cause: error,
      },
    );
  }
}

function validateInput(input: unknown): ConfigInput {
  const result = configInputSchema.safeParse(input);
  if (!result.success) {
    throw new AppError(ErrorCode.ConfigurationInvalid, 'Configuration values are invalid.', {
      details: { issues: result.error.issues },
    });
  }

  return result.data;
}

export function loadConfig(
  options: { configPath?: string; env?: NodeJS.ProcessEnv } = {},
): ServerConfig {
  const env = options.env ?? process.env;
  const configPath =
    options.configPath ??
    environmentValue(
      env,
      'ANDROID_AGENT_MCP_CONFIG',
      'ANDROID_MCP_CONFIG',
      'ANDROID_DEVICE_MCP_CONFIG',
    );
  const fileConfig = configPath === undefined ? {} : readJsonConfig(configPath);
  const input = validateInput(fileConfig);
  const overrides = validateInput(environmentOverrides(env));
  const defaults = defaultConfig();

  const mirror: MirrorConfig = {
    autoStart: overrides.mirror?.autoStart ?? input.mirror?.autoStart ?? defaults.mirror.autoStart,
    maxSize: overrides.mirror?.maxSize ?? input.mirror?.maxSize ?? defaults.mirror.maxSize,
    maxFps: overrides.mirror?.maxFps ?? input.mirror?.maxFps ?? defaults.mirror.maxFps,
    audio: overrides.mirror?.audio ?? input.mirror?.audio ?? defaults.mirror.audio,
    leaveRunningOnExit:
      overrides.mirror?.leaveRunningOnExit ??
      input.mirror?.leaveRunningOnExit ??
      defaults.mirror.leaveRunningOnExit,
  };

  return {
    adbPath: overrides.adbPath ?? input.adbPath ?? defaults.adbPath,
    scrcpyPath: overrides.scrcpyPath ?? input.scrcpyPath ?? defaults.scrcpyPath,
    autoSelectSingleDevice:
      overrides.autoSelectSingleDevice ??
      input.autoSelectSingleDevice ??
      defaults.autoSelectSingleDevice,
    allowedPackages: overrides.allowedPackages ?? input.allowedPackages ?? defaults.allowedPackages,
    sensitivePackages:
      overrides.sensitivePackages ?? input.sensitivePackages ?? defaults.sensitivePackages,
    allowedRuntimePermissions:
      overrides.allowedRuntimePermissions ??
      input.allowedRuntimePermissions ??
      defaults.allowedRuntimePermissions,
    allowedApkRoots: overrides.allowedApkRoots ?? input.allowedApkRoots ?? defaults.allowedApkRoots,
    evidenceRoot: overrides.evidenceRoot ?? input.evidenceRoot ?? defaults.evidenceRoot,
    maxScreenshotBytes:
      overrides.maxScreenshotBytes ?? input.maxScreenshotBytes ?? defaults.maxScreenshotBytes,
    maxApkBytes: overrides.maxApkBytes ?? input.maxApkBytes ?? defaults.maxApkBytes,
    maxLogBytes: overrides.maxLogBytes ?? input.maxLogBytes ?? defaults.maxLogBytes,
    maxCommandOutputBytes:
      overrides.maxCommandOutputBytes ??
      input.maxCommandOutputBytes ??
      defaults.maxCommandOutputBytes,
    maxEvidenceBytes:
      overrides.maxEvidenceBytes ?? input.maxEvidenceBytes ?? defaults.maxEvidenceBytes,
    maxEvidenceFiles:
      overrides.maxEvidenceFiles ?? input.maxEvidenceFiles ?? defaults.maxEvidenceFiles,
    evidenceRetentionMaxAgeMs:
      overrides.evidenceRetentionMaxAgeMs ??
      input.evidenceRetentionMaxAgeMs ??
      defaults.evidenceRetentionMaxAgeMs,
    defaultTimeoutMs:
      overrides.defaultTimeoutMs ?? input.defaultTimeoutMs ?? defaults.defaultTimeoutMs,
    uiSnapshotMaxAgeMs:
      overrides.uiSnapshotMaxAgeMs ?? input.uiSnapshotMaxAgeMs ?? defaults.uiSnapshotMaxAgeMs,
    displayGeometryMaxAgeMs:
      overrides.displayGeometryMaxAgeMs ??
      input.displayGeometryMaxAgeMs ??
      defaults.displayGeometryMaxAgeMs,
    approvalMode: overrides.approvalMode ?? input.approvalMode ?? defaults.approvalMode,
    mirror,
  };
}
