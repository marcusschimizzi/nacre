import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMemoryFile,
  serializeMemoryFile,
  memoryFilePath,
  memorySlug,
  mintMemoryId,
  isValidScope,
  scopeToDir,
  pathToScope,
  extractClaim,
  extractSource,
  extractWikilinks,
  MemoryFileError,
  type MemoryObject,
} from '../memory-file.js';

const EXAMPLE = `---
id: mem_a1b2c3d4e5f6
type: decision
scope: project/nacre
confidence: 0.9
sensitivity: low
created: 2026-07-17
last_confirmed: 2026-07-17
supersedes: mem_x9y8aabbccdd
sources:
  - episode:ep_2026-06-08_1
  - file:docs/REVIEW-2026-06.md
salience:
  reinforcement_count: 3
  last_reinforced: 2026-07-15
---

Chose SQLite over JSON persistence for the graph store, because [[better-sqlite3]]
gives WAL-mode durability and the JSON export remains for portability.

## Source

> "JSON import/export kept for portability and viz" — ROADMAP, 2026-06-08
`;

function makeMemory(overrides: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id: 'mem_0011aabbccdd',
    type: 'fact',
    scope: 'user',
    confidence: 1,
    sensitivity: 'low',
    created: '2026-07-17',
    lastConfirmed: '2026-07-17',
    sources: [],
    salience: { reinforcementCount: 0 },
    body: 'Marcus prefers [[TypeScript]] strict mode.',
    ...overrides,
  };
}

describe('parseMemoryFile', () => {
  it('parses the canonical example', () => {
    const parsed = parseMemoryFile(EXAMPLE);
    assert.equal(parsed.memory.id, 'mem_a1b2c3d4e5f6');
    assert.equal(parsed.memory.type, 'decision');
    assert.equal(parsed.memory.scope, 'project/nacre');
    assert.equal(parsed.memory.confidence, 0.9);
    assert.equal(parsed.memory.supersedes, 'mem_x9y8aabbccdd');
    assert.deepEqual(parsed.memory.sources, [
      'episode:ep_2026-06-08_1',
      'file:docs/REVIEW-2026-06.md',
    ]);
    assert.equal(parsed.memory.salience.reinforcementCount, 3);
    assert.equal(parsed.memory.salience.lastReinforced, '2026-07-15');
    assert.match(parsed.claim, /^Chose SQLite over JSON persistence/);
    assert.match(parsed.source ?? '', /portability and viz/);
    assert.deepEqual(parsed.wikilinks, ['better-sqlite3']);
    assert.deepEqual(parsed.warnings, []);
  });

  it('applies defaults: sensitivity low, confidence 1, last_confirmed = created, salience 0', () => {
    const parsed = parseMemoryFile(
      `---\nid: mem_0011aabbccdd\ntype: fact\nscope: user\ncreated: 2026-07-17\n---\n\nA plain fact.\n`,
    );
    assert.equal(parsed.memory.sensitivity, 'low');
    assert.equal(parsed.memory.confidence, 1);
    assert.equal(parsed.memory.lastConfirmed, '2026-07-17');
    assert.equal(parsed.memory.salience.reinforcementCount, 0);
  });

  it('warns on unknown frontmatter keys (closed schema)', () => {
    const parsed = parseMemoryFile(
      `---\nid: mem_0011aabbccdd\ntype: fact\nscope: user\ncreated: 2026-07-17\nvibes: high\n---\n\nBody.\n`,
    );
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /Unknown frontmatter key: "vibes"/);
  });

  it('rejects sensitivity: secret (zero-retention class)', () => {
    assert.throws(
      () =>
        parseMemoryFile(
          `---\nid: mem_0011aabbccdd\ntype: fact\nscope: user\ncreated: 2026-07-17\nsensitivity: secret\n---\n\nAn API key.\n`,
        ),
      MemoryFileError,
    );
  });

  it('rejects missing frontmatter, bad ids, bad types, bad scopes, bad confidence', () => {
    assert.throws(() => parseMemoryFile('No frontmatter here.'), MemoryFileError);
    const base = (fm: string) => `---\n${fm}\n---\n\nBody.\n`;
    assert.throws(
      () => parseMemoryFile(base('id: nope\ntype: fact\nscope: user\ncreated: 2026-07-17')),
      MemoryFileError,
    );
    assert.throws(
      () =>
        parseMemoryFile(base('id: mem_0011aabbccdd\ntype: vibe\nscope: user\ncreated: 2026-07-17')),
      MemoryFileError,
    );
    assert.throws(
      () =>
        parseMemoryFile(
          base('id: mem_0011aabbccdd\ntype: fact\nscope: global\ncreated: 2026-07-17'),
        ),
      MemoryFileError,
    );
    assert.throws(
      () =>
        parseMemoryFile(
          base(
            'id: mem_0011aabbccdd\ntype: fact\nscope: user\ncreated: 2026-07-17\nconfidence: 1.5',
          ),
        ),
      MemoryFileError,
    );
  });

  it('path-encoded scope wins over frontmatter scope, with a warning', () => {
    const content = `---\nid: mem_0011aabbccdd\ntype: fact\nscope: user\ncreated: 2026-07-17\n---\n\nBody.\n`;
    const parsed = parseMemoryFile(content, 'projects/nacre/facts/body.md');
    assert.equal(parsed.memory.scope, 'project/nacre');
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /path wins/);
  });

  it('warns when the body has no claim paragraph', () => {
    const parsed = parseMemoryFile(
      `---\nid: mem_0011aabbccdd\ntype: fact\nscope: user\ncreated: 2026-07-17\n---\n\n## Source\n\n> quoted only\n`,
    );
    assert.ok(parsed.warnings.some((w) => w.includes('no claim paragraph')));
  });
});

