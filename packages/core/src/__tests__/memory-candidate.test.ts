import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { compileMemoryDir, listMemoryFiles } from '../memory-compile.js';
import type { MemoryCandidate } from '../memory-candidate.js';
import {
  extractCandidatesFromHistoricalEvidence,
  importHistoricalConversation,
  rebuildHistoricalEvidence,
  verifiedHistoricalEvidenceInputs,
  type ConversationInput,
} from '../index.js';
import { readDurableMemoryCandidates } from '../memory-candidate-durable.js';
import {
  promoteMemoryCandidate,
  rebuildDurableMemoryCandidates,
  rejectMemoryCandidate,
} from '../memory-candidate-lifecycle.js';
import { extractMemoryCandidates } from '../memory-extraction.js';
import { parseMemoryFile } from '../memory-file.js';
import { SqliteStore as StoreClass } from '../store.js';

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 'mem_111122223333444455556666',
    type: 'preference',
    claim: 'I prefer deterministic tests.',
    normalizedClaim: 'i prefer deterministic tests',
    scope: 'user',
    sensitivity: 'personal',
    confidence: 0.99,
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T10:00:00.000Z',
    proposedAt: '2026-07-01T10:00:00.000Z',
    evidence: [
      {
        sourceRef: 'openclaw:s1#message:m1',
        messageId: 'm1',
        sourcePosition: { line: 2, ordinal: 0 },
        span: { start: 0, end: 29, text: 'I prefer deterministic tests.' },
      },
    ],
    subjectEntityIds: [],
    extractor: { name: 'nacre-explicit-memory', version: '1' },
    lifecycle: 'candidate',
    createdAt: '2026-07-22T10:00:00.000Z',
    updatedAt: '2026-07-22T10:00:00.000Z',
    ...overrides,
  };
}

const openStore = (path?: string) => StoreClass.open(path);

describe('MemoryCandidate persistence', () => {
  it('stores candidates separately from entity nodes with full typed provenance', () => {
    const store = openStore();
    const value = candidate();

    assert.equal(store.createMemoryCandidate(value), true);
    assert.deepEqual(store.getMemoryCandidate(value.id), value);
    assert.deepEqual(store.listMemoryCandidates(), [value]);
    assert.equal(store.nodeCount(), 0);

    store.close();
  });

  it('migrates schema v11 to v12 without losing legacy candidate CRUD fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-schema-v11-'));
    const dbPath = join(root, 'graph.db');
    const legacy = openStore(dbPath);
    const value = candidate();
    legacy.createMemoryCandidate(value);
    const db = legacy.rawDatabaseForTests();
    db.exec(`
      ALTER TABLE memory_candidates DROP COLUMN resolved_memory_id;
      ALTER TABLE nodes DROP COLUMN belief_lifecycle;
      ALTER TABLE nodes DROP COLUMN valid_from;
      ALTER TABLE nodes DROP COLUMN valid_until;
      UPDATE meta SET value = '11' WHERE key = 'schema_version';
    `);
    legacy.close();

    const migrated = openStore(dbPath);
    assert.deepEqual(migrated.getMemoryCandidate(value.id), value);
    const promoted = {
      ...value,
      lifecycle: 'promoted' as const,
      canonicalPath: 'user/preferences/test.md',
      resolvedMemoryId: 'mem_aaaaaaaaaaaaaaaaaaaaaaaa',
    };
    migrated.updateMemoryCandidate(promoted);
    assert.equal(
      migrated.getMemoryCandidate(value.id)?.resolvedMemoryId,
      promoted.resolvedMemoryId,
    );
    assert.equal(migrated.getMeta('schema_version'), '12');
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects malformed candidates at the store CRUD boundary', () => {
    const store = openStore();
    assert.throws(
      () =>
        store.createMemoryCandidate(
          candidate({
            id: 'not-a-memory-id',
            scope: 'session',
            confidence: 2,
            trust: -7,
            normalizedClaim: 'incorrect',
            evidence: [
              {
                sourceRef: '',
                messageId: 'm1',
                span: { start: 0, end: 1, text: 'too long' },
              },
            ],
            extractor: {} as MemoryCandidate['extractor'],
          }),
        ),
      /invalid memory candidate/i,
    );
    assert.equal(store.listMemoryCandidates().length, 0);
    store.close();
  });

  it('fails loudly when legacy rows contain malformed candidate state', () => {
    const store = openStore();
    const value = candidate();
    assert.equal(store.createMemoryCandidate(value), true);
    store
      .rawDatabaseForTests()
      .prepare('UPDATE memory_candidates SET trust = -99 WHERE id = ?')
      .run(value.id);
    assert.throws(() => store.getMemoryCandidate(value.id), /invalid memory candidate/i);
    store.close();
  });
});

