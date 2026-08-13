import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import type { ServerConfig } from '../config/types.js';

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u');
}

function matchesPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => (pattern.includes('*') || pattern.includes('?') ? globToRegExp(pattern).test(value) : pattern === value));
}

export class Policy {
  constructor(private readonly config: ServerConfig) {}

  isPackageAllowed(packageName: string): boolean {
    return matchesPattern(packageName, this.config.allowedPackages);
  }

  isSensitivePackage(packageName: string | null): boolean {
    return packageName !== null && matchesPattern(packageName, this.config.sensitivePackages);
  }

  assertPackageAllowed(packageName: string): void {
    if (this.isSensitivePackage(packageName)) {
      throw new AppError(ErrorCode.SensitivePackage, 'The selected package is classified as sensitive.', {
        details: { packageName },
      });
    }

    if (!this.isPackageAllowed(packageName)) {
      throw new AppError(ErrorCode.PackageNotAllowed, 'The package is outside the configured allowlist.', {
        details: { packageName, allowedPackagesConfigured: this.config.allowedPackages.length > 0 },
      });
    }
  }

  assertApproval(approved: boolean | undefined, operation: string): void {
    if (this.config.approvalMode === 'allow') {
      return;
    }

    if (this.config.approvalMode === 'deny') {
      throw new AppError(ErrorCode.ApprovalRequired, `Policy denies approval-required operation: ${operation}.`, {
        details: { operation, approvalMode: this.config.approvalMode },
      });
    }

    if (approved !== true) {
      throw new AppError(ErrorCode.ApprovalRequired, `Explicit approval is required for: ${operation}.`, {
        details: { operation, approvalMode: this.config.approvalMode },
      });
    }
  }

  canRecordPackage(packageName: string | null): boolean {
    return packageName !== null && this.isPackageAllowed(packageName) && !this.isSensitivePackage(packageName);
  }
}
