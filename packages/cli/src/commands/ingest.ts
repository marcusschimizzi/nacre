import { readFileSync } from 'node:fs';
import { defineCommand } from 'citty';
import {
  SqliteStore,
  ingestConversation,
  parseConversationFile,
  resolveProvider,
  type ConversationFormat,
  type IngestOptions,
} from '@nacre/core';
import { extractFromConversation } from '@nacre/parser';
import { formatJSON } from '../output.js';

export default defineCommand({
  meta: {
    name: 'ingest',
    description: 'Ingest a conversation file into the memory graph',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to conversation file (or - for stdin)',
      required: false,
    },
    graph: {
      type: 'string',
      description: 'Path to graph database (.db)',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Input format: auto, openai, anthropic, clawdbot, jsonl, nacre',
      default: 'auto',
    },
    embed: {
      type: 'boolean',
      description: 'Generate embeddings for new nodes',
      default: false,
    },
    provider: {
      type: 'string',
      description: 'Embedding provider (ollama, openai, onnx)',
    },
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
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const graphPath = args.graph as string;
    if (!graphPath.endsWith('.db')) {
      console.error('Ingest requires a SQLite graph (.db file)');
      process.exit(1);
    }

    let content: string;
    const filePath = args.file as string | undefined;

    if (!filePath || filePath === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      content = Buffer.concat(chunks).toString('utf-8');
    } else {
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch (err) {
        console.error(`Failed to read file: ${filePath}`);
        process.exit(1);
      }
    }

    const format = args.format as ConversationFormat;
    const input = parseConversationFile(content, format, {
      sessionId: (args.sessionId as string) ?? undefined,
      source: filePath && filePath !== '-' ? filePath : undefined,
    });

    if (args.sessionId) {
      input.metadata = { ...input.metadata, sessionId: args.sessionId as string };
    }

    if (input.messages.length === 0) {
      console.error('No messages found in input');
      process.exit(1);
    }

    const store = SqliteStore.open(graphPath);

    try {
      const ingestOpts: IngestOptions = {
        store,
        deduplicateBy: args.deduplicate as IngestOptions['deduplicateBy'],
        chunkOptions: {
          maxMessages: parseInt(args.maxMessages as string, 10),
        },
        extractEntities: extractFromConversation,
      };

      if (args.embed) {
        const providerName = (args.provider as string) ?? undefined;
        try {
          const provider = resolveProvider({ provider: providerName, graphPath });
          if (provider) ingestOpts.provider = provider;
        } catch (err) {
          console.error(`Failed to create embedding provider: ${err instanceof Error ? err.message : err}`);
        }
      }

      const result = await ingestConversation(input, ingestOpts);

      if (args.json) {
        console.log(formatJSON(result));
      } else {
        console.log(`Ingestion complete:`);
        console.log(`  Chunks processed: ${result.chunksProcessed}`);
        console.log(`  Episodes created: ${result.episodesCreated}`);
        console.log(`  Nodes created: ${result.nodesCreated}`);
        console.log(`  Nodes reinforced: ${result.nodesReinforced}`);
        console.log(`  Edges created: ${result.edgesCreated}`);
        if (result.duplicatesSkipped > 0) {
          console.log(`  Duplicates skipped: ${result.duplicatesSkipped}`);
        }
      }
    } finally {
      store.close();
    }
  },
});
