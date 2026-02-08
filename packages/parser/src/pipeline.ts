import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { basename, resolve, relative, dirname } from 'node:path';
import {
  createGraph,
  loadEntityMap,
  decayAllEdges,
  SqliteStore,
  loadConfig,
  type EmbeddingProvider,
  type NacreGraph,
  type PendingEdge,
  type ConsolidationResult,
  type FileFailure,
} from '@nacre/core';
import { scanDirectories, detectChanges, hashFileSync } from './discover.js';
import { parseMarkdown, extractSections } from './parse.js';
import { extractStructural } from './extract/structural.js';
import { extractNLP } from './extract/nlp.js';
import { extractCustom } from './extract/custom.js';
import { extractEpisodes } from './extract/episode-extractor.js';
import { processFileExtractions, type ConsolidationStats } from './merge.js';
import type { Episode } from '@nacre/core';

export interface ConsolidateOptions {
  inputs: string[];
  ignore?: string[];
  outDir: string;
  entityMapPath?: string;
  embeddingProvider?: EmbeddingProvider;
  now?: Date;
}

function parseRetention(retention: string): number {
  const match = retention.match(/^(\d+)([dhm])$/);
  if (!match) return 0;
  const [, num, unit] = match;
  const multiplier = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
  return parseInt(num, 10) * multiplier;
}

function extractDateFromContent(filePath: string, content: string): string | null {
  // 1. Parse frontmatter for explicit date
  const frontmatterMatch = content.match(/^---\n(?:.*\n)?date:\s*([^\n]+)/im);
  if (frontmatterMatch) {
    const date = frontmatterMatch[1].trim();
    // Validate it's a real ISO date
    if (!isNaN(new Date(date).getTime())) {
      return date;
    }
  }

  // 2. Fall back to filename prefix (YYYY-MM-DD)
  const name = basename(filePath, '.md');
  const datePrefixMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePrefixMatch) {
    return datePrefixMatch[1];
  }

  // 3. Fall back to file mtime
  try {
    const stats = statSync(filePath);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}

function loadGraphFromJson(outDir: string): NacreGraph {
  const graphPath = resolve(outDir, 'graph.json');
  if (existsSync(graphPath)) {
    return JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;
  }
  return createGraph();
}

function loadPendingEdges(outDir: string): PendingEdge[] {
  const pendingPath = resolve(outDir, 'pending-edges.json');
  if (existsSync(pendingPath)) {
    return JSON.parse(readFileSync(pendingPath, 'utf8')) as PendingEdge[];
  }
  return [];
}

/**
 * Determine if outDir points to a SQLite database.
 * Convention: if outDir ends in .db, it's SQLite.
 */
function isSqlitePath(outDir: string): boolean {
  return outDir.endsWith('.db');
}

/**
 * Run the consolidation pipeline.
 * 
 * Supports both JSON and SQLite output:
 * - If outDir ends in .db → reads/writes SQLite database
 * - Otherwise → reads/writes graph.json + pending-edges.json in the directory
 */
