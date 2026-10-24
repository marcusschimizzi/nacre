import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type Json, logActivity } from './activity.js';
import type { Sql } from './db/sql.js';
import { newId } from './ids.js';
import { mergeRedactions, redactJson, redactSecrets } from './redact.js';

/**
 * Event ingest (spec §5.1, §6.2): validate a client's event, strip secrets, hash, and write the
 * event, its content, an `extract` job and an `event_append` entry in one transaction. The
 * `POST /v1/events` route and, later, `remember` (task 10) both call `ingestEvent`.
 */

/** Size caps (spec §5.1). Over any of them the event is rejected with 413, never truncated. */
export const EVENT_LIMITS = {
  /** The whole request body, in bytes. */
  bodyBytes: 512 * 1024,
  /** `content`, in code points, before NFC. */
  contentChars: 100_000,
  /** `JSON.stringify(metadata)`, in UTF-8 bytes. */
  metadataBytes: 8 * 1024,
} as const;

/** Device and hub clocks further apart than this: `drift`. */
export const DRIFT_MS = 5 * 60_000;
/** Observed time more than this after received time: `future` (normal skew sets nothing). */
export const FUTURE_TOLERANCE_MS = 60_000;

export type ClockFlag = 'drift' | 'future';

/** Spec §5.1's clock flags, in alphabetical order. */
export function clockFlags(observed: Date, received: Date): ClockFlag[] {
  const ahead = observed.getTime() - received.getTime();
  const flags: ClockFlag[] = [];
  if (Math.abs(ahead) > DRIFT_MS) flags.push('drift');
  if (ahead > FUTURE_TOLERANCE_MS) flags.push('future');
  return flags;
}

/** sha256 over the UTF-8 bytes of the stored (NFC, redacted) body. */
export const contentHash = (body: string): Buffer =>
  createHash('sha256').update(body, 'utf8').digest();

// Printable ASCII with no spaces: what the hook builds from session and prompt ids.
const KEY = /^[\x21-\x7E]{1,200}$/;

// Strict: an unknown key (`agent_id`, `trust_tier`, …) is a 422, never silently ignored.
export const eventSchema = z.strictObject({
  client_event_id: z.string().regex(KEY),
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  session_id: z.string().regex(KEY).nullish(),
  // A `Z` or a numeric offset, as the spec §8.3 hook sends (`2026-10-21T14:05:09-05:00`). The year
  // check keeps a date Postgres can't store from becoming a 500.
  observed_at: z.iso.datetime({ offset: true }).refine((value) => {
    const year = new Date(value).getUTCFullYear();
    // NaN: not a date at all, which the format check already reports.
    return Number.isNaN(year) || (year >= 1 && year <= 9999);
  }),
  // Lenient on purpose: anything that isn't a time zone is stored as NULL (see `timeZoneOrNull`).
  observed_tz: z.string().nullish(),
  content: z.string(),
  scope_hint: z.string().max(100).nullish(),
  sensitivity_hint: z.enum(['normal', 'private', 'restricted']).nullish(),
  metadata: z.record(z.string(), z.json()).optional(),
});

export type EventInput = z.output<typeof eventSchema>;

export type EventField = keyof EventInput;
const EVENT_FIELDS = new Set<string>(Object.keys(eventSchema.shape));

/** One 422 problem: the field and a code, never the submitted value or an unknown key's name. */
export interface EventIssue {
  /** A known field name, or `""` for the body itself or an unknown key. */
  path: string;
  code: string;
}

export type ParsedEvent =
  | { ok: true; event: EventInput }
  | { ok: false; status: 422; issues: EventIssue[] }
  | { ok: false; status: 413; field: 'content' | 'metadata' };

/**
 * Validate a parsed JSON body: shape (422) first, then the content and metadata caps (413). The
 * issues are built here from zod's codes, so no message (which can quote input) is passed through.
 */
export function parseEvent(body: unknown): ParsedEvent {
  const result = eventSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const field = issue.path[0];
      return {
        path: typeof field === 'string' && EVENT_FIELDS.has(field) ? field : '',
        code: issue.code,
      };
    });
    return { ok: false, status: 422, issues: dedupe(issues) };
  }
  const event = result.data;

  // Postgres text and jsonb can't hold NUL, and a lone surrogate isn't valid UTF-8.
  const issues: EventIssue[] = [];
  if (!cleanString(event.content)) issues.push({ path: 'content', code: 'invalid_characters' });
  else if (!/\S/.test(event.content)) issues.push({ path: 'content', code: 'empty_content' });
  if (event.scope_hint != null && !cleanString(event.scope_hint)) {
    issues.push({ path: 'scope_hint', code: 'invalid_characters' });
  }
  if (event.metadata && !cleanJson(event.metadata)) {
    issues.push({ path: 'metadata', code: 'invalid_characters' });
  }
  if (issues.length > 0) return { ok: false, status: 422, issues };

  if (codePointLength(event.content) > EVENT_LIMITS.contentChars) {
    return { ok: false, status: 413, field: 'content' };
  }
  if (
    event.metadata &&
    Buffer.byteLength(JSON.stringify(event.metadata), 'utf8') > EVENT_LIMITS.metadataBytes
  ) {
    return { ok: false, status: 413, field: 'metadata' };
  }
  return { ok: true, event };
}

