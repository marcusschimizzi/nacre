import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findNode,
  getNeighbors,
  getRelated,
  getFading,
  getClusters,
  generateBrief,
  generateAlerts,
  searchNodes,
} from '../query.js';
import { createGraph, addNode, addEdge } from '../graph.js';
import type { EntityType, NacreGraph } from '../types.js';

function makeNode(
  label: string,
  type: EntityType,
  overrides: Record<string, unknown> = {},
) {
  return {
    label,
    type,
    aliases: [] as string[],
    firstSeen: '2026-01-10',
    lastReinforced: '2026-01-20',
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: ['test.md'],
    excerpts: [],
    ...overrides,
  };
}

function makeEdge(
  source: string,
  target: string,
  type: 'explicit' | 'co-occurrence' | 'temporal' | 'causal' = 'co-occurrence',
  overrides: Record<string, unknown> = {},
) {
  return {
    source,
    target,
    type,
    directed: false,
    weight: 0.5,
    baseWeight: 0.5,
    reinforcementCount: 1,
    firstFormed: '2026-01-10',
    lastReinforced: '2026-01-20',
    stability: 1.0,
    evidence: [],
    ...overrides,
  };
}

function buildTestGraph(): NacreGraph {
  const graph = createGraph();
  const marcus = addNode(graph, makeNode('marcus', 'person', {
    mentionCount: 10,
    reinforcementCount: 8,
    lastReinforced: '2026-01-28',
    aliases: ['Marcus S'],
  }));
  const nacre = addNode(graph, makeNode('nacre', 'concept', {
    mentionCount: 8,
    reinforcementCount: 5,
    lastReinforced: '2026-01-27',
  }));
  const typescript = addNode(graph, makeNode('typescript', 'tool', {
    mentionCount: 5,
    reinforcementCount: 3,
    lastReinforced: '2026-01-25',
  }));
  const tidepool = addNode(graph, makeNode('tide-pool', 'project', {
    mentionCount: 4,
    reinforcementCount: 2,
    lastReinforced: '2026-01-20',
  }));
  const orphan = addNode(graph, makeNode('forgotten-idea', 'concept', {
    mentionCount: 1,
    reinforcementCount: 0,
    lastReinforced: '2026-01-10',
  }));

  addEdge(graph, makeEdge(marcus.id, nacre.id, 'explicit', {
    weight: 0.9, baseWeight: 1.0, reinforcementCount: 5,
    lastReinforced: '2026-01-28',
  }));
  addEdge(graph, makeEdge(marcus.id, typescript.id, 'co-occurrence', {
    weight: 0.6, baseWeight: 0.3, reinforcementCount: 3,
    lastReinforced: '2026-01-25',
  }));
  addEdge(graph, makeEdge(nacre.id, typescript.id, 'co-occurrence', {
    weight: 0.4, baseWeight: 0.3, reinforcementCount: 2,
    lastReinforced: '2026-01-22',
  }));
  addEdge(graph, makeEdge(marcus.id, tidepool.id, 'explicit', {
    weight: 0.08, baseWeight: 1.0, reinforcementCount: 0,
    lastReinforced: '2026-01-10',
  }));
  addEdge(graph, makeEdge(nacre.id, tidepool.id, 'temporal', {
    weight: 0.07, baseWeight: 0.1, reinforcementCount: 0,
    lastReinforced: '2026-01-10',
  }));

  return graph;
}

describe('generateBrief', () => {
  it('returns structured BriefResult with all fields', () => {
    const graph = buildTestGraph();
    const now = new Date('2026-01-30');
    const result = generateBrief(graph, { now, recentDays: 7 });

    assert.ok(Array.isArray(result.topEntities));
    assert.ok(Array.isArray(result.activeNodes));
    assert.ok(Array.isArray(result.fadingEdges));
    assert.ok(Array.isArray(result.clusters));
    assert.ok(typeof result.stats === 'object');
    assert.ok(typeof result.summary === 'string');
  });

  it('ranks nodes by score (mentions + reinforcement + recency)', () => {
    const graph = buildTestGraph();
    const now = new Date('2026-01-30');
    const result = generateBrief(graph, { now });

    assert.ok(result.topEntities.length > 0);
    assert.equal(result.topEntities[0].node.label, 'marcus');
    for (let i = 1; i < result.topEntities.length; i++) {
      assert.ok(result.topEntities[i - 1].score >= result.topEntities[i].score);
    }
  });

  it('identifies active nodes within recentDays window', () => {
    const graph = buildTestGraph();
    const now = new Date('2026-01-30');
    const result = generateBrief(graph, { now, recentDays: 7 });

    for (const active of result.activeNodes) {
      assert.ok(active.daysSinceReinforced <= 7);
    }
  });

  it('computes graph stats correctly', () => {
    const graph = buildTestGraph();
    const result = generateBrief(graph, { now: new Date('2026-01-30') });

    assert.equal(result.stats.totalNodes, 5);
    assert.equal(result.stats.totalEdges, 5);
    assert.ok(result.stats.averageWeight > 0);
    assert.ok(result.stats.entityTypeCounts['person'] >= 1);
    assert.ok(result.stats.entityTypeCounts['concept'] >= 1);
  });

  it('includes cluster information', () => {
    const graph = buildTestGraph();
    const result = generateBrief(graph, { now: new Date('2026-01-30') });

    assert.ok(result.clusters.length >= 1);
    assert.ok(result.clusters[0].size > 0);
    assert.ok(typeof result.clusters[0].hub === 'string');
  });

  it('generates human-readable summary', () => {
    const graph = buildTestGraph();
    const result = generateBrief(graph, { now: new Date('2026-01-30'), recentDays: 10 });

    assert.ok(result.summary.length > 0);
    assert.ok(result.summary.includes('Graph:'));
  });
});

