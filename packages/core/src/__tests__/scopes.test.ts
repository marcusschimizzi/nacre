import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture } from '../capture.js';
import { resolveScopeForWrite, resolveScopePolicy } from '../config.js';
import { compileMemoryDir, replayCaptureCandidates } from '../memory-compile.js';
import { SqliteStore } from '../store.js';
import { consolidateTruthLayer } from '../truth-layer.js';
import {
  DEFAULT_SCOPE_POLICIES,
  SESSION_SCOPE,
  isDurableScope,
  isKnownScope,
  resolveWriteScope,
  scopeClass,
  scopePolicy,
} from '../scopes.js';

describe('scope classification', () => {
  it('distinguishes durable scopes from session scratch', () => {
    for (const scope of ['user', 'agent', 'project/nacre', 'project/tide-pool']) {
      assert.ok(isDurableScope(scope), `${scope} is durable`);
      assert.ok(isKnownScope(scope));
    }
    assert.ok(!isDurableScope(SESSION_SCOPE), 'session is not durable');
    assert.ok(isKnownScope(SESSION_SCOPE), 'session is known');
    assert.ok(!isKnownScope('global'));
    assert.ok(!isKnownScope('project/'));
  });

  it('maps scopes to policy classes', () => {
    assert.equal(scopeClass('user'), 'user');
    assert.equal(scopeClass('agent'), 'agent');
    assert.equal(scopeClass('session'), 'session');
    assert.equal(scopeClass('project/nacre'), 'project');
    assert.equal(scopeClass('nonsense'), undefined);
  });
});

describe('scopePolicy', () => {
  it('applies built-in defaults per class', () => {
    assert.deepEqual(scopePolicy('user'), DEFAULT_SCOPE_POLICIES.user);
    assert.deepEqual(scopePolicy('project/nacre'), DEFAULT_SCOPE_POLICIES.project);
    assert.equal(scopePolicy('agent').hiveEligible, false);
    assert.equal(scopePolicy('session').spooled, false);
    assert.equal(scopePolicy('session').retentionDays, 7);
  });

  it('unknown scopes get the most conservative policy (store-only scratch)', () => {
    const policy = scopePolicy('whatever');
    assert.equal(policy.spooled, false);
    assert.equal(policy.hiveEligible, false);
  });

  it('class overrides apply to every scope in the class; exact overrides win', () => {
    const overrides = {
      project: { hiveEligible: false },
      'project/public-notes': { hiveEligible: true },
      agent: { syncEligible: true },
    };
    assert.equal(scopePolicy('project/nacre', overrides).hiveEligible, false);
    assert.equal(scopePolicy('project/public-notes', overrides).hiveEligible, true);
    assert.equal(scopePolicy('agent', overrides).syncEligible, true);
    // Untouched fields keep their defaults.
    assert.equal(scopePolicy('project/nacre', overrides).spooled, true);
  });
});

describe('resolveWriteScope', () => {
  it('explicit wins, config default second, agent last', () => {
    assert.equal(resolveWriteScope('project/nacre', 'user'), 'project/nacre');
    assert.equal(resolveWriteScope(undefined, 'user'), 'user');
    assert.equal(resolveWriteScope(undefined, undefined), 'agent');
  });

  it('explicit session is honored (scratch is a deliberate choice)', () => {
    assert.equal(resolveWriteScope('session', 'user'), 'session');
  });

  it('invalid explicit and non-durable config defaults fall through', () => {
    assert.equal(resolveWriteScope('global', 'user'), 'user');
    // A session DEFAULT would silently make everything scratch — refused.
    assert.equal(resolveWriteScope(undefined, 'session'), 'agent');
    assert.equal(resolveWriteScope(undefined, 'nonsense'), 'agent');
  });
});

describe('config-level scope resolution', () => {
  let root: string;
  after(() => rmSync(root, { recursive: true, force: true }));

  it('reads memory.defaultScope and scopes overrides from nacre.config.json', () => {
    root = mkdtempSync(join(tmpdir(), 'nacre-scopecfg-'));
    const graphPath = join(root, 'graph.db');
    writeFileSync(
      join(root, 'nacre.config.json'),
      JSON.stringify({
        memory: { defaultScope: 'project/nacre' },
        scopes: { agent: { hiveEligible: true }, session: { retentionDays: 1 } },
      }),
    );

    assert.equal(resolveScopeForWrite(graphPath), 'project/nacre');
    assert.equal(resolveScopeForWrite(graphPath, 'user'), 'user');
    assert.equal(resolveScopePolicy(graphPath, 'agent').hiveEligible, true);
    assert.equal(resolveScopePolicy(graphPath, 'session').retentionDays, 1);
    // Untouched scopes keep builtin policy.
    assert.equal(resolveScopePolicy(graphPath, 'user').hiveEligible, true);
  });

  it('falls back to agent without config', () => {
    assert.equal(resolveScopeForWrite(null), 'agent');
  });
});

