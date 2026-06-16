import { readFileSync } from 'node:fs';
import type { EntityMap, EntityType, MemoryNode, NacreGraph, RawEntity } from './types.js';
import { generateNodeId } from './graph.js';

export function normalize(text: string): string {
  return text
    .replace(/[\u2019\u2018]s$/g, '') // strip smart possessive 's
    .replace(/[\u201C\u201D\u2018\u2019"]/g, '') // strip smart/straight quotes
    .replace(/[\u2014\u2013-]+\s*$/g, '') // strip trailing em/en dashes
    .replace(/^\s*[\u2014\u2013-]+/g, '') // strip leading em/en dashes
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/'s$/g, '') // strip ASCII possessive 's
    .replace(/[.,;:!?]+$/g, '');
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[m][n];
}

export function fuzzyMatch(candidate: string, existing: string, maxDistance?: number): boolean {
  const a = normalize(candidate);
  const b = normalize(existing);

  if (a.length <= 15 && b.length <= 15) {
    return levenshteinDistance(a, b) <= (maxDistance ?? 2);
  }

  const tokensA = new Set(a.split(' '));
  const tokensB = new Set(b.split(' '));
  let shared = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) shared++;
  }
  const maxTokens = Math.max(tokensA.size, tokensB.size);
  return maxTokens > 0 && shared / maxTokens >= 0.5;
}

export function loadEntityMap(path: string): EntityMap {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as EntityMap;
  } catch {
    return { aliases: {}, ignore: [] };
  }
}

/**
 * Pre-built lookup over a graph's nodes for O(1) exact/alias entity resolution,
 * with an insertion-ordered list for the fuzzy fallback. Maps are first-writer-
 * wins to reproduce resolveEntity's iteration-order tie behavior.
 */
export interface EntityIndex {
  labelMap: Map<string, string>; // normalized label -> node id
  aliasMap: Map<string, string>; // normalized alias -> node id
  fuzzy: Array<{ id: string; label: string }>; // raw labels, in insertion order
}

export function buildEntityIndex(graph: NacreGraph): EntityIndex {
  const index: EntityIndex = { labelMap: new Map(), aliasMap: new Map(), fuzzy: [] };
  for (const node of Object.values(graph.nodes)) {
    addNodeToIndex(index, node);
  }
  return index;
}

/** Add a node to an EntityIndex (call right after a node is created mid-run). */
export function addNodeToIndex(index: EntityIndex, node: MemoryNode): void {
  const normLabel = normalize(node.label);
  if (!index.labelMap.has(normLabel)) index.labelMap.set(normLabel, node.id);
  for (const alias of node.aliases) {
    const normAlias = normalize(alias);
    if (!index.aliasMap.has(normAlias)) index.aliasMap.set(normAlias, node.id);
  }
  index.fuzzy.push({ id: node.id, label: node.label });
}

export function resolveEntity(
  raw: RawEntity,
  graph: NacreGraph,
  entityMap: EntityMap,
  index?: EntityIndex,
): { nodeId: string; isNew: boolean; canonicalLabel: string; type: EntityType } | null {
  const normalized = normalize(raw.text);

  if (!normalized || normalized.length <= 1) return null;

  const ignoreLower = entityMap.ignore.map((w) => w.toLowerCase());
  if (ignoreLower.includes(normalized)) return null;

  let canonical = normalized;
  if (entityMap.aliases[raw.text] !== undefined) {
    canonical = normalize(entityMap.aliases[raw.text]);
  } else if (entityMap.aliases[normalized] !== undefined) {
    canonical = normalize(entityMap.aliases[normalized]);
  }

  const hit = (id: string) => {
    const node = graph.nodes[id];
    return { nodeId: node.id, isNew: false, canonicalLabel: node.label, type: node.type };
  };

  if (index) {
    // Indexed path: exact label, then alias, then fuzzy — same global priority,
    // but the first two tiers are O(1) instead of full scans.
    const labelHit = index.labelMap.get(canonical);
    if (labelHit !== undefined) return hit(labelHit);

    const aliasHit = index.aliasMap.get(canonical);
    if (aliasHit !== undefined) return hit(aliasHit);

    for (const cand of index.fuzzy) {
      if (fuzzyMatch(canonical, cand.label)) return hit(cand.id);
    }
  } else {
    for (const node of Object.values(graph.nodes)) {
      if (normalize(node.label) === canonical) return hit(node.id);
    }
    for (const node of Object.values(graph.nodes)) {
      if (node.aliases.some((a) => normalize(a) === canonical)) return hit(node.id);
    }
    for (const node of Object.values(graph.nodes)) {
      if (fuzzyMatch(canonical, node.label)) return hit(node.id);
    }
  }

  if (raw.confidence > 0.5) {
    return {
      nodeId: generateNodeId(canonical),
      isNew: true,
      canonicalLabel: canonical,
      type: raw.type,
    };
  }

  return null;
}
