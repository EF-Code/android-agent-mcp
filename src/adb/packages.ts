import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { AdbClient } from './client.js';

export interface PackageSummary {
  packageName: string;
  thirdParty: boolean | null;
  system: boolean | null;
  enabled: boolean | null;
}

export interface PackageInfo {
  packageName: string;
  versionName: string | null;
  versionCode: string | null;
  minSdkVersion: number | null;
  targetSdkVersion: number | null;
  sourcePath: string | null;
  primaryCpuAbi: string | null;
  installerPackage: string | null;
  launcherActivity: string | null;
  requestedPermissions: string[];
  grantedRuntimePermissions: string[];
  enabled: boolean | null;
  debuggable: boolean | null;
}

export interface PackageEntry {
  packageName: string;
  sourcePath: string | null;
}

export function parsePackageEntries(output: string): PackageEntry[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.replace(/^package:/u, '').trim())
    .flatMap((line) => {
      const separator = line.lastIndexOf('=');
      const packageName = (separator < 0 ? line : line.slice(separator + 1)).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(packageName)) return [];
      return [{ packageName, sourcePath: separator < 0 ? null : line.slice(0, separator) || null }];
    });
}

function parsePackageLines(output: string): string[] {
  return parsePackageEntries(output).map((entry) => entry.packageName);
}

function firstMatch(output: string, pattern: RegExp): string | null {
  return pattern.exec(output)?.[1]?.trim() ?? null;
}

function firstNumber(output: string, pattern: RegExp): number | null {
  const value = firstMatch(output, pattern);
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export class AdbPackages {
  constructor(private readonly adb: AdbClient) {}

  async list(
    serial: string,
    options: {
      thirdParty?: boolean;
      system?: boolean;
      enabled?: boolean;
      disabled?: boolean;
      limit?: number;
    } = {},
  ): Promise<PackageSummary[]> {
    if (options.enabled === true && options.disabled === true) {
      throw new AppError(
        ErrorCode.InvalidInput,
        'app.list cannot request both enabled and disabled packages.',
      );
    }
    if (options.thirdParty === true && options.system === true) {
      throw new AppError(
        ErrorCode.InvalidInput,
        'app.list cannot request both third-party and system packages.',
      );
    }

    const command = (flags: string[]): Promise<string> =>
      this.adb.text(
        this.adb.shell(serial, ['pm', 'list', 'packages', ...flags], {
          timeoutMs: 20_000,
          maxOutputBytes: 2_000_000,
        }),
      );
    const [allOutput, thirdPartyOutput, systemOutput, enabledOutput, disabledOutput] =
      await Promise.all([
        command(['-f']),
        command(['-3']),
        command(['-s']),
        command(['-e']),
        command(['-d']),
      ]);
    const thirdParty = new Set(parsePackageLines(thirdPartyOutput));
    const system = new Set(parsePackageLines(systemOutput));
    const enabled = new Set(parsePackageLines(enabledOutput));
    const disabled = new Set(parsePackageLines(disabledOutput));
    return parsePackageEntries(allOutput)
      .map(({ packageName }) => ({
        packageName,
        thirdParty: thirdParty.has(packageName) ? true : system.has(packageName) ? false : null,
        system: system.has(packageName) ? true : thirdParty.has(packageName) ? false : null,
        enabled: enabled.has(packageName) ? true : disabled.has(packageName) ? false : null,
      }))
      .filter(
        (entry) => options.thirdParty === undefined || entry.thirdParty === options.thirdParty,
      )
      .filter((entry) => options.system === undefined || entry.system === options.system)
      .filter((entry) => options.enabled === undefined || entry.enabled === options.enabled)
      .filter(
        (entry) =>
          options.disabled === undefined ||
          (options.disabled ? entry.enabled === false : entry.enabled !== false),
      )
      .slice(0, options.limit ?? 2_000);
  }

  async info(serial: string, packageName: string): Promise<PackageInfo> {
    const output = await this.adb.text(
      this.adb.shell(serial, ['dumpsys', 'package', packageName], {
        timeoutMs: 20_000,
        maxOutputBytes: 1_000_000,
      }),
    );
    const requestedPermissions = [...output.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*$/gmu)]
      .map((match) => match[1]!)
      .filter((permission) => permission.startsWith('android.permission.'));
    const grantedRuntimePermissions = [
      ...output.matchAll(/^\s*(android\.permission\.[A-Za-z0-9_.-]+): granted=true/gmu),
    ].map((match) => match[1]!);
    const launcherActivity = await this.resolveLauncherActivity(serial, packageName);
    return {
      packageName,
      versionName: firstMatch(output, /versionName=([^\s]+)/u),
      versionCode: firstMatch(output, /versionCode=(\d+)/u),
      minSdkVersion: firstNumber(output, /minSdk=([0-9]+)/u),
      targetSdkVersion: firstNumber(output, /targetSdk=([0-9]+)/u),
      sourcePath: firstMatch(output, /(?:codePath|path)=([^\s]+)/u),
      primaryCpuAbi: firstMatch(output, /primaryCpuAbi=([^\s]+)/u),
      installerPackage: firstMatch(output, /installerPackageName=([^\s]+)/u),
      launcherActivity,
      requestedPermissions: [...new Set(requestedPermissions)].slice(0, 500),
      grantedRuntimePermissions: [...new Set(grantedRuntimePermissions)].slice(0, 500),
      enabled: output.includes('enabled=true')
        ? true
        : output.includes('enabled=false')
          ? false
          : null,
      debuggable: /DEBUGGABLE(?:\s|$)/u.test(output)
        ? true
        : /DEBUGGABLE=false/u.test(output)
          ? false
          : null,
    };
  }

  async resolveLauncherActivity(serial: string, packageName: string): Promise<string | null> {
    const output = await this.adb.text(
      this.adb.shell(serial, ['cmd', 'package', 'resolve-activity', '--brief', packageName], {
        timeoutMs: 10_000,
        maxOutputBytes: 16_000,
      }),
    );
    const component = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${packageName}/`));
    return component ?? null;
  }

  async launch(
    serial: string,
    packageName: string,
  ): Promise<{ component: string | null; output: string }> {
    const component = await this.resolveLauncherActivity(serial, packageName);
    if (component !== null) {
      const output = await this.adb.text(
        this.adb.shell(serial, ['am', 'start', '-W', '-n', component], {
          timeoutMs: 20_000,
          maxOutputBytes: 64_000,
        }),
      );
      return { component, output };
    }
    const output = await this.adb.text(
      this.adb.shell(
        serial,
        ['monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
        {
          timeoutMs: 20_000,
          maxOutputBytes: 64_000,
        },
      ),
    );
    return { component: null, output };
  }

  async stop(serial: string, packageName: string): Promise<void> {
    await this.adb.shell(serial, ['am', 'force-stop', packageName], {
      timeoutMs: 10_000,
      maxOutputBytes: 8_192,
    });
  }

  async clearData(serial: string, packageName: string): Promise<string> {
    return this.adb.text(
      this.adb.shell(serial, ['pm', 'clear', packageName], {
        timeoutMs: 30_000,
        maxOutputBytes: 16_000,
      }),
    );
  }
}

export { parsePackageLines };
