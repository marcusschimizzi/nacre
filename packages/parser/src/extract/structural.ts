import type { RawEntity } from '@nacre/core';
import type { Section } from '../parse.js';

const GENERIC_HEADINGS = new Set([
  'projects', 'tools', 'lessons', 'decisions', 'events', 'notes',
  'summary', 'overview', 'research', 'implementation', 'architecture',
  'intro', '(intro)',
]);

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const CODE_RE = /`([^`]+)`/g;
const CAUSAL_RE = /(?:led to|because of|resulted in|caused by|due to|which meant|this meant)\s/gi;

/**
 * Filter out noisy code entities that are actually paths, URLs, commands, or config strings
 */
function isNoisyCodeEntity(text: string): boolean {
  // Skip paths
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../') || text.startsWith('~')) {
    return true;
  }
  
  // Skip URLs
  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('file://')) {
    return true;
  }
  
  // Skip if contains multiple path segments (like memory/browser-setup-notes.md)
  if (text.includes('/') && text.split('/').length > 1) {
    return true;
  }
  
  // Skip commands with flags (contains " --" or " -" followed by letters)
  if (/\s--/.test(text) || /\s-[a-zA-Z]/.test(text)) {
    return true;
  }
  
  // Skip IP addresses and port patterns
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(text)) {
    return true;
  }
  if (/127\.0\.0\.1|172\.17\.0\.\d+|localhost:\d+/.test(text)) {
    return true;
  }
  
  // Skip media paths and mount specs
  if (text.startsWith('MEDIA:') || text.includes(':rw') || text.includes(':ro')) {
    return true;
  }
  
  return false;
}

export function extractStructural(
  sections: Section[],
  filePath: string,
): RawEntity[] {
  const entities: RawEntity[] = [];

  for (const section of sections) {
    const { content, headingPath, startLine } = section;

    let match: RegExpExecArray | null;

    const wikiRe = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
    while ((match = wikiRe.exec(content)) !== null) {
      entities.push({
        text: match[1].trim(),
        type: 'concept',
        confidence: 0.9,
        source: 'structural',
        position: { file: filePath, section: headingPath, line: startLine },
      });
    }

    const boldRe = new RegExp(BOLD_RE.source, BOLD_RE.flags);
    while ((match = boldRe.exec(content)) !== null) {
      const text = match[1].trim();
      if (text.length <= 2) continue;
      entities.push({
        text,
        type: 'concept',
        confidence: 0.7,
        source: 'structural',
        position: { file: filePath, section: headingPath, line: startLine },
      });
    }

    const codeRe = new RegExp(CODE_RE.source, CODE_RE.flags);
    while ((match = codeRe.exec(content)) !== null) {
      const text = match[1].trim();
      if (text.length <= 1 || text.length > 40) continue;
      if (/[{}()=<>&|$+^~]/.test(text)) continue;
      if (/^\\./.test(text)) continue;
      // Apply noise filtering
      if (isNoisyCodeEntity(text)) continue;
      entities.push({
        text,
        type: 'tool',
        confidence: 0.7,
        source: 'structural',
        position: { file: filePath, section: headingPath, line: startLine },
      });
    }

    const headingNorm = section.heading.toLowerCase().trim();
    if (!GENERIC_HEADINGS.has(headingNorm) && headingNorm.length > 2) {
      entities.push({
        text: section.heading,
        type: 'concept',
        confidence: 0.6,
        source: 'structural',
        position: { file: filePath, section: headingPath, line: startLine },
      });
    }
  }

  return entities;
}

export function detectCausalPhrases(content: string): boolean {
  return CAUSAL_RE.test(content);
}
