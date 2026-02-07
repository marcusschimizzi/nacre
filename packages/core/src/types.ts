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

export interface FileFailure {
  path: string;
  error: string;
}

export interface ConsolidationResult {
  graph: NacreGraph;
  newNodes: number;
  newEdges: number;
  reinforcedNodes: number;
  reinforcedEdges: number;
  decayedEdges: number;
  newEmbeddings: number;
  newEpisodes: number;
  pendingEdges: PendingEdge[];
  failures: FileFailure[];
}

// === Brief & Alerts Types (Phase 3) ===

export interface ScoredNode {
  node: MemoryNode;
  score: number;
  edgeCount: number;
  daysSinceReinforced: number;
}

export interface FadingEdgeInfo {
  edge: MemoryEdge;
  sourceLabel: string;
  targetLabel: string;
  currentWeight: number;
  daysSinceReinforced: number;
  estimatedDaysUntilDormant: number;
}

export interface ClusterInfo {
  hub: string;
  hubType: EntityType;
  members: string[];
  size: number;
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  entityTypeCounts: Record<string, number>;
  edgeTypeCounts: Record<string, number>;
  averageWeight: number;
  dormantEdges: number;
}

export interface BriefResult {
  topEntities: ScoredNode[];
  activeNodes: ScoredNode[];
  fadingEdges: FadingEdgeInfo[];
  clusters: ClusterInfo[];
  stats: GraphStats;
  summary: string;
}

export interface AlertResult {
  fadingEdges: FadingEdgeInfo[];
  orphanNodes: MemoryNode[];
  healthScore: number;
  summary: string;
}

export interface SearchOptions {
  type?: EntityType;
  sinceDays?: number;
  now?: Date;
}

export interface SearchResult {
  node: MemoryNode;
  matchScore: number;
}

// === Intelligence Types (Phase 4) ===

export type SuggestionReason = 'pending-near-threshold' | 'structural-hole' | 'type-bridge';

export interface ConnectionSuggestion {
  sourceId: string;
  sourceLabel: string;
  targetId: string;
  targetLabel: string;
  reason: SuggestionReason;
  confidence: number;
  explanation: string;
}

export interface SuggestionResult {
  suggestions: ConnectionSuggestion[];
  summary: string;
}

export interface LabeledCluster {
  hub: string;
  hubType: EntityType;
  label: string;
  members: Array<{ id: string; label: string; type: EntityType }>;
  size: number;
  dominantType: EntityType;
  typeCounts: Record<string, number>;
}

export interface SignificanceCategory {
  label: string;
  nodes: ScoredNode[];
}

export interface InsightResult {
  emerging: ScoredNode[];
  anchors: ScoredNode[];
  fadingImportant: ScoredNode[];
  clusters: LabeledCluster[];
  summary: string;
}

// === Episodic Memory Types (M4) ===

export type EpisodeType = 'conversation' | 'event' | 'decision' | 'observation';

export interface Episode {
  id: string;
  timestamp: string;
  endTimestamp?: string;
  type: EpisodeType;
  title: string;
  summary?: string;
  content: string;
  sequence: number;
  parentId?: string;
  participants: string[];
  topics: string[];
  outcomes?: string[];
  importance: number;
  accessCount: number;
  lastAccessed: string;
  source: string;
  sourceType: 'markdown' | 'conversation' | 'api';
}

export interface EpisodeEntityLink {
  episodeId: string;
  nodeId: string;
  role: 'participant' | 'topic' | 'outcome' | 'mentioned';
}

export interface EpisodeFilter {
  type?: EpisodeType;
  since?: string;
  until?: string;
  source?: string;
  hasEntity?: string;
}

// === Procedural Memory Types (M8) ===

export type ProcedureType = 'preference' | 'skill' | 'antipattern' | 'insight' | 'heuristic';

export interface Procedure {
  id: string;
  statement: string;
  type: ProcedureType;
  triggerKeywords: string[];
  triggerContexts: string[];
  sourceEpisodes: string[];
  sourceNodes: string[];
  confidence: number;
  applications: number;
  contradictions: number;
  stability: number;
  lastApplied: string | null;
  createdAt: string;
  updatedAt: string;
  flaggedForReview: boolean;
}

export interface ProcedureFilter {
  type?: ProcedureType;
  minConfidence?: number;
  flaggedOnly?: boolean;
  hasKeyword?: string;
  hasContext?: string;
}

// === Hybrid Recall Types (M5) ===

export interface RecallWeights {
  semantic: number;
  graph: number;
  recency: number;
  importance: number;
}

export const DEFAULT_RECALL_WEIGHTS: RecallWeights = {
  semantic: 0.4,
  graph: 0.3,
  recency: 0.2,
  importance: 0.1,
};

export interface RecallOptions {
  query: string;
  limit?: number;
  minScore?: number;
  types?: EntityType[];
  since?: string;
  until?: string;
  weights?: Partial<RecallWeights>;
  hops?: number;
}

export interface RecallScores {
  semantic: number;
  graph: number;
  recency: number;
  importance: number;
}

export interface RecallConnection {
  label: string;
  type: string;
  relationship: string;
  weight: number;
}

export interface RecallResult {
  id: string;
  label: string;
  type: string;
  score: number;
  scores: RecallScores;
  excerpts: string[];
  connections: RecallConnection[];
  episodes?: Episode[];
}
