import type { NacreGraphData, ForceNode, ForceLink, GraphConfig } from './types.ts';

export interface LoadResult {
  nodes: ForceNode[];
  links: ForceLink[];
  config: GraphConfig;
  dateRange: { earliest: string; latest: string };
}

export async function loadGraph(url: string): Promise<LoadResult> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load graph: ${res.status}`);
  const data: NacreGraphData = await res.json();
  return transformGraph(data);
}

export function transformGraph(data: NacreGraphData): LoadResult {
  const edgeCounts = new Map<string, number>();
  const maxWeights = new Map<string, number>();

  for (const edge of Object.values(data.edges)) {
    edgeCounts.set(edge.source, (edgeCounts.get(edge.source) ?? 0) + 1);
    edgeCounts.set(edge.target, (edgeCounts.get(edge.target) ?? 0) + 1);

    const srcMax = maxWeights.get(edge.source) ?? 0;
    if (edge.weight > srcMax) maxWeights.set(edge.source, edge.weight);

    const tgtMax = maxWeights.get(edge.target) ?? 0;
    if (edge.weight > tgtMax) maxWeights.set(edge.target, edge.weight);
  }

  const nodes: ForceNode[] = Object.values(data.nodes).map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    firstSeen: n.firstSeen,
    lastReinforced: n.lastReinforced,
    mentionCount: n.mentionCount,
    reinforcementCount: n.reinforcementCount,
    sourceFiles: n.sourceFiles,
    excerpts: n.excerpts,
    edgeCount: edgeCounts.get(n.id) ?? 0,
    maxEdgeWeight: maxWeights.get(n.id) ?? 0,
  }));

  const links: ForceLink[] = Object.values(data.edges).map((e) => ({
    source: e.source,
    target: e.target,
    id: e.id,
    type: e.type,
    directed: e.directed,
    weight: e.weight,
    baseWeight: e.baseWeight,
    reinforcementCount: e.reinforcementCount,
    firstFormed: e.firstFormed,
    lastReinforced: e.lastReinforced,
    stability: e.stability,
  }));

  let earliest = '';
  let latest = '';
  for (const n of nodes) {
    if (!earliest || n.firstSeen < earliest) earliest = n.firstSeen;
    if (!latest || n.lastReinforced > latest) latest = n.lastReinforced;
  }

  const config: GraphConfig = {
    decayRate: data.config.decayRate,
    reinforcementBoost: data.config.reinforcementBoost,
    visibilityThreshold: data.config.visibilityThreshold,
  };

  return { nodes, links, config, dateRange: { earliest, latest } };
}

export function getEntityTypes(nodes: ForceNode[]): string[] {
  const types = new Set(nodes.map((n) => n.type));
  return [...types].sort();
}

export function getEdgeTypes(links: ForceLink[]): string[] {
  const types = new Set(links.map((l) => l.type));
  return [...types].sort();
}
