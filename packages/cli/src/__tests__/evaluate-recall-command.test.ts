import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  MockEmbedder,
  serializeMemoryFile,
  SqliteStore,
  type MemoryNode,
  type MemoryObject,
} from '@nacre/core';

const AT = '2099-01-01T00:00:00.000Z';
const RELEVANT = 'mem_aaaaaaaaaaaa';
const DISTRACTOR = 'mem_bbbbbbbbbbbb';

interface Fixture {
  root: string;
  graph: string;
  memoryDir: string;
  manifest: string;
}

function memory(id: string, body: string, sensitivity: 'low' | 'sensitive'): MemoryObject {
  return {
    id,
    type: 'decision',
    scope: 'user',
    confidence: 0.95,
    sensitivity,
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    lifecycle: 'active',
    validFrom: '2026-07-01T00:00:00.000Z',
    sources: [`synthetic:${id}`],
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T00:00:00.000Z',
    salience: { reinforcementCount: 0 },
    body,
  };
}

async function seedFixture(prefix: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const graph = join(root, 'graph.db');
  const memoryDir = join(root, 'memory');
  const manifest = join(root, 'recall-manifest.json');
  mkdirSync(join(memoryDir, 'user', 'decisions'), { recursive: true });
  const memories = [
    memory(RELEVANT, 'Use the current deterministic preference.', 'low'),
    memory(DISTRACTOR, 'Unrelated sensitive distractor.', 'sensitive'),
  ];
  for (const item of memories) {
    writeFileSync(join(memoryDir, 'user', 'decisions', `${item.id}.md`), serializeMemoryFile(item));
  }

  const provider = new MockEmbedder();
  const store = SqliteStore.open(graph);
  for (const item of memories) {
    const label =
      item.id === RELEVANT ? 'current deterministic preference' : 'unrelated distractor';
    const node: MemoryNode = {
      id: item.id,
      label,
      aliases: [],
      type: 'decision',
      firstSeen: '2026-07-01',
      lastReinforced: '2026-07-01',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
      status: 'promoted',
      canonicalPath: `user/decisions/${item.id}.md`,
      scope: 'user',
      beliefLifecycle: 'active',
      validFrom: item.validFrom,
    };
    store.putNode(node);
    store.putEmbedding(item.id, 'node', label, await provider.embed(label), provider.name);
  }
  store.createSnapshot('manual');
  store.close();

  writeFileSync(
    manifest,
    `${JSON.stringify({
      version: 'nacre.recall-replay-manifest.v1',
      id: 'synthetic-explicit-recall',
      encoderFingerprint: 'mock:64',
      thresholds: { minRetrievalPrecisionAtK: 0.5 },
      probes: [
        {
          id: 'current-preference',
          query: 'current deterministic preference',
          evaluatedAt: AT,
          limit: 2,
          scopes: ['user'],
          expectedRelevantMemoryIds: [RELEVANT],
          forbiddenRetrievalMemoryIds: [],
          forbiddenAdmissionMemoryIds: [DISTRACTOR],
        },
      ],
    })}\n`,
  );
  return { root, graph, memoryDir, manifest };
}

function snapshot(root: string): Array<{
  path: string;
  type: 'directory' | 'file';
  bytes: string;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  ctime: number;
  birthtime: number;
}> {
  const entries: ReturnType<typeof snapshot> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      entries.push({
        path: rel,
        type: stat.isDirectory() ? 'directory' : 'file',
        bytes: stat.isFile() ? readFileSync(path).toString('base64') : '',
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        birthtime: stat.birthtimeMs,
      });
      if (stat.isDirectory()) visit(path);
    }
  };
  visit(root);
  return entries;
}

