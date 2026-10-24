import type { Sql, TransactionSql } from '../shared/db/sql.js';

/** The budget day runs midnight to midnight here (spec §12.2). */
export const BUDGET_TIME_ZONE = 'America/Chicago';

export interface BudgetState {
  /** The Chicago date, `YYYY-MM-DD`. */
  day: string;
  dayStart: Date;
  /** The next Chicago midnight: where a deferred job's `run_after` goes. */
  nextStart: Date;
  spentUsd: number;
  exhausted: boolean;
}

/**
 * Today's spend against the daily budget (spec §12.2), as of `now`. The day bounds are computed in
 * Postgres, so DST (a 23- or 25-hour day) is its problem, and the comparison is numeric, not float.
 * It sums every `model_calls` row whatever its purpose: embeddings count too.
 *
 * A ceiling checked before each call, not a reservation: with one job at a time the overshoot is at
 * most one call (about $0.0004, up to about $0.002 for a long chunk).
 */
export async function budgetState(
  sql: Sql | TransactionSql,
  now: Date,
  budgetUsd: number,
): Promise<BudgetState> {
  const [row] = await sql<
    { day: string; day_start: Date; next_start: Date; spent: string; exhausted: boolean }[]
  >`
    WITH d AS (
      SELECT date_trunc('day', ${now}::timestamptz AT TIME ZONE ${BUDGET_TIME_ZONE}) AS local_day)
    SELECT to_char(d.local_day, 'YYYY-MM-DD') AS day,
           b.day_start, b.next_start, s.spent::text AS spent,
           s.spent >= ${String(budgetUsd)}::numeric AS exhausted
    FROM d
    CROSS JOIN LATERAL (
      SELECT d.local_day AT TIME ZONE ${BUDGET_TIME_ZONE} AS day_start,
             (d.local_day + interval '1 day') AT TIME ZONE ${BUDGET_TIME_ZONE} AS next_start) b
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(cost_usd), 0) AS spent FROM model_calls
      WHERE at >= b.day_start AND at < b.next_start) s`;
  if (!row) throw new Error('budget query returned no row');
  return {
    day: row.day,
    dayStart: row.day_start,
    nextStart: row.next_start,
    spentUsd: Number(row.spent),
    exhausted: row.exhausted,
  };
}
