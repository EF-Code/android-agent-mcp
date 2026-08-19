import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TOOL_METADATA } from '../../src/mcp/tool-registry.js';

const repositoryRoot = process.cwd();
const serverEntrypoint = join(repositoryRoot, 'dist-test', 'src', 'index.js');
const fakeAdb = join(repositoryRoot, 'tests', 'fixtures', 'fake-adb.mjs');

test('MCP stdio server initializes with instructions and exposes stable tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntrypoint],
    cwd: repositoryRoot,
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ANDROID_AGENT_MCP_ADB_PATH: fakeAdb,
      ANDROID_AGENT_MCP_ALLOWED_PACKAGES: 'com.example.app',
      ANDROID_AGENT_MCP_MIRROR_AUTO_START: 'false',
    },
  });
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  let serverPid: number | null = null;
  try {
    await client.connect(transport);
    serverPid = transport.pid;
    assert.ok(serverPid !== null);
    assert.deepEqual(client.getServerVersion(), { name: 'android-device', version: '0.4.1' });
    const instructions = client.getInstructions();
    assert.ok(instructions?.startsWith('Select exactly one authorized Android device'));
    assert.ok(instructions !== undefined && instructions.length <= 512);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const expected of Object.keys(TOOL_METADATA)) {
      assert.ok(names.has(expected), `missing tool ${expected}`);
    }
    assert.equal(tools.tools.length, Object.keys(TOOL_METADATA).length);
    const installTool = tools.tools.find((tool) => tool.name === 'app_install');
    assert.equal(installTool?.annotations?.readOnlyHint, false);
    assert.equal(installTool?.annotations?.destructiveHint, true);
    const captureTool = tools.tools.find((tool) => tool.name === 'screen_capture');
    assert.equal(captureTool?.annotations?.readOnlyHint, true);
    const keyTool = tools.tools.find((tool) => tool.name === 'key_press');
    const keySchema = keyTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    assert.equal(keySchema?.properties?.allow_power, undefined);
    const result = await client.callTool({ name: 'device_list', arguments: {} });
    const content = result.content as Array<{ type: 'text' | 'image'; text?: string }>;
    const text = content.find((item) => item.type === 'text');
    assert.ok(text !== undefined && text.type === 'text');
    assert.ok(text.text !== undefined);
    const parsed = JSON.parse(text.text) as { ok: boolean; data: unknown };
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.data));
    const blockedKey = await client.callTool({ name: 'key_press', arguments: { key: 'power' } });
    assert.equal(blockedKey.isError, true);
  } finally {
    await client.close();
    await transport.close();
    assert.equal(transport.pid, null);
  }
});

