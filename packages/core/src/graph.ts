import { createHash } from 'node:crypto';
import type {
  EdgeType,
  Evidence,
  Excerpt,
  GraphConfig,
  MemoryEdge,
  MemoryNode,
  NacreGraph,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export function generateNodeId(label: string): string {
  return createHash('sha256')
    .update(label.toLowerCase().trim())
    .digest('hex')
    .slice(0, 12);
}

export function generateEdgeId(source: string, target: string, type: EdgeType): string {
  const [a, b] = source < target ? [source, target] : [target, source];
  return `${a}--${b}--${type}`;
}

export function createGraph(config?: Partial<GraphConfig>): NacreGraph {
  return {
    version: 1,
    lastConsolidated: '',
    processedFiles: [],
    nodes: {},
    edges: {},
    config: { ...DEFAULT_CONFIG, ...config },
  };
}

export function addNode(
  graph: NacreGraph,
  node: Omit<MemoryNode, 'id'> & { id?: string },
): MemoryNode {
  const id = node.id ?? generateNodeId(node.label);
  const full: MemoryNode = { ...node, id };
  graph.nodes[id] = full;
  return full;
}

export function addEdge(
  graph: NacreGraph,
  edge: Omit<MemoryEdge, 'id'> & { id?: string },
): MemoryEdge {
  const id = edge.id ?? generateEdgeId(edge.source, edge.target, edge.type);
  const full: MemoryEdge = { ...edge, id };
  graph.edges[id] = full;
  return full;
}

export function getNode(graph: NacreGraph, id: string): MemoryNode | undefined {
  return graph.nodes[id];
}

export function getEdge(graph: NacreGraph, id: string): MemoryEdge | undefined {
  return graph.edges[id];
}

export function updateNode(
  graph: NacreGraph,
  id: string,
  updates: Partial<MemoryNode>,
): MemoryNode {
  const existing = graph.nodes[id];
  if (!existing) throw new Error(`Node not found: ${id}`);
  const updated = { ...existing, ...updates, id };
  graph.nodes[id] = updated;
  return updated;
}

export function reinforceNode(
  graph: NacreGraph,
  id: string,
  file: string,
  date: string,
  excerpt?: Excerpt,
): MemoryNode {
  const node = graph.nodes[id];
  if (!node) throw new Error(`Node not found: ${id}`);

  node.mentionCount += 1;
  node.reinforcementCount += 1;
  node.lastReinforced = date;

  if (!node.sourceFiles.includes(file)) {
    node.sourceFiles.push(file);
  }

  if (excerpt && node.excerpts.length < 10) {
    node.excerpts.push(excerpt);
  }

  return node;
}

export function reinforceEdge(
  graph: NacreGraph,
  id: string,
  evidence: Evidence,
): MemoryEdge {
  const edge = graph.edges[id];
  if (!edge) throw new Error(`Edge not found: ${id}`);

  edge.reinforcementCount += 1;
  edge.lastReinforced = evidence.date;
  edge.stability =
    1 + graph.config.reinforcementBoost * Math.log(edge.reinforcementCount + 1);

  if (edge.evidence.length < 20) {
    edge.evidence.push(evidence);
  }

  return edge;
}

export interface AdjacencyEntry {
  edgeId: string;
  neighborId: string;
}

export type AdjacencyMap = Record<string, AdjacencyEntry[]>;

export function buildAdjacencyMap(graph: NacreGraph): AdjacencyMap {
  const map: AdjacencyMap = {};

  for (const nodeId of Object.keys(graph.nodes)) {
    map[nodeId] = [];
  }

  for (const edge of Object.values(graph.edges)) {
    if (map[edge.source]) {
      map[edge.source].push({ edgeId: edge.id, neighborId: edge.target });
    }
    if (map[edge.target]) {
      map[edge.target].push({ edgeId: edge.id, neighborId: edge.source });
    }
  }

  return map;
}

export function findNodeByLabel(
  graph: NacreGraph,
  label: string,
): MemoryNode | undefined {
  const normalized = label.toLowerCase().trim();

  for (const node of Object.values(graph.nodes)) {
    if (node.label.toLowerCase() === normalized) return node;
    if (node.aliases.some((a) => a.toLowerCase() === normalized)) return node;
  }

  return undefined;
}
