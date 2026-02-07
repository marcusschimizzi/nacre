import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  SqliteStore,
  type Procedure,
  type ProcedureType,
  type ProcedureFilter,
  recall,
  MockEmbedder,
} from '@nacre/core';
import { findRelevantProcedures, applyProcedure } from '../procedures.js';

function asProcedureStore(store: SqliteStore): Parameters<typeof findRelevantProcedures>[0] {
  return store as unknown as Parameters<typeof findRelevantProcedures>[0];
}

function asApplyStore(store: SqliteStore): Parameters<typeof applyProcedure>[0] {
  return store as unknown as Parameters<typeof applyProcedure>[0];
}

function makeProc(overrides: Partial<Procedure> & { id: string; statement: string }): Procedure {
  return {
    type: 'skill',
    triggerKeywords: [],
    triggerContexts: [],
    sourceEpisodes: [],
    sourceNodes: [],
    confidence: 0.5,
    applications: 0,
    contradictions: 0,
    stability: 1.0,
    lastApplied: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    flaggedForReview: false,
    ...overrides,
  };
}

describe('procedures store CRUD', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open(':memory:');
  });

  after(() => {
    store.close();
  });

  it('putProcedure/getProcedure roundtrip preserves all fields', () => {
    const proc = makeProc({
      id: 'p1',
      statement: 'Use strict TypeScript settings',
      type: 'heuristic',
      triggerKeywords: ['typescript', 'strict'],
      triggerContexts: ['coding', 'review'],
      sourceEpisodes: ['ep1', 'ep2'],
      sourceNodes: ['n1'],
      confidence: 0.72,
      applications: 4,
      contradictions: 1,
      stability: 1.4,
      lastApplied: '2026-01-15T10:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-15T10:00:00.000Z',
      flaggedForReview: true,
    });

    store.putProcedure(proc);
    const got = store.getProcedure('p1');

    assert.ok(got);
    assert.deepStrictEqual(got, proc);
  });

  it('getProcedure returns undefined for missing id', () => {
    assert.equal(store.getProcedure('missing-proc'), undefined);
  });

  it('listProcedures with no filter returns all procedures', () => {
    store.putProcedure(makeProc({ id: 'p2', statement: 'Keep commits atomic' }));
    store.putProcedure(makeProc({ id: 'p3', statement: 'Prefer explicit names' }));

    const all = store.listProcedures();
    const ids = all.map((p) => p.id);
    assert.ok(ids.includes('p1'));
    assert.ok(ids.includes('p2'));
    assert.ok(ids.includes('p3'));
  });

  it('listProcedures with type filter returns matching type', () => {
    const prefType: ProcedureType = 'preference';
    store.putProcedure(makeProc({ id: 'p4', statement: 'Use monospace fonts in editor', type: prefType }));

    const filter: ProcedureFilter = { type: prefType };
    const results = store.listProcedures(filter);

    assert.ok(results.length >= 1);
    assert.ok(results.every((p) => p.type === 'preference'));
  });

  it('listProcedures with minConfidence filter returns confident procedures', () => {
    store.putProcedure(makeProc({ id: 'p5', statement: 'Validate input types', confidence: 0.9 }));
    store.putProcedure(makeProc({ id: 'p6', statement: 'Try random workaround', confidence: 0.2 }));

    const results = store.listProcedures({ minConfidence: 0.8 });
    assert.ok(results.length >= 1);
    assert.ok(results.every((p) => p.confidence >= 0.8));
  });

  it('listProcedures with flaggedOnly filter returns flagged procedures', () => {
    store.putProcedure(makeProc({ id: 'p7', statement: 'Outdated deployment flow', flaggedForReview: true }));
    store.putProcedure(makeProc({ id: 'p8', statement: 'Current deployment flow', flaggedForReview: false }));

    const flagged = store.listProcedures({ flaggedOnly: true });
    assert.ok(flagged.length >= 1);
    assert.ok(flagged.every((p) => p.flaggedForReview));
  });

  it('deleteProcedure removes the procedure', () => {
    store.putProcedure(makeProc({ id: 'p-del', statement: 'Delete me' }));
    assert.ok(store.getProcedure('p-del'));

    store.deleteProcedure('p-del');
    assert.equal(store.getProcedure('p-del'), undefined);
  });

  it('procedureCount returns correct count', () => {
    const countFromStore = store.procedureCount();
    const listed = store.listProcedures().length;
    assert.equal(countFromStore, listed);
  });
});

