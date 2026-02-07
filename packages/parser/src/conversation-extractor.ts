import nlp from 'compromise';
import type {
  ConversationChunk,
  ConversationMessage,
  EntityMap,
  EntityType,
  EdgeType,
  RawEntity,
} from '@nacre/core';
import { normalize } from '@nacre/core';

export interface ConversationEntities {
  nodes: Array<{
    label: string;
    type: EntityType;
    mentionedBy: string[];
    excerpts: string[];
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: EdgeType;
    context: string;
  }>;
}

const STOP_WORDS = new Set([
  'the', 'it', 'this', 'that', 'a', 'an', 'is', 'was', 'are', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'also', 'just', 'very',
  'good', 'great', 'well', 'much', 'big', 'day', 'today', 'yes', 'no',
  'ok', 'okay', 'sure', 'thanks', 'thank', 'please', 'hello', 'hi',
  'hey', 'bye', 'yeah', 'yep', 'nope', 'right', 'let', 'me',
]);

const KNOWN_TOOL_PATTERNS = [
  'Claude Code', 'Codex', 'Vite', 'tmux', 'Three.js', 'VS Code',
  'Git', 'Docker', 'Playwright', 'TypeScript', 'JavaScript', 'Node.js',
  'npm', 'React', 'Next.js', 'Bun', 'Webpack', 'ESLint', 'Prettier',
  'SQLite', 'WebGL', 'tsup', 'Hono', 'Express', 'Prisma', 'Python',
  'Rust', 'Go', 'PostgreSQL', 'Redis', 'Kubernetes', 'AWS', 'Terraform',
];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TOOL_REGEXPS = KNOWN_TOOL_PATTERNS.map(tool => ({
  pattern: new RegExp(`\\b${escapeRegex(tool)}\\b`, 'gi'),
  canonical: tool,
}));

