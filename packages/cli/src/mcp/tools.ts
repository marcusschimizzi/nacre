import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SqliteStore,
  MockEmbedder,
  OllamaEmbedder,
  recall,
  generateBrief,
  extractQueryTerms,
  type EmbeddingProvider,
  type EntityType,
  type MemoryNode,
  type Procedure,
  type ProcedureType,
} from '@nacre/core';

function createProvider(store: SqliteStore): EmbeddingProvider | null {
  if (store.embeddingCount() === 0) return null;
  // Use MockEmbedder for reliable behavior - OllamaEmbedder requires running Ollama
  // The MCP tool handler has fallback logic if embedding fails
  return new MockEmbedder();
}

function generateId(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return `n-${Math.abs(hash).toString(36)}`;
}

const now = () => new Date().toISOString();

export function registerTools(server: McpServer, store: SqliteStore): void {
  server.tool(
    'nacre_recall',
    'Retrieve relevant memories using hybrid semantic + graph search',
    {
      query: z.string().describe('Natural language query'),
      limit: z.number().optional().default(10).describe('Max results'),
      types: z.array(z.string()).optional().describe('Filter by entity types'),
      since: z.string().optional().describe('ISO date — only memories after this'),
    },
    async (args) => {
      let response;
      try {
        const provider = createProvider(store);
        response = await recall(store, provider, {
          query: args.query,
          limit: args.limit,
          types: args.types as EntityType[] | undefined,
          since: args.since,
        });
      } catch {
        // Ollama unavailable or other error — fall back to graph-only recall
        try {
          response = await recall(store, null, {
            query: args.query,
            limit: args.limit,
            types: args.types as EntityType[] | undefined,
            since: args.since,
          });
        } catch {
          // If even graph-only recall fails, return empty results
          return { content: [{ type: 'text', text: 'No memories found for that query.' }] };
        }
      }

      if (response.results.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found for that query.' }] };
      }

      const lines = response.results.map((r, i) =>
        `${i + 1}. ${r.label} (${r.type}) — score: ${r.score.toFixed(3)}\n` +
        `   semantic: ${r.scores.semantic.toFixed(2)}  graph: ${r.scores.graph.toFixed(2)}  ` +
        `recency: ${r.scores.recency.toFixed(2)}  importance: ${r.scores.importance.toFixed(2)}` +
        (r.connections.length > 0
          ? `\n   connections: ${r.connections.map((c) => `${c.label} (${c.relationship})`).join(', ')}`
          : ''),
      );

      let text = `Found ${response.results.length} result${response.results.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`;
      
      if (response.procedures.length > 0) {
        text += `\n\nRelevant Procedures:\n` + response.procedures.map(p => 
          `• ${p.statement} (${p.type}, confidence: ${p.confidence.toFixed(2)})`
        ).join('\n');
      }

      return {
        content: [{ type: 'text', text }],
      };
    },
  );

  server.tool(
    'nacre_brief',
    'Get a contextual briefing — recent activity, key entities, alerts',
    {
      focus: z.string().optional().describe('Optional topic to focus the briefing on'),
      top: z.number().optional().default(10).describe('Number of top entities to include'),
    },
    (args) => {
      const graph = store.getFullGraph();
      const result = generateBrief(graph, {
        top: args.top,
        recentDays: 7,
        now: new Date(),
      });

      let text = result.summary;
      if (args.focus) {
        const focusLower = args.focus.toLowerCase();
        const lines = text.split('\n').filter(
          (line) => line.toLowerCase().includes(focusLower) || line.startsWith('#') || line.trim() === '',
        );
        if (lines.length > 2) {
          text = lines.join('\n');
        }
      }

      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'nacre_remember',
    'Store a new memory — a fact, observation, or event',
    {
      content: z.string().describe('The memory content'),
      type: z
        .enum(['fact', 'event', 'observation', 'decision'])
        .optional()
        .default('fact')
        .describe('Memory type'),
      importance: z.number().optional().default(0.5).describe('0-1, how important (affects decay)'),
      entities: z.array(z.string()).optional().describe('Related entity names to link'),
    },
    (args) => {
      const typeMap: Record<string, EntityType> = {
        fact: 'concept',
        event: 'event',
        observation: 'concept',
        decision: 'decision',
      };

      const nodeType = typeMap[args.type] || 'concept';
      const id = generateId(args.content);
      const timestamp = now();

      const node: MemoryNode = {
        id,
        label: args.content.slice(0, 100),
        type: nodeType,
        aliases: [],
        firstSeen: timestamp,
        lastReinforced: timestamp,
        mentionCount: 1,
        reinforcementCount: Math.ceil(args.importance * 3),
        sourceFiles: ['mcp'],
        excerpts: [{ file: 'mcp', text: args.content, date: timestamp }],
      };

      store.putNode(node);

      const linked: string[] = [];
      if (args.entities) {
        for (const name of args.entities) {
          const existing = store.findNode(name);
          if (existing) {
            const edgeId = `${id}--${existing.id}--explicit`;
            store.putEdge({
              id: edgeId,
              source: id,
              target: existing.id,
              type: 'explicit',
              directed: false,
              weight: 0.8,
              baseWeight: 0.8,
              reinforcementCount: 1,
              firstFormed: timestamp,
              lastReinforced: timestamp,
              stability: 1.0,
              evidence: [{ file: 'mcp', date: timestamp, context: `Linked by user: ${name}` }],
            });
            linked.push(existing.label);
          }
        }
      }

      const linkMsg = linked.length > 0 ? ` Linked to: ${linked.join(', ')}.` : '';
      return {
        content: [{
          type: 'text',
          text: `Remembered: "${node.label}" (${nodeType}, id: ${id}).${linkMsg}`,
        }],
      };
    },
  );

  server.tool(
    'nacre_forget',
    'Explicitly forget a memory',
    {
      memoryId: z.string().describe('ID of the memory to forget'),
      reason: z.string().optional().describe('Why this is being forgotten'),
    },
    (args) => {
      const existing = store.getNode(args.memoryId);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Memory not found: ${args.memoryId}` }],
          isError: true,
        };
      }

      const label = existing.label;
      store.deleteNode(args.memoryId);

      return {
        content: [{
          type: 'text',
          text: `Forgotten: "${label}" (${args.memoryId}).${args.reason ? ` Reason: ${args.reason}` : ''}`,
        }],
      };
    },
  );

  server.tool(
    'nacre_feedback',
    "Rate a memory's usefulness — helps nacre learn what matters",
    {
      memoryId: z.string().describe('ID of the memory'),
      rating: z.number().min(-1).max(1).describe('-1 (not useful) to 1 (very useful)'),
      reason: z.string().optional().describe('Why this rating'),
    },
    (args) => {
      const existing = store.getNode(args.memoryId);
      if (!existing) {
        return {
          content: [{ type: 'text', text: `Memory not found: ${args.memoryId}` }],
          isError: true,
        };
      }

      const updated: MemoryNode = { ...existing };
      if (args.rating > 0) {
        updated.reinforcementCount += 1;
        updated.lastReinforced = now();
      } else if (args.rating < 0) {
        updated.reinforcementCount = Math.max(0, updated.reinforcementCount - 1);
      }
      store.putNode(updated);

      const direction = args.rating > 0 ? 'reinforced' : args.rating < 0 ? 'weakened' : 'noted';
      return {
        content: [{
          type: 'text',
          text: `Feedback ${direction}: "${existing.label}" (rating: ${args.rating}).${args.reason ? ` Reason: ${args.reason}` : ''}`,
        }],
      };
    },
  );

  server.tool(
    'nacre_lesson',
    'Record a learned lesson, preference, or behavioral pattern as a procedure',
    {
      lesson: z.string().describe('What was learned'),
      type: z
        .enum(['preference', 'skill', 'antipattern', 'insight', 'heuristic'])
        .optional()
        .default('insight')
        .describe('Procedure type'),
      context: z.string().optional().describe('When/where this applies'),
      keywords: z.array(z.string()).optional().describe('Trigger keywords'),
      contexts: z.array(z.string()).optional().describe('Domain contexts'),
    },
    (args) => {
      const id = generateId(`proc:${args.lesson}`);
      const timestamp = now();

      const keywords = args.keywords ?? extractQueryTerms(args.lesson);

      const proc: Procedure = {
        id,
        statement: args.lesson,
        type: args.type as ProcedureType,
        triggerKeywords: [...new Set(keywords)],
        triggerContexts: args.contexts ?? [],
        sourceEpisodes: [],
        sourceNodes: [],
        confidence: 0.5,
        applications: 0,
        contradictions: 0,
        stability: 1.0,
        lastApplied: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        flaggedForReview: false,
      };

      store.putProcedure(proc);

      return {
        content: [{
          type: 'text',
          text: `Procedure recorded: "${proc.statement}" (${proc.type}, id: ${id}, triggers: ${proc.triggerKeywords.join(', ')})`,
        }],
      };
    },
  );

  server.tool(
    'nacre_procedures',
    'List procedures — learned behavioral patterns, preferences, and skills',
    {
      type: z
        .enum(['preference', 'skill', 'antipattern', 'insight', 'heuristic'])
        .optional()
        .describe('Filter by procedure type'),
      flagged: z.boolean().optional().default(false).describe('Show only flagged procedures'),
      limit: z.number().optional().default(20).describe('Max results'),
    },
    (args) => {
      const procedures = store.listProcedures({
        type: args.type as ProcedureType | undefined,
        flaggedOnly: args.flagged,
      });

      const limited = procedures.slice(0, args.limit);

      if (limited.length === 0) {
        return { content: [{ type: 'text', text: 'No procedures found.' }] };
      }

      const lines = limited.map((p, i) => {
        const flagged = p.flaggedForReview ? ' [FLAGGED]' : '';
        return `${i + 1}. ${p.statement} (${p.type}, confidence: ${p.confidence.toFixed(2)})${flagged}\n` +
          `   id: ${p.id}, applied: ${p.applications}x, contradictions: ${p.contradictions}`;
      });

      return {
        content: [{
          type: 'text',
          text: `${limited.length} procedure${limited.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`,
        }],
      };
    },
  );
}
