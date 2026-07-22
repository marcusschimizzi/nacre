import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SqliteStore } from '@nacre/core';
import { executeHistoricalIngest } from '../commands/ingest.js';
import { rebuildHistoricalWithDefaultExtractor } from '../commands/rebuild.js';

describe('rebuild command historical evidence replay', () => {
  let temp: string;
  before(async () => {
    temp = await mkdtemp(join(tmpdir(), 'nacre-cli-rebuild-'));
  });
  after(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('replays durable historical evidence with the real conversation extractor', async () => {
    const memoryRoot = join(temp, 'memory');
    const originalGraph = join(temp, 'original.db');
    const source = join(temp, 'extractable.jsonl');
    await writeFile(
      source,
      `${JSON.stringify({ type: 'session', id: 'rebuild-extractable' })}\n${JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'We chose TypeScript for this project.' } })}\n`,
    );
    await executeHistoricalIngest({
      source,
      graph: originalGraph,
      memoryRoot,
      format: 'openclaw',
      scope: 'agent',
      dryRun: false,
    });

    const original = SqliteStore.open(originalGraph);
    const rebuilt = SqliteStore.open(join(temp, 'rebuilt.db'));
    try {
      const replay = await rebuildHistoricalWithDefaultExtractor(rebuilt, memoryRoot);
      assert.equal(replay.importsCompleted, 1);
      assert.deepEqual(rebuilt.listEpisodes(), original.listEpisodes());
      assert.deepEqual(rebuilt.listNodes(), original.listNodes());
      assert.ok(rebuilt.listNodes().length > 0);
    } finally {
      rebuilt.close();
      original.close();
    }
  });
});
