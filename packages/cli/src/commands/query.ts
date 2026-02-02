import { readFileSync } from 'node:fs';
import { defineCommand } from 'citty';
import {
  findNode,
  getNeighbors,
  getRelated,
  getFading,
  getClusters,
  generateBrief,
  type NacreGraph,
} from '@nacre/core';
import { formatText, formatJSON } from '../output.js';

export default defineCommand({
  meta: {
    name: 'query',
    description: 'Query the memory graph',
  },
  args: {
    search: {
      type: 'positional',
      description: 'Entity to search for',
      required: false,
    },
    hops: {
      type: 'string',
      description: 'Number of hops for neighborhood',
      default: '1',
    },
    related: {
      type: 'boolean',
      description: 'Show related entities sorted by edge weight',
    },
    fading: {
      type: 'boolean',
      description: 'Show edges approaching dormancy',
    },
    clusters: {
      type: 'boolean',
      description: 'Show graph clusters',
    },
    brief: {
      type: 'boolean',
      description: 'Generate context briefing',
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
    graph: {
      type: 'string',
      description: 'Path to graph.json',
      default: 'data/graphs/default/graph.json',
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    let graph: NacreGraph;
    try {
      graph = JSON.parse(readFileSync(graphPath, 'utf8')) as NacreGraph;
    } catch {
      console.error(`Could not read graph at: ${graphPath}`);
      process.exit(1);
    }

    const fmt = args.format as string;
    const now = new Date();

    if (args.brief) {
      const text = generateBrief(graph, { now });
      console.log(text);
      return;
    }

    if (args.clusters) {
      const result = getClusters(graph);
      if (fmt === 'json') {
        console.log(formatJSON(result));
      } else {
        console.log(formatText({ clusters: result }));
      }
      return;
    }

    if (args.fading) {
      const edges = getFading(graph, now, graph.config);
      if (fmt === 'json') {
        console.log(formatJSON(edges));
      } else {
        console.log(formatText({ edges }));
      }
      return;
    }

    const search = args.search as string | undefined;
    if (!search) {
      console.error('Provide a search term, or use --brief, --clusters, or --fading');
      process.exit(1);
    }

    const node = findNode(graph, search);
    if (!node) {
      console.error(`Node not found: ${search}`);
      process.exit(1);
    }

    if (args.related) {
      const related = getRelated(graph, node.id);
      if (fmt === 'json') {
        console.log(formatJSON({ node, related }));
      } else {
        console.log(formatText({ nodes: [node, ...related] }));
      }
      return;
    }

    const hops = parseInt(args.hops as string, 10) || 1;
    const { nodes, edges } = getNeighbors(graph, node.id, hops);

    if (fmt === 'json') {
      console.log(formatJSON({ node, neighbors: { nodes, edges } }));
    } else {
      console.log(`${node.label} (${node.type})`);
      console.log(`  Mentions: ${node.mentionCount}, Reinforced: ${node.reinforcementCount}`);
      console.log(`  First seen: ${node.firstSeen}, Last reinforced: ${node.lastReinforced}`);
      console.log(`  Sources: ${node.sourceFiles.length} files`);
      console.log(`\nNeighbors (${hops} hop${hops > 1 ? 's' : ''}):`);
      for (const n of nodes) {
        console.log(`  ${n.label} (${n.type}) - mentions: ${n.mentionCount}`);
      }
      console.log(`\nEdges: ${edges.length}`);
      for (const e of edges) {
        const src = graph.nodes[e.source]?.label ?? e.source;
        const tgt = graph.nodes[e.target]?.label ?? e.target;
        console.log(`  ${src} --[${e.type}]--> ${tgt} (weight: ${e.weight.toFixed(3)})`);
      }
    }
  },
});
