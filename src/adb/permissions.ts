import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import { AdbClient } from './client.js';
import { AdbPackages } from './packages.js';

export interface PermissionState {
  permission: string;
  requested: boolean;
  granted: boolean;
}

const SPECIAL_PERMISSION_PREFIXES = [
  'android.permission.MANAGE_',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.PACKAGE_USAGE_STATS',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.ACCESS_NOTIFICATION_POLICY',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.WRITE_SETTINGS',
  'android.permission.SYSTEM_',
  'android.permission.PACKAGE_',
  'android.permission.BIND_',
  'android.permission.CHANGE_COMPONENT_ENABLED_STATE',
  'android.permission.MOUNT_UNMOUNT_FILESYSTEMS',
  'android.permission.INTERACT_ACROSS_USERS',
  'android.permission.NOTIFICATION_',
  'android.permission.VPN_',
];

export function isSpecialPermission(permission: string): boolean {
  return SPECIAL_PERMISSION_PREFIXES.some((prefix) => permission.startsWith(prefix));
}

export class AdbPermissions {
  constructor(private readonly adb: AdbClient, private readonly packages: AdbPackages) {}

  async list(serial: string, packageName: string): Promise<PermissionState[]> {
    const info = await this.packages.info(serial, packageName);
    return info.requestedPermissions.map((permission) => ({
      permission,
      requested: true,
      granted: info.grantedRuntimePermissions.includes(permission),
    }));
  }

  async set(serial: string, packageName: string, permission: string, action: 'grant' | 'revoke'): Promise<void> {
    if (!/^android\.permission\.[A-Z0-9_]+$/u.test(permission)) {
      throw new AppError(ErrorCode.InvalidInput, 'Permission name is not a valid Android permission.');
    }
    if (isSpecialPermission(permission)) {
      throw new AppError(ErrorCode.ProhibitedOperation, 'Special access and policy-level permissions are not changeable in version 1.', {
        details: { permission },
      });
    }
    const info = await this.packages.info(serial, packageName);
    if (!info.requestedPermissions.includes(permission)) {
      throw new AppError(ErrorCode.PermissionNotRequested, 'The package did not request this permission.', {
        details: { packageName, permission },
      });
    }
    await this.adb.shell(serial, ['pm', action, packageName, permission], { timeoutMs: 15_000, maxOutputBytes: 16_000 });
  }
}
