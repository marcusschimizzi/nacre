import { defineCommand } from 'citty';
import { SqliteStore, consolidateHive } from '@nacre/core';
import { formatJSON } from '../output.js';

const hiveConsolidate = defineCommand({
  meta: {
    name: 'consolidate',
    description: 'Merge multiple agent graphs into a hive graph',
  },
  args: {
    agents: {
      type: 'string',
      description: 'Comma-separated name:path pairs (e.g. "lobstar:/path/lobstar.db,melli:/path/melli.db")',
      required: true,
    },
    out: {
      type: 'string',
      description: 'Output path for hive .db',
      required: true,
    },
    'origin-factor': {
      type: 'string',
      description: 'Origin factor for hive weight discount (default: 0.6)',
      default: '0.6',
    },
  },
  async run({ args }) {
    const agentPairs = (args.agents as string).split(',').map((pair) => {
      const [name, graphPath] = pair.split(':');
      if (!name || !graphPath) {
        console.error(`Invalid agent pair: "${pair}". Expected format: name:/path/to/graph.db`);
        process.exit(1);
      }
      return { name: name.trim(), graphPath: graphPath.trim() };
    });

    const outPath = args.out as string;
    if (!outPath.endsWith('.db')) {
      console.error('Output path must end with .db');
      process.exit(1);
    }

    const originFactor = parseFloat(args['origin-factor'] as string);

    console.log(`Consolidating hive from ${agentPairs.length} agents...`);
    const hive = await consolidateHive({
      agents: agentPairs,
      outPath,
      originFactor,
    });

    const nodeCount = Object.keys(hive.nodes).length;
    const edgeCount = Object.keys(hive.edges).length;

    console.log(`Hive consolidation complete.`);
    console.log(`  Agents: ${hive.agents.join(', ')}`);
    console.log(`  Nodes merged: ${nodeCount}`);
    console.log(`  Edges: ${edgeCount}`);
    console.log(`  Written to: ${outPath}`);
  },
});

const hiveBrief = defineCommand({
  meta: {
    name: 'brief',
    description: 'Show a summary of a hive graph',
  },
  args: {
    hive: {
      type: 'string',
      description: 'Path to hive .db',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
  },
  async run({ args }) {
    const hivePath = args.hive as string;
    if (!hivePath.endsWith('.db')) {
      console.error('Hive path must be a .db file');
      process.exit(1);
    }

    const store = SqliteStore.open(hivePath);

    try {
      const agentsStr = store.getMeta('hive_agents');
      const agents: string[] = agentsStr ? JSON.parse(agentsStr) : [];
      const originFactor = store.getMeta('hive_origin_factor') ?? '0.6';
      const provenanceStr = store.getMeta('hive_provenance');
      const provenance: Record<string, { sourceAgents: string[]; referenceCount: number; endorsements: number }> =
        provenanceStr ? JSON.parse(provenanceStr) : {};

      const nodes = store.listNodes();
      const edgeCount = store.edgeCount();

      // Sort by hiveWeight (approximated from mention+reinforcement counts * originFactor)
      const factor = parseFloat(originFactor);
      const scored = nodes.map((n) => ({
        node: n,
        hiveWeight: (n.mentionCount + n.reinforcementCount) * factor,
        provenance: provenance[n.id],
      }));
      scored.sort((a, b) => b.hiveWeight - a.hiveWeight);
      const top = scored.slice(0, 10);

      if ((args.format as string) === 'json') {
        console.log(formatJSON({ agents, originFactor: factor, nodeCount: nodes.length, edgeCount, top }));
        return;
      }

      console.log(`Hive Graph: ${hivePath}`);
      console.log(`  Agents: ${agents.join(', ') || '(unknown)'}`);
      console.log(`  Origin factor: ${originFactor}`);
      console.log(`  Nodes: ${nodes.length}`);
      console.log(`  Edges: ${edgeCount}`);
      console.log(`\nTop 10 nodes by hive weight:`);

      for (let i = 0; i < top.length; i++) {
        const { node, hiveWeight, provenance: prov } = top[i];
        const agentList = prov?.sourceAgents?.join(', ') ?? '?';
        console.log(
          `  ${i + 1}. ${node.label} (${node.type}) — hiveWeight: ${hiveWeight.toFixed(2)}, agents: [${agentList}]`,
        );
      }
    } finally {
      store.close();
    }
  },
});

export default defineCommand({
  meta: {
    name: 'hive',
    description: 'Federated multi-agent hive graph operations',
  },
  subCommands: {
    consolidate: hiveConsolidate,
    brief: hiveBrief,
  },
});
