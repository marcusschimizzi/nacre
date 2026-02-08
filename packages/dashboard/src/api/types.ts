export type ApiError = {
  error: {
    message: string;
    code: string;
  };
};

export type ApiEnvelope<T> = { data: T };

// NOTE: These types intentionally mirror the CLI API payloads.
// The server responds with extra fields beyond what the dashboard uses; that's fine.

export type MemoryNode = {
  id: string;
  label: string;
  type: string;
  firstSeen?: string;
  lastReinforced?: string;
  mentionCount?: number;
  reinforcementCount?: number;
  sourceFiles?: string[];
  excerpts?: Array<{ file: string; text: string; date: string }>;
  aliases?: string[];
};

export type MemoryEdge = {
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
};

export type HealthData = {
  status: string;
  version: string;
  nodeCount: number;
  edgeCount: number;
  uptime: number;
};

export type GraphStatsData = {
  nodeCount: number;
  edgeCount: number;
  embeddingCount: number;
  avgWeight: number;
  lastConsolidated: string | null;
};

export type AlertResult = {
  fadingEdges: Array<{
    edge: MemoryEdge;
    sourceLabel: string;
    targetLabel: string;
    currentWeight: number;
    daysSinceReinforced: number;
    estimatedDaysUntilDormant: number;
  }>;
  orphanNodes: MemoryNode[];
  healthScore: number;
  summary: string;
};

export type Episode = {
  id: string;
  timestamp: string;
  type: string;
  title: string;
  summary?: string | null;
  content?: string;
  participants?: string[];
  topics?: string[];
  outcomes?: string[];
  importance?: number;
};

export type EpisodeEntity = {
  id: string;
  label: string;
  type: string;
};

export type Procedure = {
  id: string;
  statement: string;
  type: string;
  confidence: number;
  applications: number;
  contradictions: number;
  stability: number;
  lastApplied: string | null;
  createdAt: string;
  updatedAt: string;
  flaggedForReview: boolean;
};

export type Snapshot = {
  id: string;
  createdAt: string;
  trigger: string;
  nodeCount: number;
  edgeCount: number;
  episodeCount?: number;
  metadata?: Record<string, unknown>;
};

export type GraphDiff = {
  fromSnapshot: string;
  toSnapshot: string;
  nodes: {
    added: MemoryNode[];
    removed: MemoryNode[];
    changed: Array<{ before: MemoryNode; after: MemoryNode; changes: string[] }>;
  };
  edges: {
    added: MemoryEdge[];
    removed: MemoryEdge[];
    strengthened: MemoryEdge[];
    weakened: MemoryEdge[];
  };
  stats: {
    nodesAdded: number;
    nodesRemoved: number;
    nodesChanged: number;
    edgesAdded: number;
    edgesRemoved: number;
    edgesStrengthened: number;
    edgesWeakened: number;
    netChange: number;
  };
};

export type RecallScores = {
  semantic: number;
  graph: number;
  recency: number;
  importance: number;
};

export type RecallConnection = {
  label: string;
  type: string;
  relationship: string;
  weight: number;
};

export type RecallProcedureMatch = {
  id: string;
  statement: string;
  type: string;
  confidence: number;
  score: number;
  matchedKeywords: string[];
};

export type RecallResult = {
  id: string;
  label: string;
  type: string;
  score: number;
  scores: RecallScores;
  excerpts: string[];
  connections: RecallConnection[];
};

export type RecallResponse = {
  data: RecallResult[];
  procedures: RecallProcedureMatch[];
};
