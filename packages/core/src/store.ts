/**
 * GraphStore — persistent storage layer for nacre's knowledge graph.
 *
 * Uses SQLite (via better-sqlite3) as the backing store.
 * Synchronous API, direct file writes, no manual save needed.
 *
 * A nacre graph is a single .db file on disk.
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  MemoryNode,
  MemoryEdge,
  FileHash,
  GraphConfig,
  NacreGraph,
  EntityType,
  EdgeType,
  Episode,
  EpisodeType,
  EpisodeFilter,
  EpisodeEntityLink,
  Procedure,
  ProcedureType,
  ProcedureFilter,
  Snapshot,
  SnapshotTrigger,
  SnapshotFilter,
  EntityHistory,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { cosineSimilarity, bufferToVector, vectorToBuffer } from './embeddings.js';
import { buildAdjacencyMap, type AdjacencyMap } from './graph.js';

// ── Schema ──────────────────────────────────────────────────────

const SCHEMA_VERSION = 5;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id                  TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  type                TEXT NOT NULL,
  aliases             TEXT NOT NULL DEFAULT '[]',
  first_seen          TEXT NOT NULL,
  last_reinforced     TEXT NOT NULL,
  mention_count       INTEGER NOT NULL DEFAULT 1,
  reinforcement_count INTEGER NOT NULL DEFAULT 0,
  source_files        TEXT NOT NULL DEFAULT '[]',
  excerpts            TEXT NOT NULL DEFAULT '[]',
  hive_exclude        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS edges (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  target              TEXT NOT NULL,
  type                TEXT NOT NULL,
  directed            INTEGER NOT NULL DEFAULT 0,
  weight              REAL NOT NULL,
  base_weight         REAL NOT NULL,
  reinforcement_count INTEGER NOT NULL DEFAULT 0,
  first_formed        TEXT NOT NULL,
  last_reinforced     TEXT NOT NULL,
  stability           REAL NOT NULL DEFAULT 1.0,
  evidence            TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS processed_files (
  path          TEXT PRIMARY KEY,
  hash          TEXT NOT NULL,
  last_processed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  content    TEXT NOT NULL,
  vector     BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  provider   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(type);

CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  timestamp       TEXT NOT NULL,
  end_timestamp   TEXT,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT,
  content         TEXT NOT NULL,
  sequence        INTEGER NOT NULL DEFAULT 0,
  parent_id       TEXT,
  importance      REAL NOT NULL DEFAULT 0.5,
  access_count    INTEGER NOT NULL DEFAULT 0,
  last_accessed   TEXT,
  source          TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS episode_entities (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  PRIMARY KEY (episode_id, node_id, role)
);

CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp);
CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(type);
CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
CREATE INDEX IF NOT EXISTS idx_episode_entities_episode ON episode_entities(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_entities_node ON episode_entities(node_id);

CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('preference','skill','antipattern','insight','heuristic')),
  trigger_keywords TEXT NOT NULL DEFAULT '[]',
  trigger_contexts TEXT NOT NULL DEFAULT '[]',
  source_episodes TEXT NOT NULL DEFAULT '[]',
  source_nodes TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  applications INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  stability REAL NOT NULL DEFAULT 1.0,
  last_applied TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  flagged_for_review INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_procedures_type ON procedures(type);
CREATE INDEX IF NOT EXISTS idx_procedures_confidence ON procedures(confidence DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  node_count    INTEGER NOT NULL,
  edge_count    INTEGER NOT NULL,
  episode_count INTEGER NOT NULL,
  metadata      TEXT
);

CREATE TABLE IF NOT EXISTS snapshot_nodes (
  snapshot_id   TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  label         TEXT NOT NULL,
  type          TEXT NOT NULL,
  mention_count INTEGER NOT NULL,
  data          TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, node_id)
);

CREATE TABLE IF NOT EXISTS snapshot_edges (
  snapshot_id   TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  edge_id       TEXT NOT NULL,
  source        TEXT NOT NULL,
  target        TEXT NOT NULL,
  weight        REAL NOT NULL,
  stability     REAL NOT NULL,
  data          TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, edge_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_created ON snapshots(created_at);
`;

// ── Serialization helpers ───────────────────────────────────────

function rowToNode(row: Record<string, unknown>): MemoryNode {
  const node: MemoryNode = {
    id: row.id as string,
    label: row.label as string,
    type: row.type as EntityType,
    aliases: JSON.parse(row.aliases as string),
    firstSeen: row.first_seen as string,
    lastReinforced: row.last_reinforced as string,
    mentionCount: row.mention_count as number,
    reinforcementCount: row.reinforcement_count as number,
    sourceFiles: JSON.parse(row.source_files as string),
    excerpts: JSON.parse(row.excerpts as string),
  };
  if ((row.hive_exclude as number) === 1) {
    node.hiveExclude = true;
  }
  return node;
}

function rowToEdge(row: Record<string, unknown>): MemoryEdge {
  return {
    id: row.id as string,
    source: row.source as string,
    target: row.target as string,
    type: row.type as EdgeType,
    directed: (row.directed as number) === 1,
    weight: row.weight as number,
    baseWeight: row.base_weight as number,
    reinforcementCount: row.reinforcement_count as number,
    firstFormed: row.first_formed as string,
    lastReinforced: row.last_reinforced as string,
    stability: row.stability as number,
    evidence: JSON.parse(row.evidence as string),
  };
}

function rowToProcedure(row: Record<string, unknown>): Procedure {
  return {
    id: row.id as string,
    statement: row.statement as string,
    type: row.type as ProcedureType,
    triggerKeywords: JSON.parse(row.trigger_keywords as string),
    triggerContexts: JSON.parse(row.trigger_contexts as string),
    sourceEpisodes: JSON.parse(row.source_episodes as string),
    sourceNodes: JSON.parse(row.source_nodes as string),
    confidence: row.confidence as number,
    applications: row.applications as number,
    contradictions: row.contradictions as number,
    stability: row.stability as number,
    lastApplied: (row.last_applied as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    flaggedForReview: (row.flagged_for_review as number) === 1,
  };
}

function rowToEpisode(row: Record<string, unknown>): Episode {
  return {
    id: row.id as string,
    timestamp: row.timestamp as string,
    endTimestamp: (row.end_timestamp as string) ?? undefined,
    type: row.type as EpisodeType,
    title: row.title as string,
    summary: (row.summary as string) ?? undefined,
    content: row.content as string,
    sequence: row.sequence as number,
    parentId: (row.parent_id as string) ?? undefined,
    participants: [],
    topics: [],
    outcomes: [],
    importance: row.importance as number,
    accessCount: row.access_count as number,
    lastAccessed: row.last_accessed as string,
    source: row.source as string,
    sourceType: row.source_type as Episode['sourceType'],
  };
}

// ── Store Interface ─────────────────────────────────────────────

export interface NodeFilter {
  type?: EntityType;
  label?: string;
  since?: string; // ISO date — nodes reinforced after this date
}

export interface EdgeFilter {
  type?: EdgeType;
  source?: string;
  target?: string;
  minWeight?: number;
}

export interface EmbeddingRecord {
  id: string;
  type: string;
  content: string;
  vector: Float32Array;
  provider: string;
}

export interface SimilarityResult {
  id: string;
  type: string;
  content: string;
  similarity: number;
}

export interface SimilaritySearchOptions {
  type?: string;
  limit?: number;
  minSimilarity?: number;
}

export interface GraphStore {
  // Node operations
  getNode(id: string): MemoryNode | undefined;
  findNode(label: string): MemoryNode | undefined;
  listNodes(filter?: NodeFilter): MemoryNode[];
  putNode(node: MemoryNode): void;
  deleteNode(id: string): void;
  nodeCount(): number;

  // Edge operations
  getEdge(id: string): MemoryEdge | undefined;
  listEdges(filter?: EdgeFilter): MemoryEdge[];
  putEdge(edge: MemoryEdge): void;
  deleteEdge(id: string): void;
  edgeCount(): number;

  // File tracking
  getFileHash(path: string): FileHash | undefined;
  listFileHashes(): FileHash[];
  putFileHash(hash: FileHash): void;

  // Embedding operations
  getEmbeddingProvider(): string;
  setEmbeddingProvider(provider: string): void;
  putEmbedding(
    id: string,
    type: string,
    content: string,
    vector: Float32Array,
    provider: string,
  ): void;
  getEmbedding(id: string): EmbeddingRecord | undefined;
  searchSimilar(query: Float32Array, opts?: SimilaritySearchOptions): SimilarityResult[];
  deleteEmbedding(id: string): void;
  clearAllEmbeddings(): number;
  embeddingCount(): number;
  embeddingCountByType(type: string): number;

  // Episode operations
  putEpisode(episode: Episode): void;
  getEpisode(id: string): Episode | undefined;
  listEpisodes(filter?: EpisodeFilter): Episode[];
  deleteEpisode(id: string): void;
  episodeCount(): number;
  linkEpisodeEntity(episodeId: string, nodeId: string, role: EpisodeEntityLink['role']): void;
  unlinkEpisodeEntity(episodeId: string, nodeId: string, role: EpisodeEntityLink['role']): void;
  getEpisodeEntities(episodeId: string): EpisodeEntityLink[];
  getEntityEpisodes(nodeId: string): Episode[];
  getEntityEpisodesBatch(nodeIds: string[]): Map<string, Episode[]>;
  touchEpisode(id: string): void;

  // Procedure operations
  putProcedure(procedure: Procedure): void;
  getProcedure(id: string): Procedure | undefined;
  listProcedures(filter?: ProcedureFilter): Procedure[];
  deleteProcedure(id: string): void;
  procedureCount(): number;

  // Snapshot operations
  createSnapshot(trigger: SnapshotTrigger, metadata?: Record<string, unknown>): Snapshot;
  getSnapshot(id: string): Snapshot | undefined;
  listSnapshots(opts?: SnapshotFilter): Snapshot[];
  getSnapshotGraph(id: string): NacreGraph;
  deleteSnapshot(id: string): void;
  getNodeHistory(nodeId: string): EntityHistory;
  getEdgeHistory(edgeId: string): EntityHistory;

  // Bulk operations
  getFullGraph(): NacreGraph;
  getAdjacencyMap(): AdjacencyMap;
  importGraph(graph: NacreGraph): void;

  // Metadata
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;

  // Lifecycle
  save(): void;
  close(): void;
}

// ── SQLite Implementation ───────────────────────────────────────

export class SqliteStore implements GraphStore {
  private db: BetterSqlite3.Database;

  // Prepared statements (lazily cached for performance)
  private _stmts: Record<string, BetterSqlite3.Statement> = {};

  // In-memory read caches for the live graph, rebuilt lazily. They turn the
  // per-recall full-graph hydration + adjacency build + findNode alias scan into
  // a one-time cost between writes. Invalidated explicitly on our own writes, and
  // automatically when another connection/process commits (PRAGMA data_version).
  private _graphCache: NacreGraph | null = null;
  private _adjCache: AdjacencyMap | null = null;
  private _aliasIndex: Map<string, string> | null = null;
  private _cacheDataVersion = -1;

  private constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  /**
   * SQLite's data_version changes when a DIFFERENT connection commits to this
   * database (it does NOT change for this connection's own writes). We use it to
   * drop caches when another nacre instance/process (e.g. a separate `consolidate`)
   * has written underneath us.
   */
  private currentDataVersion(): number {
    return this.db.pragma('data_version', { simple: true }) as number;
  }

  /** Drop caches if an external connection has written since we last built them. */
  private syncCacheVersion(): void {
    const v = this.currentDataVersion();
    if (v !== this._cacheDataVersion) {
      this._graphCache = null;
      this._adjCache = null;
      this._aliasIndex = null;
      this._cacheDataVersion = v;
    }
  }

  /** Drop the live-graph read caches. Called by every node/edge write path. */
  private invalidateCaches(): void {
    this._graphCache = null;
    this._adjCache = null;
    this._aliasIndex = null;
    // Our own writes don't bump data_version; keep it current so the next
    // syncCacheVersion() doesn't mistake this for an external write.
    this._cacheDataVersion = this.currentDataVersion();
  }

  /**
   * Open or create a nacre graph database.
   * Pass a file path to persist, or ':memory:' / undefined for in-memory.
   */
  static open(dbPath?: string | null): SqliteStore {
    const resolvedPath = dbPath ?? ':memory:';

    // Ensure parent directory exists for file-based DBs
    if (resolvedPath !== ':memory:' && resolvedPath !== '') {
      const dir = dirname(resolvedPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    const db = new Database(resolvedPath);

    // Performance settings
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    // Initialize schema
    db.exec(SCHEMA_SQL);

    // Set schema version if new
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!version) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(SCHEMA_VERSION),
      );
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        'created_at',
        new Date().toISOString(),
      );
    } else {
      const ver = parseInt(version.value, 10);
      if (ver < 2) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS episodes (
            id              TEXT PRIMARY KEY,
            timestamp       TEXT NOT NULL,
            end_timestamp   TEXT,
            type            TEXT NOT NULL,
            title           TEXT NOT NULL,
            summary         TEXT,
            content         TEXT NOT NULL,
            sequence        INTEGER NOT NULL DEFAULT 0,
            parent_id       TEXT,
            importance      REAL NOT NULL DEFAULT 0.5,
            access_count    INTEGER NOT NULL DEFAULT 0,
            last_accessed   TEXT,
            source          TEXT NOT NULL,
            source_type     TEXT NOT NULL,
            created_at      TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS episode_entities (
            episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
            role       TEXT NOT NULL,
            PRIMARY KEY (episode_id, node_id, role)
          );
          CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp);
          CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(type);
          CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
          CREATE INDEX IF NOT EXISTS idx_episode_entities_episode ON episode_entities(episode_id);
          CREATE INDEX IF NOT EXISTS idx_episode_entities_node ON episode_entities(node_id);
        `);
      }
      if (ver < 3) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS procedures (
            id TEXT PRIMARY KEY,
            statement TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('preference','skill','antipattern','insight','heuristic')),
            trigger_keywords TEXT NOT NULL DEFAULT '[]',
            trigger_contexts TEXT NOT NULL DEFAULT '[]',
            source_episodes TEXT NOT NULL DEFAULT '[]',
            source_nodes TEXT NOT NULL DEFAULT '[]',
            confidence REAL NOT NULL DEFAULT 0.5,
            applications INTEGER NOT NULL DEFAULT 0,
            contradictions INTEGER NOT NULL DEFAULT 0,
            stability REAL NOT NULL DEFAULT 1.0,
            last_applied TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            flagged_for_review INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_procedures_type ON procedures(type);
          CREATE INDEX IF NOT EXISTS idx_procedures_confidence ON procedures(confidence DESC);
        `);
      }
      if (ver < 4) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS snapshots (
            id            TEXT PRIMARY KEY,
            created_at    TEXT NOT NULL,
            trigger       TEXT NOT NULL,
            node_count    INTEGER NOT NULL,
            edge_count    INTEGER NOT NULL,
            episode_count INTEGER NOT NULL,
            metadata      TEXT
          );
          CREATE TABLE IF NOT EXISTS snapshot_nodes (
            snapshot_id   TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
            node_id       TEXT NOT NULL,
            label         TEXT NOT NULL,
            type          TEXT NOT NULL,
            mention_count INTEGER NOT NULL,
            data          TEXT NOT NULL,
            PRIMARY KEY (snapshot_id, node_id)
          );
          CREATE TABLE IF NOT EXISTS snapshot_edges (
            snapshot_id   TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
            edge_id       TEXT NOT NULL,
            source        TEXT NOT NULL,
            target        TEXT NOT NULL,
            weight        REAL NOT NULL,
            stability     REAL NOT NULL,
            data          TEXT NOT NULL,
            PRIMARY KEY (snapshot_id, edge_id)
          );
          CREATE INDEX IF NOT EXISTS idx_snapshots_created ON snapshots(created_at);
        `);
      }
      if (ver < 5) {
        // Add hive_exclude column to nodes (for federated hive graph support)
        const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === 'hive_exclude')) {
          db.exec('ALTER TABLE nodes ADD COLUMN hive_exclude INTEGER NOT NULL DEFAULT 0');
        }
      }
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(SCHEMA_VERSION),
      );
    }

    return new SqliteStore(db);
  }

  private stmt(sql: string): BetterSqlite3.Statement {
    if (!this._stmts[sql]) {
      this._stmts[sql] = this.db.prepare(sql);
    }
    return this._stmts[sql];
  }

  // ── Nodes ─────────────────────────────────────────────────

  getNode(id: string): MemoryNode | undefined {
    const row = this.stmt('SELECT * FROM nodes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToNode(row) : undefined;
  }

  findNode(label: string): MemoryNode | undefined {
    const normalized = label.toLowerCase().trim();

    // Try exact label match first (indexed via LOWER(label)).
    const exact = this.stmt('SELECT * FROM nodes WHERE LOWER(label) = ?').get(normalized) as
      | Record<string, unknown>
      | undefined;
    if (exact) return rowToNode(exact);

    // Fall back to a memoized normalized-alias index instead of scanning every
    // node + JSON.parse-ing aliases on each call.
    const id = this.aliasIndex().get(normalized);
    return id ? this.getNode(id) : undefined;
  }

  /** normalized-alias -> node id, built once per write generation. */
  private aliasIndex(): Map<string, string> {
    this.syncCacheVersion();
    if (this._aliasIndex) return this._aliasIndex;
    const index = new Map<string, string>();
    const rows = this.stmt('SELECT id, aliases FROM nodes').all() as {
      id: string;
      aliases: string;
    }[];
    for (const row of rows) {
      const aliases: string[] = JSON.parse(row.aliases);
      for (const alias of aliases) {
        const key = alias.toLowerCase().trim();
        if (!index.has(key)) index.set(key, row.id); // first-writer-wins, stable across runs
      }
    }
    this._aliasIndex = index;
    return index;
  }

  listNodes(filter?: NodeFilter): MemoryNode[] {
    let sql = 'SELECT * FROM nodes';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }
    if (filter?.label) {
      conditions.push('LOWER(label) LIKE ?');
      params.push(`%${filter.label.toLowerCase()}%`);
    }
    if (filter?.since) {
      conditions.push('last_reinforced >= ?');
      params.push(filter.since);
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY mention_count DESC';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  putNode(node: MemoryNode): void {
    this.stmt(
      `INSERT OR REPLACE INTO nodes
       (id, label, type, aliases, first_seen, last_reinforced, mention_count, reinforcement_count, source_files, excerpts, hive_exclude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      node.id,
      node.label,
      node.type,
      JSON.stringify(node.aliases),
      node.firstSeen,
      node.lastReinforced,
      node.mentionCount,
      node.reinforcementCount,
      JSON.stringify(node.sourceFiles),
      JSON.stringify(node.excerpts),
      node.hiveExclude ? 1 : 0,
    );
    this.invalidateCaches();
  }

  deleteNode(id: string): void {
    this.stmt('DELETE FROM nodes WHERE id = ?').run(id);
    this.stmt('DELETE FROM edges WHERE source = ? OR target = ?').run(id, id);
    this.invalidateCaches();
  }

  nodeCount(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM nodes').get() as { count: number };
    return row.count;
  }

  // ── Edges ─────────────────────────────────────────────────

  getEdge(id: string): MemoryEdge | undefined {
    const row = this.stmt('SELECT * FROM edges WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEdge(row) : undefined;
  }

  listEdges(filter?: EdgeFilter): MemoryEdge[] {
    let sql = 'SELECT * FROM edges';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }
    if (filter?.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }
    if (filter?.target) {
      conditions.push('target = ?');
      params.push(filter.target);
    }
    if (filter?.minWeight !== undefined) {
      conditions.push('weight >= ?');
      params.push(filter.minWeight);
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY weight DESC';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  }

  putEdge(edge: MemoryEdge): void {
    this.stmt(
      `INSERT OR REPLACE INTO edges
       (id, source, target, type, directed, weight, base_weight, reinforcement_count, first_formed, last_reinforced, stability, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      edge.id,
      edge.source,
      edge.target,
      edge.type,
      edge.directed ? 1 : 0,
      edge.weight,
      edge.baseWeight,
      edge.reinforcementCount,
      edge.firstFormed,
      edge.lastReinforced,
      edge.stability,
      JSON.stringify(edge.evidence),
    );
    this.invalidateCaches();
  }

  deleteEdge(id: string): void {
    this.stmt('DELETE FROM edges WHERE id = ?').run(id);
    this.invalidateCaches();
  }

  edgeCount(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM edges').get() as { count: number };
    return row.count;
  }

  // ── Embeddings ──────────────────────────────────────────

  getEmbeddingProvider(): string {
    return this.getMeta('embedding_provider') ?? 'ollama';
  }

  setEmbeddingProvider(provider: string): void {
    const current = this.getMeta('embedding_provider');
    if (current && current !== provider) {
      // Provider switch: clear existing embeddings to avoid dimension mismatch
      this.clearAllEmbeddings();
    }
    this.setMeta('embedding_provider', provider);
  }

  putEmbedding(
    id: string,
    type: string,
    content: string,
    vector: Float32Array,
    provider: string,
  ): void {
    // Only enforce provider check if one has been explicitly set (non-default)
    const active = this.getEmbeddingProvider();
    const metaHasProvider = this.stmt('SELECT value FROM meta WHERE key = ?').get(
      'embedding_provider',
    ) as { value: string } | undefined;
    if (metaHasProvider && provider !== active) {
      throw new Error(
        `Provider "${provider}" is not active. Active provider: "${active}". ` +
          `Call setEmbeddingProvider() to switch providers.`,
      );
    }
    this.stmt(
      `INSERT OR REPLACE INTO embeddings
       (id, type, content, vector, dimensions, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      type,
      content,
      vectorToBuffer(vector),
      vector.length,
      provider,
      new Date().toISOString(),
    );
  }

  getEmbedding(id: string): EmbeddingRecord | undefined {
    const row = this.stmt('SELECT * FROM embeddings WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      type: row.type as string,
      content: row.content as string,
      vector: bufferToVector(row.vector as Buffer),
      provider: row.provider as string,
    };
  }

  searchSimilar(query: Float32Array, opts?: SimilaritySearchOptions): SimilarityResult[] {
    const limit = opts?.limit ?? 10;
    const minSimilarity = opts?.minSimilarity ?? 0;

    let sql = 'SELECT id, type, content, vector FROM embeddings';
    const params: unknown[] = [];

    if (opts?.type) {
      sql += ' WHERE type = ?';
      params.push(opts.type);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    const scored: SimilarityResult[] = [];
    for (const row of rows) {
      const vec = bufferToVector(row.vector as Buffer);
      if (vec.length !== query.length) continue;
      const sim = cosineSimilarity(query, vec);
      if (sim >= minSimilarity) {
        scored.push({
          id: row.id as string,
          type: row.type as string,
          content: row.content as string,
          similarity: sim,
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  deleteEmbedding(id: string): void {
    this.stmt('DELETE FROM embeddings WHERE id = ?').run(id);
  }

  clearAllEmbeddings(): number {
    const result = this.db.prepare('DELETE FROM embeddings').run();
    return result.changes;
  }

  embeddingCount(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };
    return row.count;
  }

  embeddingCountByType(type: string): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM embeddings WHERE type = ?').get(type) as {
      count: number;
    };
    return row.count;
  }

  // ── File Tracking ─────────────────────────────────────────

  getFileHash(path: string): FileHash | undefined {
    const row = this.stmt('SELECT * FROM processed_files WHERE path = ?').get(path) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      path: row.path as string,
      hash: row.hash as string,
      lastProcessed: row.last_processed as string,
    };
  }

  listFileHashes(): FileHash[] {
    const rows = this.stmt('SELECT * FROM processed_files').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      path: row.path as string,
      hash: row.hash as string,
      lastProcessed: row.last_processed as string,
    }));
  }

  putFileHash(hash: FileHash): void {
    this.stmt(
      'INSERT OR REPLACE INTO processed_files (path, hash, last_processed) VALUES (?, ?, ?)',
    ).run(hash.path, hash.hash, hash.lastProcessed);
  }

  // ── Episodes ──────────────────────────────────────────────

  putEpisode(episode: Episode): void {
    this.stmt(
      `INSERT OR REPLACE INTO episodes
       (id, timestamp, end_timestamp, type, title, summary, content, sequence, parent_id,
        importance, access_count, last_accessed, source, source_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      episode.id,
      episode.timestamp,
      episode.endTimestamp ?? null,
      episode.type,
      episode.title,
      episode.summary ?? null,
      episode.content,
      episode.sequence,
      episode.parentId ?? null,
      episode.importance,
      episode.accessCount,
      episode.lastAccessed,
      episode.source,
      episode.sourceType,
      new Date().toISOString(),
    );
  }

  getEpisode(id: string): Episode | undefined {
    const row = this.stmt('SELECT * FROM episodes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const episode = rowToEpisode(row);
    this.populateEpisodeEntities(episode);
    return episode;
  }

  listEpisodes(filter?: EpisodeFilter): Episode[] {
    let sql = 'SELECT DISTINCT e.* FROM episodes e';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.hasEntity) {
      sql += ' JOIN episode_entities ee ON e.id = ee.episode_id';
      conditions.push('ee.node_id = ?');
      params.push(filter.hasEntity);
    }

    if (filter?.type) {
      conditions.push('e.type = ?');
      params.push(filter.type);
    }
    if (filter?.since) {
      conditions.push('e.timestamp >= ?');
      params.push(filter.since);
    }
    if (filter?.until) {
      conditions.push('e.timestamp <= ?');
      params.push(filter.until);
    }
    if (filter?.source) {
      conditions.push('e.source = ?');
      params.push(filter.source);
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY e.timestamp DESC';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => {
      const episode = rowToEpisode(row);
      this.populateEpisodeEntities(episode);
      return episode;
    });
  }

  deleteEpisode(id: string): void {
    this.stmt('DELETE FROM episodes WHERE id = ?').run(id);
  }

  episodeCount(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM episodes').get() as { count: number };
    return row.count;
  }

  linkEpisodeEntity(episodeId: string, nodeId: string, role: EpisodeEntityLink['role']): void {
    this.stmt(
      'INSERT OR REPLACE INTO episode_entities (episode_id, node_id, role) VALUES (?, ?, ?)',
    ).run(episodeId, nodeId, role);
  }

  unlinkEpisodeEntity(episodeId: string, nodeId: string, role: EpisodeEntityLink['role']): void {
    this.stmt('DELETE FROM episode_entities WHERE episode_id = ? AND node_id = ? AND role = ?').run(
      episodeId,
      nodeId,
      role,
    );
  }

  getEpisodeEntities(episodeId: string): EpisodeEntityLink[] {
    const rows = this.stmt(
      'SELECT episode_id, node_id, role FROM episode_entities WHERE episode_id = ?',
    ).all(episodeId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      episodeId: row.episode_id as string,
      nodeId: row.node_id as string,
      role: row.role as EpisodeEntityLink['role'],
    }));
  }

  getEntityEpisodes(nodeId: string): Episode[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.* FROM episodes e
       JOIN episode_entities ee ON e.id = ee.episode_id
       WHERE ee.node_id = ?
       ORDER BY e.timestamp DESC`,
      )
      .all(nodeId) as Record<string, unknown>[];
    return rows.map((row) => {
      const episode = rowToEpisode(row);
      this.populateEpisodeEntities(episode);
      return episode;
    });
  }

  /**
   * Batched getEntityEpisodes: returns a nodeId -> Episode[] map for many nodes
   * in two queries total (episodes + entity links) instead of the per-node N+1
   * that getEntityEpisodes + populateEpisodeEntities incurs. Output is identical:
   * each node's episodes are timestamp-DESC and fully populated.
   */
  getEntityEpisodesBatch(nodeIds: string[]): Map<string, Episode[]> {
    const result = new Map<string, Episode[]>();
    const unique = [...new Set(nodeIds)];
    if (unique.length === 0) return result;
    for (const id of unique) result.set(id, []);

    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.*, ee.node_id AS _match_node FROM episodes e
       JOIN episode_entities ee ON e.id = ee.episode_id
       WHERE ee.node_id IN (${placeholders})
       ORDER BY e.timestamp DESC`,
      )
      .all(...unique) as Record<string, unknown>[];

    // One Episode object per distinct episode id, populated once via a single
    // links query; the per-node lists reference the shared (read-only) objects.
    const byId = new Map<string, Episode>();
    for (const row of rows) {
      const id = row.id as string;
      if (!byId.has(id)) byId.set(id, rowToEpisode(row));
    }
    this.populateEpisodesBatch(byId);

    for (const row of rows) {
      const ep = byId.get(row.id as string);
      const list = result.get(row._match_node as string);
      if (ep && list) list.push(ep);
    }
    return result;
  }

  /** Fill participants/topics/outcomes for many episodes in one query. */
  private populateEpisodesBatch(byId: Map<string, Episode>): void {
    if (byId.size === 0) return;
    const ids = [...byId.keys()];
    const placeholders = ids.map(() => '?').join(', ');
    const links = this.db
      .prepare(
        `SELECT episode_id, node_id, role FROM episode_entities WHERE episode_id IN (${placeholders})`,
      )
      .all(...ids) as Record<string, unknown>[];
    for (const link of links) {
      const ep = byId.get(link.episode_id as string);
      if (!ep) continue;
      const nodeId = link.node_id as string;
      if (link.role === 'participant') ep.participants.push(nodeId);
      else if (link.role === 'topic') ep.topics.push(nodeId);
      else if (link.role === 'outcome') {
        if (!ep.outcomes) ep.outcomes = [];
        ep.outcomes.push(nodeId);
      }
    }
  }

  touchEpisode(id: string): void {
    this.stmt(
      'UPDATE episodes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?',
    ).run(new Date().toISOString(), id);
  }

  private populateEpisodeEntities(episode: Episode): void {
    const links = this.getEpisodeEntities(episode.id);
    for (const link of links) {
      if (link.role === 'participant') episode.participants.push(link.nodeId);
      else if (link.role === 'topic') episode.topics.push(link.nodeId);
      else if (link.role === 'outcome') {
        if (!episode.outcomes) episode.outcomes = [];
        episode.outcomes.push(link.nodeId);
      }
    }
  }

  // ── Procedures ──────────────────────────────────────────

  putProcedure(procedure: Procedure): void {
    this.stmt(
      `INSERT OR REPLACE INTO procedures
       (id, statement, type, trigger_keywords, trigger_contexts, source_episodes, source_nodes,
        confidence, applications, contradictions, stability, last_applied, created_at, updated_at, flagged_for_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      procedure.id,
      procedure.statement,
      procedure.type,
      JSON.stringify(procedure.triggerKeywords),
      JSON.stringify(procedure.triggerContexts),
      JSON.stringify(procedure.sourceEpisodes),
      JSON.stringify(procedure.sourceNodes),
      procedure.confidence,
      procedure.applications,
      procedure.contradictions,
      procedure.stability,
      procedure.lastApplied,
      procedure.createdAt,
      procedure.updatedAt,
      procedure.flaggedForReview ? 1 : 0,
    );
  }

  getProcedure(id: string): Procedure | undefined {
    const row = this.stmt('SELECT * FROM procedures WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProcedure(row) : undefined;
  }

  listProcedures(filter?: ProcedureFilter): Procedure[] {
    let sql = 'SELECT * FROM procedures';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }
    if (filter?.minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      params.push(filter.minConfidence);
    }
    if (filter?.flaggedOnly) {
      conditions.push('flagged_for_review = 1');
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY confidence DESC';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const procedures = rows.map(rowToProcedure);

    if (filter?.hasKeyword) {
      const kw = filter.hasKeyword.toLowerCase();
      return procedures.filter((p) => p.triggerKeywords.some((k) => k.toLowerCase().includes(kw)));
    }
    if (filter?.hasContext) {
      const ctx = filter.hasContext.toLowerCase();
      return procedures.filter((p) => p.triggerContexts.some((c) => c.toLowerCase() === ctx));
    }

    return procedures;
  }

  deleteProcedure(id: string): void {
    this.stmt('DELETE FROM procedures WHERE id = ?').run(id);
  }

  procedureCount(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM procedures').get() as { count: number };
    return row.count;
  }

  // ── Snapshots ────────────────────────────────────────────

  createSnapshot(trigger: SnapshotTrigger, metadata?: Record<string, unknown>): Snapshot {
    const now = new Date().toISOString();
    const id = `snap_${now}_${randomUUID().slice(0, 8)}`;
    const nodes = this.listNodes();
    const edges = this.listEdges();
    const epCount = this.episodeCount();

    const snapshot: Snapshot = {
      id,
      createdAt: now,
      trigger,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      episodeCount: epCount,
      metadata,
    };

    const insertAll = this.db.transaction(() => {
      this.stmt(
        `INSERT INTO snapshots (id, created_at, trigger, node_count, edge_count, episode_count, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        now,
        trigger,
        nodes.length,
        edges.length,
        epCount,
        metadata ? JSON.stringify(metadata) : null,
      );

      for (const node of nodes) {
        this.stmt(
          `INSERT INTO snapshot_nodes (snapshot_id, node_id, label, type, mention_count, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, node.id, node.label, node.type, node.mentionCount, JSON.stringify(node));
      }

      for (const edge of edges) {
        this.stmt(
          `INSERT INTO snapshot_edges (snapshot_id, edge_id, source, target, weight, stability, data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          edge.id,
          edge.source,
          edge.target,
          edge.weight,
          edge.stability,
          JSON.stringify(edge),
        );
      }
    });

    insertAll();
    return snapshot;
  }

  getSnapshot(id: string): Snapshot | undefined {
    const row = this.stmt('SELECT * FROM snapshots WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      createdAt: row.created_at as string,
      trigger: row.trigger as SnapshotTrigger,
      nodeCount: row.node_count as number,
      edgeCount: row.edge_count as number,
      episodeCount: row.episode_count as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  listSnapshots(opts?: SnapshotFilter): Snapshot[] {
    let sql = 'SELECT * FROM snapshots';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts?.until) {
      conditions.push('created_at <= ?');
      params.push(opts.until);
    }

    if (conditions.length) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      createdAt: row.created_at as string,
      trigger: row.trigger as SnapshotTrigger,
      nodeCount: row.node_count as number,
      edgeCount: row.edge_count as number,
      episodeCount: row.episode_count as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }));
  }

  getSnapshotGraph(id: string): NacreGraph {
    const snapshot = this.getSnapshot(id);
    if (!snapshot) throw new Error(`Snapshot not found: ${id}`);

    const nodeRows = this.stmt('SELECT data FROM snapshot_nodes WHERE snapshot_id = ?').all(
      id,
    ) as Array<{ data: string }>;
    const edgeRows = this.stmt('SELECT data FROM snapshot_edges WHERE snapshot_id = ?').all(
      id,
    ) as Array<{ data: string }>;

    const nodes: Record<string, MemoryNode> = {};
    for (const row of nodeRows) {
      const node = JSON.parse(row.data) as MemoryNode;
      nodes[node.id] = node;
    }

    const edges: Record<string, MemoryEdge> = {};
    for (const row of edgeRows) {
      const edge = JSON.parse(row.data) as MemoryEdge;
      edges[edge.id] = edge;
    }

    const configStr = this.getMeta('config');
    const config: GraphConfig = configStr ? JSON.parse(configStr) : DEFAULT_CONFIG;

    return {
      version: 2,
      lastConsolidated: snapshot.createdAt,
      processedFiles: [],
      nodes,
      edges,
      config,
    };
  }

  deleteSnapshot(id: string): void {
    this.stmt('DELETE FROM snapshots WHERE id = ?').run(id);
  }

  getNodeHistory(nodeId: string): EntityHistory {
    const rows = this.db
      .prepare(
        `SELECT s.id AS snapshot_id, s.created_at, sn.data
       FROM snapshot_nodes sn
       JOIN snapshots s ON s.id = sn.snapshot_id
       WHERE sn.node_id = ?
       ORDER BY s.created_at ASC`,
      )
      .all(nodeId) as Array<{ snapshot_id: string; created_at: string; data: string }>;

    return {
      entityId: nodeId,
      type: 'node',
      snapshots: rows.map((row) => ({
        snapshotId: row.snapshot_id,
        timestamp: row.created_at,
        state: JSON.parse(row.data) as MemoryNode,
      })),
    };
  }

  getEdgeHistory(edgeId: string): EntityHistory {
    const rows = this.db
      .prepare(
        `SELECT s.id AS snapshot_id, s.created_at, se.data
       FROM snapshot_edges se
       JOIN snapshots s ON s.id = se.snapshot_id
       WHERE se.edge_id = ?
       ORDER BY s.created_at ASC`,
      )
      .all(edgeId) as Array<{ snapshot_id: string; created_at: string; data: string }>;

    return {
      entityId: edgeId,
      type: 'edge',
      snapshots: rows.map((row) => ({
        snapshotId: row.snapshot_id,
        timestamp: row.created_at,
        state: JSON.parse(row.data) as MemoryEdge,
      })),
    };
  }

  // ── Bulk Operations ───────────────────────────────────────

  /**
   * Export the entire graph as a NacreGraph object.
   */
  getFullGraph(): NacreGraph {
    this.syncCacheVersion();
    if (this._graphCache) return this._graphCache;

    const nodes: Record<string, MemoryNode> = {};
    const edges: Record<string, MemoryEdge> = {};

    for (const node of this.listNodes()) {
      nodes[node.id] = node;
    }
    for (const edge of this.listEdges()) {
      edges[edge.id] = edge;
    }

    const configStr = this.getMeta('config');
    const config: GraphConfig = configStr ? JSON.parse(configStr) : DEFAULT_CONFIG;

    const graph: NacreGraph = {
      version: 2,
      lastConsolidated: this.getMeta('last_consolidated') ?? '',
      processedFiles: this.listFileHashes(),
      nodes,
      edges,
      config,
    };
    this._graphCache = graph;
    return graph;
  }

  /**
   * Adjacency map for the live graph. Memoized alongside getFullGraph and
   * invalidated on any node/edge write, so repeated recalls between writes
   * don't rebuild it.
   */
  getAdjacencyMap(): AdjacencyMap {
    this.syncCacheVersion();
    if (!this._adjCache) {
      this._adjCache = buildAdjacencyMap(this.getFullGraph());
    }
    return this._adjCache;
  }

  /**
   * Import a NacreGraph (from JSON) into this store.
   * Clears existing data and replaces with the imported graph.
   */
  importGraph(graph: NacreGraph): void {
    const importAll = this.db.transaction(() => {
      // Clear existing data
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM processed_files');

      // Import nodes
      for (const node of Object.values(graph.nodes)) {
        this.putNode(node);
      }

      // Import edges
      for (const edge of Object.values(graph.edges)) {
        this.putEdge(edge);
      }

      // Import file hashes
      for (const fh of graph.processedFiles) {
        this.putFileHash(fh);
      }

      // Store config and metadata
      this.setMeta('config', JSON.stringify(graph.config));
      this.setMeta('last_consolidated', graph.lastConsolidated);
      this.setMeta('graph_version', String(graph.version));
    });

    importAll();
    this.invalidateCaches();
  }

  // ── Metadata ──────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.stmt('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /**
   * No-op for better-sqlite3 (writes are immediate in WAL mode).
   * Kept for interface compatibility.
   */
  save(): void {
    // better-sqlite3 writes are immediate — no manual save needed
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this._stmts = {};
    this.db.close();
  }

  /**
   * Get the raw better-sqlite3 Database instance (for advanced queries).
   */
  get raw(): BetterSqlite3.Database {
    return this.db;
  }
}
