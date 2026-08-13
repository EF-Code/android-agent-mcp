import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TOOL_METADATA } from '../../src/mcp/tool-registry.js';

const repositoryRoot = process.cwd();
const serverEntrypoint = join(repositoryRoot, 'dist-test', 'src', 'index.js');

test('MCP stdio server initializes with instructions and exposes stable tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntrypoint],
    cwd: repositoryRoot,
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ANDROID_DEVICE_MCP_ALLOWED_PACKAGES: 'com.example.app',
    },
  });
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: 'android-device', version: '0.1.0' });
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
    const result = await client.callTool({ name: 'device_list', arguments: {} });
    const content = result.content as Array<{ type: 'text' | 'image'; text?: string }>;
    const text = content.find((item) => item.type === 'text');
    assert.ok(text !== undefined && text.type === 'text');
    assert.ok(text.text !== undefined);
    const parsed = JSON.parse(text.text) as { ok: boolean; data: unknown };
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.data));
  } finally {
    await client.close();
    await transport.close();
  }
});
