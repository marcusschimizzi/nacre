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
