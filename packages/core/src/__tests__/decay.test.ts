import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysBetween,
  calculateStability,
  computeCurrentWeight,
  decayAllEdges,
} from '../decay.js';
import { createGraph, addEdge } from '../graph.js';
import type { MemoryEdge } from '../types.js';

describe('daysBetween', () => {
  it('returns 0 for the same date', () => {
    assert.equal(daysBetween('2026-01-15', '2026-01-15'), 0);
  });

  it('returns correct days for different dates', () => {
    assert.equal(daysBetween('2026-01-10', '2026-01-15'), 5);
  });

  it('is commutative (absolute difference)', () => {
    assert.equal(
      daysBetween('2026-01-10', '2026-01-20'),
      daysBetween('2026-01-20', '2026-01-10'),
    );
  });

  it('handles cross-month boundaries', () => {
    assert.equal(daysBetween('2026-01-30', '2026-02-02'), 3);
  });
});

describe('calculateStability', () => {
  const EPSILON = 0.05;
  const beta = 1.5;

  it('R=0 -> S=1.0', () => {
    const s = calculateStability(0, beta);
    assert.ok(Math.abs(s - 1.0) < EPSILON, `expected ~1.0, got ${s}`);
  });

  it('R=1 -> S~2.04', () => {
    const s = calculateStability(1, beta);
    assert.ok(Math.abs(s - 2.04) < EPSILON, `expected ~2.04, got ${s}`);
  });

  it('R=3 -> S~3.08', () => {
    const s = calculateStability(3, beta);
    assert.ok(Math.abs(s - 3.08) < EPSILON, `expected ~3.08, got ${s}`);
  });

  it('R=7 -> S~4.12', () => {
    const s = calculateStability(7, beta);
    assert.ok(Math.abs(s - 4.12) < EPSILON, `expected ~4.12, got ${s}`);
  });

  it('R=15 -> S~5.16', () => {
    const s = calculateStability(15, beta);
    assert.ok(Math.abs(s - 5.16) < EPSILON, `expected ~5.16, got ${s}`);
  });

  it('R=30 -> S~6.15', () => {
    const s = calculateStability(30, beta);
    assert.ok(Math.abs(s - 6.15) < EPSILON, `expected ~6.15, got ${s}`);
  });

  it('stability increases monotonically with reinforcement', () => {
    let prev = 0;
    for (let r = 0; r <= 30; r++) {
      const s = calculateStability(r, beta);
      assert.ok(s > prev, `S(${r})=${s} should be > S(${r - 1})=${prev}`);
      prev = s;
    }
  });
});

describe('computeCurrentWeight', () => {
  const config = {
    decayRate: 0.015,
    reinforcementBoost: 1.5,
    visibilityThreshold: 0.05,
    coOccurrenceThreshold: 2,
    baseWeights: { explicit: 1.0, coOccurrence: 0.3, temporal: 0.1, causal: 0.8 },
  };

  function makeEdge(overrides: Partial<MemoryEdge> = {}): MemoryEdge {
    return {
      id: 'test-edge',
      source: 'a',
      target: 'b',
      type: 'explicit',
      directed: false,
      weight: 1.0,
      baseWeight: 1.0,
      reinforcementCount: 0,
      firstFormed: '2026-01-01',
      lastReinforced: '2026-01-01',
      stability: 1.0,
      evidence: [],
      ...overrides,
    };
  }

  it('returns baseWeight at t=0', () => {
    const edge = makeEdge({ lastReinforced: '2026-01-15T00:00:00.000Z' });
    const now = new Date('2026-01-15T00:00:00.000Z');
    const w = computeCurrentWeight(edge, now, config);
    assert.ok(Math.abs(w - 1.0) < 0.01, `expected ~1.0, got ${w}`);
  });

  it('half-life ~46 days for R=0 (S=1.0)', () => {
    const edge = makeEdge({ lastReinforced: '2026-01-01T00:00:00.000Z' });
    const now = new Date('2026-02-16T00:00:00.000Z');
    const w = computeCurrentWeight(edge, now, config);
    assert.ok(Math.abs(w - 0.5) < 0.05, `expected ~0.5 at 46 days, got ${w}`);
  });

  it('decays slower with higher reinforcement count', () => {
    const edge0 = makeEdge({
      lastReinforced: '2026-01-01',
      reinforcementCount: 0,
    });
    const edge7 = makeEdge({
      lastReinforced: '2026-01-01',
      reinforcementCount: 7,
    });
    const now = new Date('2026-03-01');
    const w0 = computeCurrentWeight(edge0, now, config);
    const w7 = computeCurrentWeight(edge7, now, config);
    assert.ok(w7 > w0, `R=7 weight (${w7}) should decay slower than R=0 (${w0})`);
  });

  it('weight never goes negative', () => {
    const edge = makeEdge({ lastReinforced: '2020-01-01' });
    const now = new Date('2026-01-01');
    const w = computeCurrentWeight(edge, now, config);
    assert.ok(w >= 0, `weight should be >= 0, got ${w}`);
  });
});

describe('decayAllEdges', () => {
  it('decays edges and counts dormant ones', () => {
    const graph = createGraph();
    addEdge(graph, {
      source: 'a',
      target: 'b',
      type: 'explicit',
      directed: false,
      weight: 1.0,
      baseWeight: 1.0,
      reinforcementCount: 0,
      firstFormed: '2025-01-01',
      lastReinforced: '2025-01-01',
      stability: 1.0,
      evidence: [],
    });
    addEdge(graph, {
      source: 'c',
      target: 'd',
      type: 'temporal',
      directed: false,
      weight: 0.1,
      baseWeight: 0.1,
      reinforcementCount: 0,
      firstFormed: '2025-01-01',
      lastReinforced: '2025-01-01',
      stability: 1.0,
      evidence: [],
    });

    const now = new Date('2026-06-01');
    const result = decayAllEdges(graph, now);

    assert.ok(result.decayed > 0, 'should have decayed edges');
    assert.ok(result.dormant >= 1, 'temporal edge should be dormant after 17 months');
  });

  it('returns 0 decayed when edges are fresh', () => {
    const graph = createGraph();
    const now = new Date('2026-01-15T00:00:00.000Z');
    addEdge(graph, {
      source: 'x',
      target: 'y',
      type: 'explicit',
      directed: false,
      weight: 1.0,
      baseWeight: 1.0,
      reinforcementCount: 0,
      firstFormed: '2026-01-15T00:00:00.000Z',
      lastReinforced: '2026-01-15T00:00:00.000Z',
      stability: 1.0,
      evidence: [],
    });

    const result = decayAllEdges(graph, now);
    assert.equal(result.decayed, 0);
    assert.equal(result.dormant, 0);
  });
});