describe('scope-filtered recall (D2)', () => {
  async function seededStore(): Promise<SqliteStore> {
    const store = SqliteStore.open(':memory:');
    const base = {
      aliases: [],
      firstSeen: '2026-07-10T09:00:00Z',
      lastReinforced: '2026-07-19T09:00:00Z',
      mentionCount: 3,
      reinforcementCount: 1,
      sourceFiles: [],
      excerpts: [],
    };
    // One memory per scope, all mentioning "deploy" so every retrieval path
    // (semantic seed via label match, graph walk, recency) can find them.
    store.putNode({
      ...base,
      id: 'mem_a00000000001',
      label: 'deploy decision for project a',
      type: 'decision',
      status: 'promoted',
      scope: 'project/a',
    } as never);
    store.putNode({
      ...base,
      id: 'mem_b00000000002',
      label: 'deploy decision for project b',
      type: 'decision',
      status: 'promoted',
      scope: 'project/b',
    } as never);
    store.putNode({
      ...base,
      id: 'mem_c00000000003',
      label: 'deploy preference of the user',
      type: 'concept',
      status: 'promoted',
      scope: 'user',
    } as never);
    store.putNode({
      ...base,
      id: 'mem_d00000000004',
      label: 'deploy scratch note',
      type: 'concept',
      scope: 'session',
    } as never);
    store.putNode({
      ...base,
      id: 'mem_e00000000005',
      label: 'deploy legacy memory',
      type: 'concept',
      status: 'candidate',
    } as never); // pre-v9: status, no scope → agent
    // A shared entity, connected to memories in two scopes.
    store.putNode({ ...base, id: 'ent-deploy', label: 'deploy', type: 'concept' } as never);
    for (const [i, source] of [
      'mem_a00000000001',
      'mem_b00000000002',
      'mem_c00000000003',
      'mem_d00000000004',
      'mem_e00000000005',
    ].entries()) {
      store.putEdge({
        id: `${source}--ent-deploy--explicit`,
        source,
        target: 'ent-deploy',
        type: 'explicit',
        directed: false,
        weight: 0.8,
        baseWeight: 0.8,
        reinforcementCount: 1,
        firstFormed: '2026-07-10',
        lastReinforced: '2026-07-19',
        stability: 1,
        evidence: [],
      });
      void i;
    }
    return store;
  }

  it('a project-scoped filter never returns other scopes on any path', async () => {
    const store = await seededStore();
    const { recall } = await import('../recall.js');
    const response = await recall(store, null, { query: 'deploy', scopes: ['project/a'] });
    const ids = response.results.map((r) => r.id);
    assert.ok(ids.includes('mem_a00000000001'), 'in-scope memory returned');
    assert.ok(ids.includes('ent-deploy'), 'entities are visible from any scope');
    for (const leaked of [
      'mem_b00000000002',
      'mem_c00000000003',
      'mem_d00000000004',
      'mem_e00000000005',
    ]) {
      assert.ok(!ids.includes(leaked), `${leaked} must not leak into project/a recall`);
    }
    // Connections on the shared entity also hide out-of-scope memories.
    const entity = response.results.find((r) => r.id === 'ent-deploy');
    assert.ok(!entity?.connections.some((c) => c.label.includes('project b')));
    store.close();
  });

  it('default recall returns every durable scope (incl. legacy-as-agent) but never session', async () => {
    const store = await seededStore();
    const { recall } = await import('../recall.js');
    const response = await recall(store, null, { query: 'deploy', limit: 20 });
    const ids = response.results.map((r) => r.id);
    for (const durable of [
      'mem_a00000000001',
      'mem_b00000000002',
      'mem_c00000000003',
      'mem_e00000000005',
    ]) {
      assert.ok(ids.includes(durable), `${durable} visible by default`);
    }
    assert.ok(!ids.includes('mem_d00000000004'), 'session scratch requires explicit request');
    store.close();
  });

  it('explicit session scope surfaces scratch', async () => {
    const store = await seededStore();
    const { recall } = await import('../recall.js');
    const response = await recall(store, null, { query: 'deploy', scopes: ['session'], limit: 20 });
    const ids = response.results.map((r) => r.id);
    assert.ok(ids.includes('mem_d00000000004'));
    assert.ok(!ids.includes('mem_c00000000003'), 'durable scopes excluded when not listed');
    store.close();
  });
});

