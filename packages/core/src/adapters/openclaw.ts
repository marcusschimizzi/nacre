import { createHash } from 'node:crypto';
import type {
  ConversationInput,
  ConversationMessage,
  ConversationMessageOrigin,
} from '../types.js';

interface OpenClawRecord {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  agentId?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
  };
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classify(role: string, content: string): ConversationMessageOrigin {
  if (/recent conversation history\s*:/i.test(content)) return 'quoted_context';
  if (/^\s*\[cron:/i.test(content)) return 'cron';
  if (/^\s*\[internal route\b/i.test(content)) return 'internal_route';
  if (role === 'system') return 'system';
  if (role === 'tool' || role === 'toolResult') return 'tool_result';
  return 'direct';
}

function roleOf(role: string): ConversationMessage['role'] {
  if (role === 'tool' || role === 'toolResult') return 'tool';
  if (role === 'assistant' || role === 'system') return role;
  return 'user';
}

function validatedTimestamp(
  value: unknown,
  source: string,
  line: number,
  warnings: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    warnings.push(`${source}:${line}: invalid event timestamp retained in durable raw evidence`);
    return undefined;
  }
  return new Date(value).toISOString();
}

export function fromOpenClaw(
  lines: string[],
  metadata?: ConversationInput['metadata'],
): ConversationInput {
  const messages: ConversationMessage[] = [];
  const warnings: string[] = [];
  const rawEvidence: NonNullable<ConversationInput['rawEvidence']> = [];
  const rawEvidenceLines = new Set<number>();
  let sessionId: string | undefined;
  let agentId: string | undefined;
  const eligibleInstants: number[] = [];
  const source = metadata?.source ?? 'openclaw';
  const retainRaw = (line: number, raw: string, reason: string): void => {
    if (rawEvidenceLines.has(line)) return;
    rawEvidenceLines.add(line);
    rawEvidence.push({ line, raw, reason });
  };

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(
        `${source}:${lineNumber}: malformed JSONL record retained in durable raw evidence`,
      );
      retainRaw(lineNumber, line, 'malformed JSONL record');
      continue;
    }
    if (!isRecord(parsed)) {
      warnings.push(`${source}:${lineNumber}: JSONL record must be an object`);
      retainRaw(lineNumber, line, 'JSONL record must be an object');
      continue;
    }
    const record = parsed as OpenClawRecord;
    if (record.type === 'session') {
      if (typeof record.id !== 'string' || record.id.length === 0) {
        warnings.push(
          `${source}:${lineNumber}: malformed session header retained in durable raw evidence`,
        );
        retainRaw(lineNumber, line, 'malformed session header');
      } else {
        sessionId = record.id;
        agentId = typeof record.agentId === 'string' ? record.agentId : undefined;
      }
      continue;
    }
    if (record.type !== 'message') {
      warnings.push(
        `${source}:${lineNumber}: unknown record type retained in durable raw evidence`,
      );
      retainRaw(lineNumber, line, 'unknown record type');
      continue;
    }
    if (!isRecord(record.message) || typeof record.id !== 'string' || record.id.length === 0) {
      warnings.push(
        `${source}:${lineNumber}: malformed message record retained in durable raw evidence`,
      );
      retainRaw(lineNumber, line, 'malformed message record');
      continue;
    }

    const nested = record.message;
    const blocks = Array.isArray(nested.content) ? nested.content : undefined;
    const textParts: string[] = [];
    const unknownBlocks: unknown[] = [];
    let lossyLine = false;
    if (typeof nested.content === 'string') {
      textParts.push(nested.content);
    } else if (blocks) {
      for (const block of blocks) {
        if (!isRecord(block)) {
          warnings.push(`${source}:${lineNumber}: invalid null/non-object content block retained`);
          unknownBlocks.push(block);
          lossyLine = true;
        } else if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'toolCall') {
          if (typeof block.id !== 'string' || typeof block.name !== 'string') {
            unknownBlocks.push(block);
          }
        } else {
          unknownBlocks.push(block);
          textParts.push(`[unsupported content block] ${JSON.stringify(block)}`);
          warnings.push(
            `${source}:${lineNumber}: unsupported content block "${String(block.type)}" retained`,
          );
        }
      }
    } else if (nested.content !== undefined) {
      unknownBlocks.push(nested.content);
      textParts.push(`[unsupported content] ${JSON.stringify(nested.content)}`);
      warnings.push(`${source}:${lineNumber}: unsupported message content retained`);
    }

    const text = textParts.join('\n');
    if (lossyLine) {
      retainRaw(lineNumber, line, 'invalid content block');
    }
    const role = typeof nested.role === 'string' ? nested.role : 'user';
    const origin = classify(role, text);
    const timestamp = validatedTimestamp(record.timestamp, source, lineNumber, warnings);
    if (record.timestamp !== undefined && timestamp === undefined) {
      retainRaw(lineNumber, line, 'invalid event timestamp');
    }
    const sourceRef = `${source}#L${lineNumber}:${record.id}`;
    messages.push({
      id: record.id,
      ...(typeof record.parentId === 'string' ? { parentId: record.parentId } : {}),
      role: roleOf(role),
      content: text,
      timestamp,
      toolName: typeof nested.toolName === 'string' ? nested.toolName : undefined,
      toolCallId: typeof nested.toolCallId === 'string' ? nested.toolCallId : undefined,
      origin,
      extractionEligible: origin === 'direct',
      sourceRef,
      sourcePosition: { line: lineNumber, ordinal: 0 },
      contentHash: hash(text),
      ...(unknownBlocks.length > 0 ? { rawContentBlocks: unknownBlocks } : {}),
    });
    if (origin === 'direct' && timestamp) eligibleInstants.push(Date.parse(timestamp));

    let toolOrdinal = 0;
    for (const block of blocks ?? []) {
      if (!isRecord(block) || block.type !== 'toolCall') continue;
      if (typeof block.id !== 'string' || typeof block.name !== 'string') {
        warnings.push(
          `${source}:${lineNumber}: malformed toolCall block retained on parent message`,
        );
        retainRaw(lineNumber, line, 'malformed toolCall block');
        continue;
      }
      toolOrdinal++;
      const content = `Called ${block.name}(${JSON.stringify(block.arguments ?? {})})`;
      messages.push({
        id: `${record.id}:tool:${block.id}`,
        parentId: record.id,
        role: 'tool',
        content,
        timestamp,
        toolName: block.name,
        toolCallId: block.id,
        origin: 'tool_call',
        extractionEligible: false,
        sourceRef: `${sourceRef}:tool:${block.id}`,
        sourcePosition: { line: lineNumber, ordinal: toolOrdinal },
        contentHash: hash(content),
      });
    }
  }

  messages.sort((a, b) => {
    const aInstant = a.timestamp === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.timestamp);
    const bInstant = b.timestamp === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.timestamp);
    return (
      aInstant - bInstant ||
      (a.sourcePosition?.line ?? Number.MAX_SAFE_INTEGER) -
        (b.sourcePosition?.line ?? Number.MAX_SAFE_INTEGER) ||
      (a.sourcePosition?.ordinal ?? 0) - (b.sourcePosition?.ordinal ?? 0)
    );
  });

  return {
    messages,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(rawEvidence.length > 0 ? { rawEvidence } : {}),
    metadata: {
      platform: 'openclaw',
      sessionId,
      agentId,
      sourceNamespace: 'openclaw',
      ...(eligibleInstants.length > 0
        ? {
            eventStart: new Date(Math.min(...eligibleInstants)).toISOString(),
            eventEnd: new Date(Math.max(...eligibleInstants)).toISOString(),
          }
        : {}),
      ...metadata,
    },
  };
}
