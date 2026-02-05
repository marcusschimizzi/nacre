import { defineCommand } from 'citty';
import {
  findNode,
  getNeighbors,
  getRelated,
  getFading,
  getClusters,
  generateBrief,
  searchNodes,
  type EntityType,
} from '@nacre/core';
import { formatText, formatJSON } from '../output.js';
import { loadGraph, closeGraph } from '../graph-loader.js';

export default defineCommand({
  meta: {
    name: 'query',
    description: 'Query the memory graph',
  },
  args: {
    search: {
      type: 'positional',
      description: 'Entity to search for (supports multiple space-separated terms)',
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
    search_: {
      type: 'boolean',
      description: 'Fuzzy multi-term search across all nodes',
      alias: 's',
    },
    type: {
      type: 'string',
      description: 'Filter by entity type (person, project, tool, concept, etc.)',
    },
    since: {
      type: 'string',
      description: 'Filter to nodes seen within N days (e.g. 7, 30)',
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
    graph: {
      type: 'string',
      description: 'Path to graph (.db or .json)',
      default: 'data/graphs/default/graph.json',
    },
  },
  async run({ args }) {
    const loaded = await loadGraph(args.graph as string);
    try {
      const graph = loaded.graph;
      const fmt = args.format as string;
      const now = new Date();
      const typeFilter = args.type as EntityType | undefined;
      const sinceDays = args.since ? parseInt(args.since as string, 10) : undefined;

      if (args.brief) {
        const result = generateBrief(graph, { now });
        if (fmt === 'json') {
          console.log(formatJSON(result));
        } else {
          console.log(result.summary);
        }
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
        if (typeFilter || sinceDays !== undefined) {
          const results = searchNodes(graph, [], { type: typeFilter, sinceDays, now });
          if (fmt === 'json') {
            console.log(formatJSON(results));
          } else {
            const nodes = results.map((r) => r.node);
            console.log(formatText({ nodes }));
          }
          return;
        }
        console.error('Provide a search term, or use --brief, --clusters, --fading, --type, or --since');
        process.exit(1);
      }

      if (args.search_ || typeFilter || sinceDays !== undefined) {
        const terms = search.split(/\s+/).filter((t) => t.length > 0);
        const results = searchNodes(graph, terms, { type: typeFilter, sinceDays, now });
        if (fmt === 'json') {
          console.log(formatJSON(results));
        } else {
          if (results.length === 0) {
            console.log('No matches found.');
          } else {
            console.log(`Found ${results.length} match${results.length === 1 ? '' : 'es'}:`);
            for (const r of results) {
              console.log(`  ${r.node.label} (${r.node.type}) — score: ${r.matchScore.toFixed(2)}, mentions: ${r.node.mentionCount}`);
            }
          }
        }
        return;
      }

      const node = findNode(graph, search);
      if (!node) {
        console.error(`Node not found: ${search}`);
        console.error('Tip: use -s for fuzzy search, or --type / --since to filter');
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
    } finally {
      closeGraph(loaded);
    }
  },
});