function dedupe(issues: EventIssue[]): EventIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const cleanString = (s: string): boolean => s.isWellFormed() && !s.includes('\u0000');

function cleanJson(value: Json): boolean {
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.every(cleanJson);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).every(([k, v]) => cleanString(k) && cleanJson(v));
  }
  return true;
}

/** Code points, not UTF-16 units: an emoji is one character. The string is well-formed. */
export function codePointLength(s: string): number {
  let pairs = 0;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      pairs++;
      i++;
    }
  }
  return s.length - pairs;
}

/**
 * The zone if it's one `Intl` knows, else null. The hook derives it from `readlink`, which can
 * yield junk, and a lost event is worse than a lost zone, so this never fails the request.
 */
export function timeZoneOrNull(tz: string | null | undefined): string | null {
  if (!tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export interface IngestCaller {
  agentId: string;
  tokenId: string;
  requestId: string | null;
}

export interface IngestResult {
  eventId: string;
  /** False for a repeated `client_event_id`: nothing was written. */
  created: boolean;
  /** For a repeat: whether its redacted body hashes the same as the stored one. */
  hashMatches: boolean;
}

/**
 * Store one validated event (spec §3 step 1). Idempotent per agent: a repeated `client_event_id`
 * returns the original id and writes nothing, even if the content differs (Decided, spec §5.1).
 */
export async function ingestEvent(
  sql: Sql,
  caller: IngestCaller,
  input: EventInput,
  { now }: { now: () => Date },
): Promise<IngestResult> {
  const receivedAt = now();
  const observedAt = new Date(input.observed_at);
  // NFC first, so offsets are stable; then secrets out, before anything is hashed or stored.
  const content = redactSecrets(input.content.normalize('NFC'));
  const metadata = redactJson(input.metadata ?? {});
  const redactions = mergeRedactions(content.redactions, metadata.redactions);
  const hash = contentHash(content.text);
  const flags = clockFlags(observedAt, receivedAt);
  const sensitivity = input.sensitivity_hint ?? 'normal';
  const eventId = newId('evt');
  const json = (value: Json) => sql.json(value as Parameters<typeof sql.json>[0]);

  return sql.begin(async (tx) => {
    // ON CONFLICT waits for a concurrent insert of the same key to commit, so the SELECT below
    // always finds the winner's row.
    const inserted = await tx`
      INSERT INTO events (event_id, kind, role, source_client, agent_id, token_id, client_event_id,
                          session_id, observed_at, observed_tz, received_at, clock_flags,
                          content_hash, hash_alg, content_type, scope_hint, scope_id, sensitivity,
                          trust_tier, redactions, metadata)
      VALUES (${eventId}, ${input.kind}, ${input.role}, ${caller.agentId}, ${caller.agentId},
              ${caller.tokenId}, ${input.client_event_id}, ${input.session_id ?? null},
              ${observedAt}, ${timeZoneOrNull(input.observed_tz)}, ${receivedAt}, ${flags},
              ${hash}, 'sha256', 'text/plain', ${input.scope_hint ?? null}, 'personal',
              ${sensitivity}, ${input.role === 'user' ? 'user_typed' : 'agent_inferred'},
              ${json(redactions.map((r) => ({ ...r })))}, ${json(metadata.value)})
      ON CONFLICT (agent_id, client_event_id) DO NOTHING
      RETURNING event_id`;

    if (inserted.length === 0) {
      const [original] = await tx<{ event_id: string; content_hash: Buffer }[]>`
        SELECT event_id, content_hash FROM events
        WHERE agent_id = ${caller.agentId} AND client_event_id = ${input.client_event_id}`;
      if (!original) throw new Error('event insert conflicted but no row was found');
      return {
        eventId: original.event_id,
        created: false,
        hashMatches: original.content_hash.equals(hash),
      };
    }

    await tx`INSERT INTO event_content (event_id, body) VALUES (${eventId}, ${content.text})`;
    await tx`INSERT INTO jobs (kind, ref_id) VALUES ('extract', ${eventId})`;
    // Last, so a failure here rolls back everything above it.
    await logActivity(tx, {
      kind: 'event_append',
      actor: caller.agentId,
      tokenId: caller.tokenId,
      requestId: caller.requestId,
      targetKind: 'event',
      targetId: eventId,
      eventIds: [eventId],
      details: {
        kind: input.kind,
        role: input.role,
        sensitivity,
        clock_flags: flags,
        redactions: redactions.map((r) => ({ ...r })),
        content_chars: codePointLength(content.text),
      },
    });
    return { eventId, created: true, hashMatches: true };
  });
}
