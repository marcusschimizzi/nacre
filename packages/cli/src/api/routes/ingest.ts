import { Hono } from 'hono';
import { z } from 'zod';
import type { SqliteStore } from '@nacre/core';
import {
  ingestConversation,
  resolveProvider,
  type IngestOptions,
} from '@nacre/core';
import { extractFromConversation } from '@nacre/parser';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  timestamp: z.string().optional(),
  name: z.string().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
});

const ingestSchema = z.object({
  messages: z.array(messageSchema).min(1),
  metadata: z.object({
    sessionId: z.string().optional(),
    platform: z.string().optional(),
    topic: z.string().optional(),
    source: z.string().optional(),
  }).optional(),
  options: z.object({
    embed: z.boolean().optional(),
    deduplicateBy: z.enum(['sessionId', 'contentHash', 'none']).optional(),
    maxMessages: z.number().int().positive().optional(),
    provider: z.string().optional(),
  }).optional(),
});

export function ingestRoutes(store: SqliteStore, graphPath: string): Hono {
  const app = new Hono();

  app.post('/ingest', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: { message: 'Invalid JSON body', code: 'VALIDATION_ERROR' } }, 400);
    }

    const parsed = ingestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: {
          message: `Validation error: ${parsed.error.issues.map(i => i.message).join(', ')}`,
          code: 'VALIDATION_ERROR',
        },
      }, 400);
    }

    const { messages, metadata, options } = parsed.data;

    const ingestOpts: IngestOptions = {
      store,
      deduplicateBy: options?.deduplicateBy ?? 'sessionId',
      chunkOptions: {
        maxMessages: options?.maxMessages ?? 20,
      },
      extractEntities: extractFromConversation,
    };

    if (options?.embed) {
      try {
        const provider = resolveProvider({
          provider: options.provider,
          graphPath,
          allowNull: true,
        });
        if (provider) ingestOpts.provider = provider;
      } catch {
        return c.json({
          error: { message: 'Failed to create embedding provider', code: 'PROVIDER_ERROR' },
        }, 500);
      }
    }

    try {
      const result = await ingestConversation({ messages, metadata }, ingestOpts);
      return c.json({ data: result }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, code: 'INGEST_ERROR' } }, 500);
    }
  });

  return app;
}
