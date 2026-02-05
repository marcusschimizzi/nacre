/**
 * Graph loader — opens a nacre graph from either SQLite (.db) or JSON (.json).
 * 
 * This provides a unified interface for CLI commands to load graphs
 * regardless of the storage format.
 */

import { readFileSync, existsSync } from 'node:fs';
import { SqliteStore, type NacreGraph } from '@nacre/core';

export interface LoadedGraph {
  graph: NacreGraph;
  store: SqliteStore | null;  // non-null if loaded from SQLite
  format: 'sqlite' | 'json';
}

/**
 * Load a graph from a file path.
 * - .db files → opened as SQLite, graph exported
 * - .json files → read and parsed as JSON
 * - Paths without extension → try .db first, then .json
 */
export async function loadGraph(graphPath: string): Promise<LoadedGraph> {
  // If it's a .db file, open as SQLite
  if (graphPath.endsWith('.db')) {
    if (!existsSync(graphPath)) {
      throw new Error(`Database not found: ${graphPath}`);
    }
    const store = SqliteStore.open(graphPath);
    const graph = store.getFullGraph();
    return { graph, store, format: 'sqlite' };
  }

  // If it's a .json file, read as JSON
  if (graphPath.endsWith('.json')) {
    if (!existsSync(graphPath)) {
      throw new Error(`Graph file not found: ${graphPath}`);
    }
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;
    return { graph, store: null, format: 'json' };
  }

  // No extension — try .db first, then .json, then directory with graph.json
  if (existsSync(graphPath + '.db')) {
    const store = SqliteStore.open(graphPath + '.db');
    const graph = store.getFullGraph();
    return { graph, store, format: 'sqlite' };
  }

  if (existsSync(graphPath + '.json')) {
    const graph = JSON.parse(readFileSync(graphPath + '.json', 'utf8')) as NacreGraph;
    return { graph, store: null, format: 'json' };
  }

  // Try as directory containing graph.json (legacy format)
  const dirJsonPath = graphPath.replace(/\/$/, '') + '/graph.json';
  if (existsSync(dirJsonPath)) {
    const graph = JSON.parse(readFileSync(dirJsonPath, 'utf8')) as NacreGraph;
    return { graph, store: null, format: 'json' };
  }

  throw new Error(
    `Could not find graph at: ${graphPath}\n` +
    `Tried: ${graphPath}.db, ${graphPath}.json, ${dirJsonPath}`
  );
}

/**
 * Save a graph back to its source.
 * - SQLite: imports the graph back into the store and saves
 * - JSON: not handled here (the pipeline manages its own writes)
 */
export function saveGraph(loaded: LoadedGraph): void {
  if (loaded.store) {
    loaded.store.importGraph(loaded.graph);
    loaded.store.save();
  }
}

/**
 * Close the graph store (if SQLite).
 */
export function closeGraph(loaded: LoadedGraph): void {
  if (loaded.store) {
    loaded.store.close();
  }
}
