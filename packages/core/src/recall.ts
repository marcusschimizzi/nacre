import type {
  NacreGraph,
  RecallOptions,
  RecallResult,
  RecallResponse,
  RecallWeights,
  RecallConnection,
  RecallProcedureMatch,
  Episode,
} from './types.js';
import { DEFAULT_RECALL_WEIGHTS } from './types.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { SqliteStore } from './store.js';
import { buildAdjacencyMap } from './graph.js';
import { computeCurrentWeight, daysBetween } from './decay.js';
import { normalize } from './resolve.js';
import { findNode, searchNodes } from './query.js';
import { findRelevantProcedures } from './procedures.js';

/**
 * Discount factor for episode→node semantic score propagation.
 * Episodes matching a query transfer relevance to their linked nodes,
 * but at a reduced weight since the match is indirect.
 */
const EPISODE_SEMANTIC_DISCOUNT = 0.8;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'after', 'before', 'above', 'below', 'and', 'or', 'but',
  'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'that', 'this',
  'it', 'its', 'what', 'which', 'who', 'how', 'when', 'where', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'them', 'his', 'her', 'just', 'also', 'very', 'much',
]);

export function extractQueryTerms(query: string): string[] {
  const tokens = query
    .split(/[\s,;:!?()\[\]{}"']+/)
    .map((t) => normalize(t))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

  return [...new Set(tokens)];
}

export function graphWalk(
  graph: NacreGraph,
  seedIds: string[],
  hops: number,
  now: Date,
): Map<string, number> {
  const scores = new Map<string, number>();
  const adj = buildAdjacencyMap(graph);

  for (const id of seedIds) {
    if (graph.nodes[id]) {
      scores.set(id, Math.max(scores.get(id) ?? 0, 1.0));
    }
  }

  let frontier = [...new Set(seedIds)].filter((id) => graph.nodes[id]);
  const visited = new Set<string>(frontier);

  for (let hop = 0; hop < hops; hop++) {
    const hopPenalty = 1 / (2 + hop);
    const next: string[] = [];

    for (const nodeId of frontier) {
      for (const entry of adj[nodeId] ?? []) {
        const edge = graph.edges[entry.edgeId];
        if (!edge) continue;

        const edgeWeight = computeCurrentWeight(edge, now, graph.config);
        if (edgeWeight < graph.config.visibilityThreshold) continue;

        const score = edgeWeight * hopPenalty;
        const existing = scores.get(entry.neighborId) ?? 0;
        if (score > existing) {
          scores.set(entry.neighborId, score);
        }

        if (!visited.has(entry.neighborId)) {
          visited.add(entry.neighborId);
          next.push(entry.neighborId);
        }
      }
    }

    frontier = next;
  }

  return scores;
}

export async function recall(
  store: SqliteStore,
  provider: EmbeddingProvider | null,
  opts: RecallOptions,
): Promise<RecallResponse> {
  const weights: RecallWeights = { ...DEFAULT_RECALL_WEIGHTS, ...opts.weights };
  const limit = opts.limit ?? 10;
  const hops = opts.hops ?? 2;
  const now = new Date();
  const nowStr = now.toISOString();

  const semanticMap = new Map<string, number>();
  const episodeHits = new Map<string, Episode[]>();

  if (provider && store.embeddingCount() > 0) {
    const queryVec = await provider.embed(opts.query);

    const storedDims = store.getMeta('embedding_dimensions');
    if (storedDims && parseInt(storedDims, 10) !== queryVec.length) {
      console.warn(
        `Embedding dimension mismatch: stored=${storedDims}, query=${queryVec.length}. Results may be empty. Run 'nacre embed --force' to re-embed.`
      );
    }

    const nodeHits = store.searchSimilar(queryVec, {
      limit: limit * 3,
      type: 'node',
    });
    for (const hit of nodeHits) {
      semanticMap.set(hit.id, Math.max(semanticMap.get(hit.id) ?? 0, hit.similarity));
    }

    const epHits = store.searchSimilar(queryVec, {
      limit,
      type: 'episode',
    });
    for (const hit of epHits) {
      const links = store.getEpisodeEntities(hit.id);
      const episode = store.getEpisode(hit.id);
      for (const link of links) {
        semanticMap.set(
          link.nodeId,
          Math.max(semanticMap.get(link.nodeId) ?? 0, hit.similarity * EPISODE_SEMANTIC_DISCOUNT),
        );
        if (episode) {
          const existing = episodeHits.get(link.nodeId) ?? [];
          existing.push(episode);
          episodeHits.set(link.nodeId, existing);
        }
      }
    }
  }

  const graph = store.getFullGraph();
  const terms = extractQueryTerms(opts.query);

  const seedIds: string[] = [];
  for (const term of terms) {
    const node = findNode(graph, term);
    if (node) seedIds.push(node.id);
  }

  if (seedIds.length === 0 && terms.length > 0) {
    const fuzzyResults = searchNodes(graph, terms);
    for (const r of fuzzyResults.slice(0, 5)) {
      seedIds.push(r.node.id);
    }
  }

  const graphMap = seedIds.length > 0
    ? graphWalk(graph, seedIds, hops, now)
    : new Map<string, number>();

  const candidateIds = new Set<string>([
    ...semanticMap.keys(),
    ...graphMap.keys(),
  ]);

  if (candidateIds.size === 0) return { results: [], procedures: [] };

  let maxMentions = 1;
  for (const id of candidateIds) {
    const node = graph.nodes[id];
    if (node) {
      const m = node.mentionCount + node.reinforcementCount;
      if (m > maxMentions) maxMentions = m;
    }
  }

  type ScoredCandidate = {
    id: string;
    combined: number;
    semantic: number;
    graphScore: number;
    recency: number;
    importance: number;
  };

  const scored: ScoredCandidate[] = [];

  for (const id of candidateIds) {
    const node = graph.nodes[id];
    if (!node) continue;

    if (opts.types && !opts.types.includes(node.type)) continue;

    if (opts.since && node.lastReinforced < opts.since) continue;
    if (opts.until && node.lastReinforced > opts.until) continue;

    const semantic = semanticMap.get(id) ?? 0;
    const graphScore = graphMap.get(id) ?? 0;
    const daysSince = daysBetween(node.lastReinforced, nowStr);
    const recency = Math.max(0, 1 - daysSince / 365);
    const importance = Math.min(
      1,
      (node.mentionCount + node.reinforcementCount) / maxMentions,
    );

    const combined =
      weights.semantic * semantic +
      weights.graph * graphScore +
      weights.recency * recency +
      weights.importance * importance;

    if (opts.minScore !== undefined && combined < opts.minScore) continue;

    scored.push({ id, combined, semantic, graphScore, recency, importance });
  }

  scored.sort((a, b) => b.combined - a.combined);
  const top = scored.slice(0, limit);

  const results: RecallResult[] = [];

  for (const candidate of top) {
    const node = graph.nodes[candidate.id]!;

    const connections: RecallConnection[] = [];
    const sourceEdges = store.listEdges({ source: candidate.id });
    const targetEdges = store.listEdges({ target: candidate.id });
    const allEdges = [...sourceEdges, ...targetEdges]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);

    for (const edge of allEdges) {
      const neighborId = edge.source === candidate.id ? edge.target : edge.source;
      const neighbor = graph.nodes[neighborId];
      if (neighbor) {
        connections.push({
          label: neighbor.label,
          type: neighbor.type,
          relationship: edge.type,
          weight: edge.weight,
        });
      }
    }

    let episodes: Episode[] | undefined;
    const nodeEpisodes = store.getEntityEpisodes(candidate.id);
    const hitEpisodes = episodeHits.get(candidate.id) ?? [];

    const allEpisodes = new Map<string, Episode>();
    for (const ep of [...nodeEpisodes, ...hitEpisodes]) {
      allEpisodes.set(ep.id, ep);
    }
    if (allEpisodes.size > 0) {
      episodes = [...allEpisodes.values()]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 3);
    }

    results.push({
      id: candidate.id,
      label: node.label,
      type: node.type,
      score: candidate.combined,
      scores: {
        semantic: candidate.semantic,
        graph: candidate.graphScore,
        recency: candidate.recency,
        importance: candidate.importance,
      },
      excerpts: node.excerpts.map((e) => e.text).slice(0, 5),
      connections,
      episodes,
    });
  }

  let procedures: RecallProcedureMatch[] = [];
  if (opts.includeProcedures !== false) {
    const procMatches = findRelevantProcedures(store, opts.query, [], {
      limit: opts.procedureLimit ?? 3,
      minScore: 0.1,
    });
    procedures = procMatches.map((m): RecallProcedureMatch => ({
      id: m.procedure.id,
      statement: m.procedure.statement,
      type: m.procedure.type,
      confidence: m.procedure.confidence,
      score: m.score,
      matchedKeywords: m.matchedKeywords,
    }));
  }

  return { results, procedures };
}
