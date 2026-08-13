import { AdbClient } from './client.js';

export interface PackageSummary {
  packageName: string;
  thirdParty: boolean;
  system: boolean;
  enabled: boolean;
}

export interface PackageInfo {
  packageName: string;
  versionName: string | null;
  versionCode: string | null;
  installerPackage: string | null;
  launcherActivity: string | null;
  requestedPermissions: string[];
  grantedRuntimePermissions: string[];
  enabled: boolean | null;
  debuggable: boolean | null;
}

function parsePackageLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.replace(/^package:/u, '').trim())
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(line));
}

function firstMatch(output: string, pattern: RegExp): string | null {
  return pattern.exec(output)?.[1]?.trim() ?? null;
}

export class AdbPackages {
  constructor(private readonly adb: AdbClient) {}

  async list(
    serial: string,
    options: { thirdParty?: boolean; system?: boolean; enabled?: boolean; disabled?: boolean; limit?: number } = {},
  ): Promise<PackageSummary[]> {
    const args = ['pm', 'list', 'packages'];
    if (options.thirdParty === true) args.push('-3');
    if (options.system === true) args.push('-s');
    if (options.enabled === true) args.push('-e');
    if (options.disabled === true) args.push('-d');
    const output = await this.adb.text(this.adb.shell(serial, args, { timeoutMs: 20_000, maxOutputBytes: 2_000_000 }));
    const packageNames = parsePackageLines(output).slice(0, options.limit ?? 2_000);
    return packageNames.map((packageName) => ({
      packageName,
      thirdParty: options.thirdParty === true,
      system: options.system === true,
      enabled: options.disabled !== true,
    }));
  }

  async info(serial: string, packageName: string): Promise<PackageInfo> {
    const output = await this.adb.text(this.adb.shell(serial, ['dumpsys', 'package', packageName], {
      timeoutMs: 20_000,
      maxOutputBytes: 1_000_000,
    }));
    const requestedPermissions = [...output.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*$/gmu)]
      .map((match) => match[1]!)
      .filter((permission) => permission.startsWith('android.permission.'));
    const grantedRuntimePermissions = [...output.matchAll(/^\s*(android\.permission\.[A-Za-z0-9_.-]+): granted=true/mgu)].map(
      (match) => match[1]!,
    );
    const launcherActivity = await this.resolveLauncherActivity(serial, packageName);
    return {
      packageName,
      versionName: firstMatch(output, /versionName=([^\s]+)/u),
      versionCode: firstMatch(output, /versionCode=(\d+)/u),
      installerPackage: firstMatch(output, /installerPackageName=([^\s]+)/u),
      launcherActivity,
      requestedPermissions: [...new Set(requestedPermissions)].slice(0, 500),
      grantedRuntimePermissions: [...new Set(grantedRuntimePermissions)].slice(0, 500),
      enabled: output.includes('enabled=true') ? true : output.includes('enabled=false') ? false : null,
      debuggable: output.includes('DEBUGGABLE') ? true : output.includes('DEBUGGABLE=false') ? false : null,
    };
  }

  async resolveLauncherActivity(serial: string, packageName: string): Promise<string | null> {
    const output = await this.adb.text(this.adb.shell(serial, ['cmd', 'package', 'resolve-activity', '--brief', packageName], {
      timeoutMs: 10_000,
      maxOutputBytes: 16_000,
    }));
    const component = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${packageName}/`));
    return component ?? null;
  }

  async launch(serial: string, packageName: string): Promise<{ component: string | null; output: string }> {
    const component = await this.resolveLauncherActivity(serial, packageName);
    if (component !== null) {
      const output = await this.adb.text(this.adb.shell(serial, ['am', 'start', '-W', '-n', component], {
        timeoutMs: 20_000,
        maxOutputBytes: 64_000,
      }));
      return { component, output };
    }
    const output = await this.adb.text(this.adb.shell(serial, ['monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], {
      timeoutMs: 20_000,
      maxOutputBytes: 64_000,
    }));
    return { component: null, output };
  }

  async stop(serial: string, packageName: string): Promise<void> {
    await this.adb.shell(serial, ['am', 'force-stop', packageName], { timeoutMs: 10_000, maxOutputBytes: 8_192 });
  }

  async clearData(serial: string, packageName: string): Promise<string> {
    return this.adb.text(this.adb.shell(serial, ['pm', 'clear', packageName], { timeoutMs: 30_000, maxOutputBytes: 16_000 }));
  }
}

export { parsePackageLines };
