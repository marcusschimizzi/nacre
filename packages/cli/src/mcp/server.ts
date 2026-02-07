import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteStore } from '@nacre/core';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

export interface McpServerOptions {
  graphPath: string;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const store = SqliteStore.open(opts.graphPath);

  const server = new McpServer(
    { name: 'nacre', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  registerTools(server, store);
  registerResources(server, store);

  return server;
}
