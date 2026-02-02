import nlp from 'compromise';
import type { RawEntity } from '@nacre/core';
import type { Section } from '../parse.js';

const STOP_WORDS = new Set([
  'the', 'it', 'this', 'that', 'a', 'an', 'is', 'was', 'are', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'also', 'just', 'very',
  'good', 'great', 'well', 'much', 'big', 'day', 'today', 'phase',
  'current', 'status', 'session', 'version', 'default', 'latest', 
  'first', 'last', 'next', 'tasks', 'rules', 'skip', 'check',
]);

function stripMarkdown(text: string): string {
  return text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`[^`]+`/g, '')
    .replace(/^#+\s+/gm, '')
    .replace(/#\w+/g, '')
    .replace(/[—–]/g, ',')
    // Strip single-word parentheticals like (claude)
    .replace(/\(\w+\)/g, '');
}

export function extractNLP(
  sections: Section[],
  filePath: string,
): RawEntity[] {
  const entities: RawEntity[] = [];

  for (const section of sections) {
    const clean = stripMarkdown(section.content);
    const doc = nlp(clean);

    const people = doc.people().out('array') as string[];
    for (const name of people) {
      const trimmed = name.trim();
      if (trimmed.length <= 2 || STOP_WORDS.has(trimmed.toLowerCase())) continue;
      entities.push({
        text: trimmed,
        type: 'person',
        confidence: 0.8,
        source: 'nlp',
        position: {
          file: filePath,
          section: section.headingPath,
          line: section.startLine,
        },
      });
    }

    const places = doc.places().out('array') as string[];
    for (const place of places) {
      const trimmed = place.trim();
      if (trimmed.length <= 2 || STOP_WORDS.has(trimmed.toLowerCase())) continue;
      entities.push({
        text: trimmed,
        type: 'place',
        confidence: 0.7,
        source: 'nlp',
        position: {
          file: filePath,
          section: section.headingPath,
          line: section.startLine,
        },
      });
    }

    const orgs = doc.organizations().out('array') as string[];
    for (const org of orgs) {
      const trimmed = org.trim();
      if (trimmed.length <= 2 || STOP_WORDS.has(trimmed.toLowerCase())) continue;
      entities.push({
        text: trimmed,
        type: 'project',
        confidence: 0.6,
        source: 'nlp',
        position: {
          file: filePath,
          section: section.headingPath,
          line: section.startLine,
        },
      });
    }
  }

  return entities;
}
