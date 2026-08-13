import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { UiSelector } from '../../src/ui/types.js';

const enabled = process.env.ANDROID_AGENT_MCP_PHYSICAL === '1';
const testPackage = process.env.ANDROID_AGENT_MCP_TEST_PACKAGE;
const repositoryRoot = process.cwd();
const serverEntrypoint = join(repositoryRoot, 'dist-test', 'src', 'index.js');

function childEnvironment(packageName: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XAUTHORITY',
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.ANDROID_AGENT_MCP_ALLOWED_PACKAGES = '*';
  environment.ANDROID_AGENT_MCP_MIRROR_AUTO_START = 'true';
  return environment;
}

function dataFrom(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === 'text')?.text;
  assert.ok(text !== undefined, 'MCP tool result did not contain structured text.');
  const envelope = JSON.parse(text) as { ok: boolean; data?: unknown; error?: unknown };
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  return envelope.data;
}

test(
  'controls an opt-in physical Android device through the MCP stdio protocol',
  { skip: !enabled || testPackage === undefined },
  async (t) => {
    const packageName = testPackage!;
    let selector: UiSelector;
    try {
      const rawSelector = process.env.ANDROID_AGENT_MCP_TEST_SELECTOR;
      if (rawSelector === undefined) {
        t.skip(
          'Set ANDROID_AGENT_MCP_TEST_SELECTOR to a repeatable harmless selector in the designated app.',
        );
        return;
      }
      selector = JSON.parse(rawSelector) as UiSelector;
    } catch {
      t.skip('ANDROID_AGENT_MCP_TEST_SELECTOR must be valid JSON.');
      return;
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntrypoint],
      cwd: repositoryRoot,
      stderr: 'pipe',
      env: childEnvironment(packageName),
    });
    const client = new Client({ name: 'physical-device-test', version: '1.0.0' });
    let connected = false;
    try {
      await client.connect(transport);
      connected = true;

      const devices = dataFrom(
        await client.callTool({ name: 'device_list', arguments: {} }),
      ) as Array<{
        serial: string;
        authorized: boolean;
      }>;
      const authorized = devices.filter((device) => device.authorized);
      if (authorized.length !== 1) {
        t.skip(`Expected exactly one authorized device; found ${authorized.length}.`);
        return;
      }
      const serial = authorized[0]!.serial;

      dataFrom(await client.callTool({ name: 'device_select', arguments: { serial } }));
      const info = dataFrom(await client.callTool({ name: 'device_info', arguments: {} })) as {
        serial: string;
      };
      assert.equal(info.serial, serial);

      dataFrom(
        await client.callTool({
          name: 'app_launch',
          arguments: { package_name: packageName },
        }),
      );
      const foregroundWait = dataFrom(
        await client.callTool({
          name: 'wait_for_ui',
          arguments: { package_name: packageName, timeout_ms: 10_000 },
        }),
      ) as { matched: boolean };
      assert.equal(foregroundWait.matched, true);

      dataFrom(
        await client.callTool({
          name: 'evidence_begin',
          arguments: { label: 'physical-mcp-smoke', metadata: { testPackage: packageName } },
        }),
      );
      const screenshot = await client.callTool({
        name: 'screen_capture',
        arguments: { save_to_evidence: true, label: 'initial' },
      });
      assert.notEqual(screenshot.isError, true);
      assert.ok(
        (screenshot.content as Array<{ type: string; mimeType?: string }>).some(
          (item) => item.type === 'image' && item.mimeType === 'image/png',
        ),
      );

      const snapshot = dataFrom(await client.callTool({ name: 'ui_dump', arguments: {} })) as {
        snapshotId: string;
      };
      const found = dataFrom(
        await client.callTool({
          name: 'ui_find',
          arguments: { snapshot_id: snapshot.snapshotId, selector },
        }),
      ) as { matches: unknown[] };
      assert.ok(found.matches.length > 0, 'The repeatable harmless selector did not match.');

      dataFrom(
        await client.callTool({
          name: 'ui_tap',
          arguments: {
            snapshot_id: snapshot.snapshotId,
            selector,
            verify_change: true,
            verify_pixels: true,
          },
        }),
      );

      const mirror = dataFrom(await client.callTool({ name: 'mirror_status', arguments: {} })) as {
        running: boolean;
        deviceSerial: string | null;
      };
      assert.equal(mirror.running, true);
      assert.equal(mirror.deviceSerial, serial);

      dataFrom(
        await client.callTool({
          name: 'logcat_capture',
          arguments: { package_name: packageName, severity: 'W', duration_ms: 250 },
        }),
      );
      const evidence = dataFrom(
        await client.callTool({ name: 'evidence_finish', arguments: {} }),
      ) as { files: Array<{ path: string }> };
      assert.ok(evidence.files.some((file) => file.path === 'summary.md'));
      assert.ok(evidence.files.some((file) => file.path.startsWith('screenshots/')));

      dataFrom(
        await client.callTool({
          name: 'app_launch',
          arguments: { package_name: 'com.android.settings' },
        }),
      );
      const settings = dataFrom(await client.callTool({ name: 'ui_dump', arguments: {} })) as {
        foreground: { packageName: string | null };
        nodes: unknown[];
      };
      assert.equal(settings.foreground.packageName, 'com.android.settings');
      assert.ok(settings.nodes.length > 0);
      const home = dataFrom(
        await client.callTool({
          name: 'key_press',
          arguments: { key: 'home', verify_change: true, verify_pixels: true },
        }),
      ) as {
        before_foreground: { packageName: string | null };
        after_foreground: { packageName: string | null };
        changed: boolean | null;
      };
      assert.equal(home.before_foreground.packageName, 'com.android.settings');
      assert.notEqual(home.after_foreground.packageName, 'com.android.settings');
      assert.equal(home.changed, true);

      dataFrom(await client.callTool({ name: 'mirror_stop', arguments: {} }));
    } finally {
      if (connected) {
        await client.callTool({ name: 'mirror_stop', arguments: {} }).catch(() => undefined);
        await client.close();
      }
      await transport.close();
    }
  },
);
