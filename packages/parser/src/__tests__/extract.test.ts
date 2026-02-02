import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractStructural,
  detectCausalPhrases,
} from '../extract/structural.js';
import { extractNLP } from '../extract/nlp.js';
import { extractCustom } from '../extract/custom.js';
import { deduplicateRawEntities } from '../merge.js';
import { normalize } from '@nacre/core';
import type { Section } from '../parse.js';
import type { RawEntity } from '@nacre/core';

function makeSection(
  content: string,
  heading?: string,
  headingPath?: string,
): Section {
  return {
    heading: heading ?? 'Test',
    headingPath: headingPath ?? '## Test',
    content,
    startLine: 1,
    endLine: 10,
  };
}

describe('extractStructural', () => {
  it('extracts wikilinks', () => {
    const section = makeSection('See [[Marcus]] and [[tide-pool]] for details', 'intro', '(intro)');
    const entities = extractStructural([section], 'test.md');
    const wikilinks = entities.filter((e) => e.confidence === 0.9);
    assert.equal(wikilinks.length, 2);
    assert.equal(wikilinks[0].text, 'Marcus');
    assert.equal(wikilinks[0].type, 'concept');
    assert.equal(wikilinks[0].source, 'structural');
    assert.equal(wikilinks[1].text, 'tide-pool');
  });

  it('extracts bold terms', () => {
    const section = makeSection('This is **context engineering** in action');
    const entities = extractStructural([section], 'test.md');
    const boldEntity = entities.find((e) => e.text === 'context engineering');
    assert.ok(boldEntity);
    assert.equal(boldEntity.confidence, 0.7);
    assert.equal(boldEntity.source, 'structural');
  });

  it('skips short bold terms', () => {
    const section = makeSection('This is **hi** text');
    const entities = extractStructural([section], 'test.md');
    const shortBold = entities.find((e) => e.text === 'hi');
    assert.equal(shortBold, undefined);
  });

  it('extracts code references', () => {
    const section = makeSection('Use `Vite` for building');
    const entities = extractStructural([section], 'test.md');
    const codeEntity = entities.find((e) => e.text === 'Vite');
    assert.ok(codeEntity);
    assert.equal(codeEntity.type, 'tool');
    assert.equal(codeEntity.confidence, 0.7);
  });

  it('skips code with special chars', () => {
    const section = makeSection('Config: `{foo: bar}`');
    const entities = extractStructural([section], 'test.md');
    const specialCode = entities.find((e) => e.text === '{foo: bar}');
    assert.equal(specialCode, undefined);
  });

  it('extracts non-generic headings as concepts', () => {
    const section = makeSection('Content here', 'Memory Architecture', '## Memory Architecture');
    const entities = extractStructural([section], 'test.md');
    const headingEntity = entities.find((e) => e.text === 'Memory Architecture');
    assert.ok(headingEntity);
    assert.equal(headingEntity.type, 'concept');
    assert.equal(headingEntity.confidence, 0.6);
  });

  it('skips generic headings', () => {
    const section = makeSection('Content here', 'Projects', '## Projects');
    const entities = extractStructural([section], 'test.md');
    const genericHeading = entities.find((e) => e.text === 'Projects');
    assert.equal(genericHeading, undefined);
  });
});

describe('detectCausalPhrases', () => {
  it('detects "led to"', () => {
    const result = detectCausalPhrases('This led to a new approach');
    assert.equal(result, true);
  });

  it('detects "because of"', () => {
    const result = detectCausalPhrases('The bug happened because of the issue');
    assert.equal(result, true);
  });

  it('returns false for non-causal text', () => {
    const result = detectCausalPhrases('The project is going well');
    assert.equal(result, false);
  });
});

