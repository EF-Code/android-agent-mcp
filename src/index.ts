#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config/loader.js';
import { createMcpServer } from './mcp/server.js';

async function main(): Promise<void> {
  const { server, service } = createMcpServer(loadConfig());
  const transport = new StdioServerTransport();
  const close = async (): Promise<void> => {
    await service.close();
    await server.close();
  };
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