describe('findRelevantProcedures trigger matching', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open(':memory:');

    store.putProcedure(makeProc({
      id: 'tm-1',
      statement: 'Use incremental rollout for deploys',
      type: 'skill',
      triggerKeywords: ['deploy', 'rollout'],
      triggerContexts: ['release'],
      confidence: 0.9,
    }));
    store.putProcedure(makeProc({
      id: 'tm-2',
      statement: 'Run tests before merge',
      type: 'heuristic',
      triggerKeywords: ['tests', 'merge'],
      triggerContexts: ['CI'],
      confidence: 0.7,
    }));
    store.putProcedure(makeProc({
      id: 'tm-3',
      statement: 'Avoid force-pushes to shared branches',
      type: 'antipattern',
      triggerKeywords: ['force-push'],
      triggerContexts: ['git'],
      confidence: 0.4,
    }));
    store.putProcedure(makeProc({
      id: 'tm-4',
      statement: 'Use staging for deployments',
      type: 'skill',
      triggerKeywords: ['deployment'],
      triggerContexts: ['Release'],
      confidence: 0.8,
    }));
  });

  after(() => {
    store.close();
  });

  it('returns empty for empty query with no contexts', () => {
    const matches = findRelevantProcedures(asProcedureStore(store), '   ');
    assert.deepStrictEqual(matches, []);
  });

  it('matches keywords exactly', () => {
    const matches = findRelevantProcedures(asProcedureStore(store), 'deploy now');
    assert.ok(matches.some((m) => m.procedure.id === 'tm-1'));
  });

  it('matches keywords partially', () => {
    const matches = findRelevantProcedures(asProcedureStore(store), 'deployment checklist');
    assert.ok(matches.some((m) => m.procedure.id === 'tm-1'));
    assert.ok(matches.some((m) => m.procedure.id === 'tm-4'));
  });

  it('matches contexts case-insensitively', () => {
    const matches = findRelevantProcedures(asProcedureStore(store), '', ['release'], { minScore: 0 });
    const ids = matches.map((m) => m.procedure.id);
    assert.ok(ids.includes('tm-1'));
    assert.ok(ids.includes('tm-4'));
  });

  it('returns results sorted by descending score', () => {
    const matches = findRelevantProcedures(asProcedureStore(store), 'deploy release');
    assert.ok(matches.length >= 2);
    for (let i = 1; i < matches.length; i++) {
      assert.ok(matches[i - 1].score >= matches[i].score);
    }
  });

  it('respects limit option', () => {
    const matches = findRelevantProcedures(asProcedureStore(store), 'deploy tests merge release', [], { limit: 2, minScore: 0 });
    assert.equal(matches.length, 2);
  });

  it('weights scores by confidence', () => {
    store.putProcedure(makeProc({
      id: 'tm-high',
      statement: 'High confidence deploy rule',
      triggerKeywords: ['deploy'],
      confidence: 0.95,
    }));
    store.putProcedure(makeProc({
      id: 'tm-low',
      statement: 'Low confidence deploy rule',
      triggerKeywords: ['deploy'],
      confidence: 0.25,
    }));

    const matches = findRelevantProcedures(asProcedureStore(store), 'deploy', [], { minScore: 0 });
    const high = matches.find((m) => m.procedure.id === 'tm-high');
    const low = matches.find((m) => m.procedure.id === 'tm-low');

    assert.ok(high);
    assert.ok(low);
    assert.ok(high.score > low.score);
  });

  it('does not return procedures below minScore', () => {
    const matches = findRelevantProcedures(asProcedureStore(store), 'force-push', [], { minScore: 0.5 });
    assert.ok(matches.every((m) => m.score >= 0.5));
    assert.ok(!matches.some((m) => m.procedure.id === 'tm-3'));
  });

  it('includes matchedKeywords and matchedContexts in results', () => {
    const matches = findRelevantProcedures(asProcedureStore(store), 'deploy', ['release'], { minScore: 0 });
    const match = matches.find((m) => m.procedure.id === 'tm-1');
    assert.ok(match);
    assert.ok(match.matchedKeywords.includes('deploy'));
    assert.ok(match.matchedContexts.some((c) => c.toLowerCase() === 'release'));
  });
});

