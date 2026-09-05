import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode } from '../../src/errors/codes.js';
import { AppError } from '../../src/errors/app-error.js';
import { OperationCoordinator } from '../../src/service/operation-coordinator.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('serializes Android operations in FIFO order', async () => {
  const coordinator = new OperationCoordinator();
  const release = deferred();
  const events: string[] = [];
  const first = coordinator.run('first', new AbortController().signal, async () => {
    events.push('first:start');
    await release.promise;
    events.push('first:end');
  });
  const second = coordinator.run('second', new AbortController().signal, async () => {
    events.push('second:start');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('removes a cancelled operation from the queue before it starts', async () => {
  const coordinator = new OperationCoordinator();
  const release = deferred();
  const first = coordinator.run('first', new AbortController().signal, async () => release.promise);
  const cancelled = new AbortController();
  let executed = false;
  const second = coordinator.run('second', cancelled.signal, async () => {
    executed = true;
  });
  cancelled.abort();

  await assert.rejects(
    second,
    (error: unknown) => error instanceof AppError && error.code === ErrorCode.CommandTimeout,
  );
  release.resolve();
  await first;
  assert.equal(executed, false);
});

test('rejects excess queued work with a retryable busy error', async () => {
  const coordinator = new OperationCoordinator(1);
  const release = deferred();
  const first = coordinator.run('first', new AbortController().signal, async () => release.promise);
  const second = coordinator.run('second', new AbortController().signal, async () => undefined);
  const third = coordinator.run('third', new AbortController().signal, async () => undefined);

  await assert.rejects(
    third,
    (error: unknown) =>
      error instanceof AppError && error.code === ErrorCode.ServerBusy && error.retryable,
  );
  release.resolve();
  await Promise.all([first, second]);
});

test('continues draining after an operation fails', async () => {
  const coordinator = new OperationCoordinator();
  const failure = coordinator.run('failure', new AbortController().signal, async () => {
    throw new Error('expected failure');
  });
  const success = coordinator.run('success', new AbortController().signal, async (context) => {
    assert.equal(context.name, 'success');
    assert.match(context.operationId, /^[0-9a-f-]{36}$/u);
    return 42;
  });

  await assert.rejects(failure, /expected failure/u);
  assert.equal(await success, 42);
});
