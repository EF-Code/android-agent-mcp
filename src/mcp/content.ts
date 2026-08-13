import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ErrorEnvelope, ResultEnvelope, SuccessEnvelope } from '../types.js';

export function jsonContent(result: ResultEnvelope<unknown>): CallToolResult {
  const text = JSON.stringify(result, null, 2);
  return {
    content: [{ type: 'text', text }],
    isError: !result.ok,
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

export function imageContent(result: SuccessEnvelope<unknown>, png: Buffer): CallToolResult {
  return {
    content: [
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify(result, null, 2) },
    ],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

export function errorContent(error: ErrorEnvelope): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
    isError: true,
    structuredContent: error as unknown as Record<string, unknown>,
  };
}
