import { defineCommand } from 'citty';
import { SqliteStore, diffSnapshots } from '@nacre/core';
import { formatJSON } from '../output.js';

export default defineCommand({
  meta: {
    name: 'snapshots',
    description: 'List, create, view, and diff graph snapshots',
  },
  args: {
    action: {
      type: 'positional',
      description: 'Action: list (default), create, show, diff',
      required: false,
    },
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    since: {
      type: 'string',
      description: 'Filter snapshots created after this ISO date',
    },
    until: {
      type: 'string',
      description: 'Filter snapshots created before this ISO date',
    },
    limit: {
      type: 'string',
      description: 'Max snapshots to return',
      default: '20',
    },
    from: {
      type: 'string',
      description: 'From snapshot ID (for diff)',
    },
    to: {
      type: 'string',
      description: 'To snapshot ID (for diff)',
    },
    id: {
      type: 'string',
      description: 'Snapshot ID (for show)',
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
      console.error('Snapshots require a SQLite graph (.db file)');
      process.exit(1);
    }

    const store = SqliteStore.open(graphPath);
    const action = (args.action as string) || 'list';

    try {
      switch (action) {
        case 'list': {
          const snapshots = store.listSnapshots({
            since: args.since as string | undefined,
            until: args.until as string | undefined,
            limit: parseInt(args.limit as string, 10),
          });

          if ((args.format as string) === 'json') {
            console.log(formatJSON(snapshots));
            return;
          }

          if (snapshots.length === 0) {
            console.log('No snapshots found.');
            return;
          }

          console.log(`Found ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}:\n`);
          for (const snap of snapshots) {
            console.log(`  ${snap.createdAt}  ${snap.trigger}  ${snap.nodeCount} nodes, ${snap.edgeCount} edges, ${snap.episodeCount} episodes`);
          }
          break;
        }

        case 'create': {
          const snapshot = store.createSnapshot('manual');
          if ((args.format as string) === 'json') {
            console.log(formatJSON(snapshot));
            return;
          }
          console.log(`Snapshot created: ${snapshot.id}`);
          console.log(`  ${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges, ${snapshot.episodeCount} episodes`);
          break;
        }

        case 'show': {
          const snapshotId = args.id as string;
          if (!snapshotId) {
            console.error('--id is required for show action');
            process.exit(1);
          }

          const snapshot = store.getSnapshot(snapshotId);
          if (!snapshot) {
            console.error(`Snapshot not found: ${snapshotId}`);
            process.exit(1);
          }

          if ((args.format as string) === 'json') {
            const graph = store.getSnapshotGraph(snapshotId);
            console.log(formatJSON({ snapshot, graph }));
            return;
          }

          console.log(`Snapshot: ${snapshot.id}`);
          console.log(`  Created: ${snapshot.createdAt}`);
          console.log(`  Trigger: ${snapshot.trigger}`);
          console.log(`  Nodes: ${snapshot.nodeCount}`);
          console.log(`  Edges: ${snapshot.edgeCount}`);
          console.log(`  Episodes: ${snapshot.episodeCount}`);
          if (snapshot.metadata) {
            console.log(`  Metadata: ${JSON.stringify(snapshot.metadata)}`);
          }
          break;
        }

        case 'diff': {
          const fromId = args.from as string;
          const toId = args.to as string;
          if (!fromId || !toId) {
            console.error('--from and --to are required for diff action');
            process.exit(1);
          }

          const diff = diffSnapshots(store, fromId, toId);

          if ((args.format as string) === 'json') {
            console.log(formatJSON(diff));
            return;
          }

          console.log(`Diff: ${diff.fromSnapshot} → ${diff.toSnapshot}\n`);
          console.log(`  Nodes: +${diff.stats.nodesAdded}, -${diff.stats.nodesRemoved}, ~${diff.stats.nodesChanged}`);
          console.log(`  Edges: +${diff.stats.edgesAdded}, -${diff.stats.edgesRemoved}, ↑${diff.stats.edgesStrengthened}, ↓${diff.stats.edgesWeakened}`);
          console.log(`  Net change: ${diff.stats.netChange >= 0 ? '+' : ''}${diff.stats.netChange}`);

          if (diff.nodes.added.length > 0) {
            console.log(`\n  Added nodes:`);
            for (const n of diff.nodes.added.slice(0, 10)) {
              console.log(`    + ${n.label} (${n.type})`);
            }
          }

          if (diff.nodes.removed.length > 0) {
            console.log(`\n  Removed nodes:`);
            for (const n of diff.nodes.removed.slice(0, 10)) {
              console.log(`    - ${n.label} (${n.type})`);
            }
          }

          if (diff.edges.strengthened.length > 0) {
            console.log(`\n  Strengthened edges:`);
            for (const e of diff.edges.strengthened.slice(0, 10)) {
              console.log(`    ↑ ${e.source} → ${e.target} (${e.weight.toFixed(3)})`);
            }
          }
          break;
        }

        default:
          console.error(`Unknown action: ${action}. Use: list, create, show, diff`);
          process.exit(1);
      }
    } finally {
      store.close();
    }
  },
});
