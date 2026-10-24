import type { Sql } from '../shared/db/sql.js';

/** Spec §6.2 step 3: how many earlier events, and how much of each, go to the model as context. */
export const CONTEXT_EVENTS = 4;
export const CONTEXT_CHARS = 1000;

export interface ContextEvent {
  eventId: string;
  role: 'user' | 'assistant';
  /** The first CONTEXT_CHARS code points of the stored body, no marker added. */
  text: string;
}

export interface ContextTarget {
  eventId: string;
  sessionId: string | null;
}

/**
 * Up to CONTEXT_EVENTS earlier events of the target's session, oldest first: `message` kind and
 * `normal` sensitivity only, both roles, strictly before the target by (observed_at, event_id).
 * Private and restricted events never appear, because context goes to the hosted model too. It is
 * for resolving references only: quotes are checked against the target, never against this.
 */
export async function loadContext(sql: Sql, target: ContextTarget): Promise<ContextEvent[]> {
  if (target.sessionId === null) return [];
  // left() counts characters (code points), as the offsets do, and keeps long bodies in the
  // database. The target's own observed_at is compared in SQL, at full precision.
  const rows = await sql<{ event_id: string; role: 'user' | 'assistant'; text: string }[]>`
    SELECT e.event_id, e.role, left(c.body, ${CONTEXT_CHARS}) AS text
    FROM events e JOIN event_content c USING (event_id)
    WHERE e.session_id = ${target.sessionId}
      AND (e.observed_at, e.event_id) <
          (SELECT t.observed_at, t.event_id FROM events t WHERE t.event_id = ${target.eventId})
      AND e.kind = 'message' AND e.sensitivity = 'normal'
      AND e.role IN ('user', 'assistant') AND c.body IS NOT NULL
    ORDER BY e.observed_at DESC, e.event_id DESC
    LIMIT ${CONTEXT_EVENTS}`;
  return rows.reverse().map((r) => ({ eventId: r.event_id, role: r.role, text: r.text }));
}
