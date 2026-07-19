import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapture } from '../capture.js';
import { compileMemoryDir } from '../memory-compile.js';
import { exportCanonical } from '../memory-export.js';
import { parseMemoryFile, serializeMemoryFile } from '../memory-file.js';
import { promoteCaptured } from '../memory-promote.js';
import { writeBackSalience } from '../memory-salience.js';
import { SqliteStore } from '../store.js';
import { generateEdgeId, generateNodeId } from '../graph.js';
import type { MemoryNode } from '../types.js';

function promoteOne(store: SqliteStore, root: string): string {
  appendCapture(root, {
    id: 'mem_0011aabbccdd',
    ts: '2026-07-17T09:00:00Z',
    origin: 'mcp',
    payload: { content: 'Vite is faster than Webpack.', type: 'fact' },
  });
  const relPath = promoteCaptured(store, root).promoted[0];
  compileMemoryDir(store, root);
  return relPath;
}

describe('writeBackSalience', () => {
  let root: string;
  let store: SqliteStore;

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'nacre-salience-'));
    store = SqliteStore.open(':memory:');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('batches store reinforcement into frontmatter', () => {
    const relPath = promoteOne(store, root);

    const node = store.getNode('mem_0011aabbccdd');
    assert.ok(node);
    node.reinforcementCount = 5;
    node.lastReinforced = '2026-07-20T12:00:00Z';
    store.putNode(node);

    const result = writeBackSalience(store, root);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.updated, [relPath]);

    const parsed = parseMemoryFile(readFileSync(join(root, relPath), 'utf-8'), relPath);
    assert.equal(parsed.memory.salience.reinforcementCount, 5);
    assert.equal(parsed.memory.salience.lastReinforced, '2026-07-20');
  });

  it('does not rewrite files that already match (no git churn)', () => {
    promoteOne(store, root);
    writeBackSalience(store, root);
    const second = writeBackSalience(store, root);
    assert.equal(second.updated.length, 0);
    assert.equal(second.unchanged, 1);
  });

  it('merge is monotone: a higher synced count in the file is never regressed', () => {
    const relPath = promoteOne(store, root);
    const abs = join(root, relPath);

    // Simulate a git-synced increment from another device.
    const parsed = parseMemoryFile(readFileSync(abs, 'utf-8'), relPath);
    parsed.memory.salience = { reinforcementCount: 9, lastReinforced: '2026-07-21' };
    writeFileSync(abs, serializeMemoryFile(parsed.memory));

    const result = writeBackSalience(store, root);
    assert.equal(result.updated.length, 0);
    const after = parseMemoryFile(readFileSync(abs, 'utf-8'), relPath);
    assert.equal(after.memory.salience.reinforcementCount, 9);
  });

  it('warns when a promoted node has lost its canonical file', () => {
    const relPath = promoteOne(store, root);
    rmSync(join(root, relPath));
    const result = writeBackSalience(store, root);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /canonical file missing/);
  });
});