describe('deterministic conservative candidate extraction', () => {
  it('rejects secret claims before retaining claim or evidence bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-secret-'));
    const store = openStore();
    const receipt = extractMemoryCandidates(
      {
        metadata: { sessionId: 's1', sourceNamespace: 'openclaw', scope: 'user' },
        messages: [
          {
            id: 'u1',
            role: 'user' as const,
            origin: 'direct' as const,
            extractionEligible: true,
            content: 'Remember that API key is TOPSECRET.',
            timestamp: '2026-07-01T10:00:00.000Z',
            sourceRef: 'openclaw:s1#message:u1',
          },
        ],
      },
      store,
      { sensitivity: 'secret', now: '2026-07-22T10:00:00.000Z', memoryDir: root },
    );
    assert.deepEqual(
      { created: receipt.created, skipped: receipt.skipped, rejected: receipt.rejected },
      { created: 0, skipped: 0, rejected: 1 },
    );
    assert.equal(store.listMemoryCandidates().length, 0);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates one candidate from direct eligible user evidence and rejects synthetic traffic', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-extract-'));
    const store = openStore();
    const input = {
      metadata: { sessionId: 's1', sourceNamespace: 'openclaw', scope: 'user' },
      messages: [
        {
          id: 'u1',
          role: 'user' as const,
          origin: 'direct' as const,
          extractionEligible: true,
          content: 'I prefer deterministic tests.',
          timestamp: '2026-07-01T10:00:00.000Z',
          sourceRef: 'openclaw:s1#message:u1',
          sourcePosition: { line: 2, ordinal: 0 },
          contentHash: 'hash-u1',
        },
        {
          id: 'a1',
          role: 'assistant' as const,
          origin: 'direct' as const,
          extractionEligible: true,
          content: 'You prefer deterministic tests.',
        },
        {
          id: 'q1',
          role: 'user' as const,
          origin: 'quoted_context' as const,
          extractionEligible: false,
          content: 'Recent Conversation History:\nI prefer deterministic tests.',
        },
        {
          id: 't1',
          role: 'tool' as const,
          origin: 'tool_result' as const,
          extractionEligible: false,
          content: 'I prefer deterministic tests.',
        },
        {
          id: 'c1',
          role: 'user' as const,
          origin: 'cron' as const,
          extractionEligible: true,
          content: 'I prefer deterministic tests.',
        },
        {
          id: 'i1',
          role: 'user' as const,
          origin: 'internal_route' as const,
          extractionEligible: false,
          content: 'I prefer deterministic tests.',
        },
        {
          id: 'u2',
          role: 'user' as const,
          origin: 'direct' as const,
          extractionEligible: true,
          content: 'Maybe tests are useful.',
        },
      ],
    };

    const receipt = extractMemoryCandidates(input, store, {
      now: '2026-07-22T10:00:00.000Z',
      memoryDir: root,
    });

    assert.equal(receipt.created, 1);
    assert.equal(receipt.skipped, 5);
    assert.equal(receipt.rejected, 1);
    assert.equal(store.listMemoryCandidates().length, 1);
    const created = store.listMemoryCandidates()[0];
    assert.equal(created.type, 'preference');
    assert.equal(created.lifecycle, 'candidate');
    assert.deepEqual(created.evidence, [
      {
        sourceRef: 'openclaw:s1#message:u1',
        messageId: 'u1',
        sourcePosition: { line: 2, ordinal: 0 },
        span: { start: 0, end: 29, text: 'I prefer deterministic tests.' },
        contentHash: 'hash-u1',
      },
    ]);
    assert.ok(receipt.reasons.some((reason) => reason.reason === 'unsupported_form'));

    const before = store.getMemoryCandidate(created.id);
    const rerun = extractMemoryCandidates(input, store, {
      now: '2026-08-01T00:00:00.000Z',
      memoryDir: root,
    });
    assert.deepEqual(
      { created: rerun.created, skipped: rerun.skipped, rejected: rerun.rejected },
      { created: 0, skipped: 6, rejected: 1 },
    );
    assert.deepEqual(store.getMemoryCandidate(created.id), before);
    assert.equal(store.listMemoryCandidates().length, 1);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('authenticated historical evidence candidate extraction', () => {
  it('iterates verified evidence, extracts exactly one normalized candidate, no-ops on rerun, rejects tamper, and rebuilds equivalently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-historical-candidates-'));
    const db = join(root, 'graph.db');
    const store = openStore(db);
    const input: ConversationInput = {
      metadata: {
        sessionId: 'hist-1',
        sourceNamespace: 'openclaw',
        scope: 'user',
      },
      messages: [
        {
          id: 'direct-1',
          role: 'user',
          origin: 'direct',
          extractionEligible: true,
          content: 'Remember that the release checklist lives in docs/release.md.',
          timestamp: '2026-07-01T10:00:00.000Z',
          sourceRef: 'openclaw:hist-1#message:direct-1',
          contentHash: 'hash-direct-1',
        },
        {
          id: 'quoted-1',
          role: 'user',
          origin: 'quoted_context',
          extractionEligible: false,
          content: 'Remember that quoted history must not create candidates.',
          timestamp: '2026-07-01T10:01:00.000Z',
          sourceRef: 'openclaw:hist-1#message:quoted-1',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          origin: 'direct',
          extractionEligible: true,
          content: 'Remember that assistant text is ineligible.',
          timestamp: '2026-07-01T10:02:00.000Z',
          sourceRef: 'openclaw:hist-1#message:assistant-1',
        },
      ],
    };
    const imported = await importHistoricalConversation(input, {
      store,
      memoryRoot: root,
      scope: 'user',
      extractEntities: () => ({ nodes: [], edges: [] }),
    });
    const verified = [...verifiedHistoricalEvidenceInputs(root)];
    assert.equal(verified.length, 1);

    const extracted = extractCandidatesFromHistoricalEvidence(store, root, {
      now: '2026-07-22T10:00:00.000Z',
    });
    assert.deepEqual(
      { files: extracted.files, created: extracted.created, skipped: extracted.skipped },
      { files: 1, created: 1, skipped: 2 },
    );
    const candidates = store.listMemoryCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(
      candidates[0].normalizedClaim,
      'remember that the release checklist lives in docs/release.md',
    );
    assert.equal(candidates[0].evidence[0].sourceRef, 'openclaw:hist-1#message:direct-1');

    const rerun = extractCandidatesFromHistoricalEvidence(store, root, {
      now: '2026-07-22T11:00:00.000Z',
    });
    assert.equal(rerun.created, 0);
    assert.equal(rerun.skipped, 3);

    const promoted = promoteMemoryCandidate(store, root, candidates[0].id, {
      now: '2026-07-22T12:00:00.000Z',
    });
    assert.equal(promoted.status, 'promoted');

    const rebuilt = openStore(join(root, 'rebuilt.db'));
    const compile = compileMemoryDir(rebuilt, root);
    const replay = rebuildDurableMemoryCandidates(rebuilt, root);
    const historical = await rebuildHistoricalEvidence(rebuilt, root, {
      extractEntities: () => ({ nodes: [], edges: [] }),
    });
    extractCandidatesFromHistoricalEvidence(rebuilt, root, {
      now: '2026-07-22T13:00:00.000Z',
    });
    assert.deepEqual(compile.errors, []);
    assert.deepEqual(replay.errors, []);
    assert.equal(historical.episodesCreated, imported.episodesCreated);
    assert.deepEqual(
      rebuilt.getMemoryCandidate(candidates[0].id),
      store.getMemoryCandidate(candidates[0].id),
    );

    const tampered = readFileSync(imported.evidencePath, 'utf8').replace(
      'release checklist',
      'tampered checklist',
    );
    writeFileSync(imported.evidencePath, tampered);
    assert.throws(() => [...verifiedHistoricalEvidenceInputs(root)], /integrity/i);

    rebuilt.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('candidate lifecycle', () => {
  it('persists pending and rejected candidate state durably under the memory root and replays it', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-durable-'));
    const store = openStore();
    const pending = candidate();
    const rejected = candidate({
      id: 'mem_222222222222222222222222',
      claim: 'We decided to reject lossy state.',
      normalizedClaim: 'we decided to reject lossy state',
      type: 'decision',
    });
    assert.equal(store.createMemoryCandidate(pending, { memoryDir: root }), true);
    assert.equal(store.createMemoryCandidate(rejected, { memoryDir: root }), true);
    rejectMemoryCandidate(store, root, rejected.id, 'duplicate evidence', {
      now: '2026-07-22T11:00:00.000Z',
    });

    const rebuilt = openStore();
    const replay = rebuildDurableMemoryCandidates(rebuilt, root);
    assert.deepEqual(
      { replayed: replay.replayed, skipped: replay.skipped, errors: replay.errors },
      {
        replayed: 2,
        skipped: 0,
        errors: [],
      },
    );
    assert.equal(rebuilt.getMemoryCandidate(pending.id)?.lifecycle, 'candidate');
    assert.equal(rebuilt.getMemoryCandidate(rejected.id)?.lifecycle, 'rejected');

    const afterReject = openStore();
    extractMemoryCandidates(
      {
        metadata: { sessionId: 's2', sourceNamespace: 'openclaw', scope: 'user' },
        messages: [
          {
            id: 'm1',
            role: 'user' as const,
            origin: 'direct' as const,
            extractionEligible: true,
            content: rejected.claim,
            timestamp: rejected.eventTime,
            sourceRef: 'openclaw:s1#message:m1',
          },
        ],
      },
      afterReject,
      { now: '2026-07-22T12:00:00.000Z', memoryDir: root },
    );
    rebuildDurableMemoryCandidates(afterReject, root);
    assert.equal(afterReject.getMemoryCandidate(rejected.id)?.lifecycle, 'rejected');

    afterReject.close();
    rebuilt.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails malformed candidate frontmatter loudly during compile', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-frontmatter-'));
    const badPath = join(root, 'user', 'facts');
    mkdirSync(badPath, { recursive: true });
    writeFileSync(
      join(badPath, 'bad.md'),
      `---
id: mem_333333333333333333333333
type: fact
scope: user
confidence: 1
sensitivity: personal
created: 2026-07-01
last_confirmed: 2026-07-01
sources:
  - openclaw:s1#message:m1
source_authority: direct_user
trust: -99
event_time: not-an-iso
proposed_at: 2026-07-01T10:00:00.000Z
evidence: not-an-array
extractor: {}
salience:
  reinforcement_count: 0
---

Remember that invalid candidate metadata fails.
`,
    );
    const store = openStore();
    const result = compileMemoryDir(store, root);
    assert.equal(result.files, 0);
    assert.match(result.errors.join('\n'), /trust|event_time|evidence|extractor/i);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails partial candidate frontmatter instead of silently rebuilding it as ordinary memory', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-partial-frontmatter-'));
    const path = join(root, 'user', 'facts');
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, 'partial.md'),
      `---
id: mem_333333333333333333333334
type: fact
scope: user
confidence: 1
sensitivity: personal
created: 2026-07-01
last_confirmed: 2026-07-01
sources:
  - openclaw:s1#message:m1
source_authority: direct_user
trust: 1
event_time: 2026-07-01T10:00:00.000Z
proposed_at: 2026-07-01T10:00:00.000Z
evidence:
  - sourceRef: openclaw:s1#message:m1
    messageId: m1
    span:
      start: 0
      end: 41
      text: Remember that partial metadata must fail.
candidate_created_at: 2026-07-22T10:00:00.000Z
candidate_updated_at: 2026-07-22T10:00:00.000Z
salience:
  reinforcement_count: 0
---

Remember that partial metadata must fail.
`,
    );
    const store = openStore();
    const result = compileMemoryDir(store, root);
    assert.equal(result.memories, 0);
    assert.match(result.errors.join('\n'), /extractor|candidate metadata/i);
    assert.equal(store.getMemoryCandidate('mem_333333333333333333333334'), undefined);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('guarded stale lifecycle writes cannot create DB/file disagreement', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-race-'));
    const db = join(root, 'graph.db');
    const first = openStore(db);
    const second = openStore(db);
    const value = candidate();
    first.createMemoryCandidate(value, { memoryDir: root });

    const stale = second.getMemoryCandidate(value.id);
    assert.ok(stale);
    const promoted = promoteMemoryCandidate(first, root, value.id, {
      now: '2026-07-22T12:00:00.000Z',
    });
    const staleRejected: MemoryCandidate = {
      ...stale,
      lifecycle: 'rejected',
      rejectionReason: 'stale reviewer',
      updatedAt: '2026-07-22T12:01:00.000Z',
    };
    assert.equal(second.transitionMemoryCandidate('candidate', staleRejected), false);
    assert.equal(second.getMemoryCandidate(value.id)?.lifecycle, 'promoted');
    assert.ok(readFileSync(join(root, promoted.canonicalPath), 'utf8').includes(value.claim));

    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects candidate durable roots that escape through symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'nacre-candidate-outside-'));
    symlinkSync(outside, join(root, '.candidates'));
    const store = openStore();
    assert.throws(
      () => store.createMemoryCandidate(candidate(), { memoryDir: root }),
      /symlink|real directory|escape/i,
    );
    assert.equal(store.getMemoryCandidate(candidate().id), undefined);
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('does not follow a symlinked durable journal file or commit the matching DB update', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-journal-symlink-'));
    const outside = join(
      mkdtempSync(join(tmpdir(), 'nacre-candidate-journal-outside-')),
      'outside',
    );
    const store = openStore();
    const value = candidate();
    store.createMemoryCandidate(value, { memoryDir: root });
    const journal = join(root, '.candidates', 'journal', '2026-07-22.jsonl');
    unlinkSync(journal);
    writeFileSync(outside, 'sentinel\n');
    symlinkSync(outside, journal);

    const changed = { ...value, trust: 0.5, updatedAt: '2026-07-22T11:00:00.000Z' };
    assert.throws(
      () => store.updateMemoryCandidate(changed, { memoryDir: root }),
      /symlink|regular file|journal/i,
    );
    assert.equal(store.getMemoryCandidate(value.id)?.trust, value.trust);
    assert.equal(readDurableMemoryCandidates(root).candidates[0]?.trust, value.trust);
    assert.equal(readFileSync(outside, 'utf8'), 'sentinel\n');

    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(outside), { recursive: true, force: true });
  });

  it('removes canonical publication when the durable promotion transition fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-promotion-rollback-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'nacre-candidate-promotion-outside-'));
    const outside = join(outsideDir, 'journal');
    const store = openStore();
    const value = candidate();
    store.createMemoryCandidate(value, { memoryDir: root });
    const journal = join(root, '.candidates', 'journal', '2026-07-22.jsonl');
    unlinkSync(journal);
    writeFileSync(outside, 'sentinel\n');
    symlinkSync(outside, journal);

    assert.throws(
      () =>
        promoteMemoryCandidate(store, root, value.id, {
          now: '2026-07-22T11:00:00.000Z',
        }),
      /journal|regular file/i,
    );
    assert.equal(store.getMemoryCandidate(value.id)?.lifecycle, 'candidate');
    assert.deepEqual(listMemoryFiles(root), []);

    unlinkSync(journal);
    writeFileSync(journal, '', { mode: 0o600 });
    const rejected = rejectMemoryCandidate(store, root, value.id, 'not durable');
    assert.equal(rejected.lifecycle, 'rejected');
    assert.deepEqual(listMemoryFiles(root), []);

    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('fails closed when durable corruption could hide a rejection decision', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-corrupt-rejection-'));
    const store = openStore();
    const input = {
      metadata: { sessionId: 's1', sourceNamespace: 'openclaw', scope: 'user' },
      messages: [
        {
          id: 'u1',
          role: 'user' as const,
          origin: 'direct' as const,
          extractionEligible: true,
          content: 'I prefer deterministic tests.',
          timestamp: '2026-07-01T10:00:00.000Z',
          sourceRef: 'openclaw:s1#message:u1',
        },
      ],
    };
    const extracted = extractMemoryCandidates(input, store, {
      now: '2026-07-22T10:00:00.000Z',
      memoryDir: root,
    });
    const id = extracted.reasons.find(
      (item: { candidateId?: string }) => item.candidateId,
    )?.candidateId;
    assert.ok(id);
    rejectMemoryCandidate(store, root, id, 'reviewed rejection', {
      now: '2026-07-22T11:00:00.000Z',
    });
    store.close();

    unlinkSync(join(root, '.candidates', 'state', `${id}.json`));
    const journal = join(root, '.candidates', 'journal', '2026-07-22.jsonl');
    const firstRecord = readFileSync(journal, 'utf8').split('\n')[0];
    writeFileSync(journal, `${firstRecord}\n{"op":`, { mode: 0o600 });

    const fresh = openStore();
    assert.throws(
      () =>
        extractMemoryCandidates(input, fresh, {
          now: '2026-07-22T12:00:00.000Z',
          memoryDir: root,
        }),
      /corrupt|refusing lifecycle decision/i,
    );
    assert.equal(fresh.listMemoryCandidates().length, 0);

    fresh.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not publish canonical memory through a symlinked scope directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-canonical-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'nacre-candidate-canonical-outside-'));
    symlinkSync(outside, join(root, 'user'));
    const store = openStore();
    const value = candidate();
    store.createMemoryCandidate(value, { memoryDir: root });

    assert.throws(() => promoteMemoryCandidate(store, root, value.id), /symlink|directory/i);
    assert.equal(store.getMemoryCandidate(value.id)?.lifecycle, 'candidate');
    assert.deepEqual(readdirSync(outside), []);

    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('explicitly promotes once through canonical markdown and rebuilds identity and provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-promote-'));
    const store = openStore();
    const value = candidate();
    store.createMemoryCandidate(value);

    const first = promoteMemoryCandidate(store, root, value.id, {
      now: '2026-07-22T11:00:00.000Z',
    });
    assert.equal(first.status, 'promoted');
    const parsed = parseMemoryFile(
      readFileSync(join(root, first.canonicalPath), 'utf8'),
      first.canonicalPath,
    );
    assert.equal(parsed.memory.id, value.id);
    assert.deepEqual(parsed.memory.evidence, value.evidence);
    assert.deepEqual(parsed.memory.extractor, value.extractor);
    assert.equal(parsed.memory.sourceAuthority, value.sourceAuthority);
    assert.equal(parsed.memory.trust, value.trust);

    const handEdited = readFileSync(join(root, first.canonicalPath), 'utf8').replace(
      `\n---\n\n${value.claim}`,
      `\n---\n\n${value.claim} Hand edit retained.`,
    );
    writeFileSync(join(root, first.canonicalPath), handEdited);
    const second = promoteMemoryCandidate(store, root, value.id, {
      now: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(second.status, 'already_promoted');
    assert.equal(readFileSync(join(root, first.canonicalPath), 'utf8'), handEdited);

    const rebuilt = openStore();
    const compile = compileMemoryDir(rebuilt, root);
    assert.deepEqual(compile.errors, []);
    const replayed = rebuilt.getMemoryCandidate(value.id);
    assert.equal(replayed?.id, value.id);
    assert.equal(replayed?.lifecycle, 'promoted');
    assert.deepEqual(replayed?.evidence, value.evidence);
    assert.deepEqual(replayed?.extractor, value.extractor);

    rebuilt.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('explicitly rejects a candidate and rejected candidates can never promote', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-candidate-reject-'));
    const store = openStore();
    const value = candidate();
    store.createMemoryCandidate(value);

    const rejected = rejectMemoryCandidate(store, root, value.id, 'not durable', {
      now: '2026-07-22T11:00:00.000Z',
    });
    assert.equal(rejected.lifecycle, 'rejected');
    assert.equal(rejected.rejectionReason, 'not durable');
    assert.throws(() => promoteMemoryCandidate(store, root, value.id), /rejected/i);
    const fresh = openStore();
    assert.equal(compileMemoryDir(fresh, root).memories, 0);
    fresh.close();

    store.close();
    rmSync(root, { recursive: true, force: true });
  });
});
