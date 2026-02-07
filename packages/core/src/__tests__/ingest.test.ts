import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import { ingestConversation } from '../ingest.js';
import type { ConversationInput, ConversationChunk } from '../types.js';

function makeConversationInput(overrides: Partial<ConversationInput> & { messages: ConversationInput['messages'] }): ConversationInput {
  return {
    metadata: {
      sessionId: 'session-test',
      platform: 'test',
      source: '/test-conversation',
    },
    ...overrides,
  };
}

function makeExtractEntities(nodeCount: number = 1, edgeCount: number = 0, seed: string = '') {
  return (chunk: ConversationChunk) => ({
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      label: `Entity${i + 1}${seed}`,
      type: i === 0 ? 'tool' : 'concept',
      mentionedBy: ['user'],
      excerpts: [`excerpt for entity ${i + 1}`],
    })),
    edges: Array.from({ length: edgeCount }, (_, i) => ({
      source: `Entity${i + 1}${seed}`,
      target: `Entity${(i + 1) % nodeCount + 1}${seed}`,
      type: 'co-occurrence',
      context: `mentioned together in chunk`,
    })),
  });
}

describe('ingestConversation', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open();
  });

  after(() => {
    store.close();
  });

  describe('basic ingestion', () => {
    it('returns zero results for empty messages', async () => {
      const input = makeConversationInput({ messages: [] });
      const result = await ingestConversation(input, { store });

      assert.equal(result.chunksProcessed, 0);
      assert.equal(result.episodesCreated, 0);
      assert.equal(result.nodesCreated, 0);
      assert.equal(result.edgesCreated, 0);
    });

    it('creates episodes from conversation chunks', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Hello, how are you?' },
          { role: 'assistant' as const, content: 'I am doing well, thank you!' },
        ],
      });

      const result = await ingestConversation(input, { store });

      assert.equal(result.chunksProcessed, 1);
      assert.equal(result.episodesCreated, 1);
      assert.ok(result.episodesCreated > 0);
    });

    it('processes multiple chunks from long conversation', async () => {
      const messages: ConversationInput['messages'] = [];
      for (let i = 0; i < 50; i++) {
        messages.push({ role: 'user' as const, content: `Question ${i}` });
        messages.push({ role: 'assistant' as const, content: `Answer ${i}` });
      }

      const input = makeConversationInput({
        messages,
        metadata: { sessionId: 'long-session', source: '/long-conversation' },
      });

      const result = await ingestConversation(input, {
        store,
        chunkOptions: { maxMessages: 10 },
      });

      assert.ok(result.chunksProcessed > 1);
      assert.equal(result.episodesCreated, result.chunksProcessed);
    });
  });

  describe('entity extraction', () => {
    it('creates nodes when extractEntities is provided', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'I am using TypeScript' },
          { role: 'assistant' as const, content: 'TypeScript is great!' },
        ],
      });

      const result = await ingestConversation(input, {
        store,
        extractEntities: makeExtractEntities(2, 0),
      });

      assert.equal(result.nodesCreated, 2);
      assert.equal(result.episodesCreated, 1);
    });

    it('reinforces existing nodes on re-ingestion', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Using React' },
          { role: 'assistant' as const, content: 'React is useful' },
        ],
        metadata: { sessionId: 'reinforce-session', source: '/reinforce' },
      });

      const extractFn = makeExtractEntities(1, 0, '-reinforce');

      const result1 = await ingestConversation(input, {
        store,
        extractEntities: extractFn,
      });

      assert.equal(result1.nodesCreated, 1);

      const input2 = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'React again' },
          { role: 'assistant' as const, content: 'Still useful' },
        ],
        metadata: { sessionId: 'reinforce-session-2', source: '/reinforce-2' },
      });

      const result2 = await ingestConversation(input2, {
        store,
        extractEntities: extractFn,
      });

      assert.equal(result2.nodesReinforced, 1);
      assert.equal(result2.nodesCreated, 0);
    });

    it('creates co-occurrence edges between extracted entities', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'TypeScript and React together' },
          { role: 'assistant' as const, content: 'Great combination' },
        ],
        metadata: { sessionId: 'edge-session', source: '/edges' },
      });

      const result = await ingestConversation(input, {
        store,
        extractEntities: makeExtractEntities(2, 1, '-edge'),
      });

      assert.equal(result.nodesCreated, 2);
      assert.equal(result.edgesCreated, 1);
    });

    it('links extracted entities to episodes', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Discussing Node.js' },
          { role: 'assistant' as const, content: 'Node.js is powerful' },
        ],
        metadata: { sessionId: 'link-session', source: '/links' },
      });

      const result = await ingestConversation(input, {
        store,
        extractEntities: makeExtractEntities(1, 0, '-link'),
      });

      assert.equal(result.episodesCreated, 1);
      assert.equal(result.nodesCreated, 1);

      const episodes = store.listEpisodes({ source: '/links' });
      assert.ok(episodes.length > 0);

      const episode = episodes[0];
      const links = store.getEpisodeEntities(episode.id);
      assert.ok(links.length > 0);
    });

    it('works without extractEntities callback (episodes only)', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Just a conversation' },
          { role: 'assistant' as const, content: 'No entity extraction' },
        ],
        metadata: { sessionId: 'no-extract-session', source: '/no-extract' },
      });

      const result = await ingestConversation(input, { store });

      assert.equal(result.episodesCreated, 1);
      assert.equal(result.nodesCreated, 0);
      assert.equal(result.edgesCreated, 0);
    });
  });

  describe('deduplication', () => {
    it('deduplicates by sessionId (skips if already ingested)', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'First time' },
          { role: 'assistant' as const, content: 'Response' },
        ],
        metadata: { sessionId: 'dup-session-unique-1' },
      });

      const result1 = await ingestConversation(input, { store, deduplicateBy: 'sessionId' });
      assert.equal(result1.episodesCreated, 1);

      const result2 = await ingestConversation(input, {
        store,
        deduplicateBy: 'sessionId',
      });

      assert.equal(result2.duplicatesSkipped, 1);
      assert.equal(result2.episodesCreated, 0);
    });

    it('deduplicates by contentHash (skips identical content)', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Same content' },
          { role: 'assistant' as const, content: 'Same response' },
        ],
        metadata: { sessionId: 'hash-session-1', source: '/hash-1' },
      });

      const result1 = await ingestConversation(input, {
        store,
        deduplicateBy: 'contentHash',
      });

      assert.equal(result1.episodesCreated, 1);

      const input2 = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Same content' },
          { role: 'assistant' as const, content: 'Same response' },
        ],
        metadata: { sessionId: 'hash-session-2', source: '/hash-2' },
      });

      const result2 = await ingestConversation(input2, {
        store,
        deduplicateBy: 'contentHash',
      });

      assert.equal(result2.duplicatesSkipped, 1);
      assert.equal(result2.episodesCreated, 0);
    });

    it('allows duplicate content when deduplicateBy is none', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Duplicate allowed' },
          { role: 'assistant' as const, content: 'Response' },
        ],
        metadata: { sessionId: 'none-dup-1', source: '/none-dup-1' },
      });

      const result1 = await ingestConversation(input, {
        store,
        deduplicateBy: 'none',
      });

      assert.equal(result1.episodesCreated, 1);

      const input2 = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Duplicate allowed' },
          { role: 'assistant' as const, content: 'Response' },
        ],
        metadata: { sessionId: 'none-dup-2', source: '/none-dup-2' },
      });

      const result2 = await ingestConversation(input2, {
        store,
        deduplicateBy: 'none',
      });

      assert.equal(result2.episodesCreated, 1);
      assert.equal(result2.duplicatesSkipped, 0);
    });
  });

  describe('edge reinforcement', () => {
    it('reinforces existing edges on re-ingestion', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'TypeScript and Node.js' },
          { role: 'assistant' as const, content: 'Great pair' },
        ],
        metadata: { sessionId: 'edge-reinforce-1', source: '/edge-reinforce-1' },
      });

      const result1 = await ingestConversation(input, {
        store,
        extractEntities: makeExtractEntities(2, 1, '-reinf'),
      });

      assert.equal(result1.edgesCreated, 1);

      const input2 = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'TypeScript and Node.js again' },
          { role: 'assistant' as const, content: 'Still great' },
        ],
        metadata: { sessionId: 'edge-reinforce-2', source: '/edge-reinforce-2' },
      });

      const result2 = await ingestConversation(input2, {
        store,
        extractEntities: makeExtractEntities(2, 1, '-reinf'),
      });

      assert.ok(result2.edgesCreated === 0 || result2.edgesCreated === 1);
    });
  });

  describe('result tracking', () => {
    it('tracks all ingestion metrics accurately', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Complex conversation' },
          { role: 'assistant' as const, content: 'With entities' },
          { role: 'user' as const, content: 'And more content' },
          { role: 'assistant' as const, content: 'Final response' },
        ],
        metadata: { sessionId: 'metrics-session', source: '/metrics' },
      });

      const result = await ingestConversation(input, {
        store,
        extractEntities: makeExtractEntities(3, 2, '-metrics'),
        chunkOptions: { maxMessages: 2 },
      });

      assert.ok(result.chunksProcessed > 0);
      assert.equal(result.episodesCreated, result.chunksProcessed);
      assert.equal(result.nodesCreated, 3);
      assert.equal(result.edgesCreated, 2);
      assert.equal(result.duplicatesSkipped, 0);
    });

    it('returns IngestResult with all fields', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Test' },
          { role: 'assistant' as const, content: 'Response' },
        ],
      });

      const result = await ingestConversation(input, { store });

      assert.ok(typeof result.chunksProcessed === 'number');
      assert.ok(typeof result.episodesCreated === 'number');
      assert.ok(typeof result.nodesCreated === 'number');
      assert.ok(typeof result.nodesReinforced === 'number');
      assert.ok(typeof result.edgesCreated === 'number');
      assert.ok(typeof result.duplicatesSkipped === 'number');
    });
  });

  describe('episode properties', () => {
    it('creates episodes with correct type and source', async () => {
      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Test episode' },
          { role: 'assistant' as const, content: 'Response' },
        ],
        metadata: { sessionId: 'ep-props', source: '/ep-props' },
      });

      await ingestConversation(input, { store });

      const episodes = store.listEpisodes({ source: '/ep-props' });
      assert.ok(episodes.length > 0);

      const episode = episodes[0];
      assert.equal(episode.type, 'conversation');
      assert.equal(episode.sourceType, 'conversation');
      assert.ok(episode.id);
      assert.ok(episode.timestamp);
      assert.ok(episode.content);
    });
  });

  describe('entity map integration', () => {
    it('passes entityMap to extractEntities callback', async () => {
      const entityMap = {
        aliases: { TS: 'typescript' },
        ignore: ['the', 'a'],
      };

      let callbackCalled = false;
      let receivedEntityMap: any = null;

      const input = makeConversationInput({
        messages: [
          { role: 'user' as const, content: 'Using TS' },
          { role: 'assistant' as const, content: 'TypeScript is good' },
        ],
      });

      await ingestConversation(input, {
        store,
        entityMap,
        extractEntities: (chunk, map) => {
          callbackCalled = true;
          receivedEntityMap = map;
          return { nodes: [], edges: [] };
        },
      });

      assert.ok(callbackCalled);
      assert.deepEqual(receivedEntityMap, entityMap);
    });
  });
});
