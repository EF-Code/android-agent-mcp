import { randomUUID } from 'node:crypto';

import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import type { ForegroundApp } from '../types.js';
import type { UiSnapshot } from './types.js';

export class SnapshotStore {
  private readonly snapshots = new Map<string, UiSnapshot>();
  private currentId: string | null = null;

  constructor(private readonly maxAgeMs: number, private readonly maxSnapshots = 20) {}

  put(snapshot: Omit<UiSnapshot, 'snapshotId'> & { snapshotId?: string }): UiSnapshot {
    const stored: UiSnapshot = {
      ...snapshot,
      snapshotId: snapshot.snapshotId ?? randomUUID(),
    };
    this.snapshots.set(stored.snapshotId, stored);
    this.currentId = stored.snapshotId;
    while (this.snapshots.size > this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    return stored;
  }

  get(snapshotId?: string): UiSnapshot | null {
    const id = snapshotId ?? this.currentId;
    return id === null ? null : (this.snapshots.get(id) ?? null);
  }

  requireFresh(snapshotId: string | undefined, foreground?: ForegroundApp): UiSnapshot {
    const snapshot = this.get(snapshotId);
    if (snapshot === null) {
      throw new AppError(ErrorCode.StaleUiSnapshot, 'UI snapshot is missing or no longer retained.', {
        retryable: true,
        details: { snapshotId },
      });
    }

    const ageMs = Date.now() - Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(ageMs) || ageMs > this.maxAgeMs) {
      throw new AppError(ErrorCode.StaleUiSnapshot, 'UI snapshot is older than the configured freshness window.', {
        retryable: true,
        details: { snapshotId: snapshot.snapshotId, ageMs, maxAgeMs: this.maxAgeMs },
      });
    }

    if (
      foreground !== undefined &&
      (foreground.packageName !== snapshot.foreground.packageName || foreground.activity !== snapshot.foreground.activity)
    ) {
      throw new AppError(ErrorCode.StaleUiSnapshot, 'Foreground application changed after the UI snapshot was captured.', {
        retryable: true,
        details: {
          snapshotId: snapshot.snapshotId,
          snapshotForeground: snapshot.foreground,
          currentForeground: foreground,
        },
      });
    }

    return snapshot;
  }

  invalidate(): void {
    this.snapshots.clear();
    this.currentId = null;
  }
}
