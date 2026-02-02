import type { GraphConfig, MemoryEdge, MemoryNode, NacreGraph } from './types.js';
import { computeCurrentWeight, daysBetween } from './decay.js';
import { normalize } from './resolve.js';

export function findNode(
  graph: NacreGraph,
  search: string,
): MemoryNode | undefined {
  if (graph.nodes[search]) return graph.nodes[search];

  const norm = normalize(search);
  for (const node of Object.values(graph.nodes)) {
    if (normalize(node.label) === norm) return node;
    if (node.aliases.some((a) => normalize(a) === norm)) return node;
  }
  return undefined;
}

export function getNeighbors(
  graph: NacreGraph,
  nodeId: string,
  hops = 1,
): { nodes: MemoryNode[]; edges: MemoryEdge[] } {
  const visited = new Set<string>();
  const edgeSet = new Set<string>();
  let frontier = [nodeId];
  visited.add(nodeId);

  for (let hop = 0; hop < hops; hop++) {
    const next: string[] = [];
    for (const nid of frontier) {
      for (const edge of Object.values(graph.edges)) {
        let neighbor: string | null = null;
        if (edge.source === nid) neighbor = edge.target;
        else if (edge.target === nid) neighbor = edge.source;

        if (neighbor !== null) {
          edgeSet.add(edge.id);
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
    }
    frontier = next;
  }

  visited.delete(nodeId);
  const nodes = [...visited]
    .map((id) => graph.nodes[id])
    .filter((n): n is MemoryNode => n !== undefined);
  const edges = [...edgeSet]
    .map((id) => graph.edges[id])
    .filter((e): e is MemoryEdge => e !== undefined);

  return { nodes, edges };
}

export function getRelated(
  graph: NacreGraph,
  nodeId: string,
): MemoryNode[] {
  const edgesWithWeight: Array<{ neighborId: string; weight: number }> = [];

  for (const edge of Object.values(graph.edges)) {
    let neighborId: string | null = null;
    if (edge.source === nodeId) neighborId = edge.target;
    else if (edge.target === nodeId) neighborId = edge.source;

    if (neighborId !== null) {
      edgesWithWeight.push({ neighborId, weight: edge.weight });
    }
  }

  edgesWithWeight.sort((a, b) => b.weight - a.weight);

  return edgesWithWeight
    .map((e) => graph.nodes[e.neighborId])
    .filter((n): n is MemoryNode => n !== undefined);
}

export function getFading(
  graph: NacreGraph,
  now: Date,
  config: GraphConfig,
): MemoryEdge[] {
  const threshold = config.visibilityThreshold;
  const upper = threshold * 2;

  return Object.values(graph.edges).filter((edge) => {
    const w = computeCurrentWeight(edge, now, config);
    return w >= threshold && w <= upper;
  });
}

export function getClusters(
  graph: NacreGraph,
): Record<string, string[]> {
  const nodeIds = Object.keys(graph.nodes);
  const visited = new Set<string>();
  const clusters: Record<string, string[]> = {};

  for (const startId of nodeIds) {
    if (visited.has(startId)) continue;

    const component: string[] = [];
    const queue = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      for (const edge of Object.values(graph.edges)) {
        let neighbor: string | null = null;
        if (edge.source === current) neighbor = edge.target;
        else if (edge.target === current) neighbor = edge.source;

        if (neighbor !== null && !visited.has(neighbor) && graph.nodes[neighbor]) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    let hubNode = graph.nodes[component[0]];
    for (const id of component) {
      const node = graph.nodes[id];
      if (node && hubNode && node.mentionCount > hubNode.mentionCount) {
        hubNode = node;
      }
    }

    if (hubNode) {
      clusters[hubNode.label] = component;
    }
  }

  return clusters;
}

export function generateBrief(
  graph: NacreGraph,
  options: { top?: number; recentDays?: number; now?: Date } = {},
): string {
  const { top = 20, recentDays = 7, now = new Date() } = options;
  const nowStr = now.toISOString();

  const scored = Object.values(graph.nodes).map((node) => {
    const daysSince = daysBetween(node.lastReinforced, nowStr);
    const recencyBonus = daysSince <= recentDays
      ? 1.0 - (daysSince / recentDays) * 0.5
      : Math.max(0, 0.5 - (daysSince - recentDays) / 60);

    const edgeCount = Object.values(graph.edges).filter(
      (e) => e.source === node.id || e.target === node.id,
    ).length;

    const score =
      node.mentionCount * 0.3 +
      node.reinforcementCount * 0.3 +
      recencyBonus * 10 * 0.4;

    return { node, score, edgeCount, daysSince };
  });

  scored.sort((a, b) => b.score - a.score);
  const topNodes = scored.slice(0, top);

  const fading = getFading(graph, now, graph.config);

  const active = topNodes
    .filter((s) => s.daysSince <= recentDays)
    .slice(0, 8)
    .map(
      (s) =>
        `${s.node.label} (${s.edgeCount} connections, ` +
        `last seen ${formatDaysAgo(s.daysSince)})`,
    );

  const fadingDescriptions = fading.slice(0, 5).map((edge) => {
    const src = graph.nodes[edge.source]?.label ?? edge.source;
    const tgt = graph.nodes[edge.target]?.label ?? edge.target;
    const days = daysBetween(edge.lastReinforced, nowStr);
    return `${src} ↔ ${tgt} (${days} days since reinforced)`;
  });

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push(`Active: ${active.join(', ')}.`);
  }

  if (fadingDescriptions.length > 0) {
    lines.push(`Fading: ${fadingDescriptions.join(', ')}.`);
  }

  if (lines.length === 0) {
    lines.push('No active nodes in the graph.');
  }

  return lines.join('\n');
}

function formatDaysAgo(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
