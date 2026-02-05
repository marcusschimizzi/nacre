import type { ConsolidationResult, MemoryNode, MemoryEdge, BriefResult } from '@nacre/core';

export function formatJSON(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatText(data: {
  nodes?: MemoryNode[];
  edges?: MemoryEdge[];
  clusters?: Record<string, string[]>;
  brief?: BriefResult;
}): string {
  const lines: string[] = [];

  if (data.brief) {
    lines.push(data.brief.summary);
  }

  if (data.clusters) {
    lines.push('Clusters:');
    for (const [label, ids] of Object.entries(data.clusters)) {
      lines.push(`  ${label}: ${ids.length} nodes`);
    }
  }

  if (data.nodes && data.nodes.length > 0) {
    lines.push('Nodes:');
    for (const node of data.nodes) {
      lines.push(`  ${node.label} (${node.type}) - mentions: ${node.mentionCount}`);
    }
  }

  if (data.edges && data.edges.length > 0) {
    lines.push('Edges:');
    for (const edge of data.edges) {
      lines.push(
        `  ${edge.source} --[${edge.type}]--> ${edge.target} (weight: ${edge.weight.toFixed(3)})`,
      );
    }
  }

  return lines.join('\n');
}

export function formatConsolidationSummary(
  result: ConsolidationResult,
  elapsedMs: number,
): string {
  const totalNodes = Object.keys(result.graph.nodes).length;
  const totalEdges = Object.keys(result.graph.edges).length;

  const lines = [
    `Consolidation complete in ${elapsedMs}ms`,
    `  Nodes: ${totalNodes} total (${result.newNodes} new, ${result.reinforcedNodes} reinforced)`,
    `  Edges: ${totalEdges} total (${result.newEdges} new)`,
    `  Decayed: ${result.decayedEdges} edges`,
    `  Pending: ${result.pendingEdges.length} sub-threshold edges`,
  ];

  if (result.newEmbeddings > 0) {
    lines.push(`  Embeddings: ${result.newEmbeddings} new`);
  }

  if (result.failures.length > 0) {
    lines.push(`  Failures: ${result.failures.length} file(s) skipped`);
    for (const f of result.failures) {
      lines.push(`    ${f.path}: ${f.error}`);
    }
  }

  return lines.join('\n');
}
