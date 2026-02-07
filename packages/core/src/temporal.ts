import type { MemoryNode, MemoryEdge } from './types.js';
import type { SqliteStore } from './store.js';

export interface GraphDiff {
  fromSnapshot: string;
  toSnapshot: string;
  nodes: {
    added: MemoryNode[];
    removed: MemoryNode[];
    changed: Array<{ before: MemoryNode; after: MemoryNode; changes: string[] }>;
  };
  edges: {
    added: MemoryEdge[];
    removed: MemoryEdge[];
    strengthened: MemoryEdge[];
    weakened: MemoryEdge[];
  };
  stats: {
    nodesAdded: number;
    nodesRemoved: number;
    nodesChanged: number;
    edgesAdded: number;
    edgesRemoved: number;
    edgesStrengthened: number;
    edgesWeakened: number;
    netChange: number;
  };
}

function diffNodeFields(before: MemoryNode, after: MemoryNode): string[] {
  const changes: string[] = [];
  if (before.label !== after.label) changes.push('label');
  if (before.type !== after.type) changes.push('type');
  if (before.mentionCount !== after.mentionCount) changes.push('mentionCount');
  if (before.reinforcementCount !== after.reinforcementCount) changes.push('reinforcementCount');
  if (before.lastReinforced !== after.lastReinforced) changes.push('lastReinforced');
  if (JSON.stringify(before.aliases) !== JSON.stringify(after.aliases)) changes.push('aliases');
  if (before.sourceFiles.length !== after.sourceFiles.length) changes.push('sourceFiles');
  if (before.excerpts.length !== after.excerpts.length) changes.push('excerpts');
  return changes;
}

export function diffSnapshots(store: SqliteStore, fromId: string, toId: string): GraphDiff {
  const fromGraph = store.getSnapshotGraph(fromId);
  const toGraph = store.getSnapshotGraph(toId);

  const addedNodes: MemoryNode[] = [];
  const removedNodes: MemoryNode[] = [];
  const changedNodes: Array<{ before: MemoryNode; after: MemoryNode; changes: string[] }> = [];

  const addedEdges: MemoryEdge[] = [];
  const removedEdges: MemoryEdge[] = [];
  const strengthenedEdges: MemoryEdge[] = [];
  const weakenedEdges: MemoryEdge[] = [];

  for (const [id, node] of Object.entries(toGraph.nodes)) {
    if (!fromGraph.nodes[id]) {
      addedNodes.push(node);
    } else {
      const changes = diffNodeFields(fromGraph.nodes[id], node);
      if (changes.length > 0) {
        changedNodes.push({ before: fromGraph.nodes[id], after: node, changes });
      }
    }
  }

  for (const [id, node] of Object.entries(fromGraph.nodes)) {
    if (!toGraph.nodes[id]) {
      removedNodes.push(node);
    }
  }

  for (const [id, edge] of Object.entries(toGraph.edges)) {
    if (!fromGraph.edges[id]) {
      addedEdges.push(edge);
    } else {
      const beforeWeight = fromGraph.edges[id].weight;
      if (edge.weight > beforeWeight) {
        strengthenedEdges.push(edge);
      } else if (edge.weight < beforeWeight) {
        weakenedEdges.push(edge);
      }
    }
  }

  for (const [id, edge] of Object.entries(fromGraph.edges)) {
    if (!toGraph.edges[id]) {
      removedEdges.push(edge);
    }
  }

  return {
    fromSnapshot: fromId,
    toSnapshot: toId,
    nodes: {
      added: addedNodes,
      removed: removedNodes,
      changed: changedNodes,
    },
    edges: {
      added: addedEdges,
      removed: removedEdges,
      strengthened: strengthenedEdges,
      weakened: weakenedEdges,
    },
    stats: {
      nodesAdded: addedNodes.length,
      nodesRemoved: removedNodes.length,
      nodesChanged: changedNodes.length,
      edgesAdded: addedEdges.length,
      edgesRemoved: removedEdges.length,
      edgesStrengthened: strengthenedEdges.length,
      edgesWeakened: weakenedEdges.length,
      netChange: (addedNodes.length - removedNodes.length) + (addedEdges.length - removedEdges.length),
    },
  };
}
