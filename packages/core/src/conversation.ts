import type {
  ConversationInput,
  ConversationChunk,
  ConversationMessage,
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
