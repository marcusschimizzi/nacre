import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const BEARER = /^Bearer +(\S+) *$/i;

// Hashing both sides gives equal-length buffers, so timingSafeEqual never throws and
// the comparison time doesn't depend on how much of the token matched.
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * The shape of the Authorization header, never its value: lets the request log show whether a
 * client sent a usable bearer token, sent nothing, or mangled it (e.g. "Bearer Bearer …").
 */
export type AuthShape = 'none' | 'bearer' | 'bearer-malformed' | 'other';

export function authShape(header: string | undefined): AuthShape {
  if (!header) return 'none';
  if (BEARER.test(header)) return 'bearer';
  return /^Bearer\b/i.test(header) ? 'bearer-malformed' : 'other';
}

/**
 * Static bearer-token check for slice 1 task 1. Missing, malformed and wrong tokens all get
 * the same 401 so the response says nothing about which part failed. Task 3 swaps the single
 * token for the per-agent token table.
 */
export function bearerAuth(expectedToken: string): MiddlewareHandler {
  const expected = digest(expectedToken);
  return async (c, next) => {
    const presented = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    if (presented === undefined || !timingSafeEqual(digest(presented), expected)) {
      c.header('WWW-Authenticate', 'Bearer realm="nacre"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
