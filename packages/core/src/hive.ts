/**
 * Hive Graph — federated multi-agent memory consolidation.
 *
 * Merges multiple agent graphs into a shared hive graph.
 * Nodes with the same ID (same label hash) are deduplicated;
 * provenance tracks which agents contributed each node.
 */

import type {
  HiveConsolidationOptions,
  HiveGraph,
  HiveNode,
  HiveProvenance,
  MemoryEdge,
  GraphConfig,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { SqliteStore } from './store.js';
import { effectiveNodeScope, scopePolicy, type ScopePolicyOverrides } from './scopes.js';

/**
 * Adaptive origin factor based on the private graph size.
 * Small graphs get a higher factor (hive knowledge is more valuable
 * when the agent has little private knowledge).
 */
export function getHiveOriginFactor(privateNodeCount: number, configuredFactor: number): number {
  if (privateNodeCount < 50) return 0.9;
  if (privateNodeCount < 100) return 0.75;
  return configuredFactor;
}

/**
 * Consolidate multiple agent graphs into a single hive graph.
 *
 * 1. Opens each agent .db readonly
 * 2. Merges nodes by ID (same label = same hash)
 * 3. Tracks provenance (which agents, reference counts, endorsements)
 * 4. Applies originFactor to compute hiveWeight
 * 5. Writes merged graph to outPath as a new SqliteStore
 */
export async function consolidateHive(options: HiveConsolidationOptions): Promise<HiveGraph> {
  const originFactor = options.originFactor ?? 0.6;
  const agentNames: string[] = [];

  const mergedNodes: Record<string, HiveNode> = {};
  const mergedEdges: Record<string, MemoryEdge> = {};
  let mergedConfig: GraphConfig = { ...DEFAULT_CONFIG };

  const stores: SqliteStore[] = [];

  try {
    for (const agent of options.agents) {
      agentNames.push(agent.name);
      const store = SqliteStore.open(agent.graphPath);
      stores.push(store);

      const graph = store.getFullGraph();
      mergedConfig = graph.config;

      for (const [id, node] of Object.entries(graph.nodes)) {
        if (node.hiveExclude) continue;
        // Scope policy (V2-2 D5): agent-local and session memories never
        // enter federated hive graphs by default. Entities (no scope) and
        // pre-v9 legacy memory rows follow their effective scope's policy.
        const effective = effectiveNodeScope(node);
        if (effective !== null && !scopePolicy(effective, options.scopeOverrides).hiveEligible) {
          continue;
        }

        if (mergedNodes[id]) {
          // Merge into existing node
          const existing = mergedNodes[id];

          // Union sourceFiles
          const sourceSet = new Set([...existing.sourceFiles, ...node.sourceFiles]);
          existing.sourceFiles = [...sourceSet];

          // Take latest lastReinforced
          if (node.lastReinforced > existing.lastReinforced) {
            existing.lastReinforced = node.lastReinforced;
          }

          // Take earliest firstSeen
          if (node.firstSeen < existing.firstSeen) {
            existing.firstSeen = node.firstSeen;
          }

          // Sum counts
          existing.mentionCount += node.mentionCount;
          existing.reinforcementCount += node.reinforcementCount;

          // Union excerpts (cap at 10)
          const excerptTexts = new Set(existing.excerpts.map((e) => e.text));
          for (const ex of node.excerpts) {
            if (!excerptTexts.has(ex.text) && existing.excerpts.length < 10) {
              existing.excerpts.push(ex);
              excerptTexts.add(ex.text);
            }
          }

          // Union aliases
          const aliasSet = new Set([...existing.aliases, ...node.aliases]);
          existing.aliases = [...aliasSet];

          // Update provenance
          if (!existing.provenance.sourceAgents.includes(agent.name)) {
            existing.provenance.sourceAgents.push(agent.name);
            existing.provenance.endorsements++;
          }
          existing.provenance.referenceCount += node.mentionCount;
          if (node.lastReinforced > existing.provenance.lastReferenced) {
            existing.provenance.lastReferenced = node.lastReinforced;
          }
          if (node.firstSeen < existing.provenance.firstSeen) {
            existing.provenance.firstSeen = node.firstSeen;
          }

          // Recalculate hiveWeight
          existing.hiveWeight =
            (existing.mentionCount + existing.reinforcementCount) * originFactor;
        } else {
          // Create new hive node
          const provenance: HiveProvenance = {
            sourceAgents: [agent.name],
            firstSeen: node.firstSeen,
            lastReferenced: node.lastReinforced,
            referenceCount: node.mentionCount,
            endorsements: 1,
          };

          mergedNodes[id] = {
            ...node,
            hiveWeight: (node.mentionCount + node.reinforcementCount) * originFactor,
            originFactor,
            provenance,
          };
        }
      }

      // Merge edges (union by ID, take higher weight)
      for (const [id, edge] of Object.entries(graph.edges)) {
        if (mergedEdges[id]) {
          const existing = mergedEdges[id];
          if (edge.weight > existing.weight) {
            mergedEdges[id] = { ...edge };
          }
          // Sum reinforcement counts
          mergedEdges[id].reinforcementCount += existing.reinforcementCount;
        } else {
          mergedEdges[id] = { ...edge };
        }
      }
    }
  } finally {
    for (const store of stores) {
      store.close();
    }
  }

  const now = new Date().toISOString();

  const hiveGraph: HiveGraph = {
    version: 1,
    lastConsolidated: now,
    agents: agentNames,
    nodes: mergedNodes,
    edges: mergedEdges,
    config: mergedConfig,
  };

  // Write to output store (clear existing data for a clean hive)
  const outStore = SqliteStore.open(options.outPath);
  try {
    outStore.raw.exec('DELETE FROM edges');
    outStore.raw.exec('DELETE FROM nodes');

    for (const node of Object.values(mergedNodes)) {
      outStore.putNode(node);
    }
    for (const edge of Object.values(mergedEdges)) {
      outStore.putEdge(edge);
    }

    // Store hive metadata in the meta table
    outStore.setMeta('hive_agents', JSON.stringify(agentNames));
    outStore.setMeta('hive_origin_factor', String(originFactor));
    outStore.setMeta('last_consolidated', now);
    outStore.setMeta('config', JSON.stringify(mergedConfig));

    // Store per-node provenance as a JSON blob in meta
    const provenanceMap: Record<string, HiveProvenance> = {};
    for (const [id, node] of Object.entries(mergedNodes)) {
      provenanceMap[id] = node.provenance;
    }
    outStore.setMeta('hive_provenance', JSON.stringify(provenanceMap));
  } finally {
    outStore.close();
  }

  return hiveGraph;
}
