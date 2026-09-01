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

export class ScrcpyDirectControl {
  private adb: Adb | null = null;
  private client: AdbScrcpyClientType<DirectOptions> | null = null;
  private serial: string | null = null;
  private starting: Promise<boolean> | null = null;

  constructor(private readonly adbCli: AdbClient) {}

  async ensureStarted(serial: string): Promise<boolean> {
    if (this.client !== null && this.serial === serial) return true;
    if (this.starting !== null) return this.starting;
    this.starting = this.start(serial).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(serial: string): Promise<boolean> {
    await this.close();
    const serverPath = await findServer();
    if (serverPath === null) return false;
    try {
      await this.adbCli.device(serial, ['push', serverPath, REMOTE_SERVER_PATH], {
        timeoutMs: 30_000,
        maxOutputBytes: 64_000,
      });
      const server = new AdbServerNodeJsClient();
      const adb = await server.createAdb({ serial });
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
      this.adb = adb;
      this.client = client;
      this.serial = serial;
      void client.exited.then(
        () => {
          if (this.client === client) {
            this.client = null;
            this.adb = null;
            this.serial = null;
          }
        },
        () => {
          if (this.client === client) {
            this.client = null;
            this.adb = null;
            this.serial = null;
          }
        },
      );
      return true;
    } catch {
      await this.close();
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
    const client = this.client;
    const adb = this.adb;
    this.client = null;
    this.adb = null;
    this.serial = null;
    await client?.close().catch(() => undefined);
    await adb?.close().catch(() => undefined);
  }
}
