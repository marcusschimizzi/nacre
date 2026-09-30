import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type SqliteStore,
  resolveProvider,
  resolveMemoryDir,
  resolveScopeForWrite,
  resolveScopePolicy,
  SESSION_SCOPE,
  filterGraphByScopes,
  parseScopesFilter,
  recall,
  generateBrief,
  extractQueryTerms,
  appendCapture,
  forgetMemory,
  mintMemoryId,
  readMemorySource,
  EncoderMismatchError,
  type EntityType,
  type MemoryNode,
  type MemoryObjectType,
  type Procedure,
  type ProcedureType,
} from '@nacre/core';
import { embedNodeBestEffort, embedResultWarning } from '../embed-node.js';

function generateId(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return `n-${Math.abs(hash).toString(36)}`;
}

const now = () => new Date().toISOString();

export function registerTools(server: McpServer, store: SqliteStore, graphPath: string): void {
  // Resolve the embedding provider once so its model (e.g. onnx) is loaded lazily
  // and reused across recall/remember rather than rebuilt on every call.
  const provider = resolveProvider({ graphPath, allowNull: true });

  server.tool(
    'nacre_recall',
    'Retrieve relevant memories using hybrid semantic + graph search',
    {
      query: z.string().describe('Natural language query'),
      limit: z.number().optional().default(10).describe('Max results'),
      types: z.array(z.string()).optional().describe('Filter by entity types'),
      since: z.string().optional().describe('ISO date — only memories after this'),
      includeSource: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include verbatim claim + Source evidence from canonical memory files'),
      scopes: z
        .array(z.string())
        .optional()
        .describe(
          "Scope filter, e.g. ['user','project/nacre']. Default: every durable scope; add 'session' explicitly to see scratch.",
        ),
    },
    async (args) => {
      let response: Awaited<ReturnType<typeof recall>>;
      let degradedNote = '';
      try {
        // Embed the query with the graph's configured provider (config/env) so
        // it matches the model the stored vectors were built with. Hardcoding a
        // provider here would mismatch dimensions and silently disable the
        // semantic half of recall. allowNull → graph-only when none is set.
        const recallProvider = store.embeddingCount() > 0 ? provider : null;
        response = await recall(store, recallProvider, {
          query: args.query,
          limit: args.limit,
          types: args.types as EntityType[] | undefined,
          since: args.since,
          scopes: parseScopesFilter(args.scopes),
        });
      } catch (err) {
        // A misconfigured encoder is a persistent configuration error, not an
        // outage — surface it; a silent graph-only fallback would mask it.
        if (err instanceof EncoderMismatchError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        // Provider unavailable (e.g. Ollama down) — degrade to graph-only
        // recall, but say so rather than masking the outage.
        try {
          response = await recall(store, null, {
            query: args.query,
            limit: args.limit,
            types: args.types as EntityType[] | undefined,
            since: args.since,
            scopes: parseScopesFilter(args.scopes),
          });
          degradedNote =
            '⚠ Semantic recall unavailable (embedding provider error) — graph-only results.\n\n';
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: 'Recall failed: embedding provider and graph recall both errored.',
              },
            ],
            isError: true,
          };
        }
      }

      if (response.results.length === 0) {
        return {
          content: [{ type: 'text', text: `${degradedNote}No memories found for that query.` }],
        };
      }

      const memoryDir = args.includeSource ? resolveMemoryDir(graphPath) : null;
      const lines = response.results.map((r, i) => {
        let line =
          `${i + 1}. ${r.label} (${r.type}) — score: ${r.score.toFixed(3)}\n` +
          `   semantic: ${r.scores.semantic.toFixed(2)}  graph: ${r.scores.graph.toFixed(2)}  ` +
          `recency: ${r.scores.recency.toFixed(2)}  importance: ${r.scores.importance.toFixed(2)}` +
          (r.connections.length > 0
            ? `\n   connections: ${r.connections.map((c) => `${c.label} (${c.relationship})`).join(', ')}`
            : '');
        if (memoryDir) {
          const canonicalPath = store.getNode(r.id)?.canonicalPath;
          const verbatim = canonicalPath ? readMemorySource(memoryDir, canonicalPath) : undefined;
          if (verbatim) {
            line += `\n   claim: ${verbatim.claim}`;
            if (verbatim.source) line += `\n   source: ${verbatim.source.replace(/\n/g, '\n   ')}`;
          }
        }
        return line;
      });

      let text = `${degradedNote}Found ${response.results.length} result${response.results.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`;

      if (response.procedures.length > 0) {
        text +=
          `\n\nRelevant Procedures:\n` +
          response.procedures
            .map((p) => `• ${p.statement} (${p.type}, confidence: ${p.confidence.toFixed(2)})`)
            .join('\n');
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
      scopes: z
        .array(z.string())
        .optional()
        .describe('Scope filter. Default: every durable scope; never session unless listed.'),
    },
    (args) => {
      const graph = filterGraphByScopes(store.getFullGraph(), parseScopesFilter(args.scopes));
      const result = generateBrief(graph, {
        top: args.top,
        recentDays: 7,
        now: new Date(),
      });

      let text = result.summary;
      if (args.focus) {
        const focusLower = args.focus.toLowerCase();
        const lines = text
          .split('\n')
          .filter(
            (line) =>
              line.toLowerCase().includes(focusLower) || line.startsWith('#') || line.trim() === '',
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
      scope: z
        .string()
        .optional()
        .describe(
          "Where the memory belongs: 'user', 'agent', 'project/<name>', or 'session' (scratch — expires, never becomes a file). Default: configured memory.defaultScope, else 'agent'.",
        ),
    },
    async (args) => {
      const typeMap: Record<string, EntityType> = {
        fact: 'concept',
        event: 'event',
        observation: 'concept',
        decision: 'decision',
      };
      const memoryTypeMap: Record<string, MemoryObjectType> = {
        fact: 'fact',
        event: 'fact',
        observation: 'claim',
        decision: 'decision',
      };

      const nodeType = typeMap[args.type] || 'concept';
      const id = mintMemoryId();
      const timestamp = now();
      const scope = resolveScopeForWrite(graphPath, args.scope);
      const scopeNote =
        args.scope && args.scope !== scope
          ? ` ⚠ Unknown scope "${args.scope}" — landed in '${scope}'.`
          : '';
      const sessionWrite = scope === SESSION_SCOPE;

      // Two-phase write (V2-1): the spool append is the durable act; the
      // candidate row below makes the memory immediately recallable. The
      // canonical file materializes at the next consolidation. Session
      // scratch short-circuits the spool entirely — it is not durable by
      // definition and must never be promoted (D4).
      const memoryDir = sessionWrite ? null : resolveMemoryDir(graphPath);
      if (memoryDir) {
        appendCapture(memoryDir, {
          id,
          ts: timestamp,
          origin: 'mcp',
          tool: 'nacre_remember',
          payload: {
            content: args.content,
            type: memoryTypeMap[args.type] ?? 'fact',
            // Preserve the node type through promotion (e.g. event → fact
            // would otherwise reclassify the compiled node as concept).
            entityType: nodeType,
            scope,
            links: args.entities,
          },
        });
      }

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
        // Session scratch is not a candidate — there is nothing to promote.
        ...(sessionWrite ? {} : { status: 'candidate' as const }),
        scope,
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

      // Embed the new memory so it's immediately recallable by semantic search.
      const embedResult = await embedNodeBestEffort(store, provider, node);
      const embedded = embedResult.embedded;

      const linkMsg = linked.length > 0 ? ` Linked to: ${linked.join(', ')}.` : '';
      const embedWarning = embedResultWarning(embedResult);
      const searchMsg = embedded
        ? ' Semantically searchable.'
        : embedWarning
          ? ` ${embedWarning}`
          : '';
      return {
        content: [
          {
            type: 'text',
            text: `Remembered: "${node.label}" (${nodeType}, id: ${id}). Scope: ${scope}.${scopeNote}${linkMsg}${searchMsg}${
              sessionWrite
                ? ` Scratch — expires after ${resolveScopePolicy(graphPath, SESSION_SCOPE).retentionDays ?? '∞'} days, never promoted to a file.`
                : memoryDir
                  ? ' Captured to the truth layer (canonical file at next consolidation).'
                  : ' ⚠ No memory directory configured — this memory lives only in the database.'
            }`,
          },
        ],
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
      // Forgetting is a truth-layer operation: remove the row, embedding, and
      // canonical file, and tombstone the spool so no consolidate/rebuild can
      // resurrect the memory.
      const result = forgetMemory(store, resolveMemoryDir(graphPath), args.memoryId, {
        ts: now(),
        origin: 'mcp',
        reason: args.reason,
      });

      const fileMsg = result.fileDeleted ? ` Canonical file removed: ${result.fileDeleted}.` : '';
      const durabilityMsg = result.tombstoned
        ? ' Tombstoned — will not return on consolidate or rebuild.'
        : ' ⚠ No memory directory configured — if this memory exists in a spool or canonical file elsewhere, it may return.';
      return {
        content: [
          {
            type: 'text',
            text: `Forgotten: "${label}" (${args.memoryId}).${args.reason ? ` Reason: ${args.reason}.` : ''}${fileMsg}${durabilityMsg}`,
          },
        ],
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
        content: [
          {
            type: 'text',
            text: `Feedback ${direction}: "${existing.label}" (rating: ${args.rating}).${args.reason ? ` Reason: ${args.reason}` : ''}`,
          },
        ],
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
        scope: resolveScopeForWrite(graphPath),
      };

      store.putProcedure(proc);

      return {
        content: [
          {
            type: 'text',
            text: `Procedure recorded: "${proc.statement}" (${proc.type}, id: ${id}, triggers: ${proc.triggerKeywords.join(', ')})`,
          },
        ],
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
        return (
          `${i + 1}. ${p.statement} (${p.type}, confidence: ${p.confidence.toFixed(2)})${flagged}\n` +
          `   id: ${p.id}, applied: ${p.applications}x, contradictions: ${p.contradictions}`
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: `${limited.length} procedure${limited.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    },
  );
}
