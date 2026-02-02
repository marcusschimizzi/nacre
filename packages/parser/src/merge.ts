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
  type Evidence,
} from '@nacre/core';
import type { Section } from './parse.js';
import { detectCausalPhrases } from './extract/structural.js';

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

export function mergeExtractions(
  graph: NacreGraph,
  entities: RawEntity[],
  filePath: string,
  fileDate: string,
  entityMap: EntityMap,
  pendingEdges: PendingEdge[],
): { graph: NacreGraph; pendingEdges: PendingEdge[] } {
  const deduped = deduplicateRawEntities(entities);

  const resolvedIds: string[] = [];

  for (const raw of deduped) {
    const resolved = resolveEntity(raw, graph, entityMap);
    if (!resolved) continue;

    if (resolved.isNew) {
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
      reinforceNode(graph, resolved.nodeId, filePath, fileDate, {
        file: filePath,
        text: raw.text,
        date: fileDate,
      });
    }

    resolvedIds.push(resolved.nodeId);
  }

  const uniqueIds = [...new Set(resolvedIds)];

  for (let i = 0; i < uniqueIds.length; i++) {
    for (let j = i + 1; j < uniqueIds.length; j++) {
      const src = uniqueIds[i];
      const tgt = uniqueIds[j];
      const edgeId = generateEdgeId(src, tgt, 'co-occurrence');

      if (graph.edges[edgeId]) {
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

        if (pendingEdges[pendingIdx].count >= graph.config.coOccurrenceThreshold) {
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

  return { graph, pendingEdges };
}

export function processFileExtractions(
  graph: NacreGraph,
  allEntities: RawEntity[],
  sections: Section[],
  filePath: string,
  fileDate: string,
  entityMap: EntityMap,
  pendingEdges: PendingEdge[],
): { graph: NacreGraph; pendingEdges: PendingEdge[] } {
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

    for (const raw of deduped) {
      const resolved = resolveEntity(raw, graph, entityMap);
      if (!resolved) continue;

      if (resolved.isNew) {
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
        reinforceNode(graph, resolved.nodeId, filePath, fileDate, {
          file: filePath,
          text: raw.text,
          date: fileDate,
        });
      }

      resolvedIds.push(resolved.nodeId);
    }

    const uniqueIds = [...new Set(resolvedIds)];
    allResolvedBySection.set(sectionKey, uniqueIds);

    const isWikilink = new Set(
      deduped
        .filter(
          (e) =>
            e.source === 'structural' &&
            e.confidence >= 0.9 &&
            e.text.match(/^[^*`#]/) !== null,
        )
        .map((e) => {
          const r = resolveEntity(e, graph, entityMap);
          return r?.nodeId;
        })
        .filter((id): id is string => id !== undefined),
    );

    for (const wikiId of isWikilink) {
      for (const otherId of uniqueIds) {
        if (wikiId === otherId) continue;
        const edgeId = generateEdgeId(wikiId, otherId, 'explicit');
        if (graph.edges[edgeId]) {
          reinforceEdge(graph, edgeId, {
            file: filePath,
            date: fileDate,
            context: 'wikilink reinforcement',
          });
        } else {
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
        const edgeId = generateEdgeId(src, tgt, 'co-occurrence');

        if (graph.edges[edgeId]) {
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
      const causalEdgeId = generateEdgeId(uniqueIds[0], uniqueIds[1], 'causal');
      if (!graph.edges[causalEdgeId]) {
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

  const allSectionKeys = [...allResolvedBySection.keys()];
  for (let i = 0; i < allSectionKeys.length; i++) {
    for (let j = i + 1; j < allSectionKeys.length; j++) {
      const idsA = allResolvedBySection.get(allSectionKeys[i]) ?? [];
      const idsB = allResolvedBySection.get(allSectionKeys[j]) ?? [];

      for (const a of idsA) {
        for (const b of idsB) {
          if (a === b) continue;
          const edgeId = generateEdgeId(a, b, 'temporal');
          if (!graph.edges[edgeId]) {
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
          } else {
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

  return { graph, pendingEdges };
}
