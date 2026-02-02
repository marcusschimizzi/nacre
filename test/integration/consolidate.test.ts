import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { consolidate } from '@nacre/parser';
import type { NacreGraph } from '@nacre/core';

const OUT_DIR = resolve(import.meta.dirname, '..', '..', 'tmp-integration-test');
const FIXTURES_DIR = resolve(import.meta.dirname, '..', 'fixtures');

describe('consolidation pipeline (integration)', () => {
  before(() => {
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
    mkdirSync(OUT_DIR, { recursive: true });
  });

  after(() => {
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
  });

  it('produces 50+ nodes from test fixtures', async () => {
    const result = await consolidate({
      inputs: [FIXTURES_DIR],
      outDir: OUT_DIR,
    });

    assert.ok(
      Object.keys(result.graph.nodes).length >= 50,
      `expected 50+ nodes, got ${Object.keys(result.graph.nodes).length}`,
    );
  });

  it('produces 100+ edges from test fixtures', async () => {
    const graphPath = resolve(OUT_DIR, 'graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;

    assert.ok(
      Object.keys(graph.edges).length >= 100,
      `expected 100+ edges, got ${Object.keys(graph.edges).length}`,
    );
  });

  it('has all 4 edge types', async () => {
    const graphPath = resolve(OUT_DIR, 'graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;
    const edgeTypes = new Set(Object.values(graph.edges).map((e) => e.type));

    assert.ok(edgeTypes.has('explicit'), 'missing explicit edges');
    assert.ok(edgeTypes.has('co-occurrence'), 'missing co-occurrence edges');
    assert.ok(edgeTypes.has('temporal'), 'missing temporal edges');
    assert.ok(edgeTypes.has('causal'), 'missing causal edges');
  });

  it('has diverse entity types', async () => {
    const graphPath = resolve(OUT_DIR, 'graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;
    const nodeTypes = new Set(Object.values(graph.nodes).map((n) => n.type));

    assert.ok(nodeTypes.has('person'), 'missing person nodes');
    assert.ok(nodeTypes.has('tool'), 'missing tool nodes');
    assert.ok(nodeTypes.has('concept'), 'missing concept nodes');
    assert.ok(nodeTypes.size >= 4, `expected 4+ entity types, got ${nodeTypes.size}`);
  });

  it('deduplicates Marcus variants to single node', async () => {
    const graphPath = resolve(OUT_DIR, 'graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;
    const marcusNodes = Object.values(graph.nodes).filter(
      (n) => n.label.includes('marcus') && n.type === 'person',
    );

    assert.equal(marcusNodes.length, 1, `expected 1 marcus node, got ${marcusNodes.length}`);
    assert.ok(
      marcusNodes[0].mentionCount >= 10,
      `marcus should have 10+ mentions, got ${marcusNodes[0].mentionCount}`,
    );
  });

  it('applies decay to edges', async () => {
    const graphPath = resolve(OUT_DIR, 'graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;
    const edges = Object.values(graph.edges);

    const decayed = edges.filter((e) => e.weight < e.baseWeight);
    assert.ok(
      decayed.length > 0,
      'some edges should have decayed weight < baseWeight',
    );
  });

  it('records processed files', async () => {
    const graphPath = resolve(OUT_DIR, 'graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;

    assert.ok(
      graph.processedFiles.length >= 14,
      `expected 14+ processed files, got ${graph.processedFiles.length}`,
    );

    for (const pf of graph.processedFiles) {
      assert.ok(
        !pf.path.startsWith('/'),
        `processedFiles should use relative paths, got absolute: ${pf.path}`,
      );
    }
  });

  it('persists graph.json and pending-edges.json', async () => {
    assert.ok(existsSync(resolve(OUT_DIR, 'graph.json')), 'graph.json should exist');
    assert.ok(existsSync(resolve(OUT_DIR, 'pending-edges.json')), 'pending-edges.json should exist');
  });

  it('generates 16-char hex node IDs', async () => {
    const graphPath = resolve(OUT_DIR, 'graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;

    for (const id of Object.keys(graph.nodes)) {
      assert.equal(id.length, 16, `node ID should be 16 hex chars, got ${id.length}: ${id}`);
      assert.match(id, /^[0-9a-f]{16}$/, `node ID should be hex: ${id}`);
    }
  });

  it('incremental run produces 0 new nodes', async () => {
    const result = await consolidate({
      inputs: [FIXTURES_DIR],
      outDir: OUT_DIR,
    });

    assert.equal(
      result.newNodes,
      0,
      `incremental run should have 0 new nodes, got ${result.newNodes}`,
    );
  });
});
