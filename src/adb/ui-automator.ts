import { AdbClient } from './client.js';

const REMOTE_DUMP_PATH = '/sdcard/android_device_mcp_ui.xml';

export class AdbUiAutomator {
  constructor(private readonly adb: AdbClient) {}

  async dump(serial: string): Promise<string> {
    await this.adb.shell(serial, ['uiautomator', 'dump', '--compressed', REMOTE_DUMP_PATH], {
      timeoutMs: 20_000,
      maxOutputBytes: 32_000,
    });
    try {
      const output = await this.adb.device(serial, ['exec-out', 'cat', REMOTE_DUMP_PATH], {
        timeoutMs: 20_000,
        maxOutputBytes: 50_000_000,
      });
      return output.stdout.toString('utf8');
    } finally {
      await this.adb.shell(serial, ['rm', '-f', REMOTE_DUMP_PATH], {
        timeoutMs: 5_000,
        maxOutputBytes: 8_192,
      }).catch(() => undefined);
    }
  }
}
