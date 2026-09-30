import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, SqliteStore, type MemoryNode, type NacreGraph } from '@nacre/core';
import { exportVizGraph } from '../commands/viz.js';

function fixture(): NacreGraph {
  const nodes: Record<string, MemoryNode> = {};
  for (const [id, scope, status] of [
    ['entity', undefined, undefined],
    ['user', 'user', 'promoted'],
    ['agent', 'agent', 'candidate'],
    ['project', 'project/nacre', 'promoted'],
    ['legacy', undefined, 'candidate'],
    ['session', 'session', undefined],
    ['unknown', 'future-scratch', undefined],
  ] as const) {
    nodes[id] = {
      id,
      label: `${id} memory`,
      type: 'concept',
      aliases: [],
      firstSeen: '2026-07-20T00:00:00.000Z',
      lastReinforced: '2026-07-20T00:00:00.000Z',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
      ...(scope ? { scope } : {}),
      ...(status ? { status } : {}),
    };
  }
  const edges: NacreGraph['edges'] = {};
  for (const [source, target] of [
    ['entity', 'user'],
    ['agent', 'entity'],
    ['entity', 'project'],
    ['legacy', 'entity'],
    ['entity', 'session'],
    ['unknown', 'entity'],
    ['session', 'unknown'],
  ]) {
    const id = `${source}-${target}`;
    edges[id] = {
      id,
      source,
      target,
      type: 'explicit',
      directed: false,
      weight: 0.8,
      baseWeight: 0.8,
      reinforcementCount: 0,
      firstFormed: '2026-07-20T00:00:00.000Z',
      lastReinforced: '2026-07-20T00:00:00.000Z',
      stability: 1,
      evidence: [],
    };
  }
  return {
    version: 2,
    lastConsolidated: '2026-07-20T00:00:00.000Z',
    processedFiles: [],
    nodes,
    edges,
    config: DEFAULT_CONFIG,
  };
}

function assertDurableExport(path: string): void {
  const graph = JSON.parse(readFileSync(path, 'utf8')) as NacreGraph;
  assert.deepEqual(Object.keys(graph.nodes).sort(), [
    'agent',
    'entity',
    'legacy',
    'project',
    'user',
  ]);
  assert.deepEqual(Object.keys(graph.edges).sort(), [
    'agent-entity',
    'entity-project',
    'entity-user',
    'legacy-entity',
  ]);
  assert.deepEqual(graph.config, DEFAULT_CONFIG);
  assert.equal(graph.version, 2);
  for (const edge of Object.values(graph.edges)) {
    assert.ok(graph.nodes[edge.source]);
    assert.ok(graph.nodes[edge.target]);
  }
}

describe('viz scope isolation', () => {
  for (const format of ['json', 'sqlite'] as const) {
    for (const extensionless of [false, true]) {
      it(`filters ${format}${extensionless ? ' extensionless' : ''} graph exports`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'nacre-viz-scope-'));
        try {
          const extension = format === 'json' ? '.json' : '.db';
          const base = join(root, 'source');
          const source = `${base}${extension}`;
          const dest = join(root, 'export.json');
          if (format === 'json') {
            writeFileSync(source, JSON.stringify(fixture()));
          } else {
            const store = SqliteStore.open(source);
            try {
              store.importGraph(fixture());
            } finally {
              store.close();
            }
          }
          const original = readFileSync(source);
          await exportVizGraph(extensionless ? base : source, dest);
          assertDurableExport(dest);
          if (format === 'json') {
            assert.deepEqual(readFileSync(source), original, 'source JSON is unchanged');
          } else {
            const store = SqliteStore.open(source);
            try {
              assert.ok(store.getNode('session'), 'export leaves scratch in the source store');
              assert.ok(store.getNode('unknown'));
              assert.equal(store.nodeCount(), 7);
              assert.equal(store.edgeCount(), 7);
            } finally {
              store.close();
            }
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  for (const trailingSlash of [false, true]) {
    it(`filters a directory input${trailingSlash ? ' with a trailing slash' : ''}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'nacre-viz-scope-'));
      try {
        const sourceDir = join(root, 'source');
        mkdirSync(sourceDir);
        const source = join(sourceDir, 'graph.json');
        const dest = join(root, 'export.json');
        const original = JSON.stringify(fixture());
        writeFileSync(source, original);
        await exportVizGraph(`${sourceDir}${trailingSlash ? '/' : ''}`, dest);
        assertDurableExport(dest);
        assert.equal(readFileSync(source, 'utf8'), original);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('filters JSON already at the viz destination instead of skipping the export', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-viz-scope-'));
    try {
      const dest = join(root, 'graph.json');
      writeFileSync(dest, JSON.stringify(fixture()));
      await exportVizGraph(dest, dest);
      assertDurableExport(dest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
