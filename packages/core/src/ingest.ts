import { createHash } from 'node:crypto';
import type { ConversationInput, ConversationChunk, EntityMap } from './types.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { SqliteStore } from './store.js';
import { chunkConversation, chunkToEpisode, type ChunkOptions } from './conversation.js';
import { generateNodeId } from './graph.js';

export interface IngestOptions {
  store: SqliteStore;
  provider?: EmbeddingProvider;
  entityMap?: EntityMap;
  chunkOptions?: ChunkOptions;
  deduplicateBy?: 'sessionId' | 'contentHash' | 'none';
  scope?: string;
  extractEntities?: (
    chunk: ConversationChunk,
    entityMap?: EntityMap,
  ) => {
    nodes: Array<{
      label: string;
      type: string;
      mentionedBy: string[];
      excerpts: string[];
    }>;
    edges: Array<{
      source: string;
      target: string;
      type: string;
      context: string;
    }>;
  };
}

export interface IngestResult {
  chunksProcessed: number;
  episodesCreated: number;
  nodesCreated: number;
  nodesReinforced: number;
  edgesCreated: number;
  duplicatesSkipped: number;
}

function computeContentHash(input: ConversationInput): string {
  const content = input.messages.map((m) => `${m.role}:${m.content}`).join('\n');
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

function validInstant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? undefined : instant;
}

