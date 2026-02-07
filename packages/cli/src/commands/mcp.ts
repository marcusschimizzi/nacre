import { defineCommand } from 'citty';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../mcp/index.js';

export default defineCommand({
  meta: {
    name: 'mcp',
    description: 'Start MCP server for AI assistant integration',
  },
  args: {
    graph: {
      type: 'string',
      required: true,
      description: 'Path to graph database (.db)',
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('MCP server requires a SQLite graph (.db file)');
      process.exit(1);
    }

    const server = createMcpServer({ graphPath });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  },
});
