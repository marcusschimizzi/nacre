import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  levenshteinDistance,
  fuzzyMatch,
  loadEntityMap,
  resolveEntity,
} from '../resolve.js';
import { createGraph, addNode } from '../graph.js';
import type { EntityMap, RawEntity } from '../types.js';

describe('normalize', () => {
  it('lowercases text', () => {
    assert.equal(normalize('Hello World'), 'hello world');
  });

  it('trims whitespace', () => {
    assert.equal(normalize('  hello  '), 'hello');
  });

  it('collapses internal whitespace', () => {
    assert.equal(normalize('hello   world'), 'hello world');
  });

  it("strips trailing possessive 's (ASCII)", () => {
    assert.equal(normalize("Marcus's"), 'marcus');
  });

  it('strips trailing punctuation', () => {
    assert.equal(normalize('hello!'), 'hello');
    assert.equal(normalize('done.'), 'done');
    assert.equal(normalize('what?!'), 'what');
  });

  it('strips smart quotes (unicode)', () => {
    assert.equal(normalize('\u201CMarcus S\u201D'), 'marcus s');
    assert.equal(normalize('\u2018hello\u2019'), 'hello');
  });

  it('strips trailing em-dashes', () => {
    assert.equal(normalize('Dr. Chen \u2014'), 'dr. chen');
  });

  it('strips leading em-dashes', () => {
    assert.equal(normalize('\u2014 hello'), 'hello');
  });
});

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshteinDistance('abc', 'abc'), 0);
  });

  it('returns string length for empty vs non-empty', () => {
    assert.equal(levenshteinDistance('', 'abc'), 3);
    assert.equal(levenshteinDistance('xyz', ''), 3);
  });

  it('returns 1 for single character difference', () => {
    assert.equal(levenshteinDistance('cat', 'car'), 1);
  });

  it('returns 2 for two character differences', () => {
    assert.equal(levenshteinDistance('marcus', 'markus'), 1);
    assert.equal(levenshteinDistance('kitten', 'sitten'), 1);
  });

  it('handles transpositions as 2 edits', () => {
    assert.equal(levenshteinDistance('ab', 'ba'), 2);
  });
});

describe('fuzzyMatch', () => {
  it('matches identical strings', () => {
    assert.ok(fuzzyMatch('marcus', 'marcus'));
  });

  it('matches within default Levenshtein distance of 2', () => {
    assert.ok(fuzzyMatch('marcus', 'markus'));
  });

  it('rejects strings beyond distance threshold', () => {
    assert.ok(!fuzzyMatch('marcus', 'johnson'));
  });

  it('uses token overlap for long strings', () => {
    assert.ok(fuzzyMatch('tide pool simulator', 'tide pool simulation'));
  });

  it('rejects long strings with low token overlap', () => {
    assert.ok(!fuzzyMatch('tide pool simulator', 'mountain bike adventure'));
  });

  it('normalizes before comparing', () => {
    assert.ok(fuzzyMatch('Marcus', 'marcus'));
    assert.ok(fuzzyMatch('  HELLO ', 'hello'));
  });
});

describe('loadEntityMap', () => {
  it('returns defaults for non-existent path', () => {
    const map = loadEntityMap('/non/existent/path.json');
    assert.deepEqual(map, { aliases: {}, ignore: [] });
  });

  it('loads real entity-map.json', () => {
    const map = loadEntityMap('data/entity-map.json');
    assert.ok(Object.keys(map.aliases).length > 0, 'should have aliases');
    assert.ok(map.ignore.length > 0, 'should have ignore list');
    assert.equal(map.aliases['Marcus S'], 'marcus');
  });
});

describe('resolveEntity', () => {
  const entityMap: EntityMap = {
    aliases: { 'Marcus S': 'marcus', TS: 'typescript' },
    ignore: ['the', 'it', 'lesson'],
  };

  function makeRaw(overrides: Partial<RawEntity> = {}): RawEntity {
    return {
      text: 'test',
      type: 'concept',
      confidence: 0.9,
      source: 'structural',
      position: { file: 'test.md', section: '## Test', line: 1 },
      ...overrides,
    };
  }

  it('returns null for empty or very short text', () => {
    assert.equal(resolveEntity(makeRaw({ text: '' }), createGraph(), entityMap), null);
    assert.equal(resolveEntity(makeRaw({ text: 'a' }), createGraph(), entityMap), null);
  });

  it('returns null for ignored terms', () => {
    assert.equal(resolveEntity(makeRaw({ text: 'the' }), createGraph(), entityMap), null);
    assert.equal(resolveEntity(makeRaw({ text: 'lesson' }), createGraph(), entityMap), null);
  });

  it('resolves via entity-map alias', () => {
    const graph = createGraph();
    addNode(graph, {
      label: 'marcus',
      aliases: [],
      type: 'person',
      firstSeen: '2026-01-01',
      lastReinforced: '2026-01-01',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
    });

    const result = resolveEntity(
      makeRaw({ text: 'Marcus S', type: 'person' }),
      graph,
      entityMap,
    );
    assert.ok(result !== null);
    assert.equal(result.isNew, false);
    assert.equal(result.canonicalLabel, 'marcus');
  });

  it('resolves exact match on existing node label', () => {
    const graph = createGraph();
    addNode(graph, {
      label: 'typescript',
      aliases: [],
      type: 'tool',
      firstSeen: '2026-01-01',
      lastReinforced: '2026-01-01',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
    });

    const result = resolveEntity(
      makeRaw({ text: 'TypeScript', type: 'tool' }),
      graph,
      entityMap,
    );
    assert.ok(result !== null);
    assert.equal(result.isNew, false);
    assert.equal(result.canonicalLabel, 'typescript');
  });

  it('resolves via node alias match', () => {
    const graph = createGraph();
    addNode(graph, {
      label: 'tide-pool',
      aliases: ['tide pool', 'tidepool'],
      type: 'project',
      firstSeen: '2026-01-01',
      lastReinforced: '2026-01-01',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
    });

    const result = resolveEntity(
      makeRaw({ text: 'tide pool', type: 'project' }),
      graph,
      entityMap,
    );
    assert.ok(result !== null);
    assert.equal(result.isNew, false);
    assert.equal(result.canonicalLabel, 'tide-pool');
  });

  it('resolves via fuzzy match', () => {
    const graph = createGraph();
    addNode(graph, {
      label: 'marcus',
      aliases: [],
      type: 'person',
      firstSeen: '2026-01-01',
      lastReinforced: '2026-01-01',
      mentionCount: 1,
      reinforcementCount: 0,
      sourceFiles: [],
      excerpts: [],
    });

    const result = resolveEntity(
      makeRaw({ text: 'markus', type: 'person' }),
      graph,
      entityMap,
    );
    assert.ok(result !== null);
    assert.equal(result.isNew, false);
    assert.equal(result.canonicalLabel, 'marcus');
  });

  it('creates new entity when no match and confidence > 0.5', () => {
    const result = resolveEntity(
      makeRaw({ text: 'nacre', confidence: 0.9 }),
      createGraph(),
      entityMap,
    );
    assert.ok(result !== null);
    assert.equal(result.isNew, true);
    assert.equal(result.canonicalLabel, 'nacre');
  });

  it('returns null for low confidence with no match', () => {
    const result = resolveEntity(
      makeRaw({ text: 'ambiguous', confidence: 0.3 }),
      createGraph(),
      entityMap,
    );
    assert.equal(result, null);
  });
});
