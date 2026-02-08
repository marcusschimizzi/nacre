export interface GraphNode {
  id: string;
  label: string;
  type: string;
  firstSeen: string;
  lastReinforced: string;
  mentionCount: number;
  reinforcementCount: number;
  sourceFiles: string[];
  excerpts: Array<{ file: string; text: string; date: string }>;
  aliases?: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  directed: boolean;
  weight: number;
  baseWeight: number;
  reinforcementCount: number;
  firstFormed: string;
  lastReinforced: string;
  stability: number;
  evidence?: Array<{ file: string; date: string; context: string }>;
}

export interface NacreGraphData {
  version: number;
  lastConsolidated: string;
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  config: {
    decayRate: number;
    reinforcementBoost: number;
    visibilityThreshold: number;
    coOccurrenceThreshold?: number;
    baseWeights?: Record<string, number>;
  };
}

export interface ForceNode {
  id: string;
  label: string;
  type: string;
  firstSeen: string;
  lastReinforced: string;
  mentionCount: number;
  reinforcementCount: number;
  sourceFiles: string[];
  excerpts: Array<{ file: string; text: string; date: string }>;
  edgeCount: number;
  maxEdgeWeight: number;
  highlight?: 'hover' | 'pin' | null;

  x?: number;
  y?: number;
  z?: number;
  fx?: number | undefined;
  fy?: number | undefined;
  fz?: number | undefined;
  vx?: number;
  vy?: number;
  vz?: number;
}

export interface ForceLink {
  source: string | ForceNode;
  target: string | ForceNode;
  id: string;
  type: string;
  directed: boolean;
  weight: number;
  baseWeight: number;
  reinforcementCount: number;
  firstFormed: string;
  lastReinforced: string;
  stability: number;
  evidence?: Array<{ file: string; date: string; context: string }>;
}

export interface GraphConfig {
  decayRate: number;
  reinforcementBoost: number;
  visibilityThreshold: number;
}

export interface AppState {
  selectedNode: ForceNode | null;
  hoveredNode: ForceNode | null;
  highlightNodes: Set<string>;
  highlightLinks: Set<string>;
  pinnedNodes: Set<string>;
  pinnedLinks: Set<string>;
  visibleTypes: Set<string>;
  visibleEdgeTypes: Set<string>;
  minWeight: number;
  scrubDate: Date | null;
}

export interface LoadResult {
  nodes: ForceNode[];
  links: ForceLink[];
  config: GraphConfig;
  dateRange: { earliest: string; latest: string };
}
