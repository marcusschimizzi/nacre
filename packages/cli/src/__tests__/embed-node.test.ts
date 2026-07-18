import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore, MockEmbedder, type MemoryNode } from '@nacre/core';
import { embedNodeBestEffort, nodeEmbeddingText } from '../embed-node.js';

function makeNode(id: string, content: string): MemoryNode {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id,
    label: content.slice(0, 100),
    type: 'concept',
    aliases: [],
    firstSeen: now,
    lastReinforced: now,
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: ['mcp'],
    excerpts: [{ file: 'mcp', text: content, date: '2026-01-01' }],
  };
}

describe('embedNodeBestEffort', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = SqliteStore.open(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('no-ops without a provider', async () => {
    const node = makeNode('a', 'hello world');
    store.putNode(node);
    const result = await embedNodeBestEffort(store, null, node);
    assert.equal(result.embedded, false);
    assert.equal(result.reason, 'no-provider');
    assert.equal(store.embeddingCount(), 0);
  });

  it('embeds the node, records provider/dimensions meta, and makes it recallable', async () => {
    const provider = new MockEmbedder();
    const node = makeNode('b', 'TypeScript strict mode is great');
    store.putNode(node);

    const result = await embedNodeBestEffort(store, provider, node);
    assert.equal(result.embedded, true);
    assert.equal(result.reason, undefined);
    assert.equal(store.embeddingCount(), 1);
    assert.ok(store.getEmbedding('b'), 'embedding stored');
    assert.equal(store.getMeta('embedding_provider'), provider.name);
    assert.equal(store.getMeta('embedding_dimensions'), String(provider.dimensions));

    // Semantic search on the same text returns the node.
    const queryVec = await provider.embed(nodeEmbeddingText(node));
    const hits = store.searchSimilar(queryVec, { type: 'node' });
    assert.ok(
      hits.some((h) => h.id === 'b'),
      'node must be findable by semantic search',
    );
  });

  it('does not mix providers: no-op when the graph already uses a different one', async () => {
    store.setMeta('embedding_provider', 'ollama/nomic-embed-text');
    const provider = new MockEmbedder(); // name 'mock' != stored
    const node = makeNode('c', 'mismatched provider');
    store.putNode(node);

    const result = await embedNodeBestEffort(store, provider, node);
    assert.equal(result.embedded, false, 'must not embed with a mismatched provider');
    assert.equal(result.reason, 'provider-config');
    assert.equal(store.embeddingCount(), 0, 'must not write a mixed-provider embedding');
    // The existing provider meta is untouched (no silent clear/switch).
    assert.equal(store.getMeta('embedding_provider'), 'ollama/nomic-embed-text');
  });

  it('reports encoder-mismatch when the store is pinned to a different space', async () => {
    // Pin the store to a 384-dim encoder, then try to embed with mock (64).
    store.putEmbedding(
      'existing',
      'node',
      'x',
      new Float32Array(384).fill(0.5),
      'onnx/all-MiniLM-L6-v2',
    );
    const provider = new MockEmbedder();
    const node = makeNode('e', 'mismatched encoder');
    store.putNode(node);

    const result = await embedNodeBestEffort(store, provider, node);
    assert.equal(result.embedded, false);
    assert.equal(result.reason, 'encoder-mismatch');
    assert.equal(store.embeddingCount(), 1, 'existing index untouched');
  });

  it('treats embedding failures as non-fatal', async () => {
    const broken = {
      name: 'broken',
      dimensions: 8,
      embed: async () => {
        throw new Error('provider unavailable');
      },
      embedBatch: async () => [],
    };
    const node = makeNode('d', 'will fail to embed');
    store.putNode(node);

    const result = await embedNodeBestEffort(store, broken, node);
    assert.equal(result.embedded, false);
    assert.equal(result.reason, 'error');
    assert.equal(store.embeddingCount(), 0);
  });
});
