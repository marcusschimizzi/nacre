import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStore } from '../store.js';
import type { NacreGraph } from '../types.js';

const GRAPH_PATH = resolve(import.meta.dirname ?? '.', '..', '..', '..', '..', 'data', 'graphs', 'lobstar', 'graph.json');
const DB_PATH = '/tmp/nacre-migration-test.db';

describe('JSON → SQLite migration', () => {
  let graph: NacreGraph;
  let store: SqliteStore;

  before(async () => {
    if (!existsSync(GRAPH_PATH)) {
      console.log('Skipping migration test — no graph.json found at', GRAPH_PATH);
      return;
    }
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    
    graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf-8'));
    store = SqliteStore.open(DB_PATH);
    store.importGraph(graph);
    store.save();
  });

  after(() => {
    if (store) store.close();
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  });

  it('imports all nodes', () => {
    if (!graph) return;
    const expected = Object.keys(graph.nodes).length;
    assert.equal(store.nodeCount(), expected);
  });

  it('imports all edges', () => {
    if (!graph) return;
    const expected = Object.keys(graph.edges).length;
    assert.equal(store.edgeCount(), expected);
  });

  it('imports all file hashes', () => {
    if (!graph) return;
    const expected = graph.processedFiles.length;
    assert.equal(store.listFileHashes().length, expected);
  });

  it('preserves node data through roundtrip', () => {
    if (!graph) return;
    const nodeIds = Object.keys(graph.nodes);
    for (const id of nodeIds.slice(0, 10)) {
      const original = graph.nodes[id];
      const stored = store.getNode(id);
      assert.ok(stored, `Node ${id} not found`);
      assert.equal(stored.label, original.label);
      assert.equal(stored.type, original.type);
      assert.equal(stored.mentionCount, original.mentionCount);
      assert.deepEqual(stored.aliases, original.aliases);
    }
  });

  it('preserves edge data through roundtrip', () => {
    if (!graph) return;
    const edgeIds = Object.keys(graph.edges);
    for (const id of edgeIds.slice(0, 10)) {
      const original = graph.edges[id];
      const stored = store.getEdge(id);
      assert.ok(stored, `Edge ${id} not found`);
      assert.equal(stored.source, original.source);
      assert.equal(stored.target, original.target);
      assert.equal(stored.type, original.type);
      assert.equal(stored.weight, original.weight);
      assert.equal(stored.stability, original.stability);
    }
  });

  it('exports matching full graph', () => {
    if (!graph) return;
    const exported = store.getFullGraph();
    assert.equal(Object.keys(exported.nodes).length, Object.keys(graph.nodes).length);
    assert.equal(Object.keys(exported.edges).length, Object.keys(graph.edges).length);
  });

  it('can query by type', () => {
    if (!graph) return;
    const tools = store.listNodes({ type: 'tool' });
    const expectedTools = Object.values(graph.nodes).filter(n => n.type === 'tool').length;
    assert.equal(tools.length, expectedTools);
  });

  it('can find nodes by label', () => {
    if (!graph) return;
    // Find a node that exists in the graph
    const anyNode = Object.values(graph.nodes)[0];
    const found = store.findNode(anyNode.label);
    assert.ok(found);
    assert.equal(found.id, anyNode.id);
  });
});