describe('filterGraphByScopes', () => {
  it('drops out-of-scope nodes and their edges; entities survive', async () => {
    const { filterGraphByScopes } = await import('../scopes.js');
    const graph = {
      nodes: {
        m1: { scope: 'project/a', status: 'promoted' },
        m2: { scope: 'session' },
        e1: {},
      },
      edges: {
        'm1--e1': { source: 'm1', target: 'e1' },
        'm2--e1': { source: 'm2', target: 'e1' },
      },
    };
    const filtered = filterGraphByScopes(graph, ['project/a']);
    assert.deepEqual(Object.keys(filtered.nodes).sort(), ['e1', 'm1']);
    assert.deepEqual(Object.keys(filtered.edges), ['m1--e1']);

    const defaultFiltered = filterGraphByScopes(graph);
    assert.ok(!defaultFiltered.nodes.m2, 'session excluded by default');
    assert.ok(defaultFiltered.nodes.m1 && defaultFiltered.nodes.e1);
  });
});

describe('scope survives the truth-layer round trip (schema v9)', () => {
  let root: string;
  after(() => rmSync(root, { recursive: true, force: true }));

  it('capture scope X → file in X dir → compiled node.scope X → rebuild still X', () => {
    root = mkdtempSync(join(tmpdir(), 'nacre-scope-rt-'));
    const store = SqliteStore.open(':memory:');
    appendCapture(root, {
      id: 'mem_50c0be110001',
      ts: '2026-07-19T09:00:00Z',
      origin: 'mcp',
      payload: { content: 'A project-scoped decision.', type: 'decision', scope: 'project/nacre' },
    });

    const truth = consolidateTruthLayer(store, root);
    const relPath = truth.promotion.promoted[0];
    assert.ok(relPath.startsWith('projects/nacre/'), 'file lands in the scope directory');
    assert.equal(store.getNode('mem_50c0be110001')?.scope, 'project/nacre');

    // Rebuild from files alone: scope intact.
    const fresh = SqliteStore.open(':memory:');
    compileMemoryDir(fresh, root);
    assert.equal(fresh.getNode('mem_50c0be110001')?.scope, 'project/nacre');

    // Entities created from the same file stay unscoped (D1).
    for (const node of fresh.listNodes()) {
      if (node.id !== 'mem_50c0be110001') assert.equal(node.scope, undefined);
    }
    fresh.close();
    store.close();
  });

  it('replayed candidates carry the capture scope; invalid scopes default to agent', () => {
    const rt = mkdtempSync(join(tmpdir(), 'nacre-scope-replay-'));
    const store = SqliteStore.open(':memory:');
    try {
      appendCapture(rt, {
        id: 'mem_50c0be110002',
        ts: '2026-07-19T09:00:00Z',
        origin: 'mcp',
        payload: { content: 'User-scoped.', type: 'fact', scope: 'user' },
      });
      appendCapture(rt, {
        id: 'mem_50c0be110003',
        ts: '2026-07-19T09:01:00Z',
        origin: 'mcp',
        payload: { content: 'Bad scope.', type: 'fact', scope: 'galaxy' },
      });
      replayCaptureCandidates(store, rt);
      assert.equal(store.getNode('mem_50c0be110002')?.scope, 'user');
      assert.equal(store.getNode('mem_50c0be110003')?.scope, 'agent');
    } finally {
      store.close();
      rmSync(rt, { recursive: true, force: true });
    }
  });

  it('episodes and procedures round-trip their scope through the store', () => {
    const store = SqliteStore.open(':memory:');
    store.putEpisode({
      id: 'ep_scope1',
      timestamp: '2026-07-19T09:00:00Z',
      type: 'conversation',
      title: 'Scoped episode',
      content: 'body',
      sequence: 0,
      participants: [],
      topics: [],
      importance: 0.5,
      accessCount: 0,
      lastAccessed: '2026-07-19T09:00:00Z',
      source: 'test',
      sourceType: 'conversation',
      scope: 'project/nacre',
    });
    assert.equal(store.getEpisode('ep_scope1')?.scope, 'project/nacre');

    store.putProcedure({
      id: 'proc_scope1',
      statement: 'Scoped procedure',
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
      createdAt: '2026-07-19',
      updatedAt: '2026-07-19',
      flaggedForReview: false,
      scope: 'user',
    });
    assert.equal(store.getProcedure('proc_scope1')?.scope, 'user');

    // Legacy rows (no scope) read back as unset.
    store.putProcedure({
      id: 'proc_legacy',
      statement: 'Legacy procedure',
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
      createdAt: '2026-07-19',
      updatedAt: '2026-07-19',
      flaggedForReview: false,
    });
    assert.equal(store.getProcedure('proc_legacy')?.scope, undefined);
    store.close();
  });
});