const GITHUB_URL_RE = /github\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/g;
const SCOPED_PKG_RE = /@([a-z0-9_-]+\/[a-z0-9_-]+)/g;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const BACKTICK_RE = /`([^`]+)`/g;

function isNoisyCodeEntity(text: string): boolean {
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../') || text.startsWith('~')) return true;
  if (text.startsWith('http://') || text.startsWith('https://')) return true;
  if (text.includes('/') && text.split('/').length > 1) return true;
  if (/\s--/.test(text) || /\s-[a-zA-Z]/.test(text)) return true;
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(text)) return true;
  if (/[{}()=<>&|$+^~;]/.test(text)) return true;
  if (text.length <= 1 || text.length > 40) return true;
  return false;
}

function extractRawEntities(text: string, speaker: string): Array<RawEntity & { speaker: string }> {
  const entities: Array<RawEntity & { speaker: string }> = [];
  const position = { file: 'conversation', section: speaker, line: 0 };

  // NLP extraction
  const doc = nlp(text);

  const people = doc.people().out('array') as string[];
  for (const name of people) {
    const trimmed = name.trim();
    if (trimmed.length <= 2 || STOP_WORDS.has(trimmed.toLowerCase())) continue;
    entities.push({
      text: trimmed, type: 'person', confidence: 0.8, source: 'nlp',
      position, speaker,
    });
  }

  const orgs = doc.organizations().out('array') as string[];
  for (const org of orgs) {
    const trimmed = org.trim();
    if (trimmed.length <= 2 || STOP_WORDS.has(trimmed.toLowerCase())) continue;
    entities.push({
      text: trimmed, type: 'project', confidence: 0.6, source: 'nlp',
      position, speaker,
    });
  }

  // Known tools
  const seenTools = new Set<string>();
  for (const { pattern, canonical } of TOOL_REGEXPS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(text) && !seenTools.has(canonical.toLowerCase())) {
      seenTools.add(canonical.toLowerCase());
      entities.push({
        text: canonical, type: 'tool', confidence: 0.9, source: 'custom',
        position, speaker,
      });
    }
  }

  // Structural: wikilinks
  let match: RegExpExecArray | null;
  const wikiRe = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((match = wikiRe.exec(text)) !== null) {
    entities.push({
      text: match[1].trim(), type: 'concept', confidence: 0.9, source: 'structural',
      position, speaker,
    });
  }

  // Structural: bold
  const boldRe = new RegExp(BOLD_RE.source, BOLD_RE.flags);
  while ((match = boldRe.exec(text)) !== null) {
    const t = match[1].trim();
    if (t.length <= 2 || STOP_WORDS.has(t.toLowerCase())) continue;
    entities.push({
      text: t, type: 'concept', confidence: 0.7, source: 'structural',
      position, speaker,
    });
  }

  // Structural: backtick code
  const codeRe = new RegExp(BACKTICK_RE.source, BACKTICK_RE.flags);
  while ((match = codeRe.exec(text)) !== null) {
    const t = match[1].trim();
    if (isNoisyCodeEntity(t)) continue;
    entities.push({
      text: t, type: 'tool', confidence: 0.7, source: 'structural',
      position, speaker,
    });
  }

  // GitHub URLs
  const ghRe = new RegExp(GITHUB_URL_RE.source, GITHUB_URL_RE.flags);
  while ((match = ghRe.exec(text)) !== null) {
    entities.push({
      text: match[1], type: 'project', confidence: 0.9, source: 'custom',
      position, speaker,
    });
  }

  // Scoped packages
  const pkgRe = new RegExp(SCOPED_PKG_RE.source, SCOPED_PKG_RE.flags);
  while ((match = pkgRe.exec(text)) !== null) {
    entities.push({
      text: `@${match[1]}`, type: 'tool', confidence: 0.8, source: 'custom',
      position, speaker,
    });
  }

  return entities;
}

export function extractFromConversation(
  chunk: ConversationChunk,
  entityMap?: EntityMap,
): ConversationEntities {
  const allRaw: Array<RawEntity & { speaker: string }> = [];

  for (const msg of chunk.messages) {
    if (msg.role === 'system') continue;

    const speaker = msg.name ?? msg.role;
    const raw = extractRawEntities(msg.content, speaker);
    allRaw.push(...raw);

    // Extract tool names as entities
    if (msg.role === 'tool' && msg.toolName) {
      allRaw.push({
        text: msg.toolName,
        type: 'tool',
        confidence: 0.95,
        source: 'custom',
        position: { file: 'conversation', section: speaker, line: 0 },
        speaker,
      });
    }

    // Extract participant names
    if (msg.name && msg.role === 'user') {
      allRaw.push({
        text: msg.name,
        type: 'person',
        confidence: 0.95,
        source: 'custom',
        position: { file: 'conversation', section: speaker, line: 0 },
        speaker,
      });
    }
  }

  // Deduplicate: keep highest confidence per normalized text
  const deduped = new Map<string, RawEntity & { speaker: string; speakers: string[] }>();
  for (const entity of allRaw) {
    const key = normalize(entity.text);
    if (STOP_WORDS.has(key)) continue;
    if (entityMap?.ignore?.includes(key)) continue;

    const canonical = entityMap?.aliases?.[key] ?? entity.text;
    const ckey = normalize(canonical);

    const existing = deduped.get(ckey);
    if (existing) {
      if (entity.confidence > existing.confidence) {
        existing.text = canonical;
        existing.confidence = entity.confidence;
        existing.type = entity.type;
      }
      if (!existing.speakers.includes(entity.speaker)) {
        existing.speakers.push(entity.speaker);
      }
    } else {
      deduped.set(ckey, { ...entity, text: canonical, speakers: [entity.speaker] });
    }
  }

  const nodes: ConversationEntities['nodes'] = [];
  const entityLabels: string[] = [];

  for (const [, entity] of deduped) {
    const e = entity as RawEntity & { speaker: string; speakers: string[] };
    nodes.push({
      label: e.text,
      type: e.type,
      mentionedBy: e.speakers,
      excerpts: chunk.messages
        .filter((m: ConversationMessage) => m.content.toLowerCase().includes(normalize(e.text)))
        .slice(0, 3)
        .map((m: ConversationMessage) => m.content.slice(0, 200)),
    });
    entityLabels.push(e.text);
  }

  // Create co-occurrence edges between entities found in same chunk
  const edges: ConversationEntities['edges'] = [];
  for (let i = 0; i < entityLabels.length; i++) {
    for (let j = i + 1; j < entityLabels.length; j++) {
      edges.push({
        source: entityLabels[i],
        target: entityLabels[j],
        type: 'co-occurrence',
        context: `co-mentioned in conversation${chunk.topic ? `: ${chunk.topic}` : ''}`,
      });
    }
  }

  return { nodes, edges };
}
