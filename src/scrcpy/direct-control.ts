import { access } from 'node:fs/promises';

import type { Adb } from '@yume-chan/adb';
import {
  AdbScrcpyClient,
  AdbScrcpyOptions4_1,
  type AdbScrcpyClient as AdbScrcpyClientType,
} from '@yume-chan/adb-scrcpy';
import { AdbServerNodeJsClient } from '@yume-chan/adb-server-node-tcp';
import {
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
} from '@yume-chan/scrcpy';

import type { AdbClient } from '../adb/client.js';
import { KEY_CODES, type InputSequenceAction } from '../adb/input.js';
import { redactLogText } from '../policy/redaction.js';

const REMOTE_SERVER_PATH = '/data/local/tmp/android-agent-mcp-scrcpy-server.jar';
type DirectOptions = AdbScrcpyOptions4_1<{
  video: false;
  videoCodec: 'h264';
  audio: false;
  control: true;
  clipboardAutosync: false;
  logLevel: 'error';
}>;
const SERVER_CANDIDATES = [
  process.env.ANDROID_AGENT_MCP_SCRCPY_SERVER_PATH,
  '/usr/share/scrcpy/scrcpy-server',
  '/usr/local/share/scrcpy/scrcpy-server',
].filter((value): value is string => value !== undefined && value.length > 0);

async function findServer(): Promise<string | null> {
  for (const candidate of SERVER_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard installation location.
    }
  }
  return null;
}

export interface DirectControlConnection {
  adb: Pick<Adb, 'close'>;
  client: {
    controller:
      | Pick<AdbScrcpyClientType<DirectOptions>['controller'], 'injectTouch' | 'injectKeyCode'>
      | undefined;
    exited: Promise<void>;
    close(): Promise<void>;
  };
}

export interface DirectControlDependencies {
  findServer(): Promise<string | null>;
  connect(serial: string): Promise<DirectControlConnection>;
}

async function connect(serial: string): Promise<DirectControlConnection> {
  const adb = await new AdbServerNodeJsClient().createAdb({ serial });
  try {
    const client = await AdbScrcpyClient.start(
      adb,
      REMOTE_SERVER_PATH,
      new AdbScrcpyOptions4_1({
        video: false,
        videoCodec: 'h264',
        audio: false,
        control: true,
        clipboardAutosync: false,
        logLevel: 'error',
      }),
    );
    return { adb, client };
  } catch (error) {
    await adb.close().catch(() => undefined);
    throw error;
  }
}

function startupDiagnostic(error: unknown): string {
  const output =
    typeof error === 'object' && error !== null && 'output' in error ? error.output : null;
  const message = Array.isArray(output)
    ? output
        .filter((line): line is string => typeof line === 'string')
        .slice(0, 2)
        .join('\n')
    : error instanceof Error
      ? error.message
      : String(error);
  return redactLogText(message).slice(0, 1000);
}

export class ScrcpyDirectControl {
  private adb: DirectControlConnection['adb'] | null = null;
  private client: DirectControlConnection['client'] | null = null;
  private serial: string | null = null;
  private starting: Promise<boolean> | null = null;
  private startingSerial: string | null = null;
  private unavailableSerial: string | null = null;
  private generation = 0;
  private failure: string | null = null;

  constructor(
    private readonly adbCli: AdbClient,
    private readonly dependencies: DirectControlDependencies = { findServer, connect },
  ) {}

  get diagnostic(): string | null {
    return this.failure;
  }

  async ensureStarted(serial: string): Promise<boolean> {
    if (this.client !== null && this.serial === serial) return true;
    if (this.unavailableSerial === serial) return false;
    if (this.starting !== null) {
      if (this.startingSerial === serial) return this.starting;
      const generation = this.generation;
      await this.starting;
      if (generation !== this.generation) return false;
      return this.ensureStarted(serial);
    }
    const generation = this.generation;
    const pending = this.start(serial, generation)
      .then((ready) => {
        if (!ready && generation === this.generation) this.unavailableSerial = serial;
        return ready;
      })
      .finally(() => {
        if (this.starting === pending) {
          this.starting = null;
          this.startingSerial = null;
        }
      });
    this.starting = pending;
    this.startingSerial = serial;
    return pending;
  }

