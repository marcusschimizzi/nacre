import type { Sql, TransactionSql } from './db/sql.js';
import { newId } from './ids.js';

/** Spec §13.2: the activity kinds slice 1 writes. */
export type ActivityKind =
  | 'event_append'
  | 'extraction_run'
  | 'extraction_error'
  | 'claim_promoted'
  | 'claim_held'
  | 'belief_add'
  | 'belief_reinforce'
  | 'retraction'
  | 'read'
  | 'token_create'
  | 'token_revoke'
  | 'token_use_denied'
  | 'oauth_client_register'
  | 'oauth_consent'
  | 'oauth_refresh_reuse'
  | 'owner_login'
  | 'system';

/** One `activity_log` row, minus what the helper fills in (`entry_id`, `at`). */
export interface ActivityEntry {
  kind: ActivityKind;
  /** agent_id, 'owner', 'worker', 'system' or 'rule:<id>'. */
  actor: string;
  tokenId?: string | null;
  requestId?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  eventIds?: string[];
  claimIds?: string[];
  oldValue?: Json | null;
  newValue?: Json | null;
  reason?: string | null;
  details?: { [key: string]: Json };
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// A full token (`nacre_tok_<ulid>_<secret>`) or a bearer header. A bare `tok_<ulid>` is the public
// token id and is fine to log.
const TOKEN_SHAPED = /nacre_tok_[0-9A-Za-z]{26}_|Bearer\s+\S/i;

/**
 * Append one activity entry and return its id. Pass a transaction to log atomically with the change
 * it describes. Refuses (throws) if anything in the entry looks like a token, so a careless caller
 * can't write a secret into an append-only table.
 */
export async function logActivity(
  sql: Sql | TransactionSql,
  entry: ActivityEntry,
): Promise<string> {
  if (TOKEN_SHAPED.test(JSON.stringify(entry))) {
    throw new Error(`refusing to log a token-shaped value in a ${entry.kind} activity entry`);
  }
  const entryId = newId('act');
  const json = (value: Json) => sql.json(value as Parameters<typeof sql.json>[0]);
  await sql`
    INSERT INTO activity_log (entry_id, kind, actor, token_id, request_id, target_kind, target_id,
                              event_ids, claim_ids, old_value, new_value, reason, details)
    VALUES (${entryId}, ${entry.kind}, ${entry.actor}, ${entry.tokenId ?? null},
            ${entry.requestId ?? null}, ${entry.targetKind ?? null}, ${entry.targetId ?? null},
            ${entry.eventIds ?? []}, ${entry.claimIds ?? []},
            ${entry.oldValue == null ? null : json(entry.oldValue)},
            ${entry.newValue == null ? null : json(entry.newValue)},
            ${entry.reason ?? null}, ${json(entry.details ?? {})})`;
  return entryId;
}
