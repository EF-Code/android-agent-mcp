import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import type { ServerConfig } from '../config/types.js';
import type { ForegroundApp } from '../types.js';
import { validatePackageName } from '../validation/common.js';

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u');
}

function matchesPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.includes('*') || pattern.includes('?')
      ? globToRegExp(pattern).test(value)
      : pattern === value,
  );
}

export class Policy {
  constructor(private readonly config: ServerConfig) {}

  isPackageAllowed(packageName: string): boolean {
    try {
      validatePackageName(packageName);
    } catch {
      return false;
    }
    // The default `*` policy intentionally permits general phone control. An
    // explicit package list still narrows the trust boundary for test-only use.
    return matchesPattern(packageName, this.config.allowedPackages);
  }

  isSensitivePackage(packageName: string | null): boolean {
    return packageName !== null && matchesPattern(packageName, this.config.sensitivePackages);
  }

  assertPackageAllowed(packageName: string): void {
    validatePackageName(packageName);
    if (this.isSensitivePackage(packageName)) {
      throw new AppError(
        ErrorCode.SensitivePackage,
        'The selected package is classified as sensitive.',
        {
          details: { packageName },
        },
      );
    }

    if (!this.isPackageAllowed(packageName)) {
      throw new AppError(
        ErrorCode.PackageNotAllowed,
        'The package is outside the configured package policy.',
        {
          details: {
            packageName,
            allowedPackagesConfigured: this.config.allowedPackages.length > 0,
          },
        },
      );
    }
  }

  assertForegroundAllowed(foreground: ForegroundApp, operation: string): string {
    if (foreground.packageName === null) {
      throw new AppError(
        ErrorCode.ForegroundUnknown,
        `Foreground package must be observable before ${operation}.`,
        {
          retryable: true,
          details: { operation, foreground },
        },
      );
    }
    this.assertPackageAllowed(foreground.packageName);
    return foreground.packageName;
  }

  assertObservationAllowed(foreground: ForegroundApp, operation: string): string {
    return this.assertForegroundAllowed(foreground, operation);
  }

  assertMutationAllowed(operation: string): void {
    if (this.config.approvalMode === 'allow') {
      return;
    }

    if (this.config.approvalMode === 'deny') {
      throw new AppError(
        ErrorCode.ApprovalRequired,
        `Policy denies approval-required operation: ${operation}.`,
        {
          details: { operation, approvalMode: this.config.approvalMode },
        },
      );
    }

    throw new AppError(ErrorCode.ApprovalRequired, `Host approval is required for: ${operation}.`, {
      retryable: true,
      details: {
        operation,
        approvalMode: this.config.approvalMode,
        mechanism: 'host-configured-approval-mode',
      },
    });
  }

  canRecordPackage(packageName: string | null): boolean {
    return (
      packageName !== null &&
      this.isPackageAllowed(packageName) &&
      !this.isSensitivePackage(packageName)
    );
  }
}
