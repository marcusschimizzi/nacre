import type {
  ConnectionSuggestion,
  EntityType,
  InsightResult,
  LabeledCluster,
  MemoryEdge,
  NacreGraph,
  PendingEdge,
  ScoredNode,
  SuggestionResult,
} from './types.js';
import type { AdjacencyMap } from './graph.js';
import { buildAdjacencyMap } from './graph.js';
import { computeCurrentWeight, daysBetween } from './decay.js';
import { getClusters } from './query.js';

function getNeighborSet(adj: AdjacencyMap, nodeId: string): Set<string> {
  const neighbors = new Set<string>();
  for (const entry of adj[nodeId] ?? []) {
    neighbors.add(entry.neighborId);
  }
  return neighbors;
}

function getSharedNeighborCount(
  adj: AdjacencyMap,
  nodeA: string,
  nodeB: string,
): number {
  const neighborsA = getNeighborSet(adj, nodeA);
  const neighborsB = getNeighborSet(adj, nodeB);
  let shared = 0;
  for (const n of neighborsA) {
    if (neighborsB.has(n)) shared++;
  }
  return shared;
}

export function generateSuggestions(
  graph: NacreGraph,
  pendingEdges: PendingEdge[],
  options: { maxSuggestions?: number; now?: Date } = {},
): SuggestionResult {
  const { maxSuggestions = 10 } = options;
  const adj = buildAdjacencyMap(graph);
  const suggestions: ConnectionSuggestion[] = [];

  const threshold = graph.config.coOccurrenceThreshold;
  const nearThreshold = pendingEdges
    .filter((pe) => pe.count >= Math.max(1, threshold - 1))
    .sort((a, b) => b.count - a.count);

  for (const pe of nearThreshold) {
    const srcNode = graph.nodes[pe.source];
    const tgtNode = graph.nodes[pe.target];
    if (!srcNode || !tgtNode) continue;

    const progress = pe.count / threshold;
    suggestions.push({
      sourceId: pe.source,
      sourceLabel: srcNode.label,
      targetId: pe.target,
      targetLabel: tgtNode.label,
      reason: 'pending-near-threshold',
      confidence: Math.min(progress, 0.95),
      explanation:
        `Co-occurred ${pe.count}/${threshold} times (${Math.round(progress * 100)}% to auto-link)`,
    });
  }

  const nodeIds = Object.keys(graph.nodes);
  const existingEdges = new Set<string>();
  for (const edge of Object.values(graph.edges)) {
    const key = edge.source < edge.target
      ? `${edge.source}::${edge.target}`
      : `${edge.target}::${edge.source}`;
    existingEdges.add(key);
  }
  const pendingKeys = new Set(
    pendingEdges.map((pe) =>
      pe.source < pe.target ? `${pe.source}::${pe.target}` : `${pe.target}::${pe.source}`,
    ),
  );

  const highConnectivity = nodeIds
    .map((id) => ({ id, edges: adj[id]?.length ?? 0 }))
    .filter((n) => n.edges >= 3)
    .sort((a, b) => b.edges - a.edges)
    .slice(0, 30);

  for (let i = 0; i < highConnectivity.length; i++) {
    for (let j = i + 1; j < highConnectivity.length; j++) {
      const a = highConnectivity[i].id;
      const b = highConnectivity[j].id;
      const key = a < b ? `${a}::${b}` : `${b}::${a}`;

      if (existingEdges.has(key) || pendingKeys.has(key)) continue;

      const shared = getSharedNeighborCount(adj, a, b);
      if (shared < 2) continue;

      const nodeA = graph.nodes[a];
      const nodeB = graph.nodes[b];
      if (!nodeA || !nodeB) continue;

      const maxPossible = Math.min(
        highConnectivity[i].edges,
        highConnectivity[j].edges,
      );
      const confidence = Math.min(shared / maxPossible, 0.9) * 0.8;

      suggestions.push({
        sourceId: a,
        sourceLabel: nodeA.label,
        targetId: b,
        targetLabel: nodeB.label,
        reason: 'structural-hole',
        confidence,
        explanation: `${shared} shared neighbors but no direct connection`,
      });
    }
  }

  for (const edge of Object.values(graph.edges)) {
    const src = graph.nodes[edge.source];
    const tgt = graph.nodes[edge.target];
    if (!src || !tgt) continue;
    if (src.type === tgt.type) continue;
    if (edge.type !== 'co-occurrence') continue;
    if (edge.weight < 0.3) continue;

    const srcEdgeCount = adj[src.id]?.length ?? 0;
    const tgtEdgeCount = adj[tgt.id]?.length ?? 0;

    const typeCombo = src.type < tgt.type
      ? `${src.type}+${tgt.type}`
      : `${tgt.type}+${src.type}`;
    const isInteresting =
      typeCombo.includes('person') || typeCombo.includes('project');

    if (!isInteresting) continue;
    if (srcEdgeCount < 2 || tgtEdgeCount < 2) continue;

    suggestions.push({
      sourceId: src.id,
      sourceLabel: src.label,
      targetId: tgt.id,
      targetLabel: tgt.label,
      reason: 'type-bridge',
      confidence: Math.min(edge.weight, 0.85),
      explanation:
        `${src.type} "${src.label}" and ${tgt.type} "${tgt.label}" strongly co-occur (weight: ${edge.weight.toFixed(2)})`,
    });
  }

  suggestions.sort((a, b) => b.confidence - a.confidence);
  const top = suggestions.slice(0, maxSuggestions);

  const lines: string[] = [];
  if (top.length === 0) {
    lines.push('No connection suggestions at this time.');
  } else {
    lines.push(`${top.length} suggestion${top.length === 1 ? '' : 's'}:`);
    for (const s of top) {
      lines.push(
        `  ${s.sourceLabel} \u2194 ${s.targetLabel} (${Math.round(s.confidence * 100)}%) \u2014 ${s.explanation}`,
      );
    }
  }

  return { suggestions: top, summary: lines.join('\n') };
}