  private async start(serial: string, generation: number): Promise<boolean> {
    await this.closeActive();
    try {
      if (generation !== this.generation) return false;
      const serverPath = await this.dependencies.findServer();
      if (generation !== this.generation) return false;
      if (serverPath === null) {
        this.failure =
          'A compatible scrcpy server was not found; using ADB input until device reselection.';
        return false;
      }
      await this.adbCli.device(serial, ['push', serverPath, REMOTE_SERVER_PATH], {
        timeoutMs: 30_000,
        maxOutputBytes: 64_000,
      });
      if (generation !== this.generation) return false;
      const { adb, client } = await this.dependencies.connect(serial);
      if (generation !== this.generation) {
        await client.close().catch(() => undefined);
        await adb.close().catch(() => undefined);
        return false;
      }
      this.adb = adb;
      this.client = client;
      this.serial = serial;
      this.failure = null;
      this.unavailableSerial = null;
      const exited = () => {
        if (this.client !== client) return;
        this.client = null;
        this.adb = null;
        this.serial = null;
        this.unavailableSerial = serial;
        this.failure = 'scrcpy direct control exited; using ADB input until device reselection.';
        void adb.close().catch(() => undefined);
      };
      void client.exited.then(exited, exited);
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.failure = startupDiagnostic(error);
        await this.closeActive();
      }
      return false;
    }
  }

  private async touch(
    action: AndroidMotionEventAction,
    x: number,
    y: number,
    width: number,
    height: number,
    pressure: number,
  ): Promise<void> {
    const controller = this.client?.controller;
    if (controller === undefined) throw new Error('scrcpy direct control is not running.');
    await controller.injectTouch({
      action,
      pointerId: ScrcpyPointerId.Finger,
      pointerX: x,
      pointerY: y,
      videoWidth: width,
      videoHeight: height,
      pressure,
      actionButton: AndroidMotionEventButton.None,
      buttons: AndroidMotionEventButton.None,
    });
  }

  async sequence(
    actions: readonly InputSequenceAction[],
    width: number,
    height: number,
    interActionDelayMs = 0,
  ): Promise<void> {
    const controller = this.client?.controller;
    if (controller === undefined) throw new Error('scrcpy direct control is not running.');
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index]!;
      if (action.type === 'tap') {
        await this.touch(AndroidMotionEventAction.Down, action.x, action.y, width, height, 1);
        await this.touch(AndroidMotionEventAction.Up, action.x, action.y, width, height, 0);
      } else if (action.type === 'swipe') {
        await this.touch(
          AndroidMotionEventAction.Down,
          action.startX,
          action.startY,
          width,
          height,
          1,
        );
        const steps = Math.max(1, Math.ceil(action.durationMs / 16));
        for (let step = 1; step < steps; step += 1) {
          await new Promise((resolve) => setTimeout(resolve, action.durationMs / steps));
          await this.touch(
            AndroidMotionEventAction.Move,
            Math.round(action.startX + ((action.endX - action.startX) * step) / steps),
            Math.round(action.startY + ((action.endY - action.startY) * step) / steps),
            width,
            height,
            1,
          );
        }
        await this.touch(AndroidMotionEventAction.Up, action.endX, action.endY, width, height, 0);
      } else {
        await controller.injectKeyCode({
          action: AndroidKeyEventAction.Down,
          keyCode: KEY_CODES[action.key],
          repeat: 0,
          metaState: 0,
        });
        await controller.injectKeyCode({
          action: AndroidKeyEventAction.Up,
          keyCode: KEY_CODES[action.key],
          repeat: 0,
          metaState: 0,
        });
      }
      if (interActionDelayMs > 0 && index + 1 < actions.length) {
        await new Promise((resolve) => setTimeout(resolve, interActionDelayMs));
      }
    }
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.unavailableSerial = null;
    this.failure = null;
    this.starting = null;
    this.startingSerial = null;
    await this.closeActive();
  }

  private async closeActive(): Promise<void> {
    const client = this.client;
    const adb = this.adb;
    this.client = null;
    this.adb = null;
    this.serial = null;
    await client?.close().catch(() => undefined);
    await adb?.close().catch(() => undefined);
  }
}
