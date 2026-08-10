import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { serializeMemoryFile, type MemoryObject } from '@nacre/core';

const AT = '2026-07-23T12:00:00.000Z';

function seed(memoryDir: string): string {
  const memory: MemoryObject = {
    id: 'mem_aaaaaaaaaaaa',
    type: 'decision',
    scope: 'user',
    confidence: 0.9,
    sensitivity: 'low',
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    lifecycle: 'active',
    validFrom: '2026-07-01T00:00:00.000Z',
    sources: ['synthetic:replay-cli'],
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T00:00:00.000Z',
    salience: { reinforcementCount: 0 },
    body: 'Use deterministic replay evaluation.',
  };
  const dir = join(memoryDir, 'user', 'decisions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'replay.md');
  writeFileSync(path, serializeMemoryFile(memory));
  return path;
}

interface TreeSnapshotEntry {
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'special';
  mode: string;
  mtimeNs: string;
  ctimeNs: string;
  birthtimeNs: string;
  uid: string;
  gid: string;
  size: string;
  bytes?: string;
}

function snapshotTree(root: string, relative = ''): TreeSnapshotEntry[] {
  const current = join(root, relative);
  const currentStat = lstatSync(current, { bigint: true });
  const type = currentStat.isDirectory()
    ? 'directory'
    : currentStat.isFile()
      ? 'file'
      : currentStat.isSymbolicLink()
        ? 'symlink'
        : 'special';
  const rows: TreeSnapshotEntry[] = [
    {
      path: relative || '.',
      type,
      mode: currentStat.mode.toString(),
      mtimeNs: currentStat.mtimeNs.toString(),
      ctimeNs: currentStat.ctimeNs.toString(),
      birthtimeNs: currentStat.birthtimeNs.toString(),
      uid: currentStat.uid.toString(),
      gid: currentStat.gid.toString(),
      size: currentStat.size.toString(),
      ...(type === 'file' ? { bytes: readFileSync(current).toString('base64') } : {}),
    },
  ];
  if (type !== 'directory') return rows;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...snapshotTree(root, child));
    else rows.push(...snapshotTree(root, child));
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

describe('built replay evaluation command', () => {
  const bin = join(import.meta.dirname, '../../dist/index.js');

  it('evaluates a manifest against canonical memory without mutating it', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-replay-cli-'));
    const memoryDir = join(root, 'memories');
    seed(memoryDir);
    const manifestPath = join(root, 'corpus.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 'nacre.replay-manifest.v1',
        id: 'synthetic-cli-corpus',
        probes: [
          {
            id: 'current-brief',
            evaluatedAt: AT,
            expectedRelevantMemoryIds: ['mem_aaaaaaaaaaaa'],
            forbiddenMemoryIds: [],
          },
        ],
      }),
    );
    const before = snapshotTree(memoryDir);

    const run = (manifest = manifestPath, memories = memoryDir) =>
      spawnSync(
        process.execPath,
        [bin, 'evaluate', 'replay', manifest, '--memory-dir', memories, '--format', 'json'],
        { encoding: 'utf8' },
      );
    const first = run();
    const second = run();

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    const report = JSON.parse(first.stdout);
    assert.equal(report.version, 'nacre.replay-evaluation.v1');
    assert.equal(report.corpusId, 'synthetic-cli-corpus');
    assert.match(report.reportId, /^replay_[a-f0-9]{64}$/);
    assert.equal(report.passed, true);
    assert.equal(report.probes[0].metrics.contextTokens > 0, true);
    assert.deepEqual(snapshotTree(memoryDir), before);

    const freshRoot = mkdtempSync(join(tmpdir(), 'nacre-replay-cli-fresh-'));
    const freshMemoryDir = join(freshRoot, 'memories');
    seed(freshMemoryDir);
    const freshManifestPath = join(freshRoot, 'corpus.json');
    writeFileSync(freshManifestPath, readFileSync(manifestPath));
    const fresh = run(freshManifestPath, freshMemoryDir);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout, first.stdout);
    const text = spawnSync(
      process.execPath,
      [bin, 'evaluate', 'replay', manifestPath, '--memory-dir', memoryDir],
      { encoding: 'utf8' },
    );
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^PASS 1\/1 probes; 0 forbidden leaks; \d+ context tokens\n$/);
    assert.deepEqual(snapshotTree(memoryDir), before);
    rmSync(freshRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects malformed manifests and canonical memory without writing to the memory tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-replay-cli-invalid-'));
    const memoryDir = join(root, 'memories');
    const memoryPath = seed(memoryDir);
    const manifestPath = join(root, 'corpus.json');
    const validProbe = {
      id: 'valid-probe',
      evaluatedAt: AT,
      expectedRelevantMemoryIds: ['mem_aaaaaaaaaaaa'],
      forbiddenMemoryIds: [],
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'unknown threshold',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'invalid-threshold',
          thresholds: { typoThreshold: 0 },
          probes: [validProbe],
        },
      ],
      [
        'null thresholds',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'null-thresholds',
          thresholds: null,
          probes: [validProbe],
        },
      ],
      [
        'null policy',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'null-policy',
          probes: [{ ...validProbe, policy: null }],
        },
      ],
      [
        'unknown policy',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'unknown-policy',
          probes: [{ ...validProbe, policy: { typoPolicy: true } }],
        },
      ],
      [
        'malformed timestamp',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'malformed-time',
          probes: [{ ...validProbe, evaluatedAt: 'not-an-instant' }],
        },
      ],
      [
        'invalid oracle id',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'invalid-oracle-id',
          probes: [{ ...validProbe, expectedRelevantMemoryIds: ['invalid'] }],
        },
      ],
      [
        'duplicate oracle id',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'duplicate-oracle-id',
          probes: [
            {
              ...validProbe,
              expectedRelevantMemoryIds: ['mem_aaaaaaaaaaaa', 'mem_aaaaaaaaaaaa'],
            },
          ],
        },
      ],
      [
        'unsorted oracle ids',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'unsorted-oracle-ids',
          probes: [
            {
              ...validProbe,
              expectedRelevantMemoryIds: ['mem_bbbbbbbbbbbb', 'mem_aaaaaaaaaaaa'],
            },
          ],
        },
      ],
      [
        'overlapping oracle ids',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'overlapping-oracle-ids',
          probes: [{ ...validProbe, forbiddenMemoryIds: ['mem_aaaaaaaaaaaa'] }],
        },
      ],
      [
        'vacuous oracle',
        {
          version: 'nacre.replay-manifest.v1',
          id: 'vacuous-oracle',
          probes: [{ ...validProbe, expectedRelevantMemoryIds: [] }],
        },
      ],
    ];

    for (const [name, manifest] of cases) {
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const before = snapshotTree(memoryDir);
      const run = spawnSync(
        process.execPath,
        [bin, 'evaluate', 'replay', manifestPath, '--memory-dir', memoryDir, '--format', 'json'],
        { encoding: 'utf8' },
      );
      assert.notEqual(run.status, 0, `${name} unexpectedly passed`);
      if (run.stdout.trim()) assert.notEqual(JSON.parse(run.stdout).passed, true, name);
      assert.deepEqual(snapshotTree(memoryDir), before, name);
    }

    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 'nacre.replay-manifest.v1',
        id: 'malformed-memory',
        probes: [validProbe],
      }),
    );
    writeFileSync(memoryPath, 'not a canonical memory file');
    const beforeMalformedMemory = snapshotTree(memoryDir);
    const malformedMemory = spawnSync(
      process.execPath,
      [bin, 'evaluate', 'replay', manifestPath, '--memory-dir', memoryDir, '--format', 'json'],
      { encoding: 'utf8' },
    );
    assert.notEqual(malformedMemory.status, 0);
    assert.deepEqual(snapshotTree(memoryDir), beforeMalformedMemory);
    rmSync(root, { recursive: true, force: true });
  });

  it('prints a machine-readable failing report and exits nonzero when a quality gate misses', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-replay-cli-fail-'));
    const memoryDir = join(root, 'memories');
    seed(memoryDir);
    const manifestPath = join(root, 'corpus.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 'nacre.replay-manifest.v1',
        id: 'failing-cli-corpus',
        thresholds: { maxContextTokensPerProbe: 0 },
        probes: [
          {
            id: 'over-context-budget',
            evaluatedAt: AT,
            expectedRelevantMemoryIds: ['mem_aaaaaaaaaaaa'],
            forbiddenMemoryIds: [],
          },
        ],
      }),
    );

    const before = snapshotTree(memoryDir);
    const run = spawnSync(
      process.execPath,
      [bin, 'evaluate', 'replay', manifestPath, '--memory-dir', memoryDir, '--format', 'json'],
      { encoding: 'utf8' },
    );

    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, false);
    assert.equal(report.summary.attributionEventsByStage.storage, 0);
    assert.equal(report.summary.attributionEventsByStage.extraction, null);
    assert.equal(report.summary.attributionEventsByStage.retrieval, null);
    assert.deepEqual(report.probes[0].gateViolations, [
      {
        metric: 'contextTokens',
        actual: report.probes[0].metrics.contextTokens,
        comparator: '<=',
        threshold: 0,
      },
    ]);
    assert.deepEqual(snapshotTree(memoryDir), before);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects oversized manifests, special files, and symbolic links in the canonical tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-replay-cli-bounds-'));
    const memoryDir = join(root, 'memories');
    const memoryPath = seed(memoryDir);
    const manifestPath = join(root, 'corpus.json');
    writeFileSync(manifestPath, ' '.repeat(4 * 1024 * 1024 + 1));

    const oversized = spawnSync(
      process.execPath,
      [bin, 'evaluate', 'replay', manifestPath, '--memory-dir', memoryDir, '--format', 'json'],
      { encoding: 'utf8' },
    );
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /manifest.*4 mib|manifest.*too large/i);

    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 'nacre.replay-manifest.v1',
        id: 'symlink-corpus',
        probes: [
          {
            id: 'current-brief',
            evaluatedAt: AT,
            expectedRelevantMemoryIds: ['mem_aaaaaaaaaaaa'],
            forbiddenMemoryIds: [],
          },
        ],
      }),
    );
    const fifoPath = join(memoryDir, 'user', 'special.md');
    const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    const special = spawnSync(
      process.execPath,
      [bin, 'evaluate', 'replay', manifestPath, '--memory-dir', memoryDir, '--format', 'json'],
      { encoding: 'utf8' },
    );
    assert.notEqual(special.status, 0);
    assert.match(special.stderr, /special|regular file/i);
    rmSync(fifoPath);

    const outside = join(root, 'outside.md');
    writeFileSync(outside, readFileSync(memoryPath));
    rmSync(memoryPath);
    symlinkSync(outside, memoryPath);
    const symlink = spawnSync(
      process.execPath,
      [bin, 'evaluate', 'replay', manifestPath, '--memory-dir', memoryDir, '--format', 'json'],
      { encoding: 'utf8' },
    );
    assert.notEqual(symlink.status, 0);
    assert.match(symlink.stderr, /symbolic link/i);
    rmSync(root, { recursive: true, force: true });
  });
});
