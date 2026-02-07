import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractEpisodes } from '../extract/episode-extractor.js';
import type { Section } from '../parse.js';

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

describe('extractEpisodes', () => {
  it('produces one episode per section', () => {
    const sections = [
      makeSection('Content A', 'Section A'),
      makeSection('Content B', 'Section B'),
      makeSection('Content C', 'Section C'),
    ];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes.length, 3);
  });

  it('uses heading as title', () => {
    const sections = [makeSection('Body text', 'My Heading')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].title, 'My Heading');
  });

  it('uses section content as episode content', () => {
    const sections = [makeSection('Detailed body text here', 'Title')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].content, 'Detailed body text here');
  });

  it('generates deterministic IDs', () => {
    const sections = [makeSection('Same content', 'Same Heading')];
    const run1 = extractEpisodes(sections, '/same/file.md');
    const run2 = extractEpisodes(sections, '/same/file.md');
    assert.equal(run1[0].id, run2[0].id);
  });

  it('generates different IDs for different content', () => {
    const sections1 = [makeSection('Content A', 'Heading')];
    const sections2 = [makeSection('Content B', 'Heading')];
    const ep1 = extractEpisodes(sections1, '/file.md');
    const ep2 = extractEpisodes(sections2, '/file.md');
    assert.notEqual(ep1[0].id, ep2[0].id);
  });

  it('assigns sequential sequence numbers', () => {
    const sections = [
      makeSection('A', 'First'),
      makeSection('B', 'Second'),
      makeSection('C', 'Third'),
    ];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].sequence, 0);
    assert.equal(episodes[1].sequence, 1);
    assert.equal(episodes[2].sequence, 2);
  });

  it('sets source and sourceType', () => {
    const sections = [makeSection('Content', 'Title')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].source, '/notes/2026-01-15.md');
    assert.equal(episodes[0].sourceType, 'markdown');
  });

  it('extracts date from filename', () => {
    const sections = [makeSection('Content', 'Title')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].timestamp, '2026-01-15');
  });

  it('initializes empty participant and topic arrays', () => {
    const sections = [makeSection('Content', 'Title')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.deepEqual(episodes[0].participants, []);
    assert.deepEqual(episodes[0].topics, []);
  });
});

describe('episode type inference', () => {
  it('infers decision from "decided" keyword', () => {
    const sections = [makeSection('We decided to use TypeScript', 'Tech Choice')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].type, 'decision');
  });

  it('infers decision from "chose" keyword', () => {
    const sections = [makeSection('The team chose Vite over Webpack', 'Build Tool')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].type, 'decision');
  });

  it('infers decision from "settled on" keyword', () => {
    const sections = [makeSection('We settled on SQLite for storage', 'Storage')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].type, 'decision');
  });

  it('infers event from date-like heading', () => {
    const sections = [makeSection('Something happened', '2026-01-15 Sprint Review')];
    const episodes = extractEpisodes(sections, '/notes/misc.md');
    assert.equal(episodes[0].type, 'event');
  });

  it('defaults to observation', () => {
    const sections = [makeSection('Just some notes about the project', 'Project Notes')];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.equal(episodes[0].type, 'observation');
  });

  it('never infers conversation from markdown', () => {
    const sections = [
      makeSection('Marcus said hello and John replied', 'Chat Log'),
      makeSection('Conversation about architecture', 'Discussion'),
    ];
    const episodes = extractEpisodes(sections, '/notes/2026-01-15.md');
    assert.ok(episodes.every(e => e.type !== 'conversation'));
  });
});
