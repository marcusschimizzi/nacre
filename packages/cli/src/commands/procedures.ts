import { defineCommand } from 'citty';
import { SqliteStore, type Procedure, type ProcedureType } from '@nacre/core';
import { formatJSON } from '../output.js';

const PROCEDURE_TYPES: ProcedureType[] = [
  'preference',
  'skill',
  'antipattern',
  'insight',
  'heuristic',
];

type Feedback = 'positive' | 'negative' | 'neutral';

function isProcedureType(value: string): value is ProcedureType {
  return PROCEDURE_TYPES.includes(value as ProcedureType);
}

function isFeedback(value: string): value is Feedback {
  return value === 'positive' || value === 'negative' || value === 'neutral';
}

function parseCommaSeparated(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function extractKeywords(statement: string): string[] {
  const terms = statement
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
  return [...new Set(terms)];
}

function generateId(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return `proc-${Math.abs(hash).toString(36)}`;
}

export default defineCommand({
  meta: {
    name: 'procedures',
    description: 'Manage procedural memory entries',
  },
  args: {
    action: {
      type: 'positional',
      description: 'Action: list, add, apply, remove',
      required: false,
    },
    id: {
      type: 'positional',
      description: 'Procedure ID (for apply/remove)',
      required: false,
    },
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    statement: {
      type: 'string',
      description: 'Procedure statement (for add)',
    },
    type: {
      type: 'string',
      description: 'Procedure type: preference, skill, antipattern, insight, heuristic',
    },
    keywords: {
      type: 'string',
      description: 'Comma-separated trigger keywords',
    },
    contexts: {
      type: 'string',
      description: 'Comma-separated domain contexts',
    },
    feedback: {
      type: 'string',
      description: 'Feedback: positive, negative, neutral',
    },
    flagged: {
      type: 'boolean',
      description: 'Show only flagged procedures',
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
      console.error('Procedures require a SQLite graph (.db file)');
      process.exit(1);
    }

    const format = args.format as string;
    if (format !== 'text' && format !== 'json') {
      console.error('Invalid --format value. Use: text or json');
      process.exit(1);
    }

    const action = ((args.action as string | undefined) ?? 'list').toLowerCase();
    const store = SqliteStore.open(graphPath);

    try {
      if (action === 'list') {
        const rawType = args.type as string | undefined;
        let procedureType: ProcedureType | undefined;

        if (rawType) {
          if (!isProcedureType(rawType)) {
            console.error(
              'Invalid --type value. Use: preference, skill, antipattern, insight, heuristic',
            );
            process.exit(1);
          }
          procedureType = rawType;
        }

        const procedures = store.listProcedures({
          type: procedureType,
          flaggedOnly: Boolean(args.flagged),
        });

        if (format === 'json') {
          console.log(formatJSON(procedures));
          return;
        }

        if (procedures.length === 0) {
          console.log('No procedures found.');
          return;
        }

        console.log(`Found ${procedures.length} procedure${procedures.length === 1 ? '' : 's'}:`);
        for (const procedure of procedures) {
          const flagged = procedure.flaggedForReview ? ' [flagged]' : '';
          console.log(
            `  ${procedure.id} (${procedure.type}) - confidence ${procedure.confidence.toFixed(2)}${flagged}`,
          );
          console.log(`    ${procedure.statement}`);
        }
        return;
      }

      if (action === 'add') {
        const statement = (args.statement as string | undefined)?.trim();
        const rawType = args.type as string | undefined;

        if (!statement) {
          console.error('Missing required --statement for add');
          process.exit(1);
        }
        if (!rawType || !isProcedureType(rawType)) {
          console.error(
            'Missing or invalid --type for add. Use: preference, skill, antipattern, insight, heuristic',
          );
          process.exit(1);
        }

        const contexts = parseCommaSeparated(args.contexts as string | undefined);

        const keywordsArg = args.keywords as string | undefined;
        const keywords = keywordsArg
          ? parseCommaSeparated(keywordsArg)
          : extractKeywords(statement);

        const now = new Date().toISOString();
        const procedure: Procedure = {
          id: generateId(statement),
          statement,
          type: rawType,
          triggerKeywords: keywords,
          triggerContexts: contexts,
          sourceEpisodes: [],
          sourceNodes: [],
          confidence: 0.5,
          applications: 0,
          contradictions: 0,
          stability: 1,
          lastApplied: null,
          createdAt: now,
          updatedAt: now,
          flaggedForReview: false,
        };

        store.putProcedure(procedure);

        if (format === 'json') {
          console.log(formatJSON(procedure));
          return;
        }

        console.log(`Added procedure ${procedure.id}`);
        return;
      }

      if (action === 'apply') {
        const id = (args.id as string | undefined)?.trim();
        const feedback = args.feedback as string | undefined;

        if (!id) {
          console.error('Missing procedure id for apply');
          process.exit(1);
        }
        if (!feedback || !isFeedback(feedback)) {
          console.error('Missing or invalid --feedback for apply. Use: positive, negative, neutral');
          process.exit(1);
        }

        const procedure = store.getProcedure(id);
        if (!procedure) {
          console.error(`Procedure not found: ${id}`);
          process.exit(1);
        }

        const now = new Date().toISOString();
        const updated: Procedure = { ...procedure, lastApplied: now, updatedAt: now };

        if (feedback === 'positive') {
          updated.applications += 1;
          updated.confidence = Math.min(
            0.99,
            procedure.confidence + 0.1 * (1 - procedure.confidence),
          );
          updated.stability = Math.min(2, procedure.stability + 0.1);
        } else if (feedback === 'negative') {
          updated.contradictions += 1;
          updated.confidence = Math.max(0.01, procedure.confidence * 0.8);

          if (updated.contradictions >= 3 && updated.confidence < 0.3) {
            updated.flaggedForReview = true;
          }
        }

        store.putProcedure(updated);

        if (format === 'json') {
          console.log(formatJSON(updated));
          return;
        }

        console.log(`Applied procedure ${updated.id} with ${feedback} feedback`);
        return;
      }

      if (action === 'remove') {
        const id = (args.id as string | undefined)?.trim();
        if (!id) {
          console.error('Missing procedure id for remove');
          process.exit(1);
        }

        const procedure = store.getProcedure(id);
        if (!procedure) {
          console.error(`Procedure not found: ${id}`);
          process.exit(1);
        }

        store.deleteProcedure(id);

        if (format === 'json') {
          console.log(formatJSON({ removed: id }));
          return;
        }

        console.log(`Removed procedure ${id}`);
        return;
      }

      console.error(`Unknown action: ${action}. Use: list, add, apply, remove`);
      process.exit(1);
    } finally {
      store.close();
    }
  },
});
