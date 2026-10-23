import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const BEARER = /^Bearer +(\S+) *$/i;

// Hashing both sides gives equal-length buffers, so timingSafeEqual never throws and
// the comparison time doesn't depend on how much of the token matched.
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

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