describe('renameNode', () => {
  it('rewrites snapshot history and procedure provenance', () => {
    const store = SqliteStore.open(':memory:');
    const entityId = generateNodeId('Vite');
    store.putNode({
      id: 'n-legacy2',
      label: 'Old memory',
      aliases: [],
      type: 'concept',
      firstSeen: '2026-06-01',
      lastReinforced: '2026-06-10',
      mentionCount: 1,
      reinforcementCount: 1,
      sourceFiles: ['mcp'],
      excerpts: [],
    });
    store.putNode({
      id: entityId,
      label: 'Vite',
      aliases: [],
      type: 'tool',
      firstSeen: '2026-06-01',
      lastReinforced: '2026-06-10',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
    });
    store.putEdge({
      id: generateEdgeId('n-legacy2', entityId, 'explicit'),
      source: 'n-legacy2',
      target: entityId,
      type: 'explicit',
      directed: false,
      weight: 0.8,
      baseWeight: 0.8,
      reinforcementCount: 1,
      firstFormed: '2026-06-01',
      lastReinforced: '2026-06-10',
      stability: 1,
      evidence: [],
    });
    const snapshot = store.createSnapshot('manual');
    store.putProcedure({
      id: 'proc-1',
      statement: 'A lesson derived from the legacy memory',
      type: 'insight',
      triggerKeywords: [],
      triggerContexts: [],
      sourceEpisodes: [],
      sourceNodes: ['n-legacy2', entityId],
      confidence: 0.8,
      applications: 0,
      contradictions: 0,
      stability: 1,
      lastApplied: null,
      createdAt: '2026-06-10',
      updatedAt: '2026-06-10',
      flaggedForReview: false,
    });

    store.renameNode('n-legacy2', 'mem_eeee00002222');

    // Snapshot history follows the memory to its new id.
    const snapGraph = store.getSnapshotGraph(snapshot.id);
    assert.ok(snapGraph.nodes['mem_eeee00002222']);
    assert.equal(snapGraph.nodes['n-legacy2'], undefined);
    const snapEdge = Object.values(snapGraph.edges)[0];
    assert.ok(snapEdge.source === 'mem_eeee00002222' || snapEdge.target === 'mem_eeee00002222');
    assert.equal(snapEdge.id, generateEdgeId('mem_eeee00002222', entityId, 'explicit'));

    // Procedure provenance follows too; unrelated ids are untouched.
    const proc = store.getProcedure('proc-1');
    assert.deepEqual(proc?.sourceNodes, ['mem_eeee00002222', entityId]);
    store.close();
  });

  it('moves edges, embeddings, and identity in one transaction', () => {
    const store = SqliteStore.open(':memory:');
    const legacy: MemoryNode = {
      id: 'n-legacy1',
      label: 'Old memory',
      aliases: [],
      type: 'concept',
      firstSeen: '2026-06-01',
      lastReinforced: '2026-06-10',
      mentionCount: 1,
      reinforcementCount: 1,
      sourceFiles: ['mcp'],
      excerpts: [],
    };
    store.putNode(legacy);
    const entityId = generateNodeId('Vite');
    store.putNode({ ...legacy, id: entityId, label: 'Vite', type: 'tool', sourceFiles: [] });
    store.putEdge({
      id: generateEdgeId('n-legacy1', entityId, 'explicit'),
      source: 'n-legacy1',
      target: entityId,
      type: 'explicit',
      directed: false,
      weight: 0.8,
      baseWeight: 0.8,
      reinforcementCount: 1,
      firstFormed: '2026-06-01',
      lastReinforced: '2026-06-10',
      stability: 1,
      evidence: [],
    });
    store.putEmbedding('n-legacy1', 'node', 'Old memory', new Float32Array(8).fill(0.5), 'mock');

    store.renameNode('n-legacy1', 'mem_ffff00001111');

    assert.equal(store.getNode('n-legacy1'), undefined);
    assert.ok(store.getNode('mem_ffff00001111'));
    assert.ok(store.getEmbedding('mem_ffff00001111'));
    assert.equal(store.getEmbedding('n-legacy1'), undefined);
    const edges = store.listEdges();
    assert.equal(edges.length, 1);
    assert.equal(
      edges[0].source === 'mem_ffff00001111' || edges[0].target === 'mem_ffff00001111',
      true,
    );
    assert.equal(edges[0].id, generateEdgeId('mem_ffff00001111', entityId, 'explicit'));
    store.close();
  });
});

