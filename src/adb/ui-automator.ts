import { randomUUID } from 'node:crypto';

import { AdbClient } from './client.js';

const REMOTE_DUMP_ROOT = '/data/local/tmp';

export class AdbUiAutomator {
  constructor(private readonly adb: AdbClient) {}

  async dump(serial: string): Promise<string> {
    const remoteDumpPath = `${REMOTE_DUMP_ROOT}/android_agent_mcp_ui_${randomUUID()}.xml`;
    try {
      await this.adb.shell(serial, ['uiautomator', 'dump', '--compressed', remoteDumpPath], {
        timeoutMs: 20_000,
        maxOutputBytes: 32_000,
      });
      const output = await this.adb.device(serial, ['exec-out', 'cat', remoteDumpPath], {
        timeoutMs: 20_000,
        maxOutputBytes: 50_000_000,
      });
      return output.stdout.toString('utf8');
    } finally {
      await this.adb
        .shell(serial, ['rm', '-f', remoteDumpPath], {
          timeoutMs: 5_000,
          maxOutputBytes: 8_192,
        })
        .catch(() => undefined);
    }
  }
}