export async function consolidate(
  opts: ConsolidateOptions,
): Promise<ConsolidationResult> {
  const outDir = resolve(opts.outDir);
  const now = opts.now ?? new Date();
  const useSqlite = isSqlitePath(outDir);

  // Load graph and pending edges
  let graph: NacreGraph;
  let pendingEdges: PendingEdge[];
  let store: SqliteStore | null = null;

  if (useSqlite) {
    store = SqliteStore.open(outDir);
    graph = store.getFullGraph();
    // Pending edges stored in SQLite meta
    const pendingStr = store.getMeta('pending_edges');
    pendingEdges = pendingStr ? JSON.parse(pendingStr) : [];
  } else {
    graph = loadGraphFromJson(outDir);
    pendingEdges = loadPendingEdges(outDir);
  }

  const entityMap = loadEntityMap(
    opts.entityMapPath ?? resolve('data', 'entity-map.json'),
  );

  const basePath = resolve(opts.inputs[0]);
  const files = await scanDirectories(opts.inputs);
  const changes = await detectChanges(files, graph.processedFiles, basePath);

  const toProcess = [...changes.newFiles, ...changes.changedFiles];

  const nodesBefore = Object.keys(graph.nodes).length;
  const edgesBefore = Object.keys(graph.edges).length;
  let reinforcedNodes = 0;
  let reinforcedEdges = 0;
  let newEpisodes = 0;
  const storedEpisodes: Episode[] = [];
  const failures: FileFailure[] = [];

  for (const filePath of toProcess) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const fileDate = extractDateFromContent(filePath, content) ?? now.toISOString().slice(0, 10);

      const tree = parseMarkdown(content);
      const sections = extractSections(tree, filePath);

      const structural = extractStructural(sections, filePath);
      const nlpEntities = extractNLP(sections, filePath);
      const custom = extractCustom(sections, filePath);
      const allEntities = [...structural, ...nlpEntities, ...custom];

      const result = processFileExtractions(
        graph,
        allEntities,
        sections,
        filePath,
        fileDate,
        entityMap,
        pendingEdges,
      );
      pendingEdges = result.pendingEdges;

      // Use explicit stats from processFileExtractions
      reinforcedNodes += result.stats.reinforcedNodes;
      reinforcedEdges += result.stats.reinforcedEdges;

      const hash = hashFileSync(filePath);
      const relPath = relative(basePath, filePath);
      const existingIdx = graph.processedFiles.findIndex(
        (pf) => pf.path === relPath,
      );
      if (existingIdx >= 0) {
        graph.processedFiles[existingIdx] = {
          path: relPath,
          hash,
          lastProcessed: now.toISOString(),
        };
      } else {
        graph.processedFiles.push({
          path: relPath,
          hash,
          lastProcessed: now.toISOString(),
        });
      }

      if (useSqlite && store) {
        try {
          const episodes = extractEpisodes(sections, filePath);
          for (const episode of episodes) {
            store.putEpisode(episode);
            storedEpisodes.push(episode);
            newEpisodes++;

            const sectionEntities = allEntities.filter(e => {
              const matchingSection = sections.find(s => s.headingPath === e.position.section);
              return matchingSection?.heading === episode.title;
            });

            for (const entity of sectionEntities) {
              const resolved = store.findNode(entity.text);
              if (!resolved) continue;
              const role: 'participant' | 'topic' | 'mentioned' =
                entity.type === 'person' ? 'participant' :
                ['concept', 'project', 'tool', 'tag'].includes(entity.type) ? 'topic' :
                'mentioned';
              try {
                store.linkEpisodeEntity(episode.id, resolved.id, role);
              } catch {
                // FK constraint — node may not be persisted yet in graph
              }
            }
          }
        } catch {
          // Non-fatal — episode extraction should not block consolidation
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ path: filePath, error: message });
    }
  }

  const { decayed } = decayAllEdges(graph, now);
  graph.lastConsolidated = now.toISOString();

  let newEmbeddings = 0;
  if (opts.embeddingProvider && useSqlite && store) {
    const provider = opts.embeddingProvider;
    for (const node of Object.values(graph.nodes)) {
      const text = node.label + ' — ' + node.excerpts.map(e => e.text).join('. ');
      const existing = store.getEmbedding(node.id);
      if (existing && existing.content === text) continue;

      try {
        const vector = await provider.embed(text);
        store.putEmbedding(node.id, 'node', text, vector, provider.name);
        newEmbeddings++;
      } catch {
        // Embedding failure is non-fatal — node still exists in graph
      }
    }

    for (const episode of storedEpisodes) {
      const text = episode.title + ' — ' + episode.content;
      const existing = store.getEmbedding(episode.id);
      if (existing && existing.content === text) continue;

      try {
        const vector = await provider.embed(text);
        store.putEmbedding(episode.id, 'episode', text, vector, provider.name);
        newEmbeddings++;
      } catch {
        // Embedding failure is non-fatal
      }
    }
  }

  if (useSqlite && store) {
    store.importGraph(graph);
    store.setMeta('pending_edges', JSON.stringify(pendingEdges));
    store.save();

    const snapshotConfig = loadConfig(outDir).snapshots;
    const snapshotsEnabled = snapshotConfig?.enabled !== false;
    const triggers = snapshotConfig?.triggers ?? ['consolidation'];

    if (snapshotsEnabled && triggers.includes('consolidation')) {
      store.createSnapshot('consolidation');

      if (snapshotConfig?.retention) {
        const retentionMs = parseRetention(snapshotConfig.retention);
        if (retentionMs > 0) {
          const cutoff = new Date(Date.now() - retentionMs).toISOString();
          const old = store.listSnapshots({ until: cutoff });
          for (const snap of old) {
            store.deleteSnapshot(snap.id);
          }
        }
      }
    }

    store.close();
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, 'graph.json'),
      JSON.stringify(graph, null, 2),
      'utf8',
    );
    writeFileSync(
      resolve(outDir, 'pending-edges.json'),
      JSON.stringify(pendingEdges, null, 2),
      'utf8',
    );
  }

  return {
    graph,
    newNodes: Object.keys(graph.nodes).length - nodesBefore,
    newEdges: Object.keys(graph.edges).length - edgesBefore,
    reinforcedNodes,
    reinforcedEdges,
    decayedEdges: decayed,
    newEmbeddings,
    newEpisodes,
    pendingEdges,
    failures,
  };
}
