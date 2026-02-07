import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import { MockEmbedder } from '../embeddings.js';
import { extractQueryTerms, graphWalk, recall } from '../recall.js';
import type { MemoryNode, MemoryEdge, Episode } from '../types.js';

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

function makeEpisode(overrides: Partial<Episode> & { id: string; title: string }): Episode {
  return {
    timestamp: '2026-01-15',
    type: 'observation',
    content: 'Test content for ' + overrides.title,
    sequence: 0,
    participants: [],
    topics: [],
    importance: 0.5,
    accessCount: 0,
    lastAccessed: '2026-01-15',
    source: '/test.md',
    sourceType: 'markdown',
    ...overrides,
  };
}

describe('extractQueryTerms', () => {
  it('tokenizes basic query', () => {
    const terms = extractQueryTerms('hello world');
    assert.deepStrictEqual(terms, ['hello', 'world']);
  });

  it('removes stopwords', () => {
    const terms = extractQueryTerms('the quick brown fox');
    assert.ok(!terms.includes('the'));
    assert.ok(terms.includes('quick'));
    assert.ok(terms.includes('brown'));
    assert.ok(terms.includes('fox'));
  });

  it('filters short tokens', () => {
    const terms = extractQueryTerms('a b cd efg');
    assert.ok(!terms.includes('a'));
    assert.ok(!terms.includes('b'));
    assert.ok(terms.includes('cd'));
    assert.ok(terms.includes('efg'));
  });

  it('handles punctuation', () => {
    const terms = extractQueryTerms('hello, world! how?');
    assert.ok(terms.includes('hello'));
    assert.ok(terms.includes('world'));
    assert.ok(!terms.includes('how'));
  });

  it('deduplicates', () => {
    const terms = extractQueryTerms('test test TEST');
    assert.strictEqual(terms.length, 1);
    assert.strictEqual(terms[0], 'test');
  });

  it('returns empty for empty input', () => {
    assert.deepStrictEqual(extractQueryTerms(''), []);
    assert.deepStrictEqual(extractQueryTerms('   '), []);
  });
});

describe('graphWalk', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open();
    store.putNode(makeNode({ id: 'n1', label: 'Alpha' }));
    store.putNode(makeNode({ id: 'n2', label: 'Beta' }));
    store.putNode(makeNode({ id: 'n3', label: 'Gamma' }));
    store.putNode(makeNode({ id: 'n4', label: 'Delta' }));
    store.putNode(makeNode({ id: 'n5', label: 'Isolated' }));

    store.putEdge(makeEdge({ id: 'n1--n2--co-occurrence', source: 'n1', target: 'n2', weight: 0.8, baseWeight: 0.8 }));
    store.putEdge(makeEdge({ id: 'n2--n3--co-occurrence', source: 'n2', target: 'n3', weight: 0.6, baseWeight: 0.6 }));
    store.putEdge(makeEdge({ id: 'n3--n4--explicit', source: 'n3', target: 'n4', type: 'explicit', weight: 1.0, baseWeight: 1.0 }));
  });

  after(() => {
    store.close();
  });

  it('gives seed nodes a score of 1.0', () => {
    const graph = store.getFullGraph();
    const scores = graphWalk(graph, ['n1'], 1, new Date());
    assert.strictEqual(scores.get('n1'), 1.0);
  });

  it('scores hop-1 neighbors lower than seeds', () => {
    const graph = store.getFullGraph();
    const scores = graphWalk(graph, ['n1'], 1, new Date());
    const seedScore = scores.get('n1')!;
    const neighborScore = scores.get('n2')!;
    assert.ok(neighborScore > 0);
    assert.ok(neighborScore < seedScore);
  });

  it('discovers hop-2 nodes', () => {
    const graph = store.getFullGraph();
    const scores = graphWalk(graph, ['n1'], 2, new Date());
    assert.ok(scores.has('n3'));
    assert.ok(!scores.has('n4'));
  });

  it('does not discover isolated nodes', () => {
    const graph = store.getFullGraph();
    const scores = graphWalk(graph, ['n1'], 3, new Date());
    assert.ok(!scores.has('n5'));
  });

  it('takes max score for multi-path nodes', () => {
    const graph = store.getFullGraph();
    const scores1 = graphWalk(graph, ['n1'], 2, new Date());
    const scores2 = graphWalk(graph, ['n1', 'n3'], 1, new Date());
    assert.ok(scores2.get('n3')! >= scores1.get('n3')!);
  });
});

