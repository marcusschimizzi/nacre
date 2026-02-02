export type EntityType =
  | 'person'
  | 'project'
  | 'tool'
  | 'concept'
  | 'decision'
  | 'event'
  | 'lesson'
  | 'place'
  | 'tag';

export interface Excerpt {
  file: string;
  text: string;
  date: string; // ISO date
}

export interface Evidence {
  file: string;
  date: string;
  context: string;
}

export interface MemoryNode {
  id: string;
  label: string;
  aliases: string[];
  type: EntityType;
  firstSeen: string;
  lastReinforced: string;
  mentionCount: number;
  reinforcementCount: number;
  sourceFiles: string[];
  excerpts: Excerpt[];
}

export type EdgeType = 'explicit' | 'co-occurrence' | 'temporal' | 'causal';

export interface MemoryEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  directed: boolean;
  weight: number;
  baseWeight: number;
  reinforcementCount: number;
  firstFormed: string;
  lastReinforced: string;
  stability: number;
  evidence: Evidence[];
}

export interface FileHash {
  path: string;
  hash: string;
  lastProcessed: string;
}

export interface GraphConfig {
  decayRate: number;
  reinforcementBoost: number;
  visibilityThreshold: number;
  coOccurrenceThreshold: number;
  baseWeights: {
    explicit: number;
    coOccurrence: number;
    temporal: number;
    causal: number;
  };
}

export interface NacreGraph {
  version: number;
  lastConsolidated: string;
  processedFiles: FileHash[];
  nodes: Record<string, MemoryNode>;
  edges: Record<string, MemoryEdge>;
  config: GraphConfig;
}

export const DEFAULT_CONFIG: GraphConfig = {
  decayRate: 0.015,
  reinforcementBoost: 1.5,
  visibilityThreshold: 0.05,
  coOccurrenceThreshold: 2,
  baseWeights: {
    explicit: 1.0,
    coOccurrence: 0.3,
    temporal: 0.1,
    causal: 0.8
  }
};

// === Pipeline Types ===

export interface PendingEdge {
  source: string;
  target: string;
  type: 'co-occurrence' | 'temporal';
  count: number;
  firstSeen: string;
  evidence: Evidence[];
}

export interface RawEntity {
  text: string;
  type: EntityType;
  confidence: number;
  source: 'structural' | 'nlp' | 'custom';
  position: {
    file: string;
    section: string;
    line: number;
  };
}

export interface DiscoveryResult {
  newFiles: string[];
  changedFiles: string[];
  unchangedFiles: string[];
}

export interface EntityMap {
  aliases: Record<string, string>;
  ignore: string[];
}

export interface ConsolidationResult {
  graph: NacreGraph;
  newNodes: number;
  newEdges: number;
  reinforcedNodes: number;
  reinforcedEdges: number;
  decayedEdges: number;
  pendingEdges: PendingEdge[];
}
