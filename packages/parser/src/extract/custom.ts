import type { RawEntity } from '@nacre/core';
import type { Section } from '../parse.js';

const KNOWN_TOOLS = [
  'Claude Code', 'Codex', 'Vite', 'tmux', 'Three.js', 'VS Code',
  'Git', 'Docker', 'Playwright', 'TypeScript', 'JavaScript', 'Node.js',
  'npm', 'React', 'Next.js', 'Bun', 'Webpack', 'ESLint', 'Prettier',
  'bitECS', 'D3.js', 'SQLite', 'WebGL', 'Esbuild', 'tsup',
  'compromise.js', 'remark', 'unified',
];

const KNOWN_PROJECTS = [
  'tide-pool', 'nacre', 'honeycomber', 'strata', 'parley', 
  'reef', 'push', 'mock-my-draft',
];

const KNOWN_PEOPLE = [
  'Marcus', 'Lobstar', 'Sarah',
];

const TOOL_PATTERNS = KNOWN_TOOLS.map((tool) => ({
  pattern: new RegExp(`\\b${escapeRegex(tool)}\\b`, 'gi'),
  canonical: tool,
}));

const PROJECT_PATTERNS = KNOWN_PROJECTS.map((project) => ({
  pattern: new RegExp(`\\b${escapeRegex(project)}\\b`, 'gi'),
  canonical: project,
}));

const PERSON_PATTERNS = KNOWN_PEOPLE.map((person) => ({
  pattern: new RegExp(`\\b${escapeRegex(person)}\\b`, 'g'),
  canonical: person,
}));

const GITHUB_URL_RE = /github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/g;
const HASHTAG_RE = /#([a-zA-Z]\w+)/g;
const SCOPED_PKG_RE = /@([a-z0-9_-]+\/[a-z0-9_-]+)/g;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractCustom(
  sections: Section[],
  filePath: string,
): RawEntity[] {
  const entities: RawEntity[] = [];

  for (const section of sections) {
    const { content, headingPath, startLine } = section;
    const seenTools = new Set<string>();
    const seenProjects = new Set<string>();
    const seenPeople = new Set<string>();

    // Extract known tools
    for (const { pattern, canonical } of TOOL_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(content) && !seenTools.has(canonical.toLowerCase())) {
        seenTools.add(canonical.toLowerCase());
        entities.push({
          text: canonical,
          type: 'tool',
          confidence: 0.9,
          source: 'custom',
          position: { file: filePath, section: headingPath, line: startLine },
        });
      }
    }

    // Extract known projects
    for (const { pattern, canonical } of PROJECT_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(content) && !seenProjects.has(canonical.toLowerCase())) {
        seenProjects.add(canonical.toLowerCase());
        entities.push({
          text: canonical,
          type: 'project',
          confidence: 0.9,
          source: 'custom',
          position: { file: filePath, section: headingPath, line: startLine },
        });
      }
    }

    // Extract known people
    for (const { pattern, canonical } of PERSON_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(content) && !seenPeople.has(canonical.toLowerCase())) {
        seenPeople.add(canonical.toLowerCase());
        entities.push({
          text: canonical,
          type: 'person',
          confidence: 0.95,
          source: 'custom',
          position: { file: filePath, section: headingPath, line: startLine },
        });
      }
    }

    let match: RegExpExecArray | null;

    const ghRe = new RegExp(GITHUB_URL_RE.source, GITHUB_URL_RE.flags);
    while ((match = ghRe.exec(content)) !== null) {
      entities.push({
        text: match[1],
        type: 'project',
        confidence: 0.9,
        source: 'custom',
        position: { file: filePath, section: headingPath, line: startLine },
      });
    }

    const hashRe = new RegExp(HASHTAG_RE.source, HASHTAG_RE.flags);
    while ((match = hashRe.exec(content)) !== null) {
      entities.push({
        text: match[1],
        type: 'tag',
        confidence: 0.8,
        source: 'custom',
        position: { file: filePath, section: headingPath, line: startLine },
      });
    }

    const pkgRe = new RegExp(SCOPED_PKG_RE.source, SCOPED_PKG_RE.flags);
    while ((match = pkgRe.exec(content)) !== null) {
      entities.push({
        text: `@${match[1]}`,
        type: 'tool',
        confidence: 0.8,
        source: 'custom',
        position: { file: filePath, section: headingPath, line: startLine },
      });
    }
  }

  return entities;
}
