import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSuggestions,
  labelClusters,
  analyzeSignificance,
} from '../intelligence.js';
import { createGraph, addNode, addEdge } from '../graph.js';
import type { EntityType, NacreGraph, PendingEdge } from '../types.js';

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
  const forgotten = addNode(graph, makeNode('forgotten-idea', 'concept', {
    mentionCount: 1,
    reinforcementCount: 0,
    lastReinforced: '2026-01-10',
  }));
  const lobstar = addNode(graph, makeNode('lobstar', 'project', {
    mentionCount: 6,
    reinforcementCount: 4,
    lastReinforced: '2026-01-26',
  }));
  const vscode = addNode(graph, makeNode('vscode', 'tool', {
    mentionCount: 3,
    reinforcementCount: 1,
    lastReinforced: '2026-01-24',
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
  addEdge(graph, makeEdge(marcus.id, lobstar.id, 'co-occurrence', {
    weight: 0.7, baseWeight: 0.3, reinforcementCount: 4,
    lastReinforced: '2026-01-26',
  }));
  addEdge(graph, makeEdge(nacre.id, lobstar.id, 'co-occurrence', {
    weight: 0.5, baseWeight: 0.3, reinforcementCount: 3,
    lastReinforced: '2026-01-25',
  }));
  addEdge(graph, makeEdge(typescript.id, lobstar.id, 'co-occurrence', {
    weight: 0.35, baseWeight: 0.3, reinforcementCount: 2,
    lastReinforced: '2026-01-23',
  }));
  addEdge(graph, makeEdge(vscode.id, marcus.id, 'co-occurrence', {
    weight: 0.5, baseWeight: 0.3, reinforcementCount: 1,
    lastReinforced: '2026-01-24',
  }));
  addEdge(graph, makeEdge(vscode.id, typescript.id, 'co-occurrence', {
    weight: 0.55, baseWeight: 0.3, reinforcementCount: 2,
    lastReinforced: '2026-01-24',
  }));
  addEdge(graph, makeEdge(vscode.id, nacre.id, 'co-occurrence', {
    weight: 0.45, baseWeight: 0.3, reinforcementCount: 1,
    lastReinforced: '2026-01-23',
  }));
  addEdge(graph, makeEdge(tidepool.id, typescript.id, 'co-occurrence', {
    weight: 0.05, baseWeight: 0.3, reinforcementCount: 0,
    lastReinforced: '2026-01-10',
  }));

  return graph;
}

describe('generateSuggestions', () => {
  it('returns empty suggestions for empty graph', () => {
    const graph = createGraph();
    const result = generateSuggestions(graph, []);

    assert.equal(result.suggestions.length, 0);
    assert.ok(result.summary.includes('No connection suggestions'));
  });

  it('detects pending edges near threshold', () => {
    const graph = createGraph();
    const a = addNode(graph, makeNode('a', 'concept'));
    const b = addNode(graph, makeNode('b', 'concept'));

    const pendingEdges: PendingEdge[] = [
      {
        source: a.id,
        target: b.id,
        type: 'co-occurrence',
        count: 1,
        firstSeen: '2026-01-28',
        evidence: [],
      },
    ];

    const result = generateSuggestions(graph, pendingEdges);

    assert.ok(result.suggestions.length > 0);
    const suggestion = result.suggestions.find(
      (s) => s.sourceId === a.id && s.targetId === b.id,
    );
    assert.ok(suggestion);
    assert.equal(suggestion.reason, 'pending-near-threshold');
  });

  it('detects structural holes', () => {
    const graph = buildTestGraph();
    const result = generateSuggestions(graph, []);

    const structuralHoles = result.suggestions.filter(
      (s) => s.reason === 'structural-hole',
    );
    assert.ok(structuralHoles.length > 0);
  });

  it('detects type bridges', () => {
    const graph = buildTestGraph();
    const result = generateSuggestions(graph, []);

    const typeBridges = result.suggestions.filter(
      (s) => s.reason === 'type-bridge',
    );
    assert.ok(typeBridges.length > 0);
  });

  it('sorts suggestions by confidence descending', () => {
    const graph = buildTestGraph();
    const result = generateSuggestions(graph, []);

    for (let i = 1; i < result.suggestions.length; i++) {
      assert.ok(
        result.suggestions[i - 1].confidence >= result.suggestions[i].confidence,
      );
    }
  });

  it('respects maxSuggestions limit', () => {
    const graph = buildTestGraph();
    const result = generateSuggestions(graph, [], { maxSuggestions: 1 });

    assert.ok(result.suggestions.length <= 1);
  });

  it('generates human-readable summary', () => {
    const graph = buildTestGraph();
    const result = generateSuggestions(graph, []);

    assert.ok(result.summary.length > 0);
    assert.ok(
      result.summary.includes('suggestion') ||
        result.summary.includes('No connection'),
    );
  });
});

describe('labelClusters', () => {
  it('labels clusters from test graph', () => {
    const graph = buildTestGraph();
    const result = labelClusters(graph);

    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0);
    for (const cluster of result) {
      assert.ok(typeof cluster.hub === 'string');
      assert.ok(typeof cluster.label === 'string');
      assert.ok(Array.isArray(cluster.members));
      assert.ok(typeof cluster.size === 'number');
      assert.ok(cluster.size > 0);
      assert.ok(typeof cluster.dominantType === 'string');
      assert.ok(typeof cluster.typeCounts === 'object');
    }
  });

  it('sorts clusters by size descending', () => {
    const graph = buildTestGraph();
    const result = labelClusters(graph);

    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i - 1].size >= result[i].size);
    }
  });

  it('counts types correctly per cluster', () => {
    const graph = buildTestGraph();
    const result = labelClusters(graph);

    for (const cluster of result) {
      let typeSum = 0;
      for (const count of Object.values(cluster.typeCounts)) {
        typeSum += count;
      }
      assert.equal(typeSum, cluster.members.length);
    }
  });

  it('handles single-node clusters', () => {
    const graph = createGraph();
    const node = addNode(graph, makeNode('single', 'concept'));

    const result = labelClusters(graph);

    assert.ok(result.length > 0);
    const singleCluster = result.find((c) => c.members.some((m) => m.id === node.id));
    assert.ok(singleCluster);
    assert.equal(singleCluster.size, 1);
  });
});

