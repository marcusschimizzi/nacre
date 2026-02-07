import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SqliteStore,
  generateBrief,
  generateAlerts,
} from '@nacre/core';

export function registerResources(server: McpServer, store: SqliteStore): void {
  server.resource(
    'Current Briefing',
    'nacre://brief',
    { description: 'Auto-updating context briefing', mimeType: 'text/plain' },
    () => {
      const graph = store.getFullGraph();
      const result = generateBrief(graph, { top: 10, recentDays: 7, now: new Date() });

      return {
        contents: [{
          uri: 'nacre://brief',
          mimeType: 'text/plain',
          text: result.summary,
        }],
      };
    },
  );

  server.resource(
    'Memory Health',
    'nacre://health',
    { description: 'Graph health metrics and status', mimeType: 'application/json' },
    () => {
      const graph = store.getFullGraph();
      const alerts = generateAlerts(graph, { now: new Date() });

      const health = {
        healthScore: alerts.healthScore,
        fadingEdgeCount: alerts.fadingEdges.length,
        orphanNodeCount: alerts.orphanNodes.length,
        summary: alerts.summary,
        fadingEdges: alerts.fadingEdges.map((f) => ({
          source: f.sourceLabel,
          target: f.targetLabel,
          currentWeight: f.currentWeight,
          daysSinceReinforced: f.daysSinceReinforced,
        })),
        orphanNodes: alerts.orphanNodes.map((n) => n.label),
      };

      return {
        contents: [{
          uri: 'nacre://health',
          mimeType: 'application/json',
          text: JSON.stringify(health, null, 2),
        }],
      };
    },
  );

  server.resource(
    'Graph Statistics',
    'nacre://graph/stats',
    { description: 'Node/edge counts, type breakdown', mimeType: 'application/json' },
    () => {
      const graph = store.getFullGraph();
      const nodes = Object.values(graph.nodes);
      const edges = Object.values(graph.edges);

      const nodesByType: Record<string, number> = {};
      for (const n of nodes) {
        nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
      }

      const edgesByType: Record<string, number> = {};
      for (const e of edges) {
        edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
      }

      const stats = {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        episodeCount: store.episodeCount(),
        embeddingCount: store.embeddingCount(),
        nodesByType,
        edgesByType,
        lastConsolidated: graph.lastConsolidated,
      };

      return {
        contents: [{
          uri: 'nacre://graph/stats',
          mimeType: 'application/json',
          text: JSON.stringify(stats, null, 2),
        }],
      };
    },
  );
}
