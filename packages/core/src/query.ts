import type {
  AlertResult,
  BriefResult,
  ClusterInfo,
  EntityType,
  FadingEdgeInfo,
  GraphConfig,
  GraphStats,
  MemoryEdge,
  MemoryNode,
  NacreGraph,
  ScoredNode,
  SearchOptions,
  SearchResult,
} from './types.js';
import type { AdjacencyMap } from './graph.js';
import { buildAdjacencyMap } from './graph.js';
import { calculateStability, computeCurrentWeight, daysBetween } from './decay.js';
import { levenshteinDistance, normalize } from './resolve.js';

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
  const adj = buildAdjacencyMap(graph);
  const visited = new Set<string>();
  const edgeSet = new Set<string>();
  let frontier = [nodeId];
  visited.add(nodeId);

  for (let hop = 0; hop < hops; hop++) {
    const next: string[] = [];
    for (const nid of frontier) {
      for (const entry of adj[nid] ?? []) {
        edgeSet.add(entry.edgeId);
        if (!visited.has(entry.neighborId)) {
          visited.add(entry.neighborId);
          next.push(entry.neighborId);
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
  const adj = buildAdjacencyMap(graph);
  const entries = adj[nodeId] ?? [];

  const edgesWithWeight = entries.map((entry) => ({
    neighborId: entry.neighborId,
    weight: graph.edges[entry.edgeId]?.weight ?? 0,
  }));

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
  const adj = buildAdjacencyMap(graph);
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

      for (const entry of adj[current] ?? []) {
        if (!visited.has(entry.neighborId) && graph.nodes[entry.neighborId]) {
          visited.add(entry.neighborId);
          queue.push(entry.neighborId);
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

function scoreNodes(
  graph: NacreGraph,
  now: Date,
  recentDays: number,
): ScoredNode[] {
  const adj = buildAdjacencyMap(graph);
  const nowStr = now.toISOString();

  return Object.values(graph.nodes).map((node) => {
    const daysSinceReinforced = daysBetween(node.lastReinforced, nowStr);
    const recencyBonus = daysSinceReinforced <= recentDays
      ? 1.0 - (daysSinceReinforced / recentDays) * 0.5
      : Math.max(0, 0.5 - (daysSinceReinforced - recentDays) / 60);

    const edgeCount = adj[node.id]?.length ?? 0;

    const score =
      node.mentionCount * 0.3 +
      node.reinforcementCount * 0.3 +
      recencyBonus * 10 * 0.4;

    return { node, score, edgeCount, daysSinceReinforced };
  });
}

function buildFadingEdgeInfo(
  edge: MemoryEdge,
  graph: NacreGraph,
  now: Date,
): FadingEdgeInfo {
  const nowStr = now.toISOString();
  const currentWeight = computeCurrentWeight(edge, now, graph.config);
  const daysSinceReinforced = daysBetween(edge.lastReinforced, nowStr);

  const stability = calculateStability(
    edge.reinforcementCount,
    graph.config.reinforcementBoost,
  );
  const threshold = graph.config.visibilityThreshold;
  const daysToThreshold =
    edge.baseWeight > 0 && threshold > 0
      ? (stability / graph.config.decayRate) *
        Math.log(edge.baseWeight / threshold) - daysSinceReinforced
      : 0;

  return {
    edge,
    sourceLabel: graph.nodes[edge.source]?.label ?? edge.source,
    targetLabel: graph.nodes[edge.target]?.label ?? edge.target,
    currentWeight,
    daysSinceReinforced,
    estimatedDaysUntilDormant: Math.max(0, Math.round(daysToThreshold)),
  };
}

function computeGraphStats(graph: NacreGraph): GraphStats {
  const edges = Object.values(graph.edges);
  const nodes = Object.values(graph.nodes);

  const entityTypeCounts: Record<string, number> = {};
  for (const node of nodes) {
    entityTypeCounts[node.type] = (entityTypeCounts[node.type] ?? 0) + 1;
  }

  const edgeTypeCounts: Record<string, number> = {};
  let weightSum = 0;
  let dormantEdges = 0;
  for (const edge of edges) {
    edgeTypeCounts[edge.type] = (edgeTypeCounts[edge.type] ?? 0) + 1;
    weightSum += edge.weight;
    if (edge.weight < graph.config.visibilityThreshold) dormantEdges++;
  }

  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    entityTypeCounts,
    edgeTypeCounts,
    averageWeight: edges.length > 0 ? weightSum / edges.length : 0,
    dormantEdges,
  };
}

function buildClusterInfos(graph: NacreGraph): ClusterInfo[] {
  const raw = getClusters(graph);
  return Object.entries(raw)
    .map(([hub, members]) => {
      const hubNode = Object.values(graph.nodes).find((n) => n.label === hub);
      return {
        hub,
        hubType: hubNode?.type ?? ('tag' as EntityType),
        members: members.map((id) => graph.nodes[id]?.label ?? id),
        size: members.length,
      };
    })
    .sort((a, b) => b.size - a.size);
}

function formatDaysAgo(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function formatBriefSummary(result: Omit<BriefResult, 'summary'>): string {
  const lines: string[] = [];

  const active = result.activeNodes.slice(0, 8);
  if (active.length > 0) {
    const descriptions = active.map(
      (s) =>
        `${s.node.label} (${s.edgeCount} connections, ` +
        `last seen ${formatDaysAgo(s.daysSinceReinforced)})`,
    );
    lines.push(`Active: ${descriptions.join(', ')}.`);
  }

  if (result.fadingEdges.length > 0) {
    const descriptions = result.fadingEdges.slice(0, 5).map(
      (f) => `${f.sourceLabel} \u2194 ${f.targetLabel} (${f.daysSinceReinforced}d ago, ~${f.estimatedDaysUntilDormant}d until dormant)`,
    );
    lines.push(`Fading: ${descriptions.join(', ')}.`);
  }

  if (result.clusters.length > 1) {
    lines.push(`Clusters: ${result.clusters.length} (largest: ${result.clusters[0].hub} with ${result.clusters[0].size} nodes).`);
  }

  const s = result.stats;
  lines.push(`Graph: ${s.totalNodes} nodes, ${s.totalEdges} edges, avg weight ${s.averageWeight.toFixed(3)}, ${s.dormantEdges} dormant.`);

  if (lines.length === 0) {
    lines.push('No active nodes in the graph.');
  }

  return lines.join('\n');
}

export function generateBrief(
  graph: NacreGraph,
  options: { top?: number; recentDays?: number; now?: Date } = {},
): BriefResult {
  const { top = 20, recentDays = 7, now = new Date() } = options;

  const scored = scoreNodes(graph, now, recentDays);
  scored.sort((a, b) => b.score - a.score);

  const topEntities = scored.slice(0, top);
  const activeNodes = scored
    .filter((s) => s.daysSinceReinforced <= recentDays)
    .sort((a, b) => b.score - a.score);

  const fadingEdges = getFading(graph, now, graph.config)
    .map((edge) => buildFadingEdgeInfo(edge, graph, now))
    .sort((a, b) => a.estimatedDaysUntilDormant - b.estimatedDaysUntilDormant);

  const clusters = buildClusterInfos(graph);
  const stats = computeGraphStats(graph);

  const partial = { topEntities, activeNodes, fadingEdges, clusters, stats };
  const summary = formatBriefSummary(partial);

  return { ...partial, summary };
}

export function generateAlerts(
  graph: NacreGraph,
  options: { now?: Date } = {},
): AlertResult {
  const { now = new Date() } = options;

  const fadingEdges = getFading(graph, now, graph.config)
    .map((edge) => buildFadingEdgeInfo(edge, graph, now))
    .sort((a, b) => a.estimatedDaysUntilDormant - b.estimatedDaysUntilDormant);

  const connectedNodeIds = new Set<string>();
  for (const edge of Object.values(graph.edges)) {
    if (edge.weight >= graph.config.visibilityThreshold) {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    }
  }
  const orphanNodes = Object.values(graph.nodes)
    .filter((node) => !connectedNodeIds.has(node.id));

  const totalEdges = Object.keys(graph.edges).length;
  const activeEdges = Object.values(graph.edges)
    .filter((e) => e.weight >= graph.config.visibilityThreshold).length;
  const totalNodes = Object.keys(graph.nodes).length;
  const connectedNodes = connectedNodeIds.size;

  const edgeHealth = totalEdges > 0 ? activeEdges / totalEdges : 1;
  const nodeHealth = totalNodes > 0 ? connectedNodes / totalNodes : 1;
  const fadingPenalty = Math.min(fadingEdges.length * 0.02, 0.3);
  const healthScore = Math.max(0, Math.min(1,
    edgeHealth * 0.5 + nodeHealth * 0.5 - fadingPenalty,
  ));

  const lines: string[] = [];
  if (fadingEdges.length > 0) {
    lines.push(`${fadingEdges.length} connection${fadingEdges.length === 1 ? '' : 's'} fading.`);
    const urgent = fadingEdges.filter((f) => f.estimatedDaysUntilDormant <= 7);
    if (urgent.length > 0) {
      lines.push(`Urgent (< 7 days): ${urgent.map((f) => `${f.sourceLabel} \u2194 ${f.targetLabel}`).join(', ')}.`);
    }
  }
  if (orphanNodes.length > 0) {
    lines.push(`${orphanNodes.length} orphan node${orphanNodes.length === 1 ? '' : 's'} (no active connections).`);
  }
  if (fadingEdges.length === 0 && orphanNodes.length === 0) {
    lines.push('No alerts. Graph is healthy.');
  }
  lines.push(`Health: ${(healthScore * 100).toFixed(0)}%`);

  return {
    fadingEdges,
    orphanNodes,
    healthScore,
    summary: lines.join('\n'),
  };
}

export function searchNodes(
  graph: NacreGraph,
  terms: string[],
  options: SearchOptions = {},
): SearchResult[] {
  const { type, sinceDays, now = new Date() } = options;
  const nowStr = now.toISOString();

  let candidates = Object.values(graph.nodes);

  if (type) {
    candidates = candidates.filter((n) => n.type === type);
  }

  if (sinceDays !== undefined) {
    candidates = candidates.filter((n) => {
      return daysBetween(n.lastReinforced, nowStr) <= sinceDays;
    });
  }

  if (terms.length === 0) {
    return candidates.map((node) => ({ node, matchScore: 1 }));
  }

  const normalizedTerms = terms.map((t) => normalize(t));

  const results: SearchResult[] = [];

  for (const node of candidates) {
    const normLabel = normalize(node.label);
    const normAliases = node.aliases.map((a) => normalize(a));
    const allNames = [normLabel, ...normAliases];

    let bestScore = 0;

    for (const term of normalizedTerms) {
      let termScore = 0;

      for (const name of allNames) {
        if (name === term) {
          termScore = Math.max(termScore, 1.0);
        } else if (name.includes(term)) {
          termScore = Math.max(termScore, 0.8);
        } else if (term.includes(name)) {
          termScore = Math.max(termScore, 0.6);
        } else {
          const dist = levenshteinDistance(term, name);
          const maxLen = Math.max(term.length, name.length);
          if (maxLen > 0 && dist / maxLen <= 0.3) {
            termScore = Math.max(termScore, 0.4 * (1 - dist / maxLen));
          }
        }
      }

      bestScore += termScore;
    }

    const matchScore = bestScore / normalizedTerms.length;

    if (matchScore > 0) {
      results.push({ node, matchScore });
    }
  }

  results.sort((a, b) => b.matchScore - a.matchScore);
  return results;
}
