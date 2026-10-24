import { readdirSync } from 'node:fs';
import { setTimeout as sleepFor } from 'node:timers/promises';
import type { Sql } from '../shared/db/sql.js';
import type { Logger } from '../shared/logger.js';

/**
 * Only `api` migrates (migrations/README.md). The worker waits at startup until the database has
 * at least the newest migration in its own image, so it never runs against a schema older than its
 * code. A database that is ahead is fine (the api deploys first).
 */

/** Where the image keeps migrations: the same relative path from src/worker and dist/worker. */
export const MIGRATIONS_DIR = new URL('../../migrations', import.meta.url);

/** The greatest 14-digit version prefix of a `.sql` file in `dir`. Throws when there is none. */
export function newestMigration(dir: URL = MIGRATIONS_DIR): string {
  const versions = readdirSync(dir)
    .map((name) => /^(\d{14})_.*\.sql$/.exec(name)?.[1])
    .filter((v): v is string => v !== undefined)
    .sort();
  const newest = versions.at(-1);
  if (!newest) throw new Error('no migration files found in the image');
  return newest;
}

/** `max(version)` from dbmate's table; null when it is empty. Needs migration 20261024120000. */
export async function readSchemaVersion(sql: Sql): Promise<string | null> {
  const [row] = await sql<{ v: string | null }[]>`SELECT max(version) AS v FROM schema_migrations`;
  return row?.v ?? null;
}

/** A SQLSTATE or a Node error code (`ECONNREFUSED`), else the error's name: never its message. */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return err instanceof Error && /^[A-Za-z0-9_.-]{1,64}$/.test(err.name) ? err.name : 'unknown';
}

/** 1 s, 2 s, 4 s, … capped at 30 s, for attempt 1, 2, 3, … */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

/** Expected while the api's pre-deploy runs, or while the database starts or is unreachable. */
function isExpectedWait(code: string): boolean {
  return (
    code === '42501' || // permission denied: the grant migration hasn't run yet
    code === '42P01' || // no schema_migrations yet
    code === '57P03' || // the database is starting up
    code.startsWith('08') ||
    code.startsWith('53') ||
    /^E[A-Z]+$/.test(code) || // ECONNREFUSED, ENOTFOUND, ECONNRESET, ETIMEDOUT…
    code === 'CONNECT_TIMEOUT' ||
    code === 'CONNECTION_CLOSED' ||
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED'
  );
}

export interface SchemaWaitDeps {
  readVersion: () => Promise<string | null>;
  newest: string;
  signal: AbortSignal;
  log: Logger;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Milliseconds; injected so tests can pass the 5-minute mark without waiting. */
  clock?: () => number;
}

const ESCALATE_AFTER_MS = 5 * 60_000;
const ESCALATED_EVERY_MS = 60_000;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  sleepFor(ms, undefined, { signal }).catch(() => {});

/**
 * Resolves true once `readVersion()` is at least `newest`, false if `signal` aborts first. Never
 * throws and never gives up: every error means "not yet". Logs only the attempt, the versions and a
 * code; after five minutes it logs at `error`, once a minute.
 */
export async function waitForSchema(deps: SchemaWaitDeps): Promise<boolean> {
  const { newest, signal, log } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  let lastEscalated = Number.NEGATIVE_INFINITY;
  for (let attempt = 1; !signal.aborted; attempt++) {
    let have: string | null = null;
    let sqlstate: string | undefined;
    try {
      have = await deps.readVersion();
      // Fixed-width 14-digit versions: a string compare is a numeric one.
      if (have !== null && have >= newest) return true;
    } catch (err) {
      sqlstate = errorCode(err);
      if (!isExpectedWait(sqlstate)) {
        log.error({ attempt, sqlstate }, 'schema wait: unexpected error; still waiting');
      }
    }
    const fields = { attempt, have, want: newest, sqlstate };
    const now = clock();
    if (now - startedAt < ESCALATE_AFTER_MS) {
      log.warn(fields, 'waiting for schema');
    } else if (now - lastEscalated >= ESCALATED_EVERY_MS) {
      lastEscalated = now;
      log.error(fields, 'waiting for schema');
    }
    await sleep(retryDelayMs(attempt), signal);
  }
  return false;
}
