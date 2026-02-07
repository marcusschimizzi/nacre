import { defineCommand } from 'citty';
import { SqliteStore } from '@nacre/core';
import type { MemoryNode, MemoryEdge } from '@nacre/core';
import { formatJSON } from '../output.js';

export default defineCommand({
  meta: {
    name: 'history',
    description: 'View how a node or edge evolved across snapshots',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Entity to track: "node:<id>" or "edge:<id>"',
      required: true,
    },
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('History requires a SQLite graph (.db file)');
      process.exit(1);
    }

    const target = args.target as string;
    const [kind, entityId] = target.includes(':') ? target.split(':', 2) : ['node', target];

    if (kind !== 'node' && kind !== 'edge') {
      console.error('Target must start with "node:" or "edge:". Example: node:typescript');
      process.exit(1);
    }

    if (!entityId) {
      console.error('Entity ID is required. Example: node:typescript');
      process.exit(1);
    }

    const store = SqliteStore.open(graphPath);

    try {
      const history = kind === 'node'
        ? store.getNodeHistory(entityId)
        : store.getEdgeHistory(entityId);

      if ((args.format as string) === 'json') {
        console.log(formatJSON(history));
        return;
      }

      if (history.snapshots.length === 0) {
        console.log(`No history found for ${kind}:${entityId}`);
        return;
      }

      console.log(`History for ${kind}:${entityId} (${history.snapshots.length} snapshot${history.snapshots.length === 1 ? '' : 's'}):\n`);

      for (let i = 0; i < history.snapshots.length; i++) {
        const entry = history.snapshots[i];
        const state = entry.state;

        if (kind === 'node') {
          const node = state as MemoryNode;
          const prev = i > 0 ? history.snapshots[i - 1].state as MemoryNode : null;
          const mentionDelta = prev ? node.mentionCount - prev.mentionCount : 0;
          console.log(`  [${entry.timestamp}]  ${node.label} (${node.type})`);
          console.log(`    mentions: ${node.mentionCount}${mentionDelta > 0 ? ` (+${mentionDelta})` : ''}  reinforcements: ${node.reinforcementCount}  last: ${node.lastReinforced}`);
        } else {
          const edge = state as MemoryEdge;
          const prev = i > 0 ? history.snapshots[i - 1].state as MemoryEdge : null;
          const weightDelta = prev ? edge.weight - prev.weight : 0;
          const arrow = weightDelta > 0 ? '↑' : weightDelta < 0 ? '↓' : '=';
          console.log(`  [${entry.timestamp}]  ${edge.source} → ${edge.target}`);
          console.log(`    weight: ${edge.weight.toFixed(3)} ${arrow}${Math.abs(weightDelta) > 0.001 ? ` (${weightDelta > 0 ? '+' : ''}${weightDelta.toFixed(3)})` : ''}  stability: ${edge.stability.toFixed(2)}  type: ${edge.type}`);
        }
        console.log();
      }
    } finally {
      store.close();
    }
  },
});