describe('round-trip', () => {
  it('serialize → parse preserves the memory object', () => {
    const memory = makeMemory({
      type: 'decision',
      scope: 'project/nacre',
      confidence: 0.75,
      supersedes: 'mem_ffeeddccbbaa',
      sources: ['file:notes/2026-07-01.md'],
      salience: { reinforcementCount: 5, lastReinforced: '2026-07-10' },
      body: 'Decided to keep the engine.\n\n## Source\n\n> keep the engine — assessment',
    });
    const parsed = parseMemoryFile(serializeMemoryFile(memory));
    assert.deepEqual(parsed.memory, memory);
  });

  it('serialization is deterministic and stable across a parse cycle', () => {
    const first = serializeMemoryFile(makeMemory());
    const second = serializeMemoryFile(parseMemoryFile(first).memory);
    assert.equal(first, second);
  });

  it('refuses to serialize secrets or invalid scopes', () => {
    assert.throws(
      () => serializeMemoryFile(makeMemory({ sensitivity: 'secret' })),
      MemoryFileError,
    );
    assert.throws(() => serializeMemoryFile(makeMemory({ scope: 'everything' })), MemoryFileError);
  });
});

describe('scopes', () => {
  it('validates scope forms', () => {
    assert.ok(isValidScope('user'));
    assert.ok(isValidScope('agent'));
    assert.ok(isValidScope('project/nacre'));
    assert.ok(isValidScope('project/tide-pool'));
    assert.ok(!isValidScope('project/'));
    assert.ok(!isValidScope('session'));
    assert.ok(!isValidScope('project/Nacre App'));
  });

  it('maps scopes to directories and back', () => {
    assert.equal(scopeToDir('user'), 'user');
    assert.equal(scopeToDir('project/nacre'), 'projects/nacre');
    assert.equal(pathToScope('user/preferences/x.md'), 'user');
    assert.equal(pathToScope('agent/facts/y.md'), 'agent');
    assert.equal(pathToScope('projects/nacre/decisions/z.md'), 'project/nacre');
    assert.equal(pathToScope('.capture/2026-07-17.jsonl'), undefined);
    assert.equal(pathToScope('stray.md'), undefined);
  });
});

describe('extraction helpers', () => {
  it('extractClaim takes the first non-heading paragraph and joins wrapped lines', () => {
    assert.equal(
      extractClaim('# Title\n\nFirst claim\nwrapped here.\n\nSecond para.'),
      'First claim wrapped here.',
    );
    assert.equal(extractClaim(''), '');
  });

  it('extractSource returns the section verbatim and stops at the next heading', () => {
    const body = 'Claim.\n\n## Source\n\n> exact quote with UUID 123e4567\n\n## Notes\n\nother';
    assert.equal(extractSource(body), '> exact quote with UUID 123e4567');
    assert.equal(extractSource('Claim without source.'), undefined);
  });

  it('extractWikilinks dedupes and handles alias/anchor syntax', () => {
    const links = extractWikilinks(
      'See [[nacre]], [[nacre]], [[tide-pool|the sim]], [[Docs#Section]].',
    );
    assert.deepEqual(links, ['nacre', 'tide-pool', 'Docs']);
  });

  it('memorySlug strips wikilinks, normalizes, and truncates on a word boundary', () => {
    assert.equal(
      memorySlug('Chose [[SQLite]] over JSON persistence!'),
      'chose-sqlite-over-json-persistence',
    );
    assert.equal(memorySlug(''), 'memory');
    const long = memorySlug('a'.repeat(10) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(30));
    assert.ok(long.length <= 60);
    assert.ok(!long.endsWith('-'));
  });

  it('mintMemoryId mints well-formed unique ids', () => {
    const a = mintMemoryId();
    const b = mintMemoryId();
    assert.match(a, /^mem_[0-9a-f]{12}$/);
    assert.notEqual(a, b);
  });

  it('memoryFilePath places files under scope/type directories', () => {
    const memory = makeMemory({
      type: 'decision',
      scope: 'project/nacre',
      body: 'Keep the engine.',
    });
    assert.equal(memoryFilePath(memory), 'projects/nacre/decisions/keep-the-engine.md');
  });
});
