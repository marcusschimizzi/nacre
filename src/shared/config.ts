import { z } from 'zod';

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const apiEnv = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  // `::` accepts IPv4 and IPv6, which Railway's private network needs.
  HOST: z.string().default('::'),
  LOG_LEVEL: logLevel.default('info'),
  // Slice 1 task 1 only: one shared dev token. Task 3 replaces it with the token table.
  NACRE_DEV_TOKEN: z.string().min(32, 'NACRE_DEV_TOKEN must be at least 32 characters'),
});

const workerEnv = z.object({
  LOG_LEVEL: logLevel.default('info'),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
});

export type ApiConfig = z.infer<typeof apiEnv>;
export type WorkerConfig = z.infer<typeof workerEnv>;

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report which variables are wrong, never their values.
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${issues.join('\n  ')}`);
  }
  return result.data;
}

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env): ApiConfig =>
  parse(apiEnv, env);

export const loadWorkerConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig =>
  parse(workerEnv, env);