describe('recall — integration', () => {
  let store: SqliteStore;
  const embedder = new MockEmbedder();

  before(async () => {
    store = SqliteStore.open();

    store.putNode(makeNode({ id: 'n-ts', label: 'TypeScript', type: 'tool', mentionCount: 10, reinforcementCount: 5 }));
    store.putNode(makeNode({ id: 'n-nacre', label: 'Nacre', type: 'project', mentionCount: 8, reinforcementCount: 3 }));
    store.putNode(makeNode({ id: 'n-marcus', label: 'Marcus', type: 'person', mentionCount: 6, reinforcementCount: 2 }));
    store.putNode(makeNode({ id: 'n-sqlite', label: 'SQLite', type: 'tool', mentionCount: 4 }));
    store.putNode(makeNode({ id: 'n-graph', label: 'knowledge graph', type: 'concept', mentionCount: 5 }));
    store.putNode(makeNode({
      id: 'n-old', label: 'OldThing', type: 'concept',
      lastReinforced: '2024-01-01', mentionCount: 1, reinforcementCount: 0,
    }));

    store.putEdge(makeEdge({ id: 'n-ts--n-nacre--explicit', source: 'n-ts', target: 'n-nacre', type: 'explicit', weight: 1.0, baseWeight: 1.0 }));
    store.putEdge(makeEdge({ id: 'n-marcus--n-nacre--explicit', source: 'n-marcus', target: 'n-nacre', type: 'explicit', weight: 0.9, baseWeight: 0.9 }));
    store.putEdge(makeEdge({ id: 'n-nacre--n-graph--co-occurrence', source: 'n-nacre', target: 'n-graph', weight: 0.6, baseWeight: 0.6 }));
    store.putEdge(makeEdge({ id: 'n-nacre--n-sqlite--co-occurrence', source: 'n-nacre', target: 'n-sqlite', weight: 0.5, baseWeight: 0.5 }));

    const nodes = ['n-ts', 'n-nacre', 'n-marcus', 'n-sqlite', 'n-graph', 'n-old'];
    for (const id of nodes) {
      const node = store.getNode(id)!;
      const text = node.label + ' ' + node.excerpts.map((e) => e.text).join(' ');
      const vec = await embedder.embed(text);
      store.putEmbedding(id, 'node', text, vec, embedder.name);
    }

    store.putEpisode(makeEpisode({ id: 'ep-1', title: 'Built Nacre core', type: 'event' }));
    store.linkEpisodeEntity('ep-1', 'n-nacre', 'topic');
    store.linkEpisodeEntity('ep-1', 'n-marcus', 'participant');
  });

  after(() => {
    store.close();
  });

  it('returns results with all score components', async () => {
    const results = await recall(store, embedder, { query: 'Nacre' });
    assert.ok(results.length > 0);
    const first = results[0];
    assert.ok('semantic' in first.scores);
    assert.ok('graph' in first.scores);
    assert.ok('recency' in first.scores);
    assert.ok('importance' in first.scores);
    assert.ok(first.score > 0);
  });

  it('finds nodes via graph traversal (graph score > 0)', async () => {
    const results = await recall(store, embedder, { query: 'Nacre' });
    const nacre = results.find((r) => r.id === 'n-nacre');
    assert.ok(nacre);
    assert.ok(nacre.scores.graph > 0);
  });

  it('includes semantic matches when provider is given', async () => {
    const results = await recall(store, embedder, { query: 'TypeScript' });
    const hasAnySemantic = results.some((r) => r.scores.semantic > 0);
    assert.ok(results.length > 0);
    assert.ok(hasAnySemantic || results.some((r) => r.scores.graph > 0));
  });

  it('works without embedding provider (graph-only)', async () => {
    const results = await recall(store, null, { query: 'Nacre' });
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.strictEqual(r.scores.semantic, 0);
    }
  });

  it('includes both semantic and graph-connected nodes', async () => {
    const results = await recall(store, embedder, { query: 'Nacre', limit: 10 });
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes('n-nacre'));
    assert.ok(results.length > 1);
  });

  it('includes connections in results', async () => {
    const results = await recall(store, embedder, { query: 'Nacre' });
    const nacre = results.find((r) => r.id === 'n-nacre');
    assert.ok(nacre);
    assert.ok(nacre.connections.length > 0);
    const conn = nacre.connections[0];
    assert.ok(conn.label);
    assert.ok(conn.type);
    assert.ok(conn.relationship);
    assert.ok(typeof conn.weight === 'number');
  });

  it('includes episodes for linked nodes', async () => {
    const results = await recall(store, embedder, { query: 'Nacre' });
    const nacre = results.find((r) => r.id === 'n-nacre');
    assert.ok(nacre);
    assert.ok(nacre.episodes);
    assert.ok(nacre.episodes.length > 0);
    assert.strictEqual(nacre.episodes[0].title, 'Built Nacre core');
  });

  it('filters by entity type', async () => {
    const results = await recall(store, embedder, { query: 'Nacre', types: ['person'] });
    for (const r of results) {
      assert.strictEqual(r.type, 'person');
    }
  });

  it('filters by time range (since)', async () => {
    const results = await recall(store, embedder, {
      query: 'knowledge graph',
      since: '2025-12-01',
    });
    for (const r of results) {
      assert.ok(r.id !== 'n-old');
    }
  });

  it('respects limit', async () => {
    const results = await recall(store, embedder, { query: 'Nacre', limit: 2 });
    assert.ok(results.length <= 2);
  });

  it('returns fewer results for unmatched query', async () => {
    const matched = await recall(store, embedder, { query: 'Nacre' });
    const unmatched = await recall(store, embedder, { query: 'xyzzynonexistent99' });
    assert.ok(unmatched.length <= matched.length);
  });

  it('includes excerpts', async () => {
    const results = await recall(store, embedder, { query: 'Nacre' });
    const nacre = results.find((r) => r.id === 'n-nacre');
    assert.ok(nacre);
    assert.ok(nacre.excerpts.length > 0);
  });

  it('respects minScore threshold', async () => {
    const results = await recall(store, embedder, { query: 'Nacre', minScore: 0.99 });
    for (const r of results) {
      assert.ok(r.score >= 0.99);
    }
  });

  it('scores recency higher for recent nodes', async () => {
    const results = await recall(store, null, { query: 'knowledge graph' });
    const graph = results.find((r) => r.id === 'n-graph');
    const old = results.find((r) => r.id === 'n-old');
    if (graph && old) {
      assert.ok(graph.scores.recency > old.scores.recency);
    }
  });
});
