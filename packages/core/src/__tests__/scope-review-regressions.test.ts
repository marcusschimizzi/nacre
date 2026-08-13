import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture, readCaptureEntries } from '../capture.js';
import { consolidateHive } from '../hive.js';
import { replayCaptureCandidates } from '../memory-compile.js';
import { exportCanonical } from '../memory-export.js';
import { forgetMemory } from '../memory-forget.js';
import { promoteCaptured } from '../memory-promote.js';
import { recall } from '../recall.js';
import { SESSION_SCOPE, parseScopesFilter, scopeVisible } from '../scopes.js';
import { SqliteStore } from '../store.js';
import { purgeExpiredScratch } from '../truth-layer.js';
import type { MemoryNode } from '../types.js';

// Regression tests for the V2-2 adversarial review findings.

function makeNode(overrides: Partial<MemoryNode> & { id: string; label: string }): MemoryNode {
  return {
    type: 'concept',
    aliases: [],
    firstSeen: '2026-07-10T09:00:00Z',
    lastReinforced: '2026-07-19T09:00:00Z',
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: [],
    excerpts: [],
    ...overrides,
  };
}

describe('export respects scope (review HIGH)', () => {
  let root: string;
  after(() => rmSync(root, { recursive: true, force: true }));

  it('never exports session scratch, and honors declared scopes for durable rows', () => {
    root = mkdtempSync(join(tmpdir(), 'nacre-rev-export-'));
    const store = SqliteStore.open(':memory:');
    // Session write, exactly as MCP produces it: sourceFiles ['mcp'], no status.
    store.putNode(
      makeNode({
        id: 'mem_5e5500000001',
        label: 'session scratch',
        sourceFiles: ['mcp'],
        excerpts: [{ file: 'mcp', text: 'session scratch', date: '2026-07-10' }],
        scope: SESSION_SCOPE,
      }),
    );
    // User-scoped candidate.
    store.putNode(
      makeNode({
        id: 'mem_ca4d00000002',
        label: 'user-scoped candidate',
        sourceFiles: ['mcp'],
        excerpts: [{ file: 'mcp', text: 'user-scoped candidate', date: '2026-07-10' }],
        status: 'candidate',
        scope: 'user',
      }),
    );

    const result = exportCanonical(store, root);
    assert.equal(result.exported.length, 1, 'only the durable candidate exports');
    assert.ok(result.exported[0].startsWith('user/'), 'file lands in the DECLARED scope dir');
    assert.ok(!existsSync(join(root, 'agent')), 'nothing demoted into agent/');
    assert.equal(store.getNode('mem_5e5500000001')?.status, undefined, 'scratch untouched');
    assert.equal(store.getNode('mem_ca4d00000002')?.scope, 'user', 'row scope preserved');
    store.close();
  });
});

