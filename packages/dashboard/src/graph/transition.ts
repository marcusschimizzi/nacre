import type { ForceLink, ForceNode, LoadResult } from './types.ts';
import type { GraphDiff } from '../api/types.ts';

export function carryOverPositions(prevNodes: ForceNode[], nextNodes: ForceNode[]): void {
  const prevMap = new Map<string, ForceNode>();
  for (const n of prevNodes) prevMap.set(n.id, n);

  // centroid of prev nodes as a reasonable seed.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let count = 0;
  for (const n of prevNodes) {
    if (n.x === undefined || n.y === undefined || n.z === undefined) continue;
    cx += n.x;
    cy += n.y;
    cz += n.z;
    count++;
  }
  if (count > 0) {
    cx /= count;
    cy /= count;
    cz /= count;
  }

  for (const n of nextNodes) {
    const prev = prevMap.get(n.id);
    if (prev) {
      n.x = prev.x;
      n.y = prev.y;
      n.z = prev.z;
      n.vx = prev.vx;
      n.vy = prev.vy;
      n.vz = prev.vz;
      continue;
    }

    // seed new nodes near centroid
    const jitter = () => (Math.random() - 0.5) * 20;
    n.x = cx + jitter();
    n.y = cy + jitter();
    n.z = cz + jitter();
  }
}

export function linkIdSet(links: ForceLink[], nodeIdSet: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const link of links) {
    const src = typeof link.source === 'string' ? link.source : link.source.id;
    const tgt = typeof link.target === 'string' ? link.target : link.target.id;
    if (nodeIdSet.has(src) || nodeIdSet.has(tgt)) ids.add(link.id);
  }
  return ids;
}

export function diffToPinnedIds(diff: GraphDiff): { nodes: Set<string>; edges: Set<string> } {
  const nodeIds = new Set<string>();
  for (const n of diff.nodes.added) nodeIds.add(n.id);
  for (const n of diff.nodes.removed) nodeIds.add(n.id);
  for (const ch of diff.nodes.changed) {
    nodeIds.add(ch.after.id);
    nodeIds.add(ch.before.id);
  }

  const edgeIds = new Set<string>();
  for (const e of diff.edges.added) edgeIds.add(e.id);
  for (const e of diff.edges.removed) edgeIds.add(e.id);
  for (const e of diff.edges.strengthened) edgeIds.add(e.id);
  for (const e of diff.edges.weakened) edgeIds.add(e.id);

  return { nodes: nodeIds, edges: edgeIds };
}

export type ApplyTransitionArgs = {
  current: LoadResult;
  next: LoadResult;
  pinnedNodes?: Set<string>;
  pinnedLinks?: Set<string>;
};