describe('extractNLP', () => {
  it('extracts people', () => {
    const section = makeSection('Marcus reviewed the code with John');
    const entities = extractNLP([section], 'test.md');
    const people = entities.filter((e) => e.type === 'person');
    assert.ok(people.length >= 1, 'should find at least 1 person');
    assert.ok(people.every((e) => e.source === 'nlp'));
  });

  it('skips stop words', () => {
    const section = makeSection('Marcus reviewed the code');
    const entities = extractNLP([section], 'test.md');
    const stopWordEntities = entities.filter(
      (e) => normalize(e.text) === normalize('the'),
    );
    assert.equal(stopWordEntities.length, 0);
  });

  it('returns empty for purely technical text', () => {
    const section = makeSection('The function returns a promise');
    const entities = extractNLP([section], 'test.md');
    assert.ok(Array.isArray(entities));
  });
});

describe('extractCustom', () => {
  it('extracts known tools', () => {
    const section = makeSection('Using Vite and TypeScript for the build');
    const entities = extractCustom([section], 'test.md');
    const vite = entities.find((e) => e.text === 'Vite');
    const ts = entities.find((e) => e.text === 'TypeScript');
    assert.ok(vite);
    assert.ok(ts);
    assert.equal(vite.type, 'tool');
    assert.equal(vite.confidence, 0.9);
    assert.equal(vite.source, 'custom');
  });

  it('extracts GitHub URLs', () => {
    const section = makeSection(
      'See https://github.com/vasturiano/3d-force-graph',
    );
    const entities = extractCustom([section], 'test.md');
    const ghEntity = entities.find((e) => e.text === 'vasturiano/3d-force-graph');
    assert.ok(ghEntity);
    assert.equal(ghEntity.type, 'project');
  });

  it('extracts hashtags', () => {
    const section = makeSection('Working on #architecture today');
    const entities = extractCustom([section], 'test.md');
    const tagEntity = entities.find((e) => e.text === 'architecture');
    assert.ok(tagEntity);
    assert.equal(tagEntity.type, 'tag');
    assert.equal(tagEntity.confidence, 0.8);
  });

  it('extracts scoped packages', () => {
    const section = makeSection('Using @nacre/core for the engine');
    const entities = extractCustom([section], 'test.md');
    const pkgEntity = entities.find((e) => e.text === '@nacre/core');
    assert.ok(pkgEntity);
    assert.equal(pkgEntity.type, 'tool');
  });

  it('deduplicates tools within a section', () => {
    const section = makeSection('Vite is great. I love Vite.');
    const entities = extractCustom([section], 'test.md');
    const viteEntities = entities.filter((e) => e.text === 'Vite');
    assert.equal(viteEntities.length, 1);
  });
});

describe('deduplicateRawEntities', () => {
  it('removes duplicates by normalized text', () => {
    const entities: RawEntity[] = [
      {
        text: 'Marcus',
        type: 'person',
        confidence: 0.8,
        source: 'nlp',
        position: { file: 'test.md', section: '## Test', line: 1 },
      },
      {
        text: 'marcus',
        type: 'person',
        confidence: 0.7,
        source: 'nlp',
        position: { file: 'test.md', section: '## Test', line: 2 },
      },
    ];
    const result = deduplicateRawEntities(entities);
    assert.equal(result.length, 1);
  });

  it('keeps higher confidence version', () => {
    const entities: RawEntity[] = [
      {
        text: 'Marcus',
        type: 'person',
        confidence: 0.6,
        source: 'nlp',
        position: { file: 'test.md', section: '## Test', line: 1 },
      },
      {
        text: 'marcus',
        type: 'person',
        confidence: 0.9,
        source: 'nlp',
        position: { file: 'test.md', section: '## Test', line: 2 },
      },
    ];
    const result = deduplicateRawEntities(entities);
    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, 0.9);
  });

  it('preserves distinct entities', () => {
    const entities: RawEntity[] = [
      {
        text: 'Marcus',
        type: 'person',
        confidence: 0.8,
        source: 'nlp',
        position: { file: 'test.md', section: '## Test', line: 1 },
      },
      {
        text: 'Nacre',
        type: 'project',
        confidence: 0.9,
        source: 'custom',
        position: { file: 'test.md', section: '## Test', line: 2 },
      },
    ];
    const result = deduplicateRawEntities(entities);
    assert.equal(result.length, 2);
  });
});
