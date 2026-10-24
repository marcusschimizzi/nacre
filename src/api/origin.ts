import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './env.js';

export type OriginVerdict = 'absent' | 'allowed' | 'forbidden';

/**
 * Exact-origin check (spec §11): scheme, host and port must equal an allow-list entry. An
 * unparsable value (including the opaque `null` origin) or anything that isn't a bare origin is
 * forbidden. Not the SDK's `originValidationResponse`, which compares hostnames only and so would
 * accept `http://` or another port on an allowed host.
 */
export function checkOrigin(
  header: string | undefined,
  allowed: ReadonlySet<string>,
): OriginVerdict {
  if (header === undefined) return 'absent';
  let parsed: URL;
  try {
    parsed = new URL(header);
  } catch {
    return 'forbidden';
  }
  return parsed.origin === header && allowed.has(header) ? 'allowed' : 'forbidden';
}

/**
 * `/mcp`: requests without `Origin` (every non-browser MCP client) pass; a present `Origin` must be
 * allowed, or the request gets 403 before auth runs. Task 3b's consent form requires the header.
 */
export function originCheck(
  allowedOrigins: readonly string[],
  options: { required?: boolean } = {},
): MiddlewareHandler<AppEnv> {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    const verdict = checkOrigin(c.req.header('origin'), allowed);
    if (verdict === 'forbidden' || (verdict === 'absent' && options.required)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  };
}
