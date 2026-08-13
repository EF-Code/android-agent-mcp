import type { ErrorCodeValue } from './codes.js';

export interface AppErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCodeValue | string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCodeValue | string, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }

  toJSON(): {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError('INTERNAL_ERROR', error.message, { cause: error });
  }

  return new AppError('INTERNAL_ERROR', 'An unknown error occurred.', { details: { value: error } });
}
