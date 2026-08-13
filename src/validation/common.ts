import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';

const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PACKAGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateSerial(serial: string): string {
  if (!SERIAL_PATTERN.test(serial)) {
    throw new AppError(ErrorCode.InvalidSerial, 'Device serial contains unsupported characters.', {
      details: { serial: '[REDACTED]' },
    });
  }

  return serial;
}

export function validatePackageName(packageName: string): string {
  if (!PACKAGE_PATTERN.test(packageName) || packageName.length > 255) {
    throw new AppError(
      ErrorCode.InvalidPackage,
      'Package name is not a valid Android package name.',
      {
        details: { packageName },
      },
    );
  }

  return packageName;
}

export function validateCoordinate(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new AppError(ErrorCode.InvalidCoordinates, `${name} must be a non-negative integer.`, {
      details: { name, value },
    });
  }

  return value;
}

export function validateDuration(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new AppError(
      ErrorCode.InvalidInput,
      `${name} must be an integer between 0 and ${maximum}.`,
      {
        details: { name, value, maximum },
      },
    );
  }

  return value;
}

export function validateLabel(label: string): string {
  if (!LABEL_PATTERN.test(label)) {
    throw new AppError(ErrorCode.InvalidInput, 'Label contains unsupported filename characters.', {
      details: { label },
    });
  }

  return label;
}

export function validateNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AppError(ErrorCode.InvalidInput, `${name} must not be empty.`, {
      details: { name },
    });
  }

  return normalized;
}