describe('exportCanonical', () => {
  let root: string;
  let store: SqliteStore;

  beforeEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'nacre-export-'));
    store = SqliteStore.open(':memory:');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function putLegacyMcpNode(): void {
    store.putNode({
      id: 'n-1a2b3c',
      label: 'Marcus prefers TypeScript strict mode everywhere, even in',
      aliases: [],
      type: 'concept',
      firstSeen: '2026-06-01T10:00:00Z',
      lastReinforced: '2026-06-15T10:00:00Z',
      mentionCount: 1,
      reinforcementCount: 2,
      sourceFiles: ['mcp'],
      excerpts: [
        {
          file: 'mcp',
          text: 'Marcus prefers TypeScript strict mode everywhere, even in quick prototypes.',
          date: '2026-06-01',
        },
      ],
    });
  }

  it('exports legacy MCP nodes to canonical files with minted mem_ ids', () => {
    putLegacyMcpNode();
    const result = exportCanonical(store, root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.exported.length, 1);
    assert.equal(result.renamed.length, 1);
    const [oldId, newId] = result.renamed[0];
    assert.equal(oldId, 'n-1a2b3c');
    assert.match(newId, /^mem_[0-9a-f]{12}$/);

    const relPath = result.exported[0];
    const parsed = parseMemoryFile(readFileSync(join(root, relPath), 'utf-8'), relPath);
    assert.equal(parsed.memory.id, newId);
    // Full excerpt text, not the truncated label.
    assert.match(parsed.claim, /quick prototypes/);
    assert.deepEqual(parsed.memory.sources, ['export:sqlite:n-1a2b3c']);
    assert.equal(parsed.memory.salience.reinforcementCount, 2);

    const node = store.getNode(newId);
    assert.equal(node?.status, 'promoted');
    assert.equal(node?.canonicalPath, relPath);
  });

  it('exports candidate nodes keeping their mem_ id', () => {
    store.putNode({
      id: 'mem_2233eeff0011',
      label: 'A candidate memory',
      aliases: [],
      type: 'decision',
      firstSeen: '2026-07-17T09:00:00Z',
      lastReinforced: '2026-07-17T09:00:00Z',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: ['mcp'],
      excerpts: [{ file: 'mcp', text: 'A candidate memory', date: '2026-07-17' }],
      status: 'candidate',
    });
    const result = exportCanonical(store, root);
    assert.equal(result.exported.length, 1);
    assert.equal(result.renamed.length, 0);
    const parsed = parseMemoryFile(readFileSync(join(root, result.exported[0]), 'utf-8'));
    assert.equal(parsed.memory.id, 'mem_2233eeff0011');
    assert.equal(parsed.memory.type, 'decision');
  });

  it('is idempotent and leaves ordinary entities alone', () => {
    putLegacyMcpNode();
    store.putNode({
      id: generateNodeId('TypeScript'),
      label: 'TypeScript',
      aliases: [],
      type: 'tool',
      firstSeen: '2026-06-01',
      lastReinforced: '2026-06-15',
      mentionCount: 5,
      reinforcementCount: 3,
      sourceFiles: ['notes/2026-06-01.md'],
      excerpts: [],
    });
    const first = exportCanonical(store, root);
    assert.equal(first.exported.length, 1);
    const second = exportCanonical(store, root);
    assert.equal(second.exported.length, 0);
    assert.equal(second.skipped, 1);
    // The entity node was never exported or renamed.
    assert.ok(store.findNode('TypeScript'));
    assert.equal(store.findNode('TypeScript')?.status, undefined);
  });

  it('export ids are deterministic: a retry against a fresh store converges on the same file', () => {
    putLegacyMcpNode();
    const first = exportCanonical(store, root);
    const [, firstNewId] = first.renamed[0];

    // Simulate a partial failure: the file was written, but the store's
    // rename was lost (fresh db). A retry must reuse the same derived id and
    // find the existing file instead of minting a new id + duplicate file.
    const retryStore = SqliteStore.open(':memory:');
    // Recreate the original legacy node in the retry store.
    retryStore.putNode({
      id: 'n-1a2b3c',
      label: 'Marcus prefers TypeScript strict mode everywhere, even in',
      aliases: [],
      type: 'concept',
      firstSeen: '2026-06-01T10:00:00Z',
      lastReinforced: '2026-06-15T10:00:00Z',
      mentionCount: 1,
      reinforcementCount: 2,
      sourceFiles: ['mcp'],
      excerpts: [
        {
          file: 'mcp',
          text: 'Marcus prefers TypeScript strict mode everywhere, even in quick prototypes.',
          date: '2026-06-01',
        },
      ],
    });
    const retry = exportCanonical(retryStore, root);
    assert.equal(retry.exported.length, 0, 'no duplicate file on retry');
    assert.equal(retry.skipped, 1);
    assert.deepEqual(retry.renamed, [['n-1a2b3c', firstNewId]]);
    assert.equal(retryStore.getNode(firstNewId)?.status, 'promoted');
    retryStore.close();
  });

  it('exported memories survive a rebuild from the memory dir alone', () => {
    putLegacyMcpNode();
    const { renamed } = exportCanonical(store, root);
    const [, newId] = renamed[0];

    const fresh = SqliteStore.open(':memory:');
    compileMemoryDir(fresh, root);
    const node = fresh.getNode(newId);
    assert.equal(node?.status, 'promoted');
    assert.match(node?.label ?? '', /quick prototypes|strict mode/);
    fresh.close();
  });
});
