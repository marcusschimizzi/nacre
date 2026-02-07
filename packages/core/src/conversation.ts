import { randomUUID } from 'node:crypto';
import type {
  ConversationInput,
  ConversationChunk,
  ConversationMessage,
  Episode,
} from './types.js';

export interface ChunkOptions {
  maxMessages?: number;
  maxTokens?: number;
  splitOnTopicChange?: boolean;
}

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_TOKENS = 4000;
const TIME_GAP_MS = 30 * 60 * 1000; // 30 minutes
const CHARS_PER_TOKEN = 4;

function estimateTokens(messages: ConversationMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.content.length + (msg.role.length + 2);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getTimestamp(msg: ConversationMessage): number | null {
  if (!msg.timestamp) return null;
  const t = new Date(msg.timestamp).getTime();
  return Number.isNaN(t) ? null : t;
}

function inferTopic(
  chunk: ConversationMessage[],
  metadata?: ConversationInput['metadata'],
): string | undefined {
  if (metadata?.topic) return metadata.topic;
  const firstUser = chunk.find(m => m.role === 'user');
  if (!firstUser) return undefined;
  const text = firstUser.content.trim();
  if (text.length <= 80) return text;
  return text.slice(0, 77) + '...';
}

export function chunkConversation(
  input: ConversationInput,
  opts?: ChunkOptions,
): ConversationChunk[] {
  const maxMessages = opts?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const messages = input.messages;

  if (messages.length === 0) return [];

  const chunks: ConversationChunk[] = [];
  let current: ConversationMessage[] = [];

  function flushChunk(): void {
    if (current.length === 0) return;

    const startTime = current[0].timestamp;
    const endTime = current[current.length - 1].timestamp;

    chunks.push({
      messages: current,
      startTime,
      endTime,
      topic: inferTopic(current, input.metadata),
    });
    current = [];
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (current.length > 0) {
      const prevTs = getTimestamp(current[current.length - 1]);
      const curTs = getTimestamp(msg);

      if (prevTs !== null && curTs !== null && (curTs - prevTs) > TIME_GAP_MS) {
        flushChunk();
      }
    }

    if (current.length >= maxMessages) {
      // Keep user-assistant pairs together: if the current message is an
      // assistant reply, include it before splitting
      if (msg.role === 'assistant' && current.length > 0 && current[current.length - 1].role === 'user') {
        current.push(msg);
        flushChunk();
        continue;
      }
      flushChunk();
    }

    if (current.length > 0 && estimateTokens([...current, msg]) > maxTokens) {
      if (msg.role === 'assistant' && current.length > 0 && current[current.length - 1].role === 'user') {
        current.push(msg);
        flushChunk();
        continue;
      }
      flushChunk();
    }

    current.push(msg);
  }

  flushChunk();
  return chunks;
}

function formatMessagesAsContent(messages: ConversationMessage[]): string {
  return messages
    .map(m => {
      const speaker = m.name ?? m.role;
      return `[${speaker}]: ${m.content}`;
    })
    .join('\n\n');
}

function generateChunkSummary(messages: ConversationMessage[]): string {
  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');
  const parts: string[] = [];

  if (userMessages.length > 0) {
    parts.push(`${userMessages.length} user message${userMessages.length > 1 ? 's' : ''}`);
  }
  if (assistantMessages.length > 0) {
    parts.push(`${assistantMessages.length} assistant response${assistantMessages.length > 1 ? 's' : ''}`);
  }

  const toolMessages = messages.filter(m => m.role === 'tool');
  if (toolMessages.length > 0) {
    const toolNames = [...new Set(toolMessages.map(m => m.toolName).filter(Boolean))];
    parts.push(`tools: ${toolNames.join(', ') || 'unnamed'}`);
  }

  return `Conversation chunk with ${parts.join(', ')}`;
}

export function chunkToEpisode(
  chunk: ConversationChunk,
  metadata?: ConversationInput['metadata'],
): Episode {
  const now = new Date().toISOString();
  const participants = [
    ...new Set(
      chunk.messages
        .filter(m => m.name && m.role === 'user')
        .map(m => m.name!)
    ),
  ];

  const title = chunk.topic
    ?? metadata?.topic
    ?? chunk.messages.find(m => m.role === 'user')?.content.slice(0, 80)
    ?? 'Untitled conversation';

  return {
    id: `ep_conv_${randomUUID().slice(0, 12)}`,
    timestamp: chunk.startTime ?? now,
    endTimestamp: chunk.endTime,
    type: 'conversation',
    title,
    summary: generateChunkSummary(chunk.messages),
    content: formatMessagesAsContent(chunk.messages),
    sequence: 0,
    participants,
    topics: [],
    importance: 0.5,
    accessCount: 0,
    lastAccessed: now,
    source: metadata?.source ?? metadata?.sessionId ?? 'conversation',
    sourceType: 'conversation',
  };
}
