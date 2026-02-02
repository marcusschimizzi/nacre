import type { GraphConfig, MemoryEdge, NacreGraph } from './types.js';

export function daysBetween(dateA: string, dateB: string): number {
  const msPerDay = 86_400_000;
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.abs(Math.floor((a - b) / msPerDay));
}

export function calculateStability(
  reinforcementCount: number,
  reinforcementBoost: number,
): number {
  return 1 + reinforcementBoost * Math.log(reinforcementCount + 1);
}

export function computeCurrentWeight(
  edge: MemoryEdge,
  now: Date,
  config: GraphConfig,
): number {
  const daysSince = daysBetween(edge.lastReinforced, now.toISOString());
  const stability = calculateStability(
    edge.reinforcementCount,
    config.reinforcementBoost,
  );
  const weight = edge.baseWeight * Math.exp(
    -(config.decayRate * daysSince) / stability,
  );
  return Math.max(weight, 0);
}

export function decayEdge(
  graph: NacreGraph,
  edgeId: string,
  now: Date,
): MemoryEdge {
  const edge = graph.edges[edgeId];
  if (!edge) throw new Error(`Edge not found: ${edgeId}`);
  edge.weight = computeCurrentWeight(edge, now, graph.config);
  return edge;
}

export function decayAllEdges(
  graph: NacreGraph,
  now: Date,
): { decayed: number; dormant: number } {
  let decayed = 0;
  let dormant = 0;

  for (const edgeId of Object.keys(graph.edges)) {
    const before = graph.edges[edgeId].weight;
    decayEdge(graph, edgeId, now);
    const after = graph.edges[edgeId].weight;

    if (after < before) decayed += 1;
    if (after < graph.config.visibilityThreshold) dormant += 1;
  }

  return { decayed, dormant };
}
