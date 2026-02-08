import {
  addNode,
  addEdge,
  reinforceNode,
  reinforceEdge,
  generateEdgeId,
  resolveEntity,
  normalize,
  type NacreGraph,
  type EntityMap,
  type PendingEdge,
  type RawEntity,
  type Excerpt,
  type Evidence,
} from '@nacre/core';
import type { Section } from './parse.js';
import { detectCausalPhrases } from './extract/structural.js';

export interface ConsolidationStats {
  newNodes: number;
  newEdges: number;
  reinforcedNodes: number;
  reinforcedEdges: number;
}

export function deduplicateRawEntities(entities: RawEntity[]): RawEntity[] {
  const map = new Map<string, RawEntity>();

  for (const entity of entities) {
    const key = normalize(entity.text);
    const existing = map.get(key);
    if (!existing || entity.confidence > existing.confidence) {
      map.set(key, entity);
    }
  }

  return [...map.values()];
}

export function processFileExtractions(
  graph: NacreGraph,
  allEntities: RawEntity[],
  sections: Section[],
  filePath: string,
  fileDate: string,
  entityMap: EntityMap,
  pendingEdges: PendingEdge[],
): { graph: NacreGraph; pendingEdges: PendingEdge[]; stats: ConsolidationStats } {
  const stats: ConsolidationStats = {
    newNodes: 0,
    newEdges: 0,
    reinforcedNodes: 0,
    reinforcedEdges: 0,
  };
  const sectionEntities = new Map<string, RawEntity[]>();

  for (const entity of allEntities) {
    const key = entity.position.section;
    const list = sectionEntities.get(key) ?? [];
    list.push(entity);
    sectionEntities.set(key, list);
  }

  const allResolvedBySection = new Map<string, string[]>();

  for (const [sectionKey, entities] of sectionEntities) {
    const deduped = deduplicateRawEntities(entities);
    const resolvedIds: string[] = [];
    const wikilinkIds = new Set<string>();

    for (const raw of deduped) {
      const resolved = resolveEntity(raw, graph, entityMap);
      if (!resolved) continue;

      if (resolved.isNew) {
        stats.newNodes++;
        addNode(graph, {
          label: resolved.canonicalLabel,
          aliases: [],
          type: resolved.type,
          firstSeen: fileDate,
          lastReinforced: fileDate,
          mentionCount: 1,
          reinforcementCount: 0,
          sourceFiles: [filePath],
          excerpts: [{ file: filePath, text: raw.text, date: fileDate }],
        });
      } else {
        stats.reinforcedNodes++;
        reinforceNode(graph, resolved.nodeId, filePath, fileDate, {
          file: filePath,
          text: raw.text,
          date: fileDate,
        });
      }

      resolvedIds.push(resolved.nodeId);

      const isStructuralWikilink =
        raw.source === 'structural' &&
        raw.confidence >= 0.9 &&
        /^[^*`#]/.test(raw.text);
      if (isStructuralWikilink) {
        wikilinkIds.add(resolved.nodeId);
      }
    }

    const uniqueIds = [...new Set(resolvedIds)];
    allResolvedBySection.set(sectionKey, uniqueIds);

    for (const wikiId of wikilinkIds) {
      for (const otherId of uniqueIds) {
        if (wikiId === otherId) continue;
        const edgeId = generateEdgeId(wikiId, otherId, 'explicit', false);
        if (graph.edges[edgeId]) {
          stats.reinforcedEdges++;
          reinforceEdge(graph, edgeId, {
            file: filePath,
            date: fileDate,
            context: 'wikilink reinforcement',
          });
        } else {
          stats.newEdges++;
          addEdge(graph, {
            source: wikiId,
            target: otherId,
            type: 'explicit',
            directed: false,
            weight: graph.config.baseWeights.explicit,
            baseWeight: graph.config.baseWeights.explicit,
            reinforcementCount: 0,
            firstFormed: fileDate,
            lastReinforced: fileDate,
            stability: 1.0,
            evidence: [
              { file: filePath, date: fileDate, context: 'wikilink connection' },
            ],
          });
        }
      }
    }

    for (let i = 0; i < uniqueIds.length; i++) {
      for (let j = i + 1; j < uniqueIds.length; j++) {
        const src = uniqueIds[i];
        const tgt = uniqueIds[j];
        const edgeId = generateEdgeId(src, tgt, 'co-occurrence', false);

        if (graph.edges[edgeId]) {
          stats.reinforcedEdges++;
          reinforceEdge(graph, edgeId, {
            file: filePath,
            date: fileDate,
            context: 'co-occurrence reinforcement',
          });
          continue;
        }

        const pendingIdx = pendingEdges.findIndex(
          (pe) =>
            (pe.source === src && pe.target === tgt) ||
            (pe.source === tgt && pe.target === src),
        );

        if (pendingIdx >= 0) {
          pendingEdges[pendingIdx].count += 1;
          pendingEdges[pendingIdx].evidence.push({
            file: filePath,
            date: fileDate,
            context: 'co-occurrence observation',
          });

          if (
            pendingEdges[pendingIdx].count >= graph.config.coOccurrenceThreshold
          ) {
            stats.newEdges++;
            addEdge(graph, {
              source: src,
              target: tgt,
              type: 'co-occurrence',
              directed: false,
              weight: graph.config.baseWeights.coOccurrence,
              baseWeight: graph.config.baseWeights.coOccurrence,
              reinforcementCount: 0,
              firstFormed: pendingEdges[pendingIdx].firstSeen,
              lastReinforced: fileDate,
              stability: 1.0,
              evidence: pendingEdges[pendingIdx].evidence,
            });
            pendingEdges.splice(pendingIdx, 1);
          }
        } else {
          pendingEdges.push({
            source: src,
            target: tgt,
            type: 'co-occurrence',
            count: 1,
            firstSeen: fileDate,
            evidence: [
              { file: filePath, date: fileDate, context: 'first co-occurrence' },
            ],
          });
        }
      }
    }

    const section = sections.find((s) => s.headingPath === sectionKey);
    if (section && detectCausalPhrases(section.content) && uniqueIds.length >= 2) {
      const causalEdgeId = generateEdgeId(uniqueIds[0], uniqueIds[1], 'causal', true);
      if (!graph.edges[causalEdgeId]) {
        stats.newEdges++;
        addEdge(graph, {
          source: uniqueIds[0],
          target: uniqueIds[1],
          type: 'causal',
          directed: true,
          weight: graph.config.baseWeights.causal,
          baseWeight: graph.config.baseWeights.causal,
          reinforcementCount: 0,
          firstFormed: fileDate,
          lastReinforced: fileDate,
          stability: 1.0,
          evidence: [
            { file: filePath, date: fileDate, context: 'causal language detected' },
          ],
        });
      }
    }
  }

  // Temporal edge creation with controls to prevent explosion
  const allSectionKeys = [...allResolvedBySection.keys()];
  let temporalEdgesCreated = 0;
  const MAX_TEMPORAL_EDGES_PER_FILE = 50;

  for (let i = 0; i < allSectionKeys.length && temporalEdgesCreated < MAX_TEMPORAL_EDGES_PER_FILE; i++) {
    for (let j = i + 1; j < allSectionKeys.length && temporalEdgesCreated < MAX_TEMPORAL_EDGES_PER_FILE; j++) {
      const idsA = allResolvedBySection.get(allSectionKeys[i]) ?? [];
      const idsB = allResolvedBySection.get(allSectionKeys[j]) ?? [];

      for (const a of idsA) {
        for (const b of idsB) {
          if (temporalEdgesCreated >= MAX_TEMPORAL_EDGES_PER_FILE) break;
          if (a === b) continue;

          // Only create temporal edges if BOTH entities have mentionCount >= 2
          const nodeA = graph.nodes[a];
          const nodeB = graph.nodes[b];
          if (!nodeA || !nodeB) continue;
          if (nodeA.mentionCount < 2 || nodeB.mentionCount < 2) continue;

          const edgeId = generateEdgeId(a, b, 'temporal', false);
          if (!graph.edges[edgeId]) {
            stats.newEdges++;
            addEdge(graph, {
              source: a,
              target: b,
              type: 'temporal',
              directed: false,
              weight: graph.config.baseWeights.temporal,
              baseWeight: graph.config.baseWeights.temporal,
              reinforcementCount: 0,
              firstFormed: fileDate,
              lastReinforced: fileDate,
              stability: 1.0,
              evidence: [
                {
                  file: filePath,
                  date: fileDate,
                  context: 'temporal proximity (different sections, same file)',
                },
              ],
            });
            temporalEdgesCreated++;
          } else {
            stats.reinforcedEdges++;
            reinforceEdge(graph, edgeId, {
              file: filePath,
              date: fileDate,
              context: 'temporal proximity reinforcement',
            });
          }
        }
      }
    }
  }

  return { graph, pendingEdges, stats };
}
