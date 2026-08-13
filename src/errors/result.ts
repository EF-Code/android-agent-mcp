import type { ErrorEnvelope, ResultEnvelope, SuccessEnvelope, Warning } from '../types.js';
import { asAppError } from './app-error.js';

export function ok<T>(
  data: T,
  options: { deviceSerial?: string; warnings?: Warning[] } = {},
): SuccessEnvelope<T> {
  const envelope: SuccessEnvelope<T> = {
    ok: true,
    observed_at: new Date().toISOString(),
    data,
    warnings: options.warnings ?? [],
  };

  if (options.deviceSerial !== undefined) {
    envelope.device_serial = options.deviceSerial;
  }

  return envelope;
}

export function fail(error: unknown): ErrorEnvelope {
  return {
    ok: false,
    error: asAppError(error).toJSON(),
  };
}

export function isSuccess<T>(result: ResultEnvelope<T>): result is SuccessEnvelope<T> {
  return result.ok;
}