function chronologicalBounds(
  messages: ConversationChunk['messages'],
  metadata: ConversationInput['metadata'],
): { start: string; end: string } {
  const instants = messages
    .map((message) => validInstant(message.timestamp))
    .filter((instant): instant is number => instant !== undefined);
  const fallback =
    validInstant(metadata?.eventStart) ?? validInstant(metadata?.eventEnd) ?? Date.now();
  const start = instants.length > 0 ? Math.min(...instants) : fallback;
  const end = instants.length > 0 ? Math.max(...instants) : fallback;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function earlier(a: string, b: string): string {
  return (validInstant(a) ?? Number.POSITIVE_INFINITY) <=
    (validInstant(b) ?? Number.POSITIVE_INFINITY)
    ? a
    : b;
}

function later(a: string, b: string): string {
  return (validInstant(a) ?? Number.NEGATIVE_INFINITY) >=
    (validInstant(b) ?? Number.NEGATIVE_INFINITY)
    ? a
    : b;
}

/** Apply the deterministic derived-state portion of conversation ingestion synchronously. */
export function ingestConversationDerived(
  input: ConversationInput,
  opts: IngestOptions,
): IngestResult {
  const { store, entityMap, chunkOptions, extractEntities } = opts;
  const deduplicateBy = opts.deduplicateBy ?? 'sessionId';

  const result: IngestResult = {
    chunksProcessed: 0,
    episodesCreated: 0,
    nodesCreated: 0,
    nodesReinforced: 0,
    edgesCreated: 0,
    duplicatesSkipped: 0,
  };

  if (input.messages.length === 0) return result;

  if (deduplicateBy === 'sessionId' && input.metadata?.sessionId) {
    const existing = store.listEpisodes({ source: input.metadata.sessionId });
    if (existing.length > 0) {
      result.duplicatesSkipped = existing.length;
      return result;
    }
  }

  if (deduplicateBy === 'contentHash') {
    const hash = computeContentHash(input);
    const hashKey = `ingest_hash_${hash}`;
    if (store.getMeta(hashKey)) {
      result.duplicatesSkipped = 1;
      return result;
    }
    store.setMeta(hashKey, new Date().toISOString());
  }

  const chunks = chunkConversation(input, chunkOptions);

  for (const chunk of chunks) {
    result.chunksProcessed++;

    const episode = chunkToEpisode(chunk, input.metadata);
    episode.scope = opts.scope ?? input.metadata?.scope;
    store.putEpisode(episode);
    result.episodesCreated++;

    if (extractEntities) {
      const eligibleChunk: ConversationChunk = {
        ...chunk,
        messages: chunk.messages.filter((message) => message.extractionEligible !== false),
      };
      if (eligibleChunk.messages.length === 0) continue;
      const extracted = extractEntities(eligibleChunk, entityMap);
      const { start: eventStart, end: eventEnd } = chronologicalBounds(
        eligibleChunk.messages,
        input.metadata,
      );

      for (const entityNode of extracted.nodes) {
        const nodeId = generateNodeId(entityNode.label);
        const existing = store.getNode(nodeId);

        if (existing) {
          existing.mentionCount += 1;
          existing.reinforcementCount += 1;
          existing.firstSeen = earlier(existing.firstSeen, eventStart);
          existing.lastReinforced = later(existing.lastReinforced, eventEnd);
          if (existing.excerpts.length < 10 && entityNode.excerpts.length > 0) {
            existing.excerpts.push({
              file: episode.source,
              text: entityNode.excerpts[0],
              date: eventEnd,
            });
          }
          store.putNode(existing);
          result.nodesReinforced++;

          store.linkEpisodeEntity(episode.id, nodeId, 'mentioned');
        } else {
          store.putNode({
            id: nodeId,
            label: entityNode.label,
            type: entityNode.type as any,
            aliases: [],
            firstSeen: eventStart,
            lastReinforced: eventEnd,
            mentionCount: 1,
            reinforcementCount: 0,
            sourceFiles: [episode.source],
            excerpts: entityNode.excerpts.slice(0, 3).map((text) => ({
              file: episode.source,
              text,
              date: eventEnd,
            })),
          });
          result.nodesCreated++;

          store.linkEpisodeEntity(episode.id, nodeId, 'mentioned');
        }

        if (entityNode.type === 'person') {
          store.linkEpisodeEntity(episode.id, nodeId, 'participant');
        }
      }

      for (const edge of extracted.edges) {
        const sourceId = generateNodeId(edge.source);
        const targetId = generateNodeId(edge.target);

        if (!store.getNode(sourceId) || !store.getNode(targetId)) continue;

        const [a, b] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];
        const edgeId = `${a}--${b}--${edge.type}`;

        const existingEdge = store.getEdge(edgeId);
        if (existingEdge) {
          existingEdge.reinforcementCount += 1;
          existingEdge.firstFormed = earlier(existingEdge.firstFormed, eventStart);
          existingEdge.lastReinforced = later(existingEdge.lastReinforced, eventEnd);
          existingEdge.stability = 1 + 1.5 * Math.log(existingEdge.reinforcementCount + 1);
          if (existingEdge.evidence.length < 20) {
            existingEdge.evidence.push({
              file: episode.source,
              date: eventEnd,
              context: edge.context,
            });
          }
          store.putEdge(existingEdge);
        } else {
          store.putEdge({
            id: edgeId,
            source: sourceId,
            target: targetId,
            type: edge.type as any,
            directed: false,
            weight: 0.3,
            baseWeight: 0.3,
            reinforcementCount: 0,
            firstFormed: eventStart,
            lastReinforced: eventEnd,
            stability: 1.0,
            evidence: [
              {
                file: episode.source,
                date: eventEnd,
                context: edge.context,
              },
            ],
          });
          result.edgesCreated++;
        }
      }
    }
  }

  return result;
}

export async function ingestConversation(
  input: ConversationInput,
  opts: IngestOptions,
): Promise<IngestResult> {
  const existingEpisodeIds = opts.provider
    ? new Set(opts.store.listEpisodes().map((episode) => episode.id))
    : undefined;
  const result = ingestConversationDerived(input, opts);
  if (opts.provider && result.episodesCreated > 0) {
    for (const episode of opts.store
      .listEpisodes()
      .filter((candidate) => !existingEpisodeIds?.has(candidate.id))) {
      try {
        const embedding = await opts.provider.embed(episode.content);
        opts.store.putEmbedding(
          episode.id,
          'episode',
          episode.content,
          embedding,
          opts.provider.name,
        );
      } catch {
        // Embedding generation is best-effort; continue on failure
      }
    }
  }
  return result;
}