test('returns image content and structured errors over MCP stdio', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntrypoint],
    cwd: repositoryRoot,
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ANDROID_AGENT_MCP_ADB_PATH: fakeAdb,
      ANDROID_AGENT_MCP_ALLOWED_PACKAGES: 'com.example.app',
      ANDROID_AGENT_MCP_MIRROR_AUTO_START: 'false',
    },
  });
  const client = new Client({ name: 'protocol-image-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const selection = await client.callTool({
      name: 'device_select',
      arguments: { serial: 'protocol-test' },
    });
    assert.equal(selection.isError, false);
    const imageResult = await client.callTool({ name: 'screen_capture', arguments: {} });
    const content = imageResult.content as Array<{
      type: string;
      mimeType?: string;
      text?: string;
    }>;
    assert.ok(content.some((item) => item.type === 'image' && item.mimeType === 'image/png'));
    const companion = content.find((item) => item.type === 'text');
    assert.ok(companion?.text?.includes('"width": 1080'));

    const fastTap = await client.callTool({
      name: 'screen_tap',
      arguments: { x: 10, y: 20, include_screenshot: true },
    });
    assert.notEqual(fastTap.isError, true);
    const fastTapContent = fastTap.content as Array<{ type: string; mimeType?: string }>;
    assert.ok(
      fastTapContent.some((item) => item.type === 'image' && item.mimeType === 'image/png'),
    );

    const sequence = await client.callTool({
      name: 'screen_input_sequence',
      arguments: {
        actions: [
          { type: 'tap', x: 10, y: 20 },
          { type: 'tap', x: 30, y: 40 },
        ],
      },
    });
    assert.notEqual(sequence.isError, true);

    const visualStart = await client.callTool({
      name: 'visual_control_start',
      arguments: {},
    });
    assert.notEqual(visualStart.isError, true);
    const visualStartContent = visualStart.content as Array<{
      type: string;
      mimeType?: string;
      text?: string;
    }>;
    assert.ok(
      visualStartContent.some((item) => item.type === 'image' && item.mimeType === 'image/jpeg'),
    );
    const visualStartText = visualStartContent.find((item) => item.type === 'text')?.text ?? '';
    const visualStartData = JSON.parse(visualStartText) as {
      data: {
        session_id: string;
        coordinate_space: string;
        screen: { mime_type: string };
      };
    };
    assert.equal(visualStartData.data.coordinate_space, 'normalized_1000');
    assert.equal(visualStartData.data.screen.mime_type, 'image/jpeg');

    const duplicateVisualStart = await client.callTool({
      name: 'visual_control_start',
      arguments: {},
    });
    assert.equal(duplicateVisualStart.isError, true);

    const visualAction = await client.callTool({
      name: 'visual_control_action',
      arguments: {
        session_id: visualStartData.data.session_id,
        actions: [
          { type: 'tap', x: 100, y: 200 },
          { type: 'tap', x: 300, y: 200 },
        ],
      },
    });
    assert.notEqual(visualAction.isError, true);
    const visualActionContent = visualAction.content as Array<{
      type: string;
      mimeType?: string;
      text?: string;
    }>;
    assert.ok(
      visualActionContent.some((item) => item.type === 'image' && item.mimeType === 'image/jpeg'),
    );
    const visualActionText = visualActionContent.find((item) => item.type === 'text')?.text ?? '';
    const visualActionData = JSON.parse(visualActionText) as {
      data: {
        action_count: number;
        changed: boolean;
        elapsed_ms: number;
        wait_elapsed_ms: number;
        timing_ms: {
          preflight: number;
          input: number;
          settle: number;
          observation: number;
          postflight: number;
        };
      };
    };
    assert.equal(visualActionData.data.action_count, 2);
    assert.equal(visualActionData.data.changed, false);
    assert.equal(typeof visualActionData.data.elapsed_ms, 'number');
    assert.equal(typeof visualActionData.data.wait_elapsed_ms, 'number');
    assert.equal(typeof visualActionData.data.timing_ms.preflight, 'number');
    assert.equal(typeof visualActionData.data.timing_ms.input, 'number');
    assert.equal(typeof visualActionData.data.timing_ms.observation, 'number');
    assert.equal(typeof visualActionData.data.timing_ms.postflight, 'number');

    const invalidVisualAction = await client.callTool({
      name: 'visual_control_action',
      arguments: {
        session_id: visualStartData.data.session_id,
        actions: [{ type: 'tap', x: 1_000, y: 200 }],
      },
    });
    assert.equal(invalidVisualAction.isError, true);

    const visualStop = await client.callTool({
      name: 'visual_control_stop',
      arguments: { session_id: visualStartData.data.session_id },
    });
    assert.equal(visualStop.isError, false);

    const staleVisualStart = await client.callTool({
      name: 'visual_control_start',
      arguments: {},
    });
    const staleVisualText =
      (staleVisualStart.content as Array<{ type: string; text?: string }>).find(
        (item) => item.type === 'text',
      )?.text ?? '';
    const staleVisualSession = JSON.parse(staleVisualText) as { data: { session_id: string } };
    const reselection = await client.callTool({
      name: 'device_select',
      arguments: { serial: 'protocol-test' },
    });
    assert.equal(reselection.isError, false);
    const staleVisualAction = await client.callTool({
      name: 'visual_control_action',
      arguments: {
        session_id: staleVisualSession.data.session_id,
        actions: [{ type: 'tap', x: 100, y: 200 }],
      },
    });
    assert.equal(staleVisualAction.isError, true);

    const invalidResult = await client.callTool({
      name: 'screen_capture',
      arguments: { save_to_evidence: 'yes' },
    });
    assert.equal(invalidResult.isError, true);

    const errorResult = await client.callTool({
      name: 'app_clear_data',
      arguments: { package_name: 'com.example.app' },
    });
    assert.equal(errorResult.isError, true);
    const errorContent = errorResult.content as Array<{ type: string; text?: string }>;
    const errorText = errorContent.find((item) => item.type === 'text')?.text ?? '';
    assert.equal(JSON.parse(errorText).error.code, 'APPROVAL_REQUIRED');
  } finally {
    await client.close();
    await transport.close();
  }
});
