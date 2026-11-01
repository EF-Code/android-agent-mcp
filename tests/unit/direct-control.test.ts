import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { AdbClient } from '../../src/adb/client.js';
import {
  ScrcpyDirectControl,
  type DirectControlConnection,
  type DirectControlDependencies,
} from '../../src/scrcpy/direct-control.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function connection() {
  const exit = deferred<void>();
  let clientCloses = 0;
  let adbCloses = 0;
  const value: DirectControlConnection = {
    adb: {
      close: async () => {
        adbCloses += 1;
      },
    },
    client: {
      controller: undefined,
      exited: exit.promise,
      close: async () => {
        clientCloses += 1;
      },
    },
  };
  return { value, exit, counts: () => ({ clientCloses, adbCloses }) };
}

function control(t: TestContext, dependencies: DirectControlDependencies) {
  const adb = new AdbClient({ adbPath: 'unused', defaultTimeoutMs: 1000, maxOutputBytes: 1000 });
  let pushes = 0;
  t.mock.method(adb, 'device', async () => {
    pushes += 1;
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      record: {
        executable: 'adb',
        args: [],
        exitCode: 0,
        signal: null,
        durationMs: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    };
  });
  return { service: new ScrcpyDirectControl(adb, dependencies), pushes: () => pushes };
}

test('caches failed direct startup until close or device reselection', async (t) => {
  let attempts = 0;
  const { service, pushes } = control(t, {
    findServer: async () => '/fake/server',
    connect: async () => {
      attempts += 1;
      throw Object.assign(new Error('startup failed'), {
        output: ['The server version (5.0.1) does not match the client (4.1)'],
      });
    },
  });
  assert.equal(await service.ensureStarted('A'), false);
  assert.equal(await service.ensureStarted('A'), false);
  assert.equal(await service.ensureStarted('A'), false);
  assert.equal(attempts, 1);
  assert.equal(pushes(), 1);
  assert.match(service.diagnostic ?? '', /does not match/u);
  await service.close();
  assert.equal(service.diagnostic, null);
  assert.equal(await service.ensureStarted('A'), false);
  assert.equal(attempts, 2);
  assert.equal(await service.ensureStarted('B'), false);
  assert.equal(attempts, 3);
});

test('missing server lookup is cached without pushing or connecting', async (t) => {
  let lookups = 0;
  const { service, pushes } = control(t, {
    findServer: async () => {
      lookups += 1;
      return null;
    },
    connect: async () => {
      throw new Error('must not connect');
    },
  });
  assert.equal(await service.ensureStarted('A'), false);
  assert.equal(await service.ensureStarted('A'), false);
  assert.equal(lookups, 1);
  assert.equal(pushes(), 0);
  assert.match(service.diagnostic ?? '', /not found/u);
  await service.close();
});

test('same-device concurrent startup shares one transport', async (t) => {
  const ready = deferred<DirectControlConnection>();
  const connecting = deferred<void>();
  const connected = connection();
  const { service, pushes } = control(t, {
    findServer: async () => '/fake/server',
    connect: async () => {
      connecting.resolve();
      return ready.promise;
    },
  });
  const first = service.ensureStarted('A');
  const second = service.ensureStarted('A');
  await connecting.promise;
  ready.resolve(connected.value);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(pushes(), 1);
  assert.equal(await service.ensureStarted('A'), true);
  assert.equal(pushes(), 1);
  await service.close();
  assert.deepEqual(connected.counts(), { clientCloses: 1, adbCloses: 1 });
});

test('close disposes a late startup and cancels waiting requests for another serial', async (t) => {
  const ready = deferred<DirectControlConnection>();
  const connecting = deferred<void>();
  const connected = connection();
  let attempts = 0;
  const { service } = control(t, {
    findServer: async () => '/fake/server',
    connect: async () => {
      attempts += 1;
      connecting.resolve();
      return ready.promise;
    },
  });
  const first = service.ensureStarted('A');
  const otherSerial = service.ensureStarted('B');
  await connecting.promise;
  await service.close();
  ready.resolve(connected.value);
  assert.deepEqual(await Promise.all([first, otherSerial]), [false, false]);
  assert.equal(attempts, 1);
  assert.deepEqual(connected.counts(), { clientCloses: 1, adbCloses: 1 });
});

test('unexpected direct-client exit closes its ADB connection and caches fallback', async (t) => {
  const connected = connection();
  let attempts = 0;
  const { service } = control(t, {
    findServer: async () => '/fake/server',
    connect: async () => {
      attempts += 1;
      return connected.value;
    },
  });
  assert.equal(await service.ensureStarted('A'), true);
  connected.exit.resolve();
  await Promise.resolve();
  assert.equal(await service.ensureStarted('A'), false);
  assert.equal(attempts, 1);
  assert.equal(connected.counts().adbCloses, 1);
  assert.match(service.diagnostic ?? '', /exited/u);
  await service.close();
});

test('different-device startup waits for the first attempt and creates its own connection', async (t) => {
  const ready = deferred<DirectControlConnection>();
  const connecting = deferred<void>();
  const a = connection();
  const b = connection();
  const serials: string[] = [];
  const { service } = control(t, {
    findServer: async () => '/fake/server',
    connect: async (serial) => {
      serials.push(serial);
      if (serial === 'A') {
        connecting.resolve();
        return ready.promise;
      }
      return b.value;
    },
  });
  const first = service.ensureStarted('A');
  const second = service.ensureStarted('B');
  await connecting.promise;
  ready.resolve(a.value);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(serials, ['A', 'B']);
  assert.deepEqual(a.counts(), { clientCloses: 1, adbCloses: 1 });
  assert.equal(await service.ensureStarted('B'), true);
  assert.equal(serials.length, 2);
  await service.close();
  assert.deepEqual(b.counts(), { clientCloses: 1, adbCloses: 1 });
});

test('a cancelled startup cannot clear or overwrite a newer startup', async (t) => {
  const firstReady = deferred<DirectControlConnection>();
  const secondReady = deferred<DirectControlConnection>();
  const firstConnecting = deferred<void>();
  const secondConnecting = deferred<void>();
  const firstConnection = connection();
  const secondConnection = connection();
  let attempts = 0;
  const { service } = control(t, {
    findServer: async () => '/fake/server',
    connect: async () => {
      attempts += 1;
      if (attempts === 1) {
        firstConnecting.resolve();
        return firstReady.promise;
      }
      secondConnecting.resolve();
      return secondReady.promise;
    },
  });
  const first = service.ensureStarted('A');
  await firstConnecting.promise;
  await service.close();
  const second = service.ensureStarted('A');
  await secondConnecting.promise;
  firstReady.resolve(firstConnection.value);
  assert.equal(await first, false);
  const shared = service.ensureStarted('A');
  secondReady.resolve(secondConnection.value);
  assert.deepEqual(await Promise.all([second, shared]), [true, true]);
  assert.equal(attempts, 2);
  assert.deepEqual(firstConnection.counts(), { clientCloses: 1, adbCloses: 1 });
  firstConnection.exit.resolve();
  await Promise.resolve();
  assert.equal(await service.ensureStarted('A'), true);
  await service.close();
  assert.deepEqual(secondConnection.counts(), { clientCloses: 1, adbCloses: 1 });
});
