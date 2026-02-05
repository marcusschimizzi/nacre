/**
 * GraphStore — persistent storage layer for nacre's knowledge graph.
 * 
 * Uses SQLite (via sql.js for portability) as the backing store.
 * The store interface is designed to be swappable — sql.js for 
 * portability/WASM, better-sqlite3 for native performance.
 * 
 * A nacre graph is a single .db file on disk.
 */

import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  MemoryNode,
  MemoryEdge,
  FileHash,
  GraphConfig,
  NacreGraph,
  EntityType,
  EdgeType,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

// ── Schema ──────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

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

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
`;

// ── Serialization helpers ───────────────────────────────────────

function nodeToRow(node: MemoryNode) {
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    aliases: JSON.stringify(node.aliases),
    first_seen: node.firstSeen,
    last_reinforced: node.lastReinforced,
    mention_count: node.mentionCount,
    reinforcement_count: node.reinforcementCount,
    source_files: JSON.stringify(node.sourceFiles),
    excerpts: JSON.stringify(node.excerpts),
  };
}

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

function edgeToRow(edge: MemoryEdge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    directed: edge.directed ? 1 : 0,
    weight: edge.weight,
    base_weight: edge.baseWeight,
    reinforcement_count: edge.reinforcementCount,
    first_formed: edge.firstFormed,
    last_reinforced: edge.lastReinforced,
    stability: edge.stability,
    evidence: JSON.stringify(edge.evidence),
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

// ── Query helpers ───────────────────────────────────────────────

function queryAll(db: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  
  const results: Record<string, unknown>[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(db: Database, sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
  const results = queryAll(db, sql, params);
  return results[0];
}

function execute(db: Database, sql: string, params: unknown[] = []): void {
  db.run(sql, params);
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
  private db: Database;
  private dbPath: string | null;
  private dirty: boolean = false;

  private constructor(db: Database, dbPath: string | null) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Open or create a nacre graph database.
   * Pass a file path to persist, or null for in-memory.
   */
  static async open(dbPath?: string | null): Promise<SqliteStore> {
    const SQL = await initSqlJs();
    
    let db: Database;
    const resolvedPath = dbPath ?? null;

    if (resolvedPath && existsSync(resolvedPath)) {
      const buffer = readFileSync(resolvedPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    // Initialize schema
    db.run(SCHEMA_SQL);

    // Set schema version if new
    const version = queryOne(db, "SELECT value FROM meta WHERE key = 'schema_version'");
    if (!version) {
      execute(db, "INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
      execute(db, "INSERT INTO meta (key, value) VALUES ('created_at', ?)", [new Date().toISOString()]);
    }

    const store = new SqliteStore(db, resolvedPath);
    return store;
  }

  // ── Nodes ─────────────────────────────────────────────────

  getNode(id: string): MemoryNode | undefined {
    const row = queryOne(this.db, 'SELECT * FROM nodes WHERE id = ?', [id]);
    return row ? rowToNode(row) : undefined;
  }

  findNode(label: string): MemoryNode | undefined {
    const normalized = label.toLowerCase().trim();
    
    // Try exact label match first
    const exact = queryOne(this.db, 'SELECT * FROM nodes WHERE LOWER(label) = ?', [normalized]);
    if (exact) return rowToNode(exact);

    // Try alias match
    const all = queryAll(this.db, 'SELECT * FROM nodes');
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
    return queryAll(this.db, sql, params).map(rowToNode);
  }

  putNode(node: MemoryNode): void {
    const row = nodeToRow(node);
    execute(this.db,
      `INSERT OR REPLACE INTO nodes 
       (id, label, type, aliases, first_seen, last_reinforced, mention_count, reinforcement_count, source_files, excerpts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.label, row.type, row.aliases, row.first_seen, row.last_reinforced,
       row.mention_count, row.reinforcement_count, row.source_files, row.excerpts]
    );
    this.dirty = true;
  }

  deleteNode(id: string): void {
    execute(this.db, 'DELETE FROM nodes WHERE id = ?', [id]);
    // Also clean up edges referencing this node
    execute(this.db, 'DELETE FROM edges WHERE source = ? OR target = ?', [id, id]);
    this.dirty = true;
  }

  nodeCount(): number {
    const row = queryOne(this.db, 'SELECT COUNT(*) as count FROM nodes');
    return (row?.count as number) ?? 0;
  }

  // ── Edges ─────────────────────────────────────────────────

  getEdge(id: string): MemoryEdge | undefined {
    const row = queryOne(this.db, 'SELECT * FROM edges WHERE id = ?', [id]);
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
    return queryAll(this.db, sql, params).map(rowToEdge);
  }

  putEdge(edge: MemoryEdge): void {
    const row = edgeToRow(edge);
    execute(this.db,
      `INSERT OR REPLACE INTO edges
       (id, source, target, type, directed, weight, base_weight, reinforcement_count, first_formed, last_reinforced, stability, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.source, row.target, row.type, row.directed, row.weight, row.base_weight,
       row.reinforcement_count, row.first_formed, row.last_reinforced, row.stability, row.evidence]
    );
    this.dirty = true;
  }

  deleteEdge(id: string): void {
    execute(this.db, 'DELETE FROM edges WHERE id = ?', [id]);
    this.dirty = true;
  }

  edgeCount(): number {
    const row = queryOne(this.db, 'SELECT COUNT(*) as count FROM edges');
    return (row?.count as number) ?? 0;
  }

  // ── File Tracking ─────────────────────────────────────────

  getFileHash(path: string): FileHash | undefined {
    const row = queryOne(this.db, 'SELECT * FROM processed_files WHERE path = ?', [path]);
    if (!row) return undefined;
    return {
      path: row.path as string,
      hash: row.hash as string,
      lastProcessed: row.last_processed as string,
    };
  }

  listFileHashes(): FileHash[] {
    return queryAll(this.db, 'SELECT * FROM processed_files').map(row => ({
      path: row.path as string,
      hash: row.hash as string,
      lastProcessed: row.last_processed as string,
    }));
  }

  putFileHash(hash: FileHash): void {
    execute(this.db,
      'INSERT OR REPLACE INTO processed_files (path, hash, last_processed) VALUES (?, ?, ?)',
      [hash.path, hash.hash, hash.lastProcessed]
    );
    this.dirty = true;
  }

  // ── Bulk Operations ───────────────────────────────────────

  /**
   * Export the entire graph as a NacreGraph object.
   * Useful for backwards compatibility, viz export, and migration.
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
    // Clear existing data
    execute(this.db, 'DELETE FROM nodes');
    execute(this.db, 'DELETE FROM edges');
    execute(this.db, 'DELETE FROM processed_files');

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

    this.dirty = true;
  }

  // ── Metadata ──────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = queryOne(this.db, 'SELECT value FROM meta WHERE key = ?', [key]);
    return row?.value as string | undefined;
  }

  setMeta(key: string, value: string): void {
    execute(this.db, 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
    this.dirty = true;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /**
   * Persist the database to disk.
   * For sql.js, this exports the WASM memory to a file.
   * For better-sqlite3, this would be a no-op (writes are immediate).
   */
  save(): void {
    if (!this.dbPath) return;
    if (!this.dirty) return;
    
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }

  /**
   * Close the database connection.
   * Saves if there are unsaved changes.
   */
  close(): void {
    if (this.dirty) {
      this.save();
    }
    this.db.close();
  }

  /**
   * Get the raw sql.js Database instance (for advanced queries).
   * Use with caution — prefer the typed methods above.
   */
  get raw(): Database {
    return this.db;
  }
}