describe('generateAlerts', () => {
  it('returns structured AlertResult', () => {
    const graph = buildTestGraph();
    const result = generateAlerts(graph, { now: new Date('2026-01-30') });

    assert.ok(Array.isArray(result.fadingEdges));
    assert.ok(Array.isArray(result.orphanNodes));
    assert.ok(typeof result.healthScore === 'number');
    assert.ok(typeof result.summary === 'string');
  });

  it('detects orphan nodes (no active connections)', () => {
    const graph = buildTestGraph();
    const result = generateAlerts(graph, { now: new Date('2026-01-30') });

    const orphanLabels = result.orphanNodes.map((n) => n.label);
    assert.ok(orphanLabels.includes('forgotten-idea'));
  });

  it('health score is between 0 and 1', () => {
    const graph = buildTestGraph();
    const result = generateAlerts(graph, { now: new Date('2026-01-30') });

    assert.ok(result.healthScore >= 0);
    assert.ok(result.healthScore <= 1);
  });

  it('fading edges include estimated days until dormant', () => {
    const graph = buildTestGraph();
    const result = generateAlerts(graph, { now: new Date('2026-01-30') });

    for (const f of result.fadingEdges) {
      assert.ok(typeof f.estimatedDaysUntilDormant === 'number');
      assert.ok(f.estimatedDaysUntilDormant >= 0);
      assert.ok(typeof f.sourceLabel === 'string');
      assert.ok(typeof f.targetLabel === 'string');
    }
  });

  it('produces summary text', () => {
    const graph = buildTestGraph();
    const result = generateAlerts(graph, { now: new Date('2026-01-30') });

    assert.ok(result.summary.includes('Health:'));
  });

  it('healthy graph reports high health score', () => {
    const graph = createGraph();
    const a = addNode(graph, makeNode('a', 'concept', {
      lastReinforced: '2026-01-29', reinforcementCount: 5,
    }));
    const b = addNode(graph, makeNode('b', 'concept', {
      lastReinforced: '2026-01-29', reinforcementCount: 5,
    }));
    addEdge(graph, makeEdge(a.id, b.id, 'explicit', {
      weight: 0.9, baseWeight: 1.0, reinforcementCount: 5,
      lastReinforced: '2026-01-29',
    }));

    const result = generateAlerts(graph, { now: new Date('2026-01-30') });
    assert.ok(result.healthScore >= 0.8, `expected >= 0.8, got ${result.healthScore}`);
    assert.equal(result.orphanNodes.length, 0);
  });
});

describe('searchNodes', () => {
  it('finds exact matches with score 1.0', () => {
    const graph = buildTestGraph();
    const results = searchNodes(graph, ['marcus']);

    assert.ok(results.length > 0);
    assert.equal(results[0].node.label, 'marcus');
    assert.equal(results[0].matchScore, 1.0);
  });

  it('finds partial matches', () => {
    const graph = buildTestGraph();
    const results = searchNodes(graph, ['type']);

    const labels = results.map((r) => r.node.label);
    assert.ok(labels.includes('typescript'));
  });

  it('handles multi-term search', () => {
    const graph = buildTestGraph();
    const results = searchNodes(graph, ['marcus', 'nacre']);

    assert.ok(results.length >= 2);
    const labels = results.map((r) => r.node.label);
    assert.ok(labels.includes('marcus'));
    assert.ok(labels.includes('nacre'));
  });

  it('filters by entity type', () => {
    const graph = buildTestGraph();
    const results = searchNodes(graph, [], { type: 'person' });

    assert.ok(results.length > 0);
    for (const r of results) {
      assert.equal(r.node.type, 'person');
    }
  });

  it('filters by sinceDays', () => {
    const graph = buildTestGraph();
    const now = new Date('2026-01-30');
    const results = searchNodes(graph, [], { sinceDays: 5, now });

    for (const r of results) {
      const lastReinforced = new Date(r.node.lastReinforced);
      const daysAgo = Math.floor((now.getTime() - lastReinforced.getTime()) / 86_400_000);
      assert.ok(daysAgo <= 5, `${r.node.label} was ${daysAgo} days ago`);
    }
  });

  it('combines type + sinceDays filters', () => {
    const graph = buildTestGraph();
    const now = new Date('2026-01-30');
    const results = searchNodes(graph, [], { type: 'concept', sinceDays: 5, now });

    for (const r of results) {
      assert.equal(r.node.type, 'concept');
    }
  });

  it('returns empty for no matches', () => {
    const graph = buildTestGraph();
    const results = searchNodes(graph, ['zzzznotexist']);

    assert.equal(results.length, 0);
  });

  it('finds nodes by alias', () => {
    const graph = buildTestGraph();
    const results = searchNodes(graph, ['marcus s']);

    assert.ok(results.length > 0);
    assert.equal(results[0].node.label, 'marcus');
  });

  it('returns all nodes when terms are empty and no filters', () => {
    const graph = buildTestGraph();
    const results = searchNodes(graph, []);

    assert.equal(results.length, 5);
  });

  it('sorts results by match score descending', () => {
    const graph = buildTestGraph();
    const results = searchNodes(graph, ['type']);

    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].matchScore >= results[i].matchScore);
    }
  });
});
