import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  SqliteStore,
  importHistoricalConversation,
  inventoryOpenClawSessions,
  parseConversationFile,
} from '@nacre/core';
import { executeHistoricalIngest } from '../commands/ingest.js';

const fixtureDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'core',
  'src',
  '__tests__',
  'fixtures',
  'openclaw',
);

describe('ingest command historical dry-run', () => {
  let temp: string;
  before(async () => {
    temp = await mkdtemp(join(tmpdir(), 'nacre-cli-ingest-'));
  });
  after(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('emits a machine-readable inventory report without graph, memory, or evidence writes', async () => {
    const graph = join(temp, 'dry-run.db');
    const memoryRoot = join(temp, 'memory');
    const reportPath = join(temp, 'report.json');
    const report = await executeHistoricalIngest({
      source: fixtureDir,
      graph,
      memoryRoot,
      format: 'openclaw',
      recursive: true,
      agent: 'main',
      scope: 'agent',
      dryRun: true,
      reportPath,
    });

    assert.equal(report.dryRun, true);
    assert.equal(report.plannedScope, 'agent');
    assert.equal(report.selectedFiles.length, 3);
    assert.equal(report.excludedFiles.length, 2);
    assert.equal(report.countsByOrigin.quoted_context, 3);
    assert.equal(report.countsByOrigin.cron, 1);
    assert.equal(report.countsByOrigin.internal_route, 1);
    assert.deepEqual(report.timeRange, {
      start: '2026-01-15T10:00:00.000Z',
      end: '2026-01-17T07:03:00.000Z',
    });
    assert.ok(report.estimatedEvidenceBytes > 0);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), report);
    assert.equal(existsSync(graph), false);
    assert.equal(existsSync(memoryRoot), false);
  });

  it('supports one OpenClaw file and gives --resume observable completed-import semantics', async () => {
    const source = join(fixtureDir, 'direct-session.jsonl');
    const graph = join(temp, 'single-file.db');
    const memoryRoot = join(temp, 'single-file-memory');
    const first = await executeHistoricalIngest({
      source,
      graph,
      memoryRoot,
      format: 'openclaw',
      recursive: false,
      scope: 'agent',
      dryRun: false,
    });
    assert.equal(first.selectedFiles.length, 1);
    assert.equal(first.imports[0].status, 'complete');

    const resumed = await executeHistoricalIngest({
      source,
      graph,
      memoryRoot,
      format: 'openclaw',
      recursive: false,
      resume: true,
      scope: 'agent',
      dryRun: false,
    });
    assert.equal(resumed.imports[0].status, 'skipped');
    assert.equal(resumed.imports[0].episodesCreated, 0);
  });

  it('requires --resume for failed and running imports using normalized import identity', async () => {
    const source = join(fixtureDir, 'direct-session.jsonl');
    const graph = join(temp, 'resume-required.db');
    const memoryRoot = join(temp, 'resume-required-memory');
    const selected = inventoryOpenClawSessions(source).sessions[0].selected;
    const input = parseConversationFile(selected.content, 'openclaw', {
      source: `openclaw:${selected.digest.slice(0, 16)}`,
      sourceDigest: selected.digest,
      agentId: undefined,
    });
    const seedStore = SqliteStore.open(graph);
    await assert.rejects(
      importHistoricalConversation(input, {
        store: seedStore,
        memoryRoot,
        scope: 'agent',
        extractEntities: () => {
          throw new Error('synthetic failed import');
        },
      }),
      /synthetic failed import/,
    );
    seedStore.close();

    const options = {
      source,
      graph,
      memoryRoot,
      format: 'openclaw' as const,
      recursive: false,
      scope: 'agent',
      dryRun: false,
    };
    await assert.rejects(executeHistoricalIngest(options), /failed.*--resume/i);

    const runningStore = SqliteStore.open(graph);
    const failed = runningStore.listImports()[0];
    runningStore.putImport({ ...failed, status: 'running' });
    runningStore.close();
    await assert.rejects(executeHistoricalIngest(options), /running.*--resume/i);

    const resumed = await executeHistoricalIngest({ ...options, resume: true });
    assert.equal(resumed.imports[0].status, 'complete');
  });
});
