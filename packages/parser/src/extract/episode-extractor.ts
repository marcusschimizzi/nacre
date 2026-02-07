import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Episode, EpisodeType } from '@nacre/core';
import type { Section } from '../parse.js';

const DECISION_RE = /\b(decided|chose|selected|agreed|settled on|went with|picked|concluded)\b/i;
const DATE_HEADING_RE = /^\d{4}-\d{2}-\d{2}/;
const DATE_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})/;

function generateEpisodeId(filePath: string, heading: string, content: string): string {
  return createHash('sha256')
    .update(`${filePath}:${heading}:${content}`)
    .digest('hex')
    .slice(0, 16);
}

function inferType(heading: string, content: string): EpisodeType {
  if (DECISION_RE.test(content)) return 'decision';
  if (DATE_HEADING_RE.test(heading)) return 'event';
  return 'observation';
}

function extractDateFromFilename(filePath: string): string | null {
  const name = basename(filePath, '.md');
  const match = name.match(DATE_FILENAME_RE);
  return match ? match[1] : null;
}

export function extractEpisodes(sections: Section[], filePath: string): Episode[] {
  const fileDate = extractDateFromFilename(filePath) ?? new Date().toISOString().slice(0, 10);

  return sections.map((section, index) => ({
    id: generateEpisodeId(filePath, section.heading, section.content),
    timestamp: fileDate,
    type: inferType(section.heading, section.content),
    title: section.heading,
    content: section.content,
    sequence: index,
    participants: [],
    topics: [],
    importance: 0.5,
    accessCount: 0,
    lastAccessed: fileDate,
    source: filePath,
    sourceType: 'markdown' as const,
  }));
}