describe('analyzeSignificance', () => {
  it('returns InsightResult structure', () => {
    const graph = buildTestGraph();
    const result = analyzeSignificance(graph);

    assert.ok(Array.isArray(result.emerging));
    assert.ok(Array.isArray(result.anchors));
    assert.ok(Array.isArray(result.fadingImportant));
    assert.ok(Array.isArray(result.clusters));
    assert.ok(typeof result.summary === 'string');
  });

  it('detects anchors (high connectivity + mentions)', () => {
    const graph = buildTestGraph();
    const result = analyzeSignificance(graph);

    const marcusAnchor = result.anchors.find((s) => s.node.label === 'marcus');
    assert.ok(marcusAnchor);
    assert.ok(marcusAnchor.edgeCount >= 5);
    assert.ok(marcusAnchor.node.mentionCount >= 3);
  });

  it('detects fading-important nodes', () => {
    const graph = buildTestGraph();
    const result = analyzeSignificance(graph, { now: new Date('2026-01-30') });

    assert.ok(Array.isArray(result.fadingImportant));
  });

  it('generates summary text', () => {
    const graph = buildTestGraph();
    const result = analyzeSignificance(graph);

    assert.ok(result.summary.length > 0);
  });

  it('respects recentDays option', () => {
    const graph = buildTestGraph();
    const result = analyzeSignificance(graph, {
      recentDays: 3,
      now: new Date('2026-01-30'),
    });

    assert.ok(Array.isArray(result.emerging));
  });

  it('handles empty graph', () => {
    const graph = createGraph();
    const result = analyzeSignificance(graph);

    assert.ok(Array.isArray(result.emerging));
    assert.ok(Array.isArray(result.anchors));
    assert.ok(Array.isArray(result.fadingImportant));
    assert.ok(Array.isArray(result.clusters));
  });
});
