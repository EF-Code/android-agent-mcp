import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { defaultConfig } from './defaults.js';
import type { ServerConfig } from './types.js';

const configInputSchema = z
  .object({
    adbPath: z.string().min(1),
    scrcpyPath: z.string().min(1),
    autoSelectSingleDevice: z.boolean(),
    allowedPackages: z.array(z.string().min(1)),
    sensitivePackages: z.array(z.string().min(1)),
    allowedApkRoots: z.array(z.string().min(1).refine(isAbsolute, 'must be absolute')),
    evidenceRoot: z.string().min(1).refine(isAbsolute, 'must be absolute'),
    maxScreenshotBytes: z.number().int().min(1_024).max(100_000_000),
    maxLogBytes: z.number().int().min(1_024).max(50_000_000),
    maxCommandOutputBytes: z.number().int().min(1_024).max(100_000_000),
    maxEvidenceBytes: z.number().int().min(1_024).max(1_000_000_000),
    maxEvidenceFiles: z.number().int().min(1).max(10_000),
    defaultTimeoutMs: z.number().int().min(250).max(120_000),
    uiSnapshotMaxAgeMs: z.number().int().min(250).max(60_000),
    approvalMode: z.enum(['prompt', 'allow', 'deny']),
    leaveScrcpyRunningOnExit: z.boolean(),
    mirror: z
      .object({
        maxSize: z.number().int().min(240).max(8_000),
        maxFps: z.number().int().min(1).max(120),
        audio: z.boolean(),
        leaveRunningOnExit: z.boolean(),
      })
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

function numberEnv(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function environmentOverrides(env: NodeJS.ProcessEnv): ConfigInput {
  const overrides: ConfigInput = {};
  const allowedPackages = splitList(env.ANDROID_DEVICE_MCP_ALLOWED_PACKAGES);
  const sensitivePackages = splitList(env.ANDROID_DEVICE_MCP_SENSITIVE_PACKAGES);
  const allowedApkRoots = splitList(env.ANDROID_DEVICE_MCP_ALLOWED_APK_ROOTS);

  if (env.ANDROID_DEVICE_MCP_ADB_PATH !== undefined) overrides.adbPath = env.ANDROID_DEVICE_MCP_ADB_PATH;
  if (env.ANDROID_DEVICE_MCP_SCRCPY_PATH !== undefined) overrides.scrcpyPath = env.ANDROID_DEVICE_MCP_SCRCPY_PATH;
  if (env.ANDROID_DEVICE_MCP_AUTO_SELECT !== undefined) {
    overrides.autoSelectSingleDevice = env.ANDROID_DEVICE_MCP_AUTO_SELECT === 'true';
  }
  if (allowedPackages !== undefined) overrides.allowedPackages = allowedPackages;
  if (sensitivePackages !== undefined) overrides.sensitivePackages = sensitivePackages;
  if (allowedApkRoots !== undefined) overrides.allowedApkRoots = allowedApkRoots;
  if (env.ANDROID_DEVICE_MCP_EVIDENCE_ROOT !== undefined) overrides.evidenceRoot = env.ANDROID_DEVICE_MCP_EVIDENCE_ROOT;
  if (env.ANDROID_DEVICE_MCP_APPROVAL_MODE !== undefined) {
    overrides.approvalMode = env.ANDROID_DEVICE_MCP_APPROVAL_MODE as ConfigInput['approvalMode'];
  }

  const numericFields: Array<[keyof ConfigInput, string]> = [
    ['maxScreenshotBytes', 'ANDROID_DEVICE_MCP_MAX_SCREENSHOT_BYTES'],
    ['maxLogBytes', 'ANDROID_DEVICE_MCP_MAX_LOG_BYTES'],
    ['maxCommandOutputBytes', 'ANDROID_DEVICE_MCP_MAX_COMMAND_OUTPUT_BYTES'],
    ['maxEvidenceBytes', 'ANDROID_DEVICE_MCP_MAX_EVIDENCE_BYTES'],
    ['maxEvidenceFiles', 'ANDROID_DEVICE_MCP_MAX_EVIDENCE_FILES'],
    ['defaultTimeoutMs', 'ANDROID_DEVICE_MCP_DEFAULT_TIMEOUT_MS'],
    ['uiSnapshotMaxAgeMs', 'ANDROID_DEVICE_MCP_UI_SNAPSHOT_MAX_AGE_MS'],
  ];

  for (const [field, variable] of numericFields) {
    const value = numberEnv(env[variable]);
    if (value !== undefined) {
      overrides[field] = value as never;
    }
  }

  return overrides;
}

function readJsonConfig(configPath: string): unknown {
  if (!existsSync(configPath)) {
    throw new AppError(ErrorCode.ConfigurationInvalid, `Configuration file does not exist: ${configPath}`, {
      details: { configPath },
    });
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new AppError(ErrorCode.ConfigurationInvalid, `Configuration file is not valid JSON: ${configPath}`, {
      details: { configPath },
      cause: error,
    });
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

export function loadConfig(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): ServerConfig {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env.ANDROID_DEVICE_MCP_CONFIG;
  const fileConfig = configPath === undefined ? {} : readJsonConfig(configPath);
  const input = validateInput(fileConfig);
  const overrides = validateInput(environmentOverrides(env));
  const defaults = defaultConfig();

  return {
    ...defaults,
    ...input,
    ...overrides,
    mirror: {
      ...defaults.mirror,
      ...(input.mirror ?? {}),
      ...(overrides.mirror ?? {}),
    },
  };
}
