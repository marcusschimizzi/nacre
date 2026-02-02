import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, extractSections } from '../parse.js';

describe('parseMarkdown', () => {
  it('parses markdown into AST', () => {
    const result = parseMarkdown('# Hello\nWorld');
    assert.equal(result.type, 'root');
    assert.ok(Array.isArray(result.children));
    assert.ok(result.children.length > 0);
  });

  it('handles empty string', () => {
    const result = parseMarkdown('');
    assert.equal(result.type, 'root');
    assert.ok(Array.isArray(result.children));
  });
});

describe('extractSections', () => {
  it('splits on H2 headings', () => {
    const markdown = '## First\nContent A\n## Second\nContent B';
    const tree = parseMarkdown(markdown);
    const sections = extractSections(tree, 'test.md');
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading, 'First');
    assert.equal(sections[1].heading, 'Second');
  });

  it('captures intro content before first heading', () => {
    const markdown = 'Intro text\n## Section\nBody';
    const tree = parseMarkdown(markdown);
    const sections = extractSections(tree, 'test.md');
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading, 'intro');
    assert.equal(sections[1].heading, 'Section');
  });

  it('handles document with no headings', () => {
    const markdown = 'Just some text';
    const tree = parseMarkdown(markdown);
    const sections = extractSections(tree, 'test.md');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, 'intro');
  });

  it('preserves heading paths', () => {
    const markdown = '## SectionName\nContent';
    const tree = parseMarkdown(markdown);
    const sections = extractSections(tree, 'test.md');
    assert.equal(sections[0].headingPath, '## SectionName');
  });

  it('handles empty sections between headings', () => {
    const markdown = '## A\n## B\nContent';
    const tree = parseMarkdown(markdown);
    const sections = extractSections(tree, 'test.md');
    const sectionB = sections.find((s) => s.heading === 'B');
    assert.ok(sectionB);
    assert.ok(sectionB.content.includes('Content'));
  });
});
