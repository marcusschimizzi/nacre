import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteStore, MockEmbedder } from '@nacre/core';
import type { MemoryNode, MemoryEdge } from '@nacre/core';
import { registerTools } from '../mcp/tools.js';
import { registerResources } from '../mcp/resources.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function makeNode(overrides: Partial<MemoryNode> & { id: string; label: string }): MemoryNode {
  return {
    type: 'concept',
    aliases: [],
    firstSeen: '2026-01-01',
    lastReinforced: '2026-01-15',
    mentionCount: 3,
    reinforcementCount: 1,
    sourceFiles: ['test.md'],
    excerpts: [{ file: 'test.md', text: `About ${overrides.label}`, date: '2026-01-15' }],
    ...overrides,
  };
}

function makeEdge(overrides: Partial<MemoryEdge> & { id: string; source: string; target: string }): MemoryEdge {
  return {
    type: 'co-occurrence',
    directed: false,
    weight: 0.5,
    baseWeight: 0.5,
    reinforcementCount: 1,
    firstFormed: '2026-01-01',
    lastReinforced: '2026-01-15',
    stability: 1.0,
    evidence: [],
    ...overrides,
  };
}

describe('MCP Server', () => {
  let store: SqliteStore;
  let client: Client;
  let mcpServer: McpServer;

  before(async () => {
    store = SqliteStore.open(':memory:');

    store.putNode(makeNode({ id: 'n-ts', label: 'TypeScript', type: 'tool', mentionCount: 10 }));
    store.putNode(makeNode({ id: 'n-nacre', label: 'Nacre', type: 'project', mentionCount: 8 }));
    store.putNode(makeNode({ id: 'n-marcus', label: 'Marcus', type: 'person', mentionCount: 5 }));

    store.putEdge(makeEdge({ id: 'n-ts--n-nacre--explicit', source: 'n-ts', target: 'n-nacre', type: 'explicit', weight: 1.0, baseWeight: 1.0 }));
    store.putEdge(makeEdge({ id: 'n-marcus--n-nacre--explicit', source: 'n-marcus', target: 'n-nacre', type: 'explicit', weight: 0.9, baseWeight: 0.9 }));

    const embedder = new MockEmbedder();
    for (const id of ['n-ts', 'n-nacre', 'n-marcus']) {
      const node = store.getNode(id)!;
      const text = node.label + ' ' + node.excerpts.map((e) => e.text).join(' ');
      const vec = await embedder.embed(text);
      store.putEmbedding(id, 'node', text, vec, embedder.name);
    }

    mcpServer = new McpServer(
      { name: 'nacre-test', version: '0.1.0' },
      { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(mcpServer, store);
    registerResources(mcpServer, store);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' });

    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  after(async () => {
    await client.close();
    await mcpServer.close();
    store.close();
  });

  describe('tool listing', () => {
    it('lists all 7 tools', async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name).sort();
      assert.deepStrictEqual(toolNames, [
        'nacre_brief',
        'nacre_feedback',
        'nacre_forget',
        'nacre_lesson',
        'nacre_procedures',
        'nacre_recall',
        'nacre_remember',
      ]);
    });
  });

  describe('nacre_recall', () => {
    it('returns results for matching query', async () => {
      const result = await client.callTool({ name: 'nacre_recall', arguments: { query: 'TypeScript' } });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.includes('TypeScript'), `Expected TypeScript in result: ${text}`);
    });

    it('returns results or no-results message for unmatched query', async () => {
      const result = await client.callTool({ name: 'nacre_recall', arguments: { query: 'xyznonexistent999' } });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      // MockEmbedder may find semantic matches even for random queries
      // We just verify it returns a valid response (either results or no-results message)
      assert.ok(text.includes('No memories found') || text.includes('result'));
    });
  });

  describe('nacre_brief', () => {
    it('returns briefing text', async () => {
      const result = await client.callTool({ name: 'nacre_brief', arguments: {} });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.length > 0, 'Brief should return non-empty text');
    });
  });

  describe('nacre_remember', () => {
    it('creates a new memory node', async () => {
      const result = await client.callTool({
        name: 'nacre_remember',
        arguments: { content: 'Vite is faster than Webpack', type: 'fact' },
      });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.includes('Remembered'));
      assert.ok(text.includes('Vite is faster than Webpack'));
    });

    it('links to existing entities when specified', async () => {
      const result = await client.callTool({
        name: 'nacre_remember',
        arguments: { content: 'Marcus prefers TypeScript', entities: ['TypeScript', 'Marcus'] },
      });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.includes('Linked to'));
    });
  });

  describe('nacre_forget', () => {
    it('deletes an existing memory', async () => {
      store.putNode(makeNode({ id: 'n-temp', label: 'Temporary' }));
      const result = await client.callTool({
        name: 'nacre_forget',
        arguments: { memoryId: 'n-temp', reason: 'test cleanup' },
      });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.includes('Forgotten'));
      assert.strictEqual(store.getNode('n-temp'), undefined);
    });

    it('returns error for missing memory', async () => {
      const result = await client.callTool({
        name: 'nacre_forget',
        arguments: { memoryId: 'n-nonexistent' },
      });
      assert.ok(result.isError);
    });
  });

  describe('nacre_feedback', () => {
    it('reinforces a memory with positive rating', async () => {
      const beforeCount = store.getNode('n-ts')!.reinforcementCount;
      const result = await client.callTool({
        name: 'nacre_feedback',
        arguments: { memoryId: 'n-ts', rating: 1 },
      });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.includes('reinforced'));
      assert.strictEqual(store.getNode('n-ts')!.reinforcementCount, beforeCount + 1);
    });

    it('weakens a memory with negative rating', async () => {
      const beforeCount = store.getNode('n-nacre')!.reinforcementCount;
      const result = await client.callTool({
        name: 'nacre_feedback',
        arguments: { memoryId: 'n-nacre', rating: -1, reason: 'outdated' },
      });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.includes('weakened'));
      assert.strictEqual(store.getNode('n-nacre')!.reinforcementCount, Math.max(0, beforeCount - 1));
    });

    it('returns error for missing memory', async () => {
      const result = await client.callTool({
        name: 'nacre_feedback',
        arguments: { memoryId: 'n-nonexistent', rating: 1 },
      });
      assert.ok(result.isError);
    });
  });

  describe('nacre_lesson', () => {
    it('records a lesson with category', async () => {
      const result = await client.callTool({
        name: 'nacre_lesson',
        arguments: { lesson: 'Always use strict mode in TypeScript', type: 'preference' },
      });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.includes('Procedure recorded'));
      assert.ok(text.includes('preference'));
    });

    it('records a lesson with context', async () => {
      const result = await client.callTool({
        name: 'nacre_lesson',
        arguments: { lesson: 'Use pnpm over npm in monorepos' },
      });
      assert.ok(!result.isError);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.ok(text.includes('Procedure recorded'));
    });
  });

  describe('resources', () => {
    it('lists all 3 resources', async () => {
      const result = await client.listResources();
      assert.strictEqual(result.resources.length, 3);
      const uris = result.resources.map((r) => r.uri).sort();
      assert.deepStrictEqual(uris, ['nacre://brief', 'nacre://graph/stats', 'nacre://health']);
    });

    it('reads nacre://brief', async () => {
      const result = await client.readResource({ uri: 'nacre://brief' });
      assert.ok(result.contents.length > 0);
      assert.strictEqual(result.contents[0].mimeType, 'text/plain');
      assert.ok((result.contents[0] as { text: string }).text.length > 0);
    });

    it('reads nacre://health', async () => {
      const result = await client.readResource({ uri: 'nacre://health' });
      assert.ok(result.contents.length > 0);
      const data = JSON.parse((result.contents[0] as { text: string }).text);
      assert.ok('healthScore' in data);
      assert.ok('fadingEdgeCount' in data);
    });

    it('reads nacre://graph/stats', async () => {
      const result = await client.readResource({ uri: 'nacre://graph/stats' });
      assert.ok(result.contents.length > 0);
      const data = JSON.parse((result.contents[0] as { text: string }).text);
      assert.ok(data.nodeCount >= 3);
      assert.ok(data.edgeCount >= 2);
      assert.ok('nodesByType' in data);
    });
  });
});