describe('built explicit-recall replay evaluation CLI', () => {
  const bin = join(import.meta.dirname, '../../dist/index.js');
  const run = (fixture: Fixture, format = 'json', extra: string[] = [], provider = 'mock') =>
    spawnSync(
      process.execPath,
      [
        bin,
        'evaluate',
        'recall',
        fixture.manifest,
        '--graph',
        fixture.graph,
        '--memory-dir',
        fixture.memoryDir,
        '--provider',
        provider,
        '--format',
        format,
        ...extra,
      ],
      { encoding: 'utf8', env: { ...process.env, NACRE_EMBEDDING_PROVIDER: '' } },
    );

  it('executes actual recall read-only and emits byte-identical raw/admission reports across fresh roots', async () => {
    const first = await seedFixture('nacre-recall-eval-a-');
    const second = await seedFixture('nacre-recall-eval-b-');
    try {
      const changedLiveStore = SqliteStore.open(second.graph);
      const changedLiveProvider = new MockEmbedder(64);
      changedLiveStore.putEmbedding(
        RELEVANT,
        'node',
        'unrelated live replacement',
        await changedLiveProvider.embed('unrelated live replacement'),
        changedLiveProvider.name,
        '2098-01-01T00:00:00.000Z',
      );
      changedLiveStore.putEmbedding(
        DISTRACTOR,
        'node',
        'current deterministic preference',
        await changedLiveProvider.embed('current deterministic preference'),
        changedLiveProvider.name,
        '2098-01-01T00:00:00.000Z',
      );
      changedLiveStore.setMeta(
        'config',
        JSON.stringify({ ...DEFAULT_CONFIG, visibilityThreshold: 0.99 }),
      );
      changedLiveStore.close();
      const firstBefore = snapshot(first.root);
      const secondBefore = snapshot(second.root);
      const one = run(first);
      const two = run(second);
      assert.equal(one.status, 0, one.stderr);
      assert.equal(two.status, 0, two.stderr);
      assert.equal(one.stderr, '');
      assert.equal(two.stderr, '');
      assert.equal(one.stdout, two.stdout);
      const report = JSON.parse(one.stdout);
      assert.equal(report.passed, true);
      assert.equal(report.stageCoverage.retrieval, true);
      assert.deepEqual(report.probes[0].rawRetrievalIds.slice(0, 1), [RELEVANT]);
      assert.deepEqual(
        report.probes[0].rawRetrieval.map((result: { nodeId: string }) => result.nodeId),
        report.probes[0].rawRetrievalIds,
      );
      assert.ok(
        report.probes[0].rawRetrieval.every((result: { score: number }) =>
          Number.isFinite(result.score),
        ),
      );
      assert.deepEqual(
        report.probes[0].canonicalCandidateIds,
        report.probes[0].rawRetrieval.flatMap((result: { canonicalMemoryId: string | null }) =>
          result.canonicalMemoryId === null ? [] : [result.canonicalMemoryId],
        ),
      );
      assert.deepEqual(report.probes[0].admittedIds, [RELEVANT]);
      assert.deepEqual(snapshot(first.root), firstBefore);
      assert.deepEqual(snapshot(second.root), secondBefore);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  });

  it('keeps raw retrieval independent from post-snapshot canonical claim edits', async () => {
    const fixture = await seedFixture('nacre-recall-eval-canonical-edit-');
    try {
      const before = run(fixture);
      assert.equal(before.status, 0, before.stderr);
      writeFileSync(
        join(fixture.memoryDir, 'user', 'decisions', `${RELEVANT}.md`),
        serializeMemoryFile(memory(RELEVANT, 'Completely changed canonical wording here.', 'low')),
      );
      const after = run(fixture);
      assert.equal(after.status, 0, after.stderr);
      assert.deepEqual(
        JSON.parse(after.stdout).probes[0].rawRetrieval,
        JSON.parse(before.stdout).probes[0].rawRetrieval,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('prints the complete JSON report and exits nonzero for a quality-gate failure', async () => {
    const fixture = await seedFixture('nacre-recall-eval-fail-');
    try {
      const parsed = JSON.parse(readFileSync(fixture.manifest, 'utf8'));
      parsed.probes[0].expectedRelevantMemoryIds = [DISTRACTOR];
      parsed.probes[0].forbiddenAdmissionMemoryIds = [];
      writeFileSync(fixture.manifest, `${JSON.stringify(parsed)}\n`);
      const before = snapshot(fixture.root);
      const result = run(fixture);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, '');
      const report = JSON.parse(result.stdout);
      assert.equal(report.passed, false);
      assert.ok(report.probes[0].gateViolations.length > 0);
      assert.deepEqual(report.probes[0].rawRetrievalIds.slice(0, 1), [RELEVANT]);
      assert.deepEqual(snapshot(fixture.root), before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed with empty stdout for malformed or temporally ungrounded probes', async () => {
    const fixture = await seedFixture('nacre-recall-eval-invalid-');
    try {
      const parsed = JSON.parse(readFileSync(fixture.manifest, 'utf8'));
      const extraPosition = run(fixture, 'json', ['unexpected-position']);
      assert.notEqual(extraPosition.status, 0);
      assert.equal(extraPosition.stdout, '');
      assert.match(extraPosition.stderr, /unexpected positional/i);
      parsed.probes[0].expectedRelevantMemoryIds = [];
      writeFileSync(fixture.manifest, `${JSON.stringify(parsed)}\n`);
      const before = snapshot(fixture.root);
      const malformed = run(fixture);
      assert.notEqual(malformed.status, 0);
      assert.equal(malformed.stdout, '');

      const unknownOption = run(fixture, 'json', ['--definitely-unknown', 'value']);
      assert.notEqual(unknownOption.status, 0);
      assert.equal(unknownOption.stdout, '');
      assert.match(unknownOption.stderr, /unknown option/i);
      assert.deepEqual(snapshot(fixture.root), before);

      const ungrounded = await seedFixture('nacre-recall-eval-no-snapshot-');
      try {
        const noSnapshotStore = SqliteStore.open(ungrounded.graph);
        noSnapshotStore.close();
        const manifest = JSON.parse(readFileSync(ungrounded.manifest, 'utf8'));
        manifest.probes[0].evaluatedAt = '2000-01-01T00:00:00.000Z';
        writeFileSync(ungrounded.manifest, `${JSON.stringify(manifest)}\n`);
        const missingSnapshot = run(ungrounded);
        assert.notEqual(missingSnapshot.status, 0);
        assert.equal(missingSnapshot.stdout, '');
        assert.match(missingSnapshot.stderr, /snapshot/i);
      } finally {
        rmSync(ungrounded.root, { recursive: true, force: true });
      }

      const ambiguous = await seedFixture('nacre-recall-eval-ambiguous-snapshot-');
      try {
        const ambiguousStore = SqliteStore.open(ambiguous.graph);
        ambiguousStore.createSnapshot('manual', undefined, '2098-01-01T00:00:00.000Z');
        ambiguousStore.createSnapshot('manual', undefined, '2098-01-01T00:00:00.000Z');
        ambiguousStore.close();
        const ambiguousSnapshot = run(ambiguous);
        assert.notEqual(ambiguousSnapshot.status, 0);
        assert.equal(ambiguousSnapshot.stdout, '');
        assert.match(ambiguousSnapshot.stderr, /ambiguous snapshots/i);
      } finally {
        rmSync(ambiguous.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('supports concise text output and rejects encoder drift before recall', async () => {
    const fixture = await seedFixture('nacre-recall-eval-text-');
    try {
      const text = run(fixture, 'text');
      assert.equal(text.status, 0, text.stderr);
      assert.match(
        text.stdout,
        /^PASS 1\/1 recall probes; 0 retrieval leaks; 0 admission leaks\n$/,
      );

      const parsed = JSON.parse(readFileSync(fixture.manifest, 'utf8'));
      parsed.encoderFingerprint = 'mock:32';
      writeFileSync(fixture.manifest, `${JSON.stringify(parsed)}\n`);
      const mismatch = run(fixture);
      assert.notEqual(mismatch.status, 0);
      assert.equal(mismatch.stdout, '');
      assert.match(mismatch.stderr, /fingerprint mismatch/i);

      parsed.encoderFingerprint = 'mock:64';
      writeFileSync(fixture.manifest, `${JSON.stringify(parsed)}\n`);
      const nondeterministicProvider = run(fixture, 'json', [], 'onnx');
      assert.notEqual(nondeterministicProvider.status, 0);
      assert.equal(nondeterministicProvider.stdout, '');
      assert.match(nondeterministicProvider.stderr, /requires the mock provider/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects an oversized graph before SQLite opens it', async () => {
    const fixture = await seedFixture('nacre-recall-eval-oversized-');
    try {
      truncateSync(fixture.graph, 512 * 1024 * 1024 + 1);
      const result = run(fixture);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /exceeds 536870912 bytes/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects rollback journals and incoherent graph-to-canonical mappings', async () => {
    const journalFixture = await seedFixture('nacre-recall-eval-journal-');
    const mappingFixture = await seedFixture('nacre-recall-eval-mapping-');
    try {
      writeFileSync(`${journalFixture.graph}-journal`, 'active rollback journal');
      const journalRun = run(journalFixture);
      assert.equal(journalRun.status, 1);
      assert.match(journalRun.stderr, /without SQLite sidecars/);

      const store = SqliteStore.open(mappingFixture.graph);
      const node = store.getNode(RELEVANT);
      assert.ok(node);
      store.putNode({ ...node, canonicalPath: `user/decisions/${DISTRACTOR}.md` });
      store.createSnapshot('manual', undefined, '2098-01-01T00:00:00.000Z');
      store.close();
      const mappingRun = run(mappingFixture);
      assert.equal(mappingRun.status, 1);
      assert.match(mappingRun.stderr, /incoherent canonical mapping/);
    } finally {
      rmSync(journalFixture.root, { recursive: true, force: true });
      rmSync(mappingFixture.root, { recursive: true, force: true });
    }
  });

  it('rejects future-dated events embedded in an eligible snapshot', async () => {
    const fixture = await seedFixture('nacre-recall-eval-future-graph-');
    try {
      const store = SqliteStore.open(fixture.graph);
      const node = store.getNode(RELEVANT);
      assert.ok(node);
      store.putNode({ ...node, lastReinforced: '2100-01-01T00:00:00.000Z' });
      store.createSnapshot('manual', undefined, '2098-01-01T00:00:00.000Z');
      store.close();
      const result = run(fixture);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /later than evaluatedAt/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
