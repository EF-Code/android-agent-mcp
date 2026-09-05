import { randomUUID } from 'node:crypto';

import { AppError } from '../errors/app-error.js';
import { ErrorCode } from '../errors/codes.js';

export interface OperationContext {
  operationId: string;
  name: string;
  signal: AbortSignal;
  queuedAt: number;
  startedAt: number;
}

interface QueuedOperation<T> {
  name: string;
  signal: AbortSignal;
  queuedAt: number;
  execute: (context: OperationContext) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  abort: () => void;
}

/** Serializes access to the server's single selected-device state. */
export class OperationCoordinator {
  private readonly queue: Array<QueuedOperation<unknown>> = [];
  private running = false;

  constructor(private readonly maxQueued = 100) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) {
      throw new AppError(ErrorCode.ConfigurationInvalid, 'Operation queue limit is invalid.');
    }
  }

  run<T>(
    name: string,
    signal: AbortSignal,
    execute: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(this.cancelled(name, 'before it was queued'));
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(
        new AppError(ErrorCode.ServerBusy, 'The Android operation queue is full.', {
          retryable: true,
          details: { name, maxQueued: this.maxQueued },
        }),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const operation: QueuedOperation<T> = {
        name,
        signal,
        queuedAt: performance.now(),
        execute,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(operation as QueuedOperation<unknown>);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(this.cancelled(name, 'while it was queued'));
        },
      };
      signal.addEventListener('abort', operation.abort, { once: true });
      this.queue.push(operation as QueuedOperation<unknown>);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const operation = this.queue.shift()!;
        operation.signal.removeEventListener('abort', operation.abort);
        if (operation.signal.aborted) {
          operation.reject(this.cancelled(operation.name, 'before it started'));
          continue;
        }
        const context: OperationContext = {
          operationId: randomUUID(),
          name: operation.name,
          signal: operation.signal,
          queuedAt: operation.queuedAt,
          startedAt: performance.now(),
        };
        try {
          operation.resolve(await operation.execute(context));
        } catch (error) {
          operation.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0) void this.drain();
    }
  }

  private cancelled(name: string, phase: string): AppError {
    return new AppError(ErrorCode.CommandTimeout, `Android operation was cancelled ${phase}.`, {
      retryable: true,
      details: { name },
    });
  }
}
