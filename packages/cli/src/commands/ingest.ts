import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defineCommand } from 'citty';
import {
  SqliteStore,
  historicalImportIdentity,
  importHistoricalConversation,
  ingestConversation,
  inventoryOpenClawSessions,
  parseConversationFile,
  resolveMemoryDir,
  resolveProvider,
  type ConversationFormat,
  type IngestOptions,
} from '@nacre/core';
import { extractFromConversation } from '@nacre/parser';
import { formatJSON } from '../output.js';

export interface HistoricalIngestCommandOptions {
  source: string;
  graph: string;
  memoryRoot: string;
  format: 'openclaw';
  recursive?: boolean;
  resume?: boolean;
  agent?: string;
  scope: string;
  dryRun: boolean;
  reportPath?: string;
}

export interface HistoricalIngestReport {
  version: 1;
  dryRun: boolean;
  plannedScope: string;
  agent?: string;
  selectedFiles: string[];
  excludedFiles: Array<{ path: string; kind: string; reason: string; digest: string }>;
  warnings: string[];
  countsByOrigin: Record<string, number>;
  timeRange: { start?: string; end?: string };
  duplicateGroups: string[][];
  estimatedEvidenceBytes: number;
  imports: Array<{ file: string; status: string; importId: string; episodesCreated: number }>;
}

