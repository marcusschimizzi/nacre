import { z } from 'zod';

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** A bare origin (`https://api.nacre.so`, no path), normalized: it is the OAuth issuer and resource base. */
const origin = z.string().refine(isOrigin, 'must be an origin like https://api.nacre.so (no path)');

function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value.replace(/\/$/, '');
  } catch {
    return false;
  }
}

const normalizeOrigin = (value: string): string => new URL(value).origin;

const databaseUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// URL');

const apiEnv = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    // `::` accepts IPv4 and IPv6, which Railway's private network needs.
    HOST: z.string().default('::'),
    LOG_LEVEL: logLevel.default('info'),
    // Connects as nacre_app (spec §4 roles), never as the owner.
    DATABASE_URL: databaseUrl,
    // HMAC key for token secrets (and, in task 3b, OAuth codes). Changing it invalidates every token.
    TOKEN_PEPPER: z.string().min(32, 'must be at least 32 characters'),
    PUBLIC_API_URL: origin.transform(normalizeOrigin),
    PUBLIC_APP_URL: origin.transform(normalizeOrigin).optional(),
    // Comma-separated origins allowed to call /mcp from a browser (spec §11).
    ALLOWED_ORIGINS: z.string().optional(),
  })
  .transform((env, ctx) => {
    const raw = env.ALLOWED_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [env.PUBLIC_API_URL, ...(env.PUBLIC_APP_URL ? [env.PUBLIC_APP_URL] : [])];
    const bad = raw.filter((o) => !isOrigin(o));
    if (bad.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGINS'],
        message: `not origins: ${bad.length} entr(ies)`,
      });
      return z.NEVER;
    }
    return { ...env, allowedOrigins: raw.map(normalizeOrigin) };
  });

const workerEnv = z.object({
  LOG_LEVEL: logLevel.default('info'),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
});

/** `nacre token …`: runs as nacre_app, like the api. The pepper is needed only to mint tokens. */
const tokenCliEnv = z.object({
  DATABASE_URL: databaseUrl,
  TOKEN_PEPPER: z.string().min(32, 'must be at least 32 characters').optional(),
});

/** `nacre db …`: the deploy steps, as the database owner. */
const dbCliEnv = z.object({
  MIGRATION_DATABASE_URL: databaseUrl,
  // Optional: when set, the pre-deploy step gives nacre_app LOGIN with this password.
  NACRE_APP_DB_PASSWORD: z.string().min(16, 'must be at least 16 characters').optional(),
});

export type ApiConfig = z.infer<typeof apiEnv>;
export type WorkerConfig = z.infer<typeof workerEnv>;
export type TokenCliConfig = z.infer<typeof tokenCliEnv>;
export type DbCliConfig = z.infer<typeof dbCliEnv>;

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  // Empty strings count as unset, so `VAR=` in .env behaves like a missing variable.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
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

export const loadTokenCliConfig = (env: NodeJS.ProcessEnv = process.env): TokenCliConfig =>
  parse(tokenCliEnv, env);

export const loadDbCliConfig = (env: NodeJS.ProcessEnv = process.env): DbCliConfig =>
  parse(dbCliEnv, env);

/** The one protected resource (spec §9.3): OAuth access tokens are valid only for this. */
export const mcpResource = (config: Pick<ApiConfig, 'PUBLIC_API_URL'>): string =>
  `${config.PUBLIC_API_URL}/mcp`;