describe('session-scoped spool entries are never durable-ized (review MEDIUM)', () => {
  it('promotion and replay both skip them, identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nacre-rev-spool-'));
    const store = SqliteStore.open(':memory:');
    try {
      appendCapture(dir, {
        id: 'mem_5e5500000003',
        ts: '2026-07-19T09:00:00Z',
        origin: 'mcp',
        payload: { content: 'Hand-crafted session entry.', type: 'fact', scope: 'session' },
      });

      const promotion = promoteCaptured(store, dir);
      assert.equal(promotion.promoted.length, 0);
      assert.ok(promotion.warnings.some((w) => w.includes('session-scoped spool entry')));

      const replay = replayCaptureCandidates(store, dir);
      assert.equal(replay.candidates, 0, 'rebuild agrees with consolidate');
      assert.equal(store.getNode('mem_5e5500000003'), undefined);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hive never carries dangling edges of excluded memories (review MEDIUM)', () => {
  it('edges of agent/session nodes are dropped with their nodes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nacre-rev-hive-'));
    try {
      const graphPath = join(dir, 'a.db');
      const store = SqliteStore.open(graphPath);
      store.putNode(
        makeNode({
          id: 'mem_a9e4400000001',
          label: 'agent secret',
          status: 'promoted',
          scope: 'agent',
        }),
      );
      store.putNode(makeNode({ id: 'ent-server', label: 'prod-server' }));
      store.putEdge({
        id: 'mem_a9e4400000001--ent-server--explicit',
        source: 'mem_a9e4400000001',
        target: 'ent-server',
        type: 'explicit',
        directed: false,
        weight: 0.8,
        baseWeight: 0.8,
        reinforcementCount: 1,
        firstFormed: '2026-07-10',
        lastReinforced: '2026-07-19',
        stability: 1,
        evidence: [{ file: 'agent/x.md', date: '2026-07-10', context: 'the secret claim text' }],
      });
      store.close();

      const hive = await consolidateHive({
        agents: [{ name: 'a', graphPath }],
        outPath: join(dir, 'hive.db'),
      });
      assert.ok(!Object.keys(hive.nodes).includes('mem_a9e4400000001'));
      assert.equal(
        Object.values(hive.edges).length,
        0,
        'no dangling edge (its id and evidence leak the excluded claim)',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scratch never enters snapshots (review MEDIUM)', () => {
  it('session rows are excluded from durable temporal history', () => {
    const store = SqliteStore.open(':memory:');
    store.putNode(
      makeNode({ id: 'mem_d0d000000004', label: 'durable', status: 'promoted', scope: 'user' }),
    );
    store.putNode(makeNode({ id: 'mem_5e5500000005', label: 'scratch', scope: 'session' }));
    const snapshot = store.createSnapshot('manual');
    const graph = store.getSnapshotGraph(snapshot.id);
    assert.ok(graph.nodes.mem_d0d000000004);
    assert.equal(
      graph.nodes.mem_5e5500000005,
      undefined,
      'scratch outliving its purge via snapshots',
    );
    store.close();
  });
});

describe('unknown scopes are scratch-class everywhere (review LOW)', () => {
  it('hidden from default reads and purged on schedule', async () => {
    assert.equal(scopeVisible('tmp'), false, 'unknown scope hidden by default');
    assert.equal(scopeVisible('tmp', ['tmp']), true, 'explicitly listable');

    const store = SqliteStore.open(':memory:');
    store.putNode(
      makeNode({
        id: 'mem_04d500000006',
        label: 'odd scope',
        scope: 'tmp',
        lastReinforced: '2026-07-01T09:00:00Z',
      }),
    );
    const purged = purgeExpiredScratch(store, undefined, new Date('2026-07-20T09:00:00Z'));
    assert.equal(purged.nodes, 1, 'unknown-scope rows expire like session');
    store.close();
  });
});

describe('forgetting session scratch leaves no durable trace (review LOW)', () => {
  it('no spool tombstone, no store forget record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nacre-rev-forget-'));
    const store = SqliteStore.open(':memory:');
    try {
      store.putNode(makeNode({ id: 'mem_5e5500000007', label: 'scratch', scope: 'session' }));
      forgetMemory(store, dir, 'mem_5e5500000007', { ts: '2026-07-20T09:00:00Z', origin: 'mcp' });
      assert.equal(store.getNode('mem_5e5500000007'), undefined);
      assert.equal(readCaptureEntries(dir).tombstones.length, 0, 'no spool tombstone for scratch');
      assert.equal(store.listForgotten().length, 0, 'no store record for scratch');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseScopesFilter (review LOW)', () => {
  it('degenerate inputs mean "no filter", never "hide everything durable"', () => {
    assert.equal(parseScopesFilter(undefined), undefined);
    assert.equal(parseScopesFilter(''), undefined);
    assert.equal(parseScopesFilter(','), undefined);
    assert.equal(parseScopesFilter(' , '), undefined);
    assert.equal(parseScopesFilter([]), undefined);
    assert.deepEqual(parseScopesFilter('user, project/a,'), ['user', 'project/a']);
    assert.deepEqual(parseScopesFilter(['user', ' ', '']), ['user']);
  });
});

describe('out-of-scope episodes do not boost ranking (review LOW)', () => {
  it('episode semantic hits are scope-checked before propagating', async () => {
    // Structure-only check: seed an episode in agent scope linked to a node,
    // recall with a project filter, and confirm the linked node gains no
    // episode-derived presence. (Semantic path requires embeddings; here we
    // assert the episodes attached to results are filtered, which shares the
    // same recordVisibleInScopes gate added to the epHits loop.)
    const store = SqliteStore.open(':memory:');
    store.putNode(
      makeNode({
        id: 'mem_be0000000008',
        label: 'target memory',
        status: 'promoted',
        scope: 'project/a',
      }),
    );
    store.putEpisode({
      id: 'ep_agent1',
      timestamp: '2026-07-19T09:00:00Z',
      type: 'conversation',
      title: 'agent-scoped episode',
      content: 'target memory discussion',
      sequence: 0,
      participants: [],
      topics: [],
      importance: 0.5,
      accessCount: 0,
      lastAccessed: '2026-07-19T09:00:00Z',
      source: 'test',
      sourceType: 'conversation',
      scope: 'agent',
    });
    store.linkEpisodeEntity('ep_agent1', 'mem_be0000000008', 'topic');

    const response = await recall(store, null, { query: 'target memory', scopes: ['project/a'] });
    const hit = response.results.find((r) => r.id === 'mem_be0000000008');
    assert.ok(hit, 'in-scope memory returned');
    assert.ok(
      !hit.episodes?.some((e) => e.id === 'ep_agent1'),
      'agent-scoped episode hidden under project filter',
    );
    store.close();
  });
});