export async function executeHistoricalIngest(
  options: HistoricalIngestCommandOptions,
): Promise<HistoricalIngestReport> {
  const inventory = inventoryOpenClawSessions(options.source, {
    recursive: options.recursive ?? false,
  });
  const countsByOrigin: Record<string, number> = {};
  const timestamps: string[] = [];
  let estimatedEvidenceBytes = 0;
  const inputs = inventory.sessions.map((session) => {
    const file = session.selected.path;
    const content = session.selected.content;
    estimatedEvidenceBytes += Buffer.byteLength(content);
    const input = parseConversationFile(content, 'openclaw', {
      source: `openclaw:${session.selected.digest.slice(0, 16)}`,
      sourceDigest: session.selected.digest,
      agentId: options.agent,
    });
    for (const message of input.messages) {
      const origin = message.origin ?? 'direct';
      countsByOrigin[origin] = (countsByOrigin[origin] ?? 0) + 1;
      if (message.timestamp) timestamps.push(message.timestamp);
    }
    return { file, input };
  });
  timestamps.sort();

  const report: HistoricalIngestReport = {
    version: 1,
    dryRun: options.dryRun,
    plannedScope: options.scope,
    ...(options.agent ? { agent: options.agent } : {}),
    selectedFiles: inventory.selectedFiles,
    excludedFiles: inventory.excludedFiles.map(({ path, kind, reason, digest }) => ({
      path,
      kind,
      reason,
      digest,
    })),
    warnings: [...inventory.warnings, ...inputs.flatMap(({ input }) => input.warnings ?? [])],
    countsByOrigin,
    timeRange: { start: timestamps.at(0), end: timestamps.at(-1) },
    duplicateGroups: inventory.duplicateGroups,
    estimatedEvidenceBytes,
    imports: [],
  };

  if (!options.dryRun) {
    const store = SqliteStore.open(options.graph);
    try {
      for (const { file, input } of inputs) {
        const existingImport = store.getImport(
          historicalImportIdentity(input, options.scope).importId,
        );
        if (existingImport && existingImport.status !== 'complete' && !options.resume) {
          throw new Error(
            `Import ${existingImport.id} is ${existingImport.status}; re-run with --resume to retry it`,
          );
        }
        const result = await importHistoricalConversation(input, {
          store,
          memoryRoot: options.memoryRoot,
          scope: options.scope,
          extractEntities: extractFromConversation,
        });
        report.imports.push({
          file,
          status: result.status,
          importId: result.importId,
          episodesCreated: result.episodesCreated,
        });
      }
    } finally {
      store.close();
    }
  }

  if (options.reportPath) {
    mkdirSync(dirname(options.reportPath), { recursive: true });
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

export default defineCommand({
  meta: {
    name: 'ingest',
    description: 'Ingest a conversation file or historical OpenClaw session archive',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to conversation file/directory (or - for stdin)',
      required: false,
    },
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Input format: auto, openai, anthropic, clawdbot, openclaw, jsonl, nacre',
      default: 'auto',
    },
    embed: { type: 'boolean', description: 'Generate embeddings for new nodes', default: false },
    provider: { type: 'string', description: 'Embedding provider (ollama, openai, onnx)' },
    sessionId: {
      type: 'string',
      description: 'Override session ID for deduplication',
      alias: 's',
    },
    deduplicate: {
      type: 'string',
      description: 'Deduplication strategy: sessionId, contentHash, none',
      default: 'sessionId',
    },
    maxMessages: {
      type: 'string',
      description: 'Max messages per chunk',
      default: '20',
    },
    json: { type: 'boolean', description: 'Output result as JSON', default: false },
    recursive: {
      type: 'boolean',
      description: 'Inventory source directories recursively',
      default: false,
    },
    agent: { type: 'string', description: 'Source agent ID for historical evidence' },
    scope: { type: 'string', description: 'Scope for imported episodes', default: 'agent' },
    'memory-dir': {
      type: 'string',
      description: 'Configured memory root for Nacre-owned evidence',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Inventory and report without graph, memory, or evidence writes',
      default: false,
    },
    report: { type: 'string', description: 'Write a machine-readable JSON import report' },
    resume: {
      type: 'boolean',
      description:
        'Retry interrupted/failed imports; completed imports are always integrity-checked no-ops',
      default: false,
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('Ingest requires a SQLite graph (.db file)');
      process.exit(1);
    }

    const filePath = args.file as string | undefined;
    const format = args.format as ConversationFormat;
    if (format === 'openclaw' && filePath) {
      const memoryRoot =
        (args['memory-dir'] as string | undefined) ?? resolveMemoryDir(graphPath) ?? '';
      if (!memoryRoot && !args['dry-run']) {
        console.error(
          'Historical ingestion requires a configured memory root (--memory-dir or memory.dir)',
        );
        process.exit(1);
      }
      const report = await executeHistoricalIngest({
        source: filePath,
        graph: graphPath,
        memoryRoot,
        format: 'openclaw',
        recursive: Boolean(args.recursive),
        resume: Boolean(args.resume),
        agent: args.agent as string | undefined,
        scope: args.scope as string,
        dryRun: Boolean(args['dry-run']),
        reportPath: args.report as string | undefined,
      });
      console.log(formatJSON(report));
      return;
    }

    let content: string;
    if (!filePath || filePath === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      content = Buffer.concat(chunks).toString('utf-8');
    } else {
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        console.error(`Failed to read file: ${filePath}`);
        process.exit(1);
      }
    }

    const input = parseConversationFile(content, format, {
      sessionId: (args.sessionId as string) ?? undefined,
      source: filePath && filePath !== '-' ? filePath : undefined,
    });
    if (args.sessionId) input.metadata = { ...input.metadata, sessionId: args.sessionId as string };
    if (input.messages.length === 0) {
      console.error('No messages found in input');
      process.exit(1);
    }

    const store = SqliteStore.open(graphPath);
    try {
      const ingestOpts: IngestOptions = {
        store,
        deduplicateBy: args.deduplicate as IngestOptions['deduplicateBy'],
        chunkOptions: { maxMessages: parseInt(args.maxMessages as string, 10) },
        extractEntities: extractFromConversation,
      };
      if (args.embed) {
        try {
          const provider = resolveProvider({
            provider: (args.provider as string) ?? undefined,
            graphPath,
          });
          if (provider) ingestOpts.provider = provider;
        } catch (error) {
          console.error(
            `Failed to create embedding provider: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      const result = await ingestConversation(input, ingestOpts);
      if (args.json) console.log(formatJSON(result));
      else {
        console.log('Ingestion complete:');
        console.log(`  Chunks processed: ${result.chunksProcessed}`);
        console.log(`  Episodes created: ${result.episodesCreated}`);
        console.log(`  Nodes created: ${result.nodesCreated}`);
        console.log(`  Nodes reinforced: ${result.nodesReinforced}`);
        console.log(`  Edges created: ${result.edgesCreated}`);
        if (result.duplicatesSkipped > 0)
          console.log(`  Duplicates skipped: ${result.duplicatesSkipped}`);
      }
    } finally {
      store.close();
    }
  },
});
