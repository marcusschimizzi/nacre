import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consolidateHive } from '../hive.js';
import { purgeExpiredScratch } from '../truth-layer.js';
import { SqliteStore } from '../store.js';
import type { MemoryNode } from '../types.js';

function makeNode(overrides: Partial<MemoryNode> & { id: string; label: string }): MemoryNode {
  return {
    type: 'concept',
    aliases: [],
    firstSeen: '2026-07-01T09:00:00Z',
    lastReinforced: '2026-07-19T09:00:00Z',
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: [],
    excerpts: [],
    ...overrides,
  };
}

describe('hive scope exclusion (D5)', () => {
  let root: string;
  after(() => rmSync(root, { recursive: true, force: true }));

  async function buildHiveFrom(scopeOverrides?: Record<string, { hiveEligible?: boolean }>) {
    root = mkdtempSync(join(tmpdir(), 'nacre-hive-scope-'));
    const graphPath = join(root, 'agent-a.db');
    const store = SqliteStore.open(graphPath);
    store.putNode(
      makeNode({ id: 'mem_a1', label: 'user memory', status: 'promoted', scope: 'user' }),
    );
    store.putNode(
      makeNode({
        id: 'mem_a2',
        label: 'project memory',
        status: 'promoted',
        scope: 'project/nacre',
      }),
    );
    store.putNode(
      makeNode({ id: 'mem_a3', label: 'agent-local memory', status: 'promoted', scope: 'agent' }),
    );
    store.putNode(makeNode({ id: 'mem_a4', label: 'session scratch', scope: 'session' }));
    store.putNode(makeNode({ id: 'mem_a5', label: 'legacy memory', status: 'candidate' })); // → agent
    store.putNode(makeNode({ id: 'ent-1', label: 'shared entity' }));
    store.close();

    return consolidateHive({
      agents: [{ name: 'a', graphPath }],
      outPath: join(root, `hive-${scopeOverrides ? 'override' : 'default'}.db`),
      scopeOverrides,
    });
  }

  it('agent, legacy-as-agent, and session memories never enter the hive by default', async () => {
    const hive = await buildHiveFrom();
    const ids = Object.keys(hive.nodes);
    assert.ok(ids.includes('mem_a1'), 'user memory in hive');
    assert.ok(ids.includes('mem_a2'), 'project memory in hive');
    assert.ok(ids.includes('ent-1'), 'unscoped entity in hive');
    assert.ok(!ids.includes('mem_a3'), 'agent memory excluded');
    assert.ok(!ids.includes('mem_a4'), 'session scratch excluded');
    assert.ok(!ids.includes('mem_a5'), 'legacy (agent-equivalent) excluded');
  });

  it('config override can opt agent scope into the hive', async () => {
    const hive = await buildHiveFrom({ agent: { hiveEligible: true } });
    const ids = Object.keys(hive.nodes);
    assert.ok(ids.includes('mem_a3'), 'agent memory included via override');
    assert.ok(!ids.includes('mem_a4'), 'session stays out regardless');
  });
});

describe('session scratch purge (D4)', () => {
  function seeded(): SqliteStore {
    const store = SqliteStore.open(':memory:');
    store.putNode(
      makeNode({
        id: 'mem_old1',
        label: 'old scratch',
        scope: 'session',
        lastReinforced: '2026-07-01T09:00:00Z',
      }),
    );
    store.putNode(
      makeNode({
        id: 'mem_new1',
        label: 'fresh scratch',
        scope: 'session',
        lastReinforced: '2026-07-19T09:00:00Z',
      }),
    );
    store.putNode(
      makeNode({
        id: 'mem_dur1',
        label: 'old durable',
        status: 'promoted',
        scope: 'user',
        lastReinforced: '2026-01-01T09:00:00Z',
      }),
    );
    store.putEmbedding('mem_old1', 'node', 'old scratch', new Float32Array(8).fill(0.5), 'mock');
    store.putEpisode({
      id: 'ep_old',
      timestamp: '2026-07-01T09:00:00Z',
      type: 'observation',
      title: 'old session episode',
      content: 'x',
      sequence: 0,
      participants: [],
      topics: [],
      importance: 0.5,
      accessCount: 0,
      lastAccessed: '2026-07-01T09:00:00Z',
      source: 'test',
      sourceType: 'conversation',
      scope: 'session',
    });
    store.putProcedure({
      id: 'proc_old',
      statement: 'old session procedure',
      type: 'insight',
      triggerKeywords: [],
      triggerContexts: [],
      sourceEpisodes: [],
      sourceNodes: [],
      confidence: 0.5,
      applications: 0,
      contradictions: 0,
      stability: 1,
      lastApplied: null,
      createdAt: '2026-07-01',
      updatedAt: '2026-07-01T09:00:00Z',
      flaggedForReview: false,
      scope: 'session',
    });
    return store;
  }

  const NOW = new Date('2026-07-20T09:00:00Z');

  it('purges expired session rows across nodes, episodes, and procedures', () => {
    const store = seeded();
    const purged = purgeExpiredScratch(store, undefined, NOW);
    assert.deepEqual(purged, { nodes: 1, episodes: 1, procedures: 1 });
    assert.equal(store.getNode('mem_old1'), undefined);
    assert.equal(store.getEmbedding('mem_old1'), undefined);
    assert.ok(store.getNode('mem_new1'), 'fresh scratch survives');
    assert.ok(store.getNode('mem_dur1'), 'durable scopes are never purged, however old');
    store.close();
  });

  it('honors a configured retention override', () => {
    const store = seeded();
    // 30-day retention: nothing from July expires by the 20th.
    const purged = purgeExpiredScratch(store, { session: { retentionDays: 30 } }, NOW);
    assert.deepEqual(purged, { nodes: 0, episodes: 0, procedures: 0 });
    // retentionDays null = keep scratch forever.
    const none = purgeExpiredScratch(store, { session: { retentionDays: null } }, NOW);
    assert.deepEqual(none, { nodes: 0, episodes: 0, procedures: 0 });
    store.close();
  });
});
