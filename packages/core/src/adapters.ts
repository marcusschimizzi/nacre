import type { ConversationInput, ConversationMessage } from './types.js';

// ── OpenAI / ChatGPT Format ─────────────────────────────────────

export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'function';
  content: string | null;
  name?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function fromOpenAI(
  messages: OpenAIMessage[],
  metadata?: ConversationInput['metadata'],
): ConversationInput {
  const converted: ConversationMessage[] = [];

  for (const msg of messages) {
    if (msg.content === null && !msg.tool_calls) continue;

    const role = msg.role === 'function' ? 'tool' : msg.role;

    converted.push({
      role: role as ConversationMessage['role'],
      content: msg.content ?? '',
      name: msg.name,
      toolCallId: msg.tool_call_id,
      toolName: msg.role === 'function' ? msg.name : undefined,
    });

    if (msg.tool_calls) {
      for (const call of msg.tool_calls) {
        converted.push({
          role: 'tool',
          content: `Called ${call.function.name}(${call.function.arguments})`,
          toolName: call.function.name,
          toolCallId: call.id,
        });
      }
    }
  }

  return {
    messages: converted,
    metadata: { platform: 'openai', ...metadata },
  };
}

// ── Anthropic Claude Format ─────────────────────────────────────

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export function fromAnthropic(
  messages: AnthropicMessage[],
  metadata?: ConversationInput['metadata'],
): ConversationInput {
  const converted: ConversationMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      converted.push({ role: msg.role, content: msg.content });
      continue;
    }

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        converted.push({ role: msg.role, content: block.text });
      } else if (block.type === 'tool_use' && block.name) {
        converted.push({
          role: 'tool',
          content: `Called ${block.name}(${JSON.stringify(block.input ?? {})})`,
          toolName: block.name,
          toolCallId: block.id,
        });
      } else if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : '';
        converted.push({
          role: 'tool',
          content: text,
          toolCallId: block.tool_use_id,
        });
      }
    }
  }

  return {
    messages: converted,
    metadata: { platform: 'anthropic', ...metadata },
  };
}

// ── Clawdbot Session Format ─────────────────────────────────────

export interface ClawdbotMessage {
  role: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ClawdbotSession {
  id: string;
  agent?: string;
  messages: ClawdbotMessage[];
  created_at?: string;
  updated_at?: string;
}

export function fromClawdbot(
  session: ClawdbotSession,
  metadata?: ConversationInput['metadata'],
): ConversationInput {
  const converted: ConversationMessage[] = [];

  for (const msg of session.messages) {
    const role = (['user', 'assistant', 'system', 'tool'].includes(msg.role)
      ? msg.role
      : 'user') as ConversationMessage['role'];

    converted.push({
      role,
      content: msg.content,
      timestamp: msg.timestamp,
    });
  }

  return {
    messages: converted,
    metadata: {
      platform: 'clawdbot',
      sessionId: session.id,
      ...metadata,
    },
  };
}

// ── JSONL Format (one message per line) ─────────────────────────

export interface JSONLMessage {
  role?: string;
  content?: string;
  text?: string;
  message?: string;
  timestamp?: string;
  name?: string;
}

export function fromJSONL(
  lines: string[],
  metadata?: ConversationInput['metadata'],
): ConversationInput {
  const converted: ConversationMessage[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: JSONLMessage;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const content = parsed.content ?? parsed.text ?? parsed.message ?? '';
    if (!content) continue;

    const role = (['user', 'assistant', 'system', 'tool'].includes(parsed.role ?? '')
      ? parsed.role
      : 'user') as ConversationMessage['role'];

    converted.push({
      role,
      content,
      timestamp: parsed.timestamp,
      name: parsed.name,
    });
  }

  return {
    messages: converted,
    metadata: { platform: 'jsonl', ...metadata },
  };
}

// ── Auto-detect Format ──────────────────────────────────────────

export type ConversationFormat = 'openai' | 'anthropic' | 'clawdbot' | 'jsonl' | 'auto' | 'nacre';

export function detectFormat(data: unknown): ConversationFormat {
  if (typeof data !== 'object' || data === null) return 'jsonl';

  const obj = data as Record<string, unknown>;

  if (obj.agent && Array.isArray(obj.messages)) return 'clawdbot';

  if (obj.messages && Array.isArray(obj.messages)) {
    const msgs = obj.messages as Array<Record<string, unknown>>;
    if (msgs.length === 0) return 'nacre';

    const first = msgs[0];

    if (first.tool_calls || first.tool_call_id) return 'openai';

    if (Array.isArray(first.content) && typeof first.content !== 'string') {
      const blocks = first.content as Array<Record<string, unknown>>;
      if (blocks.some(b => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'text')) {
        return 'anthropic';
      }
    }

    if (first.role && typeof first.content === 'string') return 'openai';

    return 'nacre';
  }

  return 'jsonl';
}

export function parseConversationFile(
  content: string,
  format: ConversationFormat = 'auto',
  metadata?: ConversationInput['metadata'],
): ConversationInput {
  if (format === 'jsonl') {
    return fromJSONL(content.split('\n'), metadata);
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return fromJSONL(content.split('\n'), metadata);
  }

  const detectedFormat = format === 'auto' ? detectFormat(data) : format;

  switch (detectedFormat) {
    case 'openai': {
      const obj = data as { messages?: OpenAIMessage[] } | OpenAIMessage[];
      const msgs = Array.isArray(obj) ? obj : (obj.messages ?? []);
      return fromOpenAI(msgs, metadata);
    }
    case 'anthropic': {
      const obj = data as { messages?: AnthropicMessage[] } | AnthropicMessage[];
      const msgs = Array.isArray(obj) ? obj : (obj.messages ?? []);
      return fromAnthropic(msgs, metadata);
    }
    case 'clawdbot': {
      return fromClawdbot(data as ClawdbotSession, metadata);
    }
    case 'nacre': {
      const obj = data as ConversationInput;
      if (metadata) {
        obj.metadata = { ...obj.metadata, ...metadata };
      }
      return obj;
    }
    default:
      return fromJSONL(content.split('\n'), metadata);
  }
}
