import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../store.js';
import { getHiveOriginFactor, consolidateHive } from '../hive.js';
import type { MemoryNode } from '../types.js';

function makeNode(overrides: Partial<MemoryNode> & { id: string; label: string }): MemoryNode {
  return {
    type: 'concept',
    aliases: [],
    firstSeen: '2026-01-01',
    lastReinforced: '2026-01-15',
    mentionCount: 3,
    reinforcementCount: 1,
    sourceFiles: ['test.md'],
    excerpts: [{ file: 'test.md', text: `About ${overrides.label}`, date: '2026-01-15' }],
    ...overrides,
  };
}

describe('getHiveOriginFactor', () => {
  it('returns 0.9 for 0 nodes', () => {
    assert.strictEqual(getHiveOriginFactor(0, 0.6), 0.9);
  });

  it('returns 0.9 for 49 nodes', () => {
    assert.strictEqual(getHiveOriginFactor(49, 0.6), 0.9);
  });

  it('returns 0.75 for 50 nodes', () => {
    assert.strictEqual(getHiveOriginFactor(50, 0.6), 0.75);
  });

  it('returns 0.75 for 99 nodes', () => {
    assert.strictEqual(getHiveOriginFactor(99, 0.6), 0.75);
  });

  it('returns configured factor for 100 nodes', () => {
    assert.strictEqual(getHiveOriginFactor(100, 0.6), 0.6);
  });

  it('returns configured factor for 500 nodes', () => {
    assert.strictEqual(getHiveOriginFactor(500, 0.5), 0.5);
  });
});

describe('consolidateHive', () => {
  const testDir = join(tmpdir(), `nacre-hive-test-${randomUUID().slice(0, 8)}`);
  const agent1Path = join(testDir, 'agent1.db');
  const agent2Path = join(testDir, 'agent2.db');
  const hivePath = join(testDir, 'hive.db');

  before(() => {
    mkdirSync(testDir, { recursive: true });

    // Create agent 1 graph
    const store1 = SqliteStore.open(agent1Path);
    store1.putNode(
      makeNode({
        id: 'shared-id-001',
        label: 'Nacre',
        mentionCount: 5,
        reinforcementCount: 2,
      }),
    );
    store1.putNode(makeNode({ id: 'agent1-only', label: 'Agent1Concept', mentionCount: 2 }));
    store1.putNode(
      makeNode({
        id: 'excluded-node',
        label: 'Secret',
        hiveExclude: true,
      }),
    );
    store1.close();

    // Create agent 2 graph
    const store2 = SqliteStore.open(agent2Path);
    store2.putNode(
      makeNode({
        id: 'shared-id-001',
        label: 'Nacre',
        mentionCount: 3,
        reinforcementCount: 1,
        lastReinforced: '2026-02-01',
        sourceFiles: ['other.md'],
        excerpts: [{ file: 'other.md', text: 'Nacre in agent2', date: '2026-02-01' }],
      }),
    );
    store2.putNode(makeNode({ id: 'agent2-only', label: 'Agent2Concept', mentionCount: 4 }));
    store2.close();
  });

  after(() => {
    // Clean up test files
    for (const p of [agent1Path, agent2Path, hivePath]) {
      if (existsSync(p)) unlinkSync(p);
      // WAL/SHM files
      if (existsSync(p + '-wal')) unlinkSync(p + '-wal');
      if (existsSync(p + '-shm')) unlinkSync(p + '-shm');
    }
  });

  it('merges two agent graphs', async () => {
    const hive = await consolidateHive({
      agents: [
        { name: 'agent1', graphPath: agent1Path },
        { name: 'agent2', graphPath: agent2Path },
      ],
      outPath: hivePath,
      originFactor: 0.6,
    });

    assert.deepStrictEqual(hive.agents, ['agent1', 'agent2']);
    // shared-id-001, agent1-only, agent2-only (excluded-node filtered)
    assert.strictEqual(Object.keys(hive.nodes).length, 3);
  });

  it('tracks provenance for merged nodes', async () => {
    const hive = await consolidateHive({
      agents: [
        { name: 'agent1', graphPath: agent1Path },
        { name: 'agent2', graphPath: agent2Path },
      ],
      outPath: hivePath,
      originFactor: 0.6,
    });

    const shared = hive.nodes['shared-id-001'];
    assert.ok(shared, 'shared node should exist');
    assert.deepStrictEqual(shared.provenance.sourceAgents.sort(), ['agent1', 'agent2']);
    assert.strictEqual(shared.provenance.endorsements, 2);
  });

  it('filters hiveExclude nodes', async () => {
    const hive = await consolidateHive({
      agents: [
        { name: 'agent1', graphPath: agent1Path },
        { name: 'agent2', graphPath: agent2Path },
      ],
      outPath: hivePath,
      originFactor: 0.6,
    });

    assert.strictEqual(hive.nodes['excluded-node'], undefined);
  });

  it('applies originFactor to hiveWeight', async () => {
    const hive = await consolidateHive({
      agents: [
        { name: 'agent1', graphPath: agent1Path },
        { name: 'agent2', graphPath: agent2Path },
      ],
      outPath: hivePath,
      originFactor: 0.6,
    });

    const shared = hive.nodes['shared-id-001'];
    assert.ok(shared);
    // mentionCount = 5+3=8, reinforcementCount = 2+1=3, total=11, * 0.6 = 6.6
    assert.strictEqual(shared.hiveWeight, (8 + 3) * 0.6);
    assert.strictEqual(shared.originFactor, 0.6);
  });

  it('merges sourceFiles and excerpts from both agents', async () => {
    const hive = await consolidateHive({
      agents: [
        { name: 'agent1', graphPath: agent1Path },
        { name: 'agent2', graphPath: agent2Path },
      ],
      outPath: hivePath,
      originFactor: 0.6,
    });

    const shared = hive.nodes['shared-id-001'];
    assert.ok(shared);
    assert.ok(shared.sourceFiles.includes('test.md'));
    assert.ok(shared.sourceFiles.includes('other.md'));
    assert.ok(shared.excerpts.length >= 2);
  });

  it('takes latest lastReinforced', async () => {
    const hive = await consolidateHive({
      agents: [
        { name: 'agent1', graphPath: agent1Path },
        { name: 'agent2', graphPath: agent2Path },
      ],
      outPath: hivePath,
      originFactor: 0.6,
    });

    const shared = hive.nodes['shared-id-001'];
    assert.ok(shared);
    assert.strictEqual(shared.lastReinforced, '2026-02-01');
  });

  it('writes hive metadata to the output store', async () => {
    await consolidateHive({
      agents: [
        { name: 'agent1', graphPath: agent1Path },
        { name: 'agent2', graphPath: agent2Path },
      ],
      outPath: hivePath,
      originFactor: 0.6,
    });

    const store = SqliteStore.open(hivePath);
    try {
      const agents = JSON.parse(store.getMeta('hive_agents')!);
      assert.deepStrictEqual(agents, ['agent1', 'agent2']);
      assert.strictEqual(store.getMeta('hive_origin_factor'), '0.6');
    } finally {
      store.close();
    }
  });
});
