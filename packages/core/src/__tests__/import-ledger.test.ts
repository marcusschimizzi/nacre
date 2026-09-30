import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseConversationFile } from '../adapters.js';
import { importHistoricalConversation, rebuildHistoricalEvidence } from '../historical-ingest.js';
import { SqliteStore } from '../store.js';
import type { ConversationChunk, ConversationInput } from '../types.js';

const fixture = join(import.meta.dirname, 'fixtures', 'openclaw', 'direct-session.jsonl');

function extractor(chunk: ConversationChunk) {
  assert.ok(chunk.messages.every((message) => message.extractionEligible !== false));
  return {
    nodes: [
      {
        label: 'Project Pearl',
        type: 'project',
        mentionedBy: ['user'],
        excerpts: ['Project Pearl'],
      },
    ],
    edges: [],
  };
}

describe('historical import ledger and evidence rebuild', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'nacre-historical-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes durable evidence, deterministic chronological episodes, and makes identical re-import a strict no-op', async () => {
    const input = parseConversationFile(readFileSync(fixture, 'utf8'), 'openclaw', {
      source: fixture,
    });
    const store = SqliteStore.open();
    const first = await importHistoricalConversation(input, {
      store,
      memoryRoot: root,
      scope: 'agent',
      extractEntities: extractor,
      ingestedAt: '2026-07-22T12:00:00.000Z',
    });

    assert.equal(first.status, 'complete');
    assert.equal(first.episodesCreated, 1);
    assert.match(first.evidencePath, /\.evidence\/conversations\/openclaw\//);
    assert.ok(readFileSync(first.evidencePath, 'utf8').includes('quoted_context'));
    assert.deepEqual(await readdir(join(root, '.evidence', 'conversations', 'openclaw')), [
      first.evidencePath.split('/').at(-1),
    ]);
    const episode = store.listEpisodes()[0];
    assert.equal(episode.timestamp, '2026-01-15T10:00:00.000Z');
    assert.equal(episode.endTimestamp, '2026-01-15T10:02:00.000Z');
    assert.equal(episode.scope, 'agent');
    assert.match(episode.content, /Recent Conversation History/);
    assert.match(episode.id, /^ep_conv_[a-f0-9]{24}$/);
    const nodeBefore = store.findNode('Project Pearl');
    assert.equal(nodeBefore?.firstSeen, '2026-01-15T10:00:00.000Z');
    assert.equal(nodeBefore?.lastReinforced, '2026-01-15T10:01:00.000Z');
    const graphBefore = store.getFullGraph();

    const second = await importHistoricalConversation(input, {
      store,
      memoryRoot: root,
      scope: 'agent',
      extractEntities: extractor,
      ingestedAt: '2026-07-23T12:00:00.000Z',
    });
    assert.equal(second.status, 'skipped');
    assert.equal(second.episodesCreated, 0);
    assert.deepEqual(store.getFullGraph(), graphBefore);
    assert.equal(store.listImports().length, 1);
    assert.equal(store.listImports()[0].ingestedAt, '2026-07-22T12:00:00.000Z');

    const rebuilt = SqliteStore.open();
    const replay = await rebuildHistoricalEvidence(rebuilt, root, { extractEntities: extractor });
    assert.equal(replay.importsCompleted, 1);
    assert.deepEqual(rebuilt.listEpisodes(), store.listEpisodes());
    assert.deepEqual(rebuilt.listNodes(), store.listNodes());
    rebuilt.close();
    store.close();
  });

  it('rolls back every derived write on extraction failure and retries without double reinforcement', async () => {
    const input: ConversationInput = {
      metadata: { sessionId: 'crash-retry', sourceNamespace: 'openclaw' },
      messages: [
        { id: 'm1', role: 'user', content: 'Project Pearl one', timestamp: '2026-02-01T10:00:00Z' },
        { id: 'm2', role: 'user', content: 'Project Pearl two', timestamp: '2026-02-01T11:00:00Z' },
      ],
    };
    const store = SqliteStore.open();
    let calls = 0;
    await assert.rejects(
      importHistoricalConversation(input, {
        store,
        memoryRoot: root,
        scope: 'agent',
        extractEntities(chunk: ConversationChunk) {
          calls++;
          if (calls === 2) throw new Error('synthetic crash');
          return extractor(chunk);
        },
      }),
      /synthetic crash/,
    );
    assert.equal(store.listEpisodes().length, 0);
    assert.equal(store.listNodes().length, 0);
    assert.equal(store.listImports()[0].status, 'failed');

    const retried = await importHistoricalConversation(input, {
      store,
      memoryRoot: root,
      scope: 'agent',
      extractEntities: extractor,
    });
    assert.equal(retried.episodesCreated, 2);
    assert.equal(store.findNode('Project Pearl')?.mentionCount, 2);
    assert.equal(store.findNode('Project Pearl')?.reinforcementCount, 1);
    store.close();
  });

  it('uses content identity rather than physical source paths and integrity-checks completed evidence', async () => {
    const base = parseConversationFile(readFileSync(fixture, 'utf8'), 'openclaw', {
      source: '/archive/original/session.jsonl',
    });
    const moved = parseConversationFile(readFileSync(fixture, 'utf8'), 'openclaw', {
      source: '/moved/archive/renamed.jsonl',
    });
    const store = SqliteStore.open();
    const first = await importHistoricalConversation(base, {
      store,
      memoryRoot: root,
      scope: 'agent',
      extractEntities: extractor,
    });
    const second = await importHistoricalConversation(moved, {
      store,
      memoryRoot: root,
      scope: 'agent',
      extractEntities: extractor,
    });
    assert.equal(second.status, 'skipped');
    assert.equal(second.importId, first.importId);
    assert.equal(store.listImports().length, 1);
    assert.doesNotMatch(readFileSync(first.evidencePath, 'utf8'), /\/archive\/|\/moved\//);

    writeFileSync(first.evidencePath, 'tampered');
    await assert.rejects(
      importHistoricalConversation(base, {
        store,
        memoryRoot: root,
        scope: 'agent',
        extractEntities: extractor,
      }),
      /integrity/i,
    );
    store.close();
  });

  it('keeps malformed-input identity path-independent while preserving pathful warnings', async () => {
    const content = [
      JSON.stringify({ type: 'session', id: 'moved-malformed' }),
      '  {broken input  ',
      JSON.stringify({
        type: 'message',
        id: 'm1',
        message: { role: 'user', content: 'valid dialogue' },
      }),
    ].join('\n');
    const original = parseConversationFile(content, 'openclaw', {
      source: '/archive/original/malformed.jsonl',
    });
    const moved = parseConversationFile(content, 'openclaw', {
      source: '/moved/archive/malformed.jsonl',
    });
    assert.notDeepEqual(original.warnings, moved.warnings);

    const memoryRoot = join(root, 'moved-malformed-memory');
    const store = SqliteStore.open();
    const first = await importHistoricalConversation(original, {
      store,
      memoryRoot,
      scope: 'agent',
    });
    const second = await importHistoricalConversation(moved, { store, memoryRoot, scope: 'agent' });

    assert.equal(second.status, 'skipped');
    assert.equal(second.importId, first.importId);
    assert.equal(store.listImports().length, 1);
    assert.match(original.warnings?.[0] ?? '', /\/archive\/original\/malformed\.jsonl:2/);
    store.close();
  });

  it('durably preserves adapter diagnostics and raw evidence and replays them without the archive', async () => {
    const input = parseConversationFile(
      [
        JSON.stringify({ type: 'session', id: 'durable-diagnostics' }),
        JSON.stringify({ type: 'future-record', payload: { retained: true } }),
        JSON.stringify({
          type: 'message',
          id: 'valid',
          timestamp: 'not-a-date',
          message: { role: 'user', content: 'retained dialogue' },
        }),
      ].join('\n'),
      'openclaw',
      { source: 'synthetic.jsonl' },
    );
    const memoryRoot = join(root, 'durable-diagnostics-memory');
    const store = SqliteStore.open();
    const imported = await importHistoricalConversation(input, {
      store,
      memoryRoot,
      scope: 'agent',
    });
    const evidence = readFileSync(imported.evidencePath, 'utf8');
    assert.match(evidence, /future-record/);
    assert.match(evidence, /invalid event timestamp/);
    assert.match(evidence, /"type":"warning"/);

    const rebuilt = SqliteStore.open();
    await rebuildHistoricalEvidence(rebuilt, memoryRoot);
    assert.ok(
      (rebuilt.getImport(imported.importId)?.report?.warningCount as number) >= 2,
      'adapter warnings survive evidence replay',
    );
    rebuilt.close();
    store.close();
  });

  it('authenticates normalized evidence content, header identity, and filename before rebuild', async () => {
    const makeEvidence = async (name: string) => {
      const memoryRoot = join(root, name);
      const store = SqliteStore.open();
      const imported = await importHistoricalConversation(
        {
          metadata: {
            sessionId: name,
            sourceNamespace: 'openclaw',
            sourceDigest: 'untrusted-external-digest',
          },
          messages: [{ id: 'm1', role: 'user', content: 'authentic content' }],
        },
        { store, memoryRoot, scope: 'agent' },
      );
      store.close();
      return { memoryRoot, imported };
    };

    const contentCase = await makeEvidence('tampered-content');
    writeFileSync(
      contentCase.imported.evidencePath,
      readFileSync(contentCase.imported.evidencePath, 'utf8').replace(
        'authentic content',
        'tampered content',
      ),
    );
    const contentStore = SqliteStore.open();
    await assert.rejects(
      rebuildHistoricalEvidence(contentStore, contentCase.memoryRoot),
      /digest|integrity/i,
    );
    contentStore.close();

    const headerCase = await makeEvidence('tampered-header');
    writeFileSync(
      headerCase.imported.evidencePath,
      readFileSync(headerCase.imported.evidencePath, 'utf8').replace(
        headerCase.imported.importId,
        'imp_000000000000000000000000',
      ),
    );
    const headerStore = SqliteStore.open();
    await assert.rejects(
      rebuildHistoricalEvidence(headerStore, headerCase.memoryRoot),
      /import ID|integrity/i,
    );
    headerStore.close();

    for (const [name, mutate] of [
      [
        'tampered-ingested-at',
        (header: Record<string, unknown>) => ({
          ...header,
          ingestedAt: '1999-01-01T00:00:00.000Z',
        }),
      ],
      [
        'tampered-durable-header-metadata',
        (header: Record<string, unknown>) => ({
          ...header,
          metadata: {
            ...(header.metadata as Record<string, unknown>),
            source: 'evidence:openclaw:tampered',
          },
        }),
      ],
    ] as const) {
      const durableHeaderCase = await makeEvidence(name);
      const lines = readFileSync(durableHeaderCase.imported.evidencePath, 'utf8').split('\n');
      lines[0] = JSON.stringify(mutate(JSON.parse(lines[0]) as Record<string, unknown>));
      writeFileSync(durableHeaderCase.imported.evidencePath, lines.join('\n'));
      const durableHeaderStore = SqliteStore.open();
      await assert.rejects(
        rebuildHistoricalEvidence(durableHeaderStore, durableHeaderCase.memoryRoot),
        /header|integrity/i,
      );
      durableHeaderStore.close();
    }

    const filenameCase = await makeEvidence('tampered-filename');
    await rename(
      filenameCase.imported.evidencePath,
      join(filenameCase.imported.evidencePath, '..', 'renamed.jsonl'),
    );
    const filenameStore = SqliteStore.open();
    await assert.rejects(
      rebuildHistoricalEvidence(filenameStore, filenameCase.memoryRoot),
      /filename|integrity/i,
    );
    filenameStore.close();
  });

  it('does not trust self-recomputed evidence metadata as an external authority', async () => {
    const memoryRoot = join(root, 'self-recomputed-header');
    const originalStore = SqliteStore.open();
    const imported = await importHistoricalConversation(
      {
        metadata: { sessionId: 'self-recomputed', sourceNamespace: 'openclaw' },
        messages: [{ id: 'm1', role: 'user', content: 'authentic content' }],
      },
      {
        store: originalStore,
        memoryRoot,
        scope: 'agent',
        ingestedAt: '2026-07-22T12:00:00.000Z',
      },
    );
    originalStore.close();

    const lines = readFileSync(imported.evidencePath, 'utf8').split('\n');
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    header.ingestedAt = '1999-01-01T00:00:00.000Z';
    const { integrityDigest: _oldDigest, ...unsignedHeader } = header;
    header.integrityDigest = createHash('sha256')
      .update(JSON.stringify(unsignedHeader))
      .digest('hex');
    lines[0] = JSON.stringify(header);
    writeFileSync(imported.evidencePath, lines.join('\n'));

    const rebuilt = SqliteStore.open();
    await rebuildHistoricalEvidence(rebuilt, memoryRoot);
    assert.notEqual(rebuilt.getImport(imported.importId)?.ingestedAt, '1999-01-01T00:00:00.000Z');
    rebuilt.close();

    const sourceLines = readFileSync(imported.evidencePath, 'utf8').split('\n');
    const sourceHeader = JSON.parse(sourceLines[0]) as Record<string, unknown>;
    (sourceHeader.metadata as Record<string, unknown>).source = 'evidence:attacker:forged';
    const { integrityDigest: _sourceDigest, ...unsignedSourceHeader } = sourceHeader;
    sourceHeader.integrityDigest = createHash('sha256')
      .update(JSON.stringify(unsignedSourceHeader))
      .digest('hex');
    sourceLines[0] = JSON.stringify(sourceHeader);
    writeFileSync(imported.evidencePath, sourceLines.join('\n'));

    const rejected = SqliteStore.open();
    await assert.rejects(
      rebuildHistoricalEvidence(rejected, memoryRoot),
      /canonical source|integrity/i,
    );
    rejected.close();
  });

  it('confines private durable evidence, validates scope and namespace, and uses private modes', async () => {
    const input: ConversationInput = {
      metadata: { sessionId: 'secure', sourceNamespace: '../escape' },
      messages: [{ id: 'm1', role: 'user', content: 'safe', timestamp: '2026-02-01T10:00:00Z' }],
    };
    const store = SqliteStore.open();
    await assert.rejects(
      importHistoricalConversation(input, { store, memoryRoot: root, scope: 'agent' }),
      /namespace/i,
    );
    input.metadata = { ...input.metadata, sourceNamespace: 'openclaw' };
    await assert.rejects(
      importHistoricalConversation(input, { store, memoryRoot: root, scope: 'session' }),
      /durable scope/i,
    );
    const result = await importHistoricalConversation(input, {
      store,
      memoryRoot: root,
      scope: 'agent',
      ingestedAt: '2000-01-01T00:00:00.000Z',
    });
    assert.equal(statSync(result.evidencePath).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, '.evidence')).mode & 0o777, 0o700);
    assert.notEqual(store.getImport(result.importId)?.completedAt, '2000-01-01T00:00:00.000Z');

    chmodSync(result.evidencePath, 0o644);
    const reused = await importHistoricalConversation(input, {
      store,
      memoryRoot: root,
      scope: 'agent',
    });
    assert.equal(reused.status, 'skipped');
    assert.equal(statSync(result.evidencePath).mode & 0o777, 0o600);
    store.close();
  });

  it('rejects evidence-directory symlink escapes', async () => {
    const memoryRoot = join(root, 'symlink-memory');
    const outside = join(root, 'outside-evidence');
    await mkdir(memoryRoot);
    await mkdir(outside);
    await symlink(outside, join(memoryRoot, '.evidence'));
    const store = SqliteStore.open();
    try {
      await assert.rejects(
        importHistoricalConversation(
          {
            metadata: { sessionId: 'symlink-escape', sourceNamespace: 'openclaw' },
            messages: [{ id: 'm1', role: 'user', content: 'safe' }],
          },
          { store, memoryRoot, scope: 'agent' },
        ),
        /symlink/i,
      );
      assert.equal((await readdir(outside)).length, 0);
    } finally {
      store.close();
    }
  });

  it('rejects a completed import when any existing evidence ancestor is replaced by a symlink', async () => {
    const memoryRoot = join(root, 'completed-ancestor-memory');
    const store = SqliteStore.open();
    const input: ConversationInput = {
      metadata: { sessionId: 'completed-ancestor', sourceNamespace: 'openclaw' },
      messages: [{ id: 'm1', role: 'user', content: 'safe' }],
    };
    const imported = await importHistoricalConversation(input, {
      store,
      memoryRoot,
      scope: 'agent',
    });
    const namespaceDirectory = join(memoryRoot, '.evidence', 'conversations', 'openclaw');
    const movedDirectory = join(root, 'completed-ancestor-outside');
    await rename(namespaceDirectory, movedDirectory);
    await symlink(movedDirectory, namespaceDirectory);

    await assert.rejects(
      importHistoricalConversation(input, { store, memoryRoot, scope: 'agent' }),
      /ancestor|symlink|directory/i,
    );
    assert.ok(readFileSync(imported.evidencePath, 'utf8').includes('safe'));
    store.close();
  });

  it('lets older eligible evidence lower firstSeen without moving node or edge reinforcement backward', async () => {
    const store = SqliteStore.open();
    const chronologyExtractor = () => ({
      nodes: [
        { label: 'Alpha', type: 'concept', mentionedBy: ['user'], excerpts: ['Alpha'] },
        { label: 'Beta', type: 'concept', mentionedBy: ['user'], excerpts: ['Beta'] },
      ],
      edges: [{ source: 'Alpha', target: 'Beta', type: 'related', context: 'Alpha Beta' }],
    });
    const conversation = (sessionId: string, timestamp: string): ConversationInput => ({
      metadata: { sessionId, sourceNamespace: 'openclaw' },
      messages: [
        {
          id: `${sessionId}-message`,
          role: 'user',
          content: 'Alpha Beta',
          timestamp,
          origin: 'direct',
          extractionEligible: true,
        },
      ],
    });
    await importHistoricalConversation(conversation('newer', '2026-05-01T00:00:00-04:00'), {
      store,
      memoryRoot: root,
      scope: 'agent',
      extractEntities: chronologyExtractor,
    });
    await importHistoricalConversation(conversation('older', '2025-01-01T00:00:00Z'), {
      store,
      memoryRoot: root,
      scope: 'agent',
      extractEntities: chronologyExtractor,
    });

    const alpha = store.findNode('Alpha');
    assert.equal(alpha?.firstSeen, '2025-01-01T00:00:00.000Z');
    assert.equal(alpha?.lastReinforced, '2026-05-01T04:00:00.000Z');
    const edge = store.listEdges()[0];
    assert.equal(edge.firstFormed, '2025-01-01T00:00:00.000Z');
    assert.equal(edge.lastReinforced, '2026-05-01T04:00:00.000Z');
    store.close();
  });
});