describe('applyProcedure confidence dynamics', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open(':memory:');
  });

  after(() => {
    store.close();
  });

  it('positive feedback increases confidence asymptotically', () => {
    store.putProcedure(makeProc({ id: 'c-pos-curve', statement: 'Use retries', confidence: 0.4 }));

    const first = applyProcedure(asApplyStore(store), 'c-pos-curve', 'positive');
    const second = applyProcedure(asApplyStore(store), 'c-pos-curve', 'positive');

    const delta1 = first.confidence - 0.4;
    const delta2 = second.confidence - first.confidence;
    assert.ok(first.confidence > 0.4);
    assert.ok(second.confidence > first.confidence);
    assert.ok(delta2 < delta1);
  });

  it('positive feedback increments applications', () => {
    store.putProcedure(makeProc({ id: 'c-pos-app', statement: 'Cache expensive calls', applications: 2 }));
    const updated = applyProcedure(asApplyStore(store), 'c-pos-app', 'positive');
    assert.equal(updated.applications, 3);
  });

  it('positive feedback increases stability', () => {
    store.putProcedure(makeProc({ id: 'c-pos-stab', statement: 'Use feature flags', stability: 1.1 }));
    const updated = applyProcedure(asApplyStore(store), 'c-pos-stab', 'positive');
    assert.ok(updated.stability > 1.1);
  });

  it('negative feedback decreases confidence by factor 0.8', () => {
    store.putProcedure(makeProc({ id: 'c-neg-conf', statement: 'Always squash merge', confidence: 0.5 }));
    const updated = applyProcedure(asApplyStore(store), 'c-neg-conf', 'negative');
    assert.equal(updated.confidence, 0.4);
  });

  it('negative feedback increments contradictions', () => {
    store.putProcedure(makeProc({ id: 'c-neg-ctr', statement: 'Use strict linting', contradictions: 1 }));
    const updated = applyProcedure(asApplyStore(store), 'c-neg-ctr', 'negative');
    assert.equal(updated.contradictions, 2);
  });

  it('neutral feedback only updates lastApplied and timestamps', () => {
    store.putProcedure(makeProc({
      id: 'c-neu',
      statement: 'Log key events',
      confidence: 0.66,
      applications: 5,
      contradictions: 2,
      stability: 1.7,
      lastApplied: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));

    const beforeProc = store.getProcedure('c-neu')!;
    const updated = applyProcedure(asApplyStore(store), 'c-neu', 'neutral');

    assert.equal(updated.confidence, beforeProc.confidence);
    assert.equal(updated.applications, beforeProc.applications);
    assert.equal(updated.contradictions, beforeProc.contradictions);
    assert.equal(updated.stability, beforeProc.stability);
    assert.ok(updated.lastApplied);
    assert.notEqual(updated.updatedAt, beforeProc.updatedAt);
  });

  it('flags procedure when contradictions >= 3 and confidence < 0.3', () => {
    store.putProcedure(makeProc({
      id: 'c-flag',
      statement: 'Legacy release process',
      confidence: 0.2,
      contradictions: 2,
      flaggedForReview: false,
    }));

    const updated = applyProcedure(asApplyStore(store), 'c-flag', 'negative');
    assert.equal(updated.contradictions, 3);
    assert.ok(updated.confidence < 0.3);
    assert.equal(updated.flaggedForReview, true);
  });

  it('throws for nonexistent procedure id', () => {
    assert.throws(() => applyProcedure(asApplyStore(store), 'does-not-exist', 'positive'), /Procedure not found/);
  });
});

describe('recall integration with procedures', () => {
  let store: SqliteStore;
  const embedder = new MockEmbedder();

  before(async () => {
    store = SqliteStore.open(':memory:');

    store.putNode({
      id: 'n-deploy',
      label: 'deploy workflow',
      type: 'concept',
      aliases: [],
      firstSeen: '2026-01-01',
      lastReinforced: '2026-01-15',
      mentionCount: 6,
      reinforcementCount: 2,
      sourceFiles: ['deploy.md'],
      excerpts: [{ file: 'deploy.md', text: 'Deploy workflow and rollback checklist', date: '2026-01-15' }],
    });

    const embedding = await embedder.embed('deploy workflow rollback checklist');
    store.putEmbedding('n-deploy', 'node', 'deploy workflow rollback checklist', embedding, embedder.name);

    store.putProcedure(makeProc({
      id: 'r-proc-1',
      statement: 'Use canary deploy and monitor errors',
      type: 'skill',
      triggerKeywords: ['deploy', 'rollback'],
      confidence: 0.85,
    }));
  });

  after(() => {
    store.close();
  });

  it('recall includes procedures in first result when procedures match', async () => {
    const results = await recall(store, embedder, { query: 'deploy rollback' });
    assert.ok(results.length > 0);
    assert.ok(results[0].procedures);
    assert.ok(results[0].procedures!.length > 0);
    assert.equal(results[0].procedures![0].id, 'r-proc-1');
  });

  it('recall with includeProcedures false omits procedures', async () => {
    const results = await recall(store, embedder, {
      query: 'deploy rollback',
      includeProcedures: false,
    });

    assert.ok(results.length > 0);
    assert.equal(results[0].procedures, undefined);
  });

  it('recall procedure matches contain score and matchedKeywords', async () => {
    const results = await recall(store, embedder, { query: 'deploy rollback' });
    const proc = results[0].procedures?.[0];

    assert.ok(proc);
    assert.ok(typeof proc.score === 'number');
    assert.ok(proc.score > 0);
    assert.ok(proc.matchedKeywords.length > 0);
    assert.ok(proc.matchedKeywords.includes('deploy') || proc.matchedKeywords.includes('rollback'));
  });
});
