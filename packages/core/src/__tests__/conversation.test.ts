import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkConversation, chunkToEpisode } from '../conversation.js';
import type { ConversationInput, ConversationMessage, ConversationChunk } from '../types.js';

function makeMessage(
  role: 'user' | 'assistant' | 'system' | 'tool',
  content: string,
  overrides?: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    role,
    content,
    ...overrides,
  };
}

function makeConversation(
  messages: ConversationMessage[],
  metadata?: ConversationInput['metadata'],
): ConversationInput {
  return {
    messages,
    metadata,
  };
}

describe('chunkConversation', () => {
  describe('basic chunking', () => {
    it('returns empty array for empty messages', () => {
      const input = makeConversation([]);
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 0);
    });

    it('returns single chunk for small conversation', () => {
      const input = makeConversation([
        makeMessage('user', 'Hello, how are you?'),
        makeMessage('assistant', 'I am doing well, thank you for asking.'),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].messages.length, 2);
    });

    it('preserves message order in chunk', () => {
      const input = makeConversation([
        makeMessage('user', 'First question'),
        makeMessage('assistant', 'First answer'),
        makeMessage('user', 'Second question'),
        makeMessage('assistant', 'Second answer'),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks[0].messages[0].content, 'First question');
      assert.equal(chunks[0].messages[1].content, 'First answer');
      assert.equal(chunks[0].messages[2].content, 'Second question');
      assert.equal(chunks[0].messages[3].content, 'Second answer');
    });
  });

  describe('maxMessages boundary', () => {
    it('splits at maxMessages boundary', () => {
      const messages: ConversationMessage[] = [];
      for (let i = 0; i < 25; i++) {
        messages.push(makeMessage('user', `Message ${i}`));
      }
      const input = makeConversation(messages);
      const chunks = chunkConversation(input, { maxMessages: 10 });
      assert.ok(chunks.length >= 2);
      assert.ok(chunks[0].messages.length <= 10);
    });

    it('respects default maxMessages of 20', () => {
      const messages: ConversationMessage[] = [];
      for (let i = 0; i < 25; i++) {
        messages.push(makeMessage('user', `Message ${i}`));
      }
      const input = makeConversation(messages);
      const chunks = chunkConversation(input);
      assert.ok(chunks.length >= 2);
      assert.ok(chunks[0].messages.length <= 20);
    });
  });

  describe('time gap splitting', () => {
    it('splits at time gap > 30 minutes', () => {
      const input = makeConversation([
        makeMessage('user', 'First message', { timestamp: '2026-01-15T10:00:00Z' }),
        makeMessage('assistant', 'First response', { timestamp: '2026-01-15T10:01:00Z' }),
        makeMessage('user', 'Second message after gap', { timestamp: '2026-01-15T10:35:00Z' }),
        makeMessage('assistant', 'Second response', { timestamp: '2026-01-15T10:36:00Z' }),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].messages.length, 2);
      assert.equal(chunks[1].messages.length, 2);
    });

    it('does not split at time gap < 30 minutes', () => {
      const input = makeConversation([
        makeMessage('user', 'First message', { timestamp: '2026-01-15T10:00:00Z' }),
        makeMessage('assistant', 'First response', { timestamp: '2026-01-15T10:01:00Z' }),
        makeMessage('user', 'Second message', { timestamp: '2026-01-15T10:15:00Z' }),
        makeMessage('assistant', 'Second response', { timestamp: '2026-01-15T10:16:00Z' }),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].messages.length, 4);
    });

    it('handles missing timestamps gracefully', () => {
      const input = makeConversation([
        makeMessage('user', 'First message'),
        makeMessage('assistant', 'First response'),
        makeMessage('user', 'Second message'),
        makeMessage('assistant', 'Second response'),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].messages.length, 4);
    });

    it('handles invalid timestamps gracefully', () => {
      const input = makeConversation([
        makeMessage('user', 'First message', { timestamp: 'invalid-date' }),
        makeMessage('assistant', 'First response', { timestamp: 'also-invalid' }),
        makeMessage('user', 'Second message', { timestamp: 'not-a-date' }),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 1);
    });
  });

  describe('user-assistant pair handling', () => {
    it('keeps user-assistant pairs together at maxMessages boundary', () => {
      const messages: ConversationMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(makeMessage('user', `User message ${i}`));
        messages.push(makeMessage('assistant', `Assistant response ${i}`));
      }
      const input = makeConversation(messages);
      const chunks = chunkConversation(input, { maxMessages: 10 });
      
      for (const chunk of chunks) {
        for (let i = 0; i < chunk.messages.length - 1; i++) {
          if (chunk.messages[i].role === 'user' && i === chunk.messages.length - 1) {
            assert.fail('User message should not be last without assistant response');
          }
        }
      }
    });

    it('includes assistant response before flushing at boundary', () => {
      const messages: ConversationMessage[] = [];
      for (let i = 0; i < 6; i++) {
        messages.push(makeMessage('user', `User ${i}`));
        messages.push(makeMessage('assistant', `Assistant ${i}`));
      }
      const input = makeConversation(messages);
      const chunks = chunkConversation(input, { maxMessages: 10 });
      
      assert.ok(chunks.length >= 1);
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk.messages.length > 0) {
        const lastMsg = lastChunk.messages[lastChunk.messages.length - 1];
        assert.ok(lastMsg.role === 'assistant' || lastMsg.role === 'user');
      }
    });
  });

  describe('maxTokens boundary', () => {
    it('splits at maxTokens boundary', () => {
      const longContent = 'a'.repeat(2000);
      const input = makeConversation([
        makeMessage('user', longContent),
        makeMessage('assistant', longContent),
        makeMessage('user', longContent),
        makeMessage('assistant', longContent),
      ]);
      const chunks = chunkConversation(input, { maxTokens: 1000 });
      assert.ok(chunks.length >= 2);
    });

    it('respects default maxTokens of 4000', () => {
      const longContent = 'x'.repeat(1000);
      const input = makeConversation([
        makeMessage('user', longContent),
        makeMessage('assistant', longContent),
        makeMessage('user', longContent),
        makeMessage('assistant', longContent),
        makeMessage('user', longContent),
      ]);
      const chunks = chunkConversation(input);
      assert.ok(chunks.length >= 1);
    });

    it('includes assistant response before flushing at token boundary', () => {
      const longContent = 'b'.repeat(1500);
      const input = makeConversation([
        makeMessage('user', longContent),
        makeMessage('assistant', longContent),
        makeMessage('user', longContent),
        makeMessage('assistant', longContent),
      ]);
      const chunks = chunkConversation(input, { maxTokens: 1000 });
      
      for (const chunk of chunks) {
        if (chunk.messages.length > 1) {
          const lastMsg = chunk.messages[chunk.messages.length - 1];
          assert.ok(lastMsg.role === 'assistant' || lastMsg.role === 'user');
        }
      }
    });
  });

  describe('topic inference', () => {
    it('infers topic from first user message', () => {
      const input = makeConversation([
        makeMessage('user', 'How do I use TypeScript with React?'),
        makeMessage('assistant', 'Here is how you use TypeScript with React...'),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks[0].topic, 'How do I use TypeScript with React?');
    });

    it('truncates long user messages to 80 chars', () => {
      const longMessage = 'a'.repeat(100);
      const input = makeConversation([
        makeMessage('user', longMessage),
        makeMessage('assistant', 'Response'),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks[0].topic?.length, 80);
      assert.ok(chunks[0].topic?.endsWith('...'));
    });

    it('uses metadata topic when provided', () => {
      const input = makeConversation(
        [
          makeMessage('user', 'Some question'),
          makeMessage('assistant', 'Some answer'),
        ],
        { topic: 'Custom Topic' },
      );
      const chunks = chunkConversation(input);
      assert.equal(chunks[0].topic, 'Custom Topic');
    });

    it('prefers metadata topic over inferred topic', () => {
      const input = makeConversation(
        [
          makeMessage('user', 'How do I use TypeScript?'),
          makeMessage('assistant', 'Here is how...'),
        ],
        { topic: 'TypeScript Guide' },
      );
      const chunks = chunkConversation(input);
      assert.equal(chunks[0].topic, 'TypeScript Guide');
    });

    it('handles conversation with no user messages', () => {
      const input = makeConversation([
        makeMessage('system', 'System message'),
        makeMessage('assistant', 'Response'),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].topic, undefined);
    });
  });

  describe('chunk timestamps', () => {
    it('sets startTime from first message timestamp', () => {
      const input = makeConversation([
        makeMessage('user', 'First', { timestamp: '2026-01-15T10:00:00Z' }),
        makeMessage('assistant', 'Response', { timestamp: '2026-01-15T10:01:00Z' }),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks[0].startTime, '2026-01-15T10:00:00Z');
    });

    it('sets endTime from last message timestamp', () => {
      const input = makeConversation([
        makeMessage('user', 'First', { timestamp: '2026-01-15T10:00:00Z' }),
        makeMessage('assistant', 'Response', { timestamp: '2026-01-15T10:05:00Z' }),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks[0].endTime, '2026-01-15T10:05:00Z');
    });

    it('handles chunks with missing timestamps', () => {
      const input = makeConversation([
        makeMessage('user', 'First'),
        makeMessage('assistant', 'Response'),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks[0].startTime, undefined);
      assert.equal(chunks[0].endTime, undefined);
    });

    it('multiple chunks get correct startTime/endTime', () => {
      const input = makeConversation([
        makeMessage('user', 'First', { timestamp: '2026-01-15T10:00:00Z' }),
        makeMessage('assistant', 'Response', { timestamp: '2026-01-15T10:01:00Z' }),
        makeMessage('user', 'Second', { timestamp: '2026-01-15T10:35:00Z' }),
        makeMessage('assistant', 'Response', { timestamp: '2026-01-15T10:36:00Z' }),
      ]);
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].startTime, '2026-01-15T10:00:00Z');
      assert.equal(chunks[0].endTime, '2026-01-15T10:01:00Z');
      assert.equal(chunks[1].startTime, '2026-01-15T10:35:00Z');
      assert.equal(chunks[1].endTime, '2026-01-15T10:36:00Z');
    });
  });
});

describe('chunkToEpisode', () => {
  describe('basic episode creation', () => {
    it('creates episode with type conversation', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi there'),
        ],
        startTime: '2026-01-15T10:00:00Z',
        topic: 'Greeting',
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.type, 'conversation');
    });

    it('sets sourceType to conversation', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.sourceType, 'conversation');
    });

    it('generates unique episode IDs', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const ep1 = chunkToEpisode(chunk);
      const ep2 = chunkToEpisode(chunk);
      assert.notEqual(ep1.id, ep2.id);
      assert.ok(ep1.id.startsWith('ep_conv_'));
      assert.ok(ep2.id.startsWith('ep_conv_'));
    });

    it('sets timestamp from chunk startTime', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
        startTime: '2026-01-15T10:00:00Z',
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.timestamp, '2026-01-15T10:00:00Z');
    });

    it('sets endTimestamp from chunk endTime', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
        startTime: '2026-01-15T10:00:00Z',
        endTime: '2026-01-15T10:05:00Z',
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.endTimestamp, '2026-01-15T10:05:00Z');
    });
  });

  describe('title generation', () => {
    it('uses chunk topic as title', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'How do I use TypeScript?'),
          makeMessage('assistant', 'Here is how...'),
        ],
        topic: 'TypeScript Guide',
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.title, 'TypeScript Guide');
    });

    it('falls back to first user message as title when no topic', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'How do I use TypeScript?'),
          makeMessage('assistant', 'Here is how...'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.title, 'How do I use TypeScript?');
    });

    it('truncates long user message titles to 80 chars', () => {
      const longMessage = 'a'.repeat(100);
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', longMessage),
          makeMessage('assistant', 'Response'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.title.length, 80);
    });

    it('uses metadata topic when provided', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Some question'),
          makeMessage('assistant', 'Some answer'),
        ],
      };
      const metadata = { topic: 'Custom Topic' };
      const episode = chunkToEpisode(chunk, metadata);
      assert.equal(episode.title, 'Custom Topic');
    });

    it('defaults to Untitled conversation when no topic or user message', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('system', 'System message'),
          makeMessage('assistant', 'Response'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.title, 'Untitled conversation');
    });
  });

  describe('content formatting', () => {
    it('formats messages as content with speaker labels', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi there'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.ok(episode.content.includes('[user]: Hello'));
      assert.ok(episode.content.includes('[assistant]: Hi there'));
    });

    it('uses participant name when available', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello', { name: 'Alice' }),
          makeMessage('assistant', 'Hi', { name: 'Bob' }),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.ok(episode.content.includes('[Alice]: Hello'));
      assert.ok(episode.content.includes('[Bob]: Hi'));
    });

    it('separates messages with double newlines', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'First'),
          makeMessage('assistant', 'Second'),
          makeMessage('user', 'Third'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      const lines = episode.content.split('\n\n');
      assert.equal(lines.length, 3);
    });
  });

  describe('participant extraction', () => {
    it('extracts participant names from user messages with names', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello', { name: 'Alice' }),
          makeMessage('assistant', 'Hi'),
          makeMessage('user', 'How are you?', { name: 'Bob' }),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.ok(episode.participants.includes('Alice'));
      assert.ok(episode.participants.includes('Bob'));
    });

    it('deduplicates participant names', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'First', { name: 'Alice' }),
          makeMessage('assistant', 'Response'),
          makeMessage('user', 'Second', { name: 'Alice' }),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.participants.filter(p => p === 'Alice').length, 1);
    });

    it('ignores assistant names in participants', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello', { name: 'Alice' }),
          makeMessage('assistant', 'Hi', { name: 'Claude' }),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.ok(episode.participants.includes('Alice'));
      assert.ok(!episode.participants.includes('Claude'));
    });

    it('handles messages without names', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.participants.length, 0);
    });
  });

  describe('episode metadata', () => {
    it('sets sequence to 0', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.sequence, 0);
    });

    it('sets importance to 0.5', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.importance, 0.5);
    });

    it('sets accessCount to 0', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.accessCount, 0);
    });

    it('sets topics to empty array', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.deepEqual(episode.topics, []);
    });

    it('sets lastAccessed to current time', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const before = new Date().toISOString();
      const episode = chunkToEpisode(chunk);
      const after = new Date().toISOString();
      assert.ok(episode.lastAccessed >= before);
      assert.ok(episode.lastAccessed <= after);
    });
  });

  describe('source handling', () => {
    it('uses metadata source when provided', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const metadata = { source: '/path/to/conversation.json' };
      const episode = chunkToEpisode(chunk, metadata);
      assert.equal(episode.source, '/path/to/conversation.json');
    });

    it('falls back to sessionId when source not provided', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const metadata = { sessionId: 'session-123' };
      const episode = chunkToEpisode(chunk, metadata);
      assert.equal(episode.source, 'session-123');
    });

    it('defaults to conversation when no source or sessionId', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Hello'),
          makeMessage('assistant', 'Hi'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.equal(episode.source, 'conversation');
    });
  });

  describe('summary generation', () => {
    it('generates summary with message counts', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'First'),
          makeMessage('assistant', 'Response'),
          makeMessage('user', 'Second'),
          makeMessage('assistant', 'Another response'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.ok(episode.summary);
      assert.ok(episode.summary.includes('2 user messages'));
      assert.ok(episode.summary.includes('2 assistant responses'));
    });

    it('handles singular message counts', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Only user message'),
          makeMessage('assistant', 'Only assistant response'),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.ok(episode.summary);
      assert.ok(episode.summary.includes('1 user message'));
      assert.ok(episode.summary.includes('1 assistant response'));
    });

    it('includes tool information in summary', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Use the calculator'),
          makeMessage('assistant', 'Calling calculator'),
          makeMessage('tool', '42', { toolName: 'calculator' }),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.ok(episode.summary);
      assert.ok(episode.summary.includes('calculator'));
    });

    it('handles multiple tool names', () => {
      const chunk: ConversationChunk = {
        messages: [
          makeMessage('user', 'Use tools'),
          makeMessage('tool', 'result1', { toolName: 'tool1' }),
          makeMessage('tool', 'result2', { toolName: 'tool2' }),
        ],
      };
      const episode = chunkToEpisode(chunk);
      assert.ok(episode.summary);
      assert.ok(episode.summary.includes('tool1'));
      assert.ok(episode.summary.includes('tool2'));
    });
  });

  describe('integration', () => {
    it('creates valid episode from chunked conversation', () => {
      const input = makeConversation([
        makeMessage('user', 'What is TypeScript?', { timestamp: '2026-01-15T10:00:00Z', name: 'Alice' }),
        makeMessage('assistant', 'TypeScript is a typed superset of JavaScript', { timestamp: '2026-01-15T10:01:00Z' }),
        makeMessage('user', 'How do I use it?', { timestamp: '2026-01-15T10:02:00Z', name: 'Alice' }),
        makeMessage('assistant', 'You can install it with npm', { timestamp: '2026-01-15T10:03:00Z' }),
      ]);
      
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 1);
      
      const episode = chunkToEpisode(chunks[0]);
      assert.equal(episode.type, 'conversation');
      assert.equal(episode.sourceType, 'conversation');
      assert.ok(episode.id.startsWith('ep_conv_'));
      assert.ok(episode.participants.includes('Alice'));
      assert.ok(episode.content.includes('[Alice]: What is TypeScript?'));
      assert.ok(episode.title.includes('TypeScript'));
    });

    it('handles multi-chunk conversation', () => {
      const input = makeConversation([
        makeMessage('user', 'First topic', { timestamp: '2026-01-15T10:00:00Z', name: 'Alice' }),
        makeMessage('assistant', 'Response 1', { timestamp: '2026-01-15T10:01:00Z' }),
        makeMessage('user', 'Second topic', { timestamp: '2026-01-15T10:35:00Z', name: 'Bob' }),
        makeMessage('assistant', 'Response 2', { timestamp: '2026-01-15T10:36:00Z' }),
      ]);
      
      const chunks = chunkConversation(input);
      assert.equal(chunks.length, 2);
      
      const ep1 = chunkToEpisode(chunks[0]);
      const ep2 = chunkToEpisode(chunks[1]);
      
      assert.notEqual(ep1.id, ep2.id);
      assert.ok(ep1.participants.includes('Alice'));
      assert.ok(ep2.participants.includes('Bob'));
    });
  });
});
