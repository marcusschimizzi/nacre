import { readFileSync } from 'node:fs';
import type { EntityMap, EntityType, NacreGraph, RawEntity } from './types.js';
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
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

export function fuzzyMatch(
  candidate: string,
  existing: string,
  maxDistance?: number,
): boolean {
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

export function resolveEntity(
  raw: RawEntity,
  graph: NacreGraph,
  entityMap: EntityMap,
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

  for (const node of Object.values(graph.nodes)) {
    if (normalize(node.label) === canonical) {
      return {
        nodeId: node.id,
        isNew: false,
        canonicalLabel: node.label,
        type: node.type,
      };
    }
  }

  for (const node of Object.values(graph.nodes)) {
    if (node.aliases.some((a) => normalize(a) === canonical)) {
      return {
        nodeId: node.id,
        isNew: false,
        canonicalLabel: node.label,
        type: node.type,
      };
    }
  }

  for (const node of Object.values(graph.nodes)) {
    if (fuzzyMatch(canonical, node.label)) {
      return {
        nodeId: node.id,
        isNew: false,
        canonicalLabel: node.label,
        type: node.type,
      };
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