export function labelClusters(graph: NacreGraph): LabeledCluster[] {
  const raw = getClusters(graph);

  return Object.entries(raw)
    .map(([hubLabel, memberIds]) => {
      const hubNode = Object.values(graph.nodes).find((n) => n.label === hubLabel);
      const hubType = hubNode?.type ?? ('tag' as EntityType);

      const members = memberIds
        .map((id) => {
          const node = graph.nodes[id];
          return node ? { id, label: node.label, type: node.type } : null;
        })
        .filter((m): m is { id: string; label: string; type: EntityType } => m !== null);

      const typeCounts: Record<string, number> = {};
      for (const m of members) {
        typeCounts[m.type] = (typeCounts[m.type] ?? 0) + 1;
      }

      let dominantType: EntityType = hubType;
      let maxCount = 0;
      for (const [type, count] of Object.entries(typeCounts)) {
        if (count > maxCount) {
          maxCount = count;
          dominantType = type as EntityType;
        }
      }

      const typeLabels: string[] = [];
      const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sorted.slice(0, 2)) {
        typeLabels.push(`${count} ${type}${count > 1 ? 's' : ''}`);
      }

      const label = members.length <= 3
        ? members.map((m) => m.label).join(', ')
        : `${hubLabel} (${typeLabels.join(', ')})`;

      return {
        hub: hubLabel,
        hubType,
        label,
        members,
        size: members.length,
        dominantType,
        typeCounts,
      };
    })
    .sort((a, b) => b.size - a.size);
}

export function analyzeSignificance(
  graph: NacreGraph,
  options: { recentDays?: number; now?: Date } = {},
): InsightResult {
  const { recentDays = 7, now = new Date() } = options;
  const adj = buildAdjacencyMap(graph);
  const nowStr = now.toISOString();
  const nodes = Object.values(graph.nodes);

  const scored: ScoredNode[] = nodes.map((node) => {
    const daysSinceReinforced = daysBetween(node.lastReinforced, nowStr);
    const edgeCount = adj[node.id]?.length ?? 0;
    const score =
      node.mentionCount * 0.3 +
      node.reinforcementCount * 0.3 +
      (daysSinceReinforced <= recentDays ? 4 : 0);

    return { node, score, edgeCount, daysSinceReinforced };
  });

  const ageDays = (n: ScoredNode) =>
    daysBetween(n.node.firstSeen, nowStr) || 1;

  const emerging = scored
    .filter((s) => {
      const age = ageDays(s);
      if (age > recentDays * 2) return false;
      const velocityScore = s.node.mentionCount / age;
      return velocityScore >= 0.5 && s.edgeCount >= 2;
    })
    .sort((a, b) => {
      const velA = a.node.mentionCount / ageDays(a);
      const velB = b.node.mentionCount / ageDays(b);
      return velB - velA;
    })
    .slice(0, 10);

  const anchors = scored
    .filter((s) => s.edgeCount >= 5 && s.node.mentionCount >= 3)
    .sort((a, b) => {
      const scoreA = a.edgeCount * 0.5 + a.node.mentionCount * 0.3 + a.node.reinforcementCount * 0.2;
      const scoreB = b.edgeCount * 0.5 + b.node.mentionCount * 0.3 + b.node.reinforcementCount * 0.2;
      return scoreB - scoreA;
    })
    .slice(0, 10);

  const fadingImportant = scored
    .filter((s) => {
      if (s.edgeCount < 3) return false;
      if (s.node.mentionCount < 2) return false;
      if (s.daysSinceReinforced <= recentDays) return false;

      const entries = adj[s.node.id] ?? [];
      const avgWeight = entries.reduce((sum, entry) => {
        const edge = graph.edges[entry.edgeId];
        if (!edge) return sum;
        return sum + computeCurrentWeight(edge, now, graph.config);
      }, 0) / (entries.length || 1);

      return avgWeight < 0.4;
    })
    .sort((a, b) => b.edgeCount - a.edgeCount)
    .slice(0, 10);

  const clusters = labelClusters(graph);

  const lines: string[] = [];

  if (emerging.length > 0) {
    lines.push(
      `Emerging: ${emerging.map((s) => s.node.label).join(', ')}.`,
    );
  }
  if (anchors.length > 0) {
    lines.push(
      `Anchors: ${anchors.slice(0, 5).map((s) => `${s.node.label} (${s.edgeCount} connections)`).join(', ')}.`,
    );
  }
  if (fadingImportant.length > 0) {
    lines.push(
      `Fading but important: ${fadingImportant.map((s) => s.node.label).join(', ')}.`,
    );
  }
  if (clusters.length > 1) {
    lines.push(
      `${clusters.length} clusters: ${clusters.slice(0, 3).map((c) => c.label).join(' | ')}.`,
    );
  }
  if (lines.length === 0) {
    lines.push('No significant patterns detected.');
  }

  return {
    emerging,
    anchors,
    fadingImportant,
    clusters,
    summary: lines.join('\n'),
  };
}
