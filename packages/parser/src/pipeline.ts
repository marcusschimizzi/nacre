import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, resolve, relative } from 'node:path';
import {
  createGraph,
  loadEntityMap,
  decayAllEdges,
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
import { processFileExtractions } from './merge.js';

export interface ConsolidateOptions {
  inputs: string[];
  ignore?: string[];
  outDir: string;
  entityMapPath?: string;
  now?: Date;
}

function extractDateFromFilename(filePath: string): string | null {
  const name = basename(filePath, '.md');
  const match = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function loadGraph(outDir: string): NacreGraph {
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

export async function consolidate(
  opts: ConsolidateOptions,
): Promise<ConsolidationResult> {
  const outDir = resolve(opts.outDir);
  const now = opts.now ?? new Date();

  const graph = loadGraph(outDir);
  let pendingEdges = loadPendingEdges(outDir);

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
  const failures: FileFailure[] = [];

  for (const filePath of toProcess) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const fileDate = extractDateFromFilename(filePath) ?? now.toISOString().slice(0, 10);

      const tree = parseMarkdown(content);
      const sections = extractSections(tree, filePath);

      const structural = extractStructural(sections, filePath);
      const nlpEntities = extractNLP(sections, filePath);
      const custom = extractCustom(sections, filePath);
      const allEntities = [...structural, ...nlpEntities, ...custom];

      const nodesBeforeFile = Object.keys(graph.nodes).length;
      const edgesBeforeFile = Object.keys(graph.edges).length;

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

      const nodesAfterFile = Object.keys(graph.nodes).length;
      const edgesAfterFile = Object.keys(graph.edges).length;

      reinforcedNodes += Math.max(
        0,
        allEntities.length - (nodesAfterFile - nodesBeforeFile),
      );
      reinforcedEdges += Math.max(
        0,
        (edgesAfterFile - edgesBeforeFile),
      );

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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ path: filePath, error: message });
    }
  }

  const { decayed } = decayAllEdges(graph, now);
  graph.lastConsolidated = now.toISOString();

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

  return {
    graph,
    newNodes: Object.keys(graph.nodes).length - nodesBefore,
    newEdges: Object.keys(graph.edges).length - edgesBefore,
    reinforcedNodes,
    reinforcedEdges,
    decayedEdges: decayed,
    pendingEdges,
    failures,
  };
}
