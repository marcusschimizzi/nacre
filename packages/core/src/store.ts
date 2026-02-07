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
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { cosineSimilarity, bufferToVector, vectorToBuffer } from './embeddings.js';

// ── Schema ──────────────────────────────────────────────────────

const SCHEMA_VERSION = 2;

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
  excerpts            TEXT NOT NULL DEFAULT '[]'
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
`;

// ── Serialization helpers ───────────────────────────────────────

function rowToNode(row: Record<string, unknown>): MemoryNode {
  return {
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
  since?: string;  // ISO date — nodes reinforced after this date
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
  putEmbedding(id: string, type: string, content: string, vector: Float32Array, provider: string): void;
  getEmbedding(id: string): EmbeddingRecord | undefined;
  searchSimilar(query: Float32Array, opts?: SimilaritySearchOptions): SimilarityResult[];
  deleteEmbedding(id: string): void;
  embeddingCount(): number;

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
  touchEpisode(id: string): void;

  // Bulk operations
  getFullGraph(): NacreGraph;
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

  private constructor(db: BetterSqlite3.Database) {
    this.db = db;
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
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!version) {
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run('schema_version', String(SCHEMA_VERSION));
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run('created_at', new Date().toISOString());
    } else if (parseInt(version.value, 10) < 2) {
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
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run('schema_version', '2');
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
    const row = this.stmt('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToNode(row) : undefined;
  }

  findNode(label: string): MemoryNode | undefined {
    const normalized = label.toLowerCase().trim();
    
    // Try exact label match first
    const exact = this.stmt('SELECT * FROM nodes WHERE LOWER(label) = ?').get(normalized) as Record<string, unknown> | undefined;
    if (exact) return rowToNode(exact);

    // Try alias match — scan all nodes
    const all = this.stmt('SELECT * FROM nodes').all() as Record<string, unknown>[];
    for (const row of all) {
      const aliases: string[] = JSON.parse(row.aliases as string);
      if (aliases.some(a => a.toLowerCase() === normalized)) {
        return rowToNode(row);
      }
    }

    return undefined;
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
       (id, label, type, aliases, first_seen, last_reinforced, mention_count, reinforcement_count, source_files, excerpts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      node.id, node.label, node.type, JSON.stringify(node.aliases),
      node.firstSeen, node.lastReinforced, node.mentionCount,
      node.reinforcementCount, JSON.stringify(node.sourceFiles),
      JSON.stringify(node.excerpts)
    );
  }

  deleteNode(id: string): void {
    this.stmt('DELETE FROM nodes WHERE id = ?').run(id);
    this.stmt('DELETE FROM edges WHERE source = ? OR target = ?').run(id, id);
  }

  nodeCount(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM nodes').get() as { count: number };
    return row.count;
  }

  // ── Edges ─────────────────────────────────────────────────

  getEdge(id: string): MemoryEdge | undefined {
    const row = this.stmt('SELECT * FROM edges WHERE id = ?').get(id) as Record<string, unknown> | undefined;
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      edge.id, edge.source, edge.target, edge.type,
      edge.directed ? 1 : 0, edge.weight, edge.baseWeight,
      edge.reinforcementCount, edge.firstFormed, edge.lastReinforced,
      edge.stability, JSON.stringify(edge.evidence)
    );
  }

  deleteEdge(id: string): void {
    this.stmt('DELETE FROM edges WHERE id = ?').run(id);
  }

  edgeCount(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM edges').get() as { count: number };
    return row.count;
  }

  // ── Embeddings ──────────────────────────────────────────

  putEmbedding(id: string, type: string, content: string, vector: Float32Array, provider: string): void {
    this.stmt(
      `INSERT OR REPLACE INTO embeddings
       (id, type, content, vector, dimensions, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, type, content, vectorToBuffer(vector), vector.length, provider, new Date().toISOString());
  }

  getEmbedding(id: string): EmbeddingRecord | undefined {
    const row = this.stmt('SELECT * FROM embeddings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
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

  embeddingCount(): number {
    const row = this.stmt('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };
    return row.count;
  }

  // ── File Tracking ─────────────────────────────────────────

  getFileHash(path: string): FileHash | undefined {
    const row = this.stmt('SELECT * FROM processed_files WHERE path = ?').get(path) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      path: row.path as string,
      hash: row.hash as string,
      lastProcessed: row.last_processed as string,
    };
  }

  listFileHashes(): FileHash[] {
    const rows = this.stmt('SELECT * FROM processed_files').all() as Record<string, unknown>[];
    return rows.map(row => ({
      path: row.path as string,
      hash: row.hash as string,
      lastProcessed: row.last_processed as string,
    }));
  }

  putFileHash(hash: FileHash): void {
    this.stmt(
      'INSERT OR REPLACE INTO processed_files (path, hash, last_processed) VALUES (?, ?, ?)'
    ).run(hash.path, hash.hash, hash.lastProcessed);
  }

  // ── Episodes ──────────────────────────────────────────────

  putEpisode(episode: Episode): void {
    this.stmt(
      `INSERT OR REPLACE INTO episodes
       (id, timestamp, end_timestamp, type, title, summary, content, sequence, parent_id,
        importance, access_count, last_accessed, source, source_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      episode.id, episode.timestamp, episode.endTimestamp ?? null,
      episode.type, episode.title, episode.summary ?? null,
      episode.content, episode.sequence, episode.parentId ?? null,
      episode.importance, episode.accessCount, episode.lastAccessed,
      episode.source, episode.sourceType, new Date().toISOString()
    );
  }

  getEpisode(id: string): Episode | undefined {
    const row = this.stmt('SELECT * FROM episodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
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
    return rows.map(row => {
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
      'INSERT OR REPLACE INTO episode_entities (episode_id, node_id, role) VALUES (?, ?, ?)'
    ).run(episodeId, nodeId, role);
  }

  unlinkEpisodeEntity(episodeId: string, nodeId: string, role: EpisodeEntityLink['role']): void {
    this.stmt(
      'DELETE FROM episode_entities WHERE episode_id = ? AND node_id = ? AND role = ?'
    ).run(episodeId, nodeId, role);
  }

  getEpisodeEntities(episodeId: string): EpisodeEntityLink[] {
    const rows = this.stmt(
      'SELECT episode_id, node_id, role FROM episode_entities WHERE episode_id = ?'
    ).all(episodeId) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      episodeId: row.episode_id as string,
      nodeId: row.node_id as string,
      role: row.role as EpisodeEntityLink['role'],
    }));
  }

  getEntityEpisodes(nodeId: string): Episode[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT e.* FROM episodes e
       JOIN episode_entities ee ON e.id = ee.episode_id
       WHERE ee.node_id = ?
       ORDER BY e.timestamp DESC`
    ).all(nodeId) as Record<string, unknown>[];
    return rows.map(row => {
      const episode = rowToEpisode(row);
      this.populateEpisodeEntities(episode);
      return episode;
    });
  }

  touchEpisode(id: string): void {
    this.stmt(
      'UPDATE episodes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?'
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

  // ── Bulk Operations ───────────────────────────────────────

  /**
   * Export the entire graph as a NacreGraph object.
   */
  getFullGraph(): NacreGraph {
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

    return {
      version: 2,
      lastConsolidated: this.getMeta('last_consolidated') ?? '',
      processedFiles: this.listFileHashes(),
      nodes,
      edges,
      config,
    };
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
  }

  // ── Metadata ──────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
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
