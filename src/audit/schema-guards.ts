import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Sql, TransactionSql } from '../shared/db/sql.js';

/**
 * Spec §14 A5 and the §4 role grants, checked against a live database. One implementation for
 * the Vitest suite, `pnpm db:verify` (local or Railway) and, later, the §13.1 nightly self-audit.
 *
 * Needs an owner (admin) connection: it inserts fixtures as the owner and switches to nacre_app
 * with SET ROLE. Everything runs in one transaction that always rolls back, with a savepoint around
 * each statement, so no rows are left behind and one failure doesn't hide the next.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export const APP_ROLE = 'nacre_app';

/** The 18 §4 tables. */
export const TABLES = [
  'scopes',
  'agents',
  'oauth_clients',
  'agent_tokens',
  'oauth_auth_codes',
  'events',
  'event_content',
  'entities',
  'extraction_runs',
  'claims',
  'evidence_spans',
  'beliefs',
  'belief_versions',
  'belief_version_claims',
  'belief_embeddings',
  'activity_log',
  'model_calls',
  'jobs',
] as const;

/** Tables where nacre_app may UPDATE every column. */
const TABLE_UPDATE = new Set<string>(['extraction_runs', 'jobs']);

/** Column-level UPDATE grants for nacre_app (spec §4 "Roles", plus claims.status_reason). */
export const COLUMN_UPDATES: Readonly<Record<string, readonly string[]>> = {
  agent_tokens: ['last_used_at', 'revoked_at', 'rotated_at'],
  oauth_clients: ['approved_at', 'disabled_at'],
  oauth_auth_codes: ['used_at'],
  claims: ['status', 'status_reason'],
  belief_versions: ['expired_at'],
};

/** Every §4 guard trigger: table and function. */
export const GUARD_TRIGGERS: Readonly<Record<string, { table: string; fn: string }>> = {
  events_append_only: { table: 'events', fn: 'nacre_forbid_mutation' },
  event_content_append_only: { table: 'event_content', fn: 'nacre_forbid_mutation' },
  runs_no_delete: { table: 'extraction_runs', fn: 'nacre_forbid_mutation' },
  claims_status_only: { table: 'claims', fn: 'nacre_status_only' },
  spans_append_only: { table: 'evidence_spans', fn: 'nacre_forbid_mutation' },
  blv_close_only: { table: 'belief_versions', fn: 'nacre_close_only' },
  bvc_append_only: { table: 'belief_version_claims', fn: 'nacre_forbid_mutation' },
  activity_append_only: { table: 'activity_log', fn: 'nacre_forbid_mutation' },
  model_calls_append_only: { table: 'model_calls', fn: 'nacre_forbid_mutation' },
};

const PERMISSION_DENIED = '42501';
const RAISE_EXCEPTION = 'P0001';
const UNIQUE_VIOLATION = '23505';

type Actor = 'app' | 'owner';
type Step = (sql: TransactionSql) => Promise<unknown>;

/** Thrown to roll a savepoint or the whole run back on purpose. */
class Rollback extends Error {}

/** Runs every check and rolls everything back. */
export async function verifySchemaGuards(sql: Sql): Promise<CheckResult[]> {
  let results: CheckResult[] = [];
  try {
    await sql.begin(async (tx) => {
      results = await runSchemaGuardChecks(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return results;
}

/** Runs every check inside the caller's transaction; the caller rolls it back. */
export async function runSchemaGuardChecks(tx: TransactionSql): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (name: string, detail?: string) => {
    results.push(detail === undefined ? { name, ok: true } : { name, ok: false, detail });
  };

  const tables = await missingTables(tx);
  add(
    'tables: all 18 §4 tables exist',
    tables.length ? `missing: ${tables.join(', ')}` : undefined,
  );
  if (tables.length) return results;

  const role = await tx<
    { ok: boolean }[]
  >`SELECT true AS ok FROM pg_roles WHERE rolname = ${APP_ROLE}`;
  add(`role: ${APP_ROLE} exists`, role.length ? undefined : 'missing');
  if (!role.length) return results;

  await checkServer(tx, add);
  await checkGrants(tx, add);
  await checkTriggers(tx, add);

  const f = await insertFixtures(tx);
  await checkGrantLayer(tx, f, add);
  await checkTriggerLayer(tx, f, add);
  await checkConstraintsAndVectors(tx, f, add);
  return results;
}

type Add = (name: string, detail?: string) => void;

async function missingTables(tx: TransactionSql): Promise<string[]> {
  const rows = await tx<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`;
  const present = new Set(rows.map((r) => r.relname));
  return TABLES.filter((t) => !present.has(t));
}

async function checkServer(tx: TransactionSql, add: Add): Promise<void> {
  const [server] = await tx<{ num: number }[]>`
    SELECT current_setting('server_version_num')::int AS num`;
  const num = server?.num ?? 0;
  add('server: Postgres 18 or later', num >= 180000 ? undefined : `server_version_num is ${num}`);

  const [ext] = await tx<{ extversion: string }[]>`
    SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
  const [major = 0, minor = 0] = (ext?.extversion ?? '0.0').split('.').map(Number);
  add(
    'extension: vector 0.8 or later',
    major > 0 || minor >= 8 ? undefined : `vector is ${ext ? ext.extversion : 'not installed'}`,
  );
}

async function checkGrants(tx: TransactionSql, add: Add): Promise<void> {
  // Effective privileges (direct, via PUBLIC or via membership), for every table in public, so a
  // new table without grants or a stray DELETE grant shows up here.
  const tables = await tx<
    {
      relname: string;
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
      trunc: boolean;
      refs: boolean;
      trig: boolean;
    }[]
  >`
    SELECT c.relname,
           has_table_privilege(${APP_ROLE}, c.oid, 'SELECT') AS sel,
           has_table_privilege(${APP_ROLE}, c.oid, 'INSERT') AS ins,
           has_table_privilege(${APP_ROLE}, c.oid, 'UPDATE') AS upd,
           has_table_privilege(${APP_ROLE}, c.oid, 'DELETE') AS del,
           has_table_privilege(${APP_ROLE}, c.oid, 'TRUNCATE') AS trunc,
           has_table_privilege(${APP_ROLE}, c.oid, 'REFERENCES') AS refs,
           has_table_privilege(${APP_ROLE}, c.oid, 'TRIGGER') AS trig
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      AND c.relname <> 'schema_migrations'
    ORDER BY c.relname`;
  const columns = await tx<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND has_column_privilege(${APP_ROLE}, format('public.%I', table_name), column_name, 'UPDATE')`;

  for (const t of tables) {
    const problems: string[] = [];
    if (!t.sel) problems.push('no SELECT');
    if (!t.ins) problems.push('no INSERT');
    if (t.del) problems.push('has DELETE');
    if (t.trunc) problems.push('has TRUNCATE');
    if (t.refs) problems.push('has REFERENCES');
    if (t.trig) problems.push('has TRIGGER');
    if (TABLE_UPDATE.has(t.relname)) {
      if (!t.upd) problems.push('no table UPDATE');
    } else {
      if (t.upd) problems.push('has table-wide UPDATE');
      const expected = [...(COLUMN_UPDATES[t.relname] ?? [])].sort();
      const actual = columns
        .filter((c) => c.table_name === t.relname)
        .map((c) => c.column_name)
        .sort();
      if (expected.join() !== actual.join()) {
        problems.push(`UPDATE columns [${actual.join(', ')}], expected [${expected.join(', ')}]`);
      }
    }
    add(`grants: ${t.relname}`, problems.length ? problems.join('; ') : undefined);
  }

  const [seq] = await tx<{ ok: boolean }[]>`
    SELECT has_sequence_privilege(${APP_ROLE}, 'jobs_job_id_seq', 'USAGE') AS ok`;
  add('grants: USAGE on jobs_job_id_seq', seq?.ok ? undefined : 'missing');

  const [r] = await tx<
    {
      owned: number;
      can_create: boolean;
      super: boolean;
      createrole: boolean;
      createdb: boolean;
      bypassrls: boolean;
    }[]
  >`
    SELECT (SELECT count(*)::int FROM pg_class WHERE relowner = ${APP_ROLE}::regrole)
             + (SELECT count(*)::int FROM pg_proc WHERE proowner = ${APP_ROLE}::regrole)
             + (SELECT count(*)::int FROM pg_namespace WHERE nspowner = ${APP_ROLE}::regrole) AS owned,
           has_schema_privilege(${APP_ROLE}, 'public', 'CREATE') AS can_create,
           rolsuper AS super, rolcreaterole AS createrole, rolcreatedb AS createdb, rolbypassrls AS bypassrls
    FROM pg_roles WHERE rolname = ${APP_ROLE}`;
  const problems: string[] = [];
  if (r?.owned) problems.push(`owns ${r.owned} objects`);
  if (r?.can_create) problems.push('has CREATE on schema public');
  for (const attr of ['super', 'createrole', 'createdb', 'bypassrls'] as const) {
    if (r?.[attr]) problems.push(`has ${attr}`);
  }
  add(
    `role: ${APP_ROLE} owns nothing, can't create objects, no admin attributes`,
    problems.join('; ') || undefined,
  );
}

async function checkTriggers(tx: TransactionSql, add: Add): Promise<void> {
  const rows = await tx<{ tgname: string; relname: string; proname: string; tgenabled: string }[]>`
    SELECT t.tgname, c.relname, p.proname, t.tgenabled
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`;
  for (const [name, want] of Object.entries(GUARD_TRIGGERS)) {
    const t = rows.find((r) => r.tgname === name && r.relname === want.table);
    let detail: string | undefined;
    if (!t) detail = 'missing';
    else if (t.proname !== want.fn) detail = `calls ${t.proname}, expected ${want.fn}`;
    // 'O' fires in normal sessions, 'A' always; 'D' is disabled and 'R' fires only on replicas.
    else if (t.tgenabled !== 'O' && t.tgenabled !== 'A')
      detail = `not enabled (tgenabled = ${t.tgenabled})`;
    add(`triggers: ${name} on ${want.table}`, detail);
  }
}

interface Fixtures {
  agent: string;
  event: string;
  clientEventId: string;
  run: string;
  claim: string;
  span: string;
  versionApp: string;
  versionOwner: string;
  activity: string;
  modelCall: string;
}

async function insertFixtures(tx: TransactionSql): Promise<Fixtures> {
  const id = (prefix: string) => `${prefix}_a5check_${randomUUID().replaceAll('-', '')}`;
  const f: Fixtures = {
    agent: id('agt'),
    event: id('evt'),
    clientEventId: id('a5'),
    run: id('run'),
    claim: id('clm'),
    span: id('spn'),
    versionApp: id('blv'),
    versionOwner: id('blv'),
    activity: id('act'),
    modelCall: id('mcl'),
  };
  const belief = id('blf');
  await tx`INSERT INTO agents (agent_id, display_name, client_kind) VALUES (${f.agent}, 'A5 check', 'a5-check')`;
  await tx`
    INSERT INTO events (event_id, kind, role, source_client, agent_id, client_event_id, observed_at,
                        content_hash, trust_tier)
    VALUES (${f.event}, 'message', 'user', 'a5-check', ${f.agent}, ${f.clientEventId}, now(),
            sha256('a5 check'::bytea), 'user_typed')`;
  await tx`INSERT INTO event_content (event_id, body) VALUES (${f.event}, 'a5 check')`;
  await tx`
    INSERT INTO extraction_runs (run_id, event_id, extractor, model, prompt_id, prompt_hash, config_hash,
                                 input_event_ids, status)
    VALUES (${f.run}, ${f.event}, 'a5-check', 'none', 'a5-check', 'x', 'x', ARRAY[${f.event}], 'running')`;
  await tx`
    INSERT INTO claims (claim_id, event_id, extraction_run_id, text, subject_text, attribute, value,
                        value_kind, assertion_type, confidence, scope_id, sensitivity, status)
    VALUES (${f.claim}, ${f.event}, ${f.run}, 'a5 check', 'user', 'a5_check', 'a5', 'literal', 'stated',
            0.5, 'personal', 'normal', 'candidate')`;
  await tx`
    INSERT INTO evidence_spans (span_id, claim_id, event_id, span_start, span_end, quote, match_kind)
    VALUES (${f.span}, ${f.claim}, ${f.event}, 0, 2, 'a5', 'exact')`;
  await tx`
    INSERT INTO beliefs (belief_id, subject_text, subject_key, attribute, attribute_key, scope_id, sensitivity)
    VALUES (${belief}, 'user', 'user', 'a5_check', ${belief}, 'personal', 'normal')`;
  for (const version of [f.versionApp, f.versionOwner]) {
    await tx`
      INSERT INTO belief_versions (version_id, belief_id, statement, value, value_norm, value_kind, status,
                                   confidence, committed_by, scope_id, sensitivity)
      VALUES (${version}, ${belief}, 'a5 check', 'a5', 'a5', 'literal', 'active', 0.5, 'a5-check',
              'personal', 'normal')`;
  }
  await tx`INSERT INTO belief_version_claims (version_id, claim_id) VALUES (${f.versionApp}, ${f.claim})`;
  await tx`INSERT INTO activity_log (entry_id, kind, actor) VALUES (${f.activity}, 'system', 'a5-check')`;
  await tx`
    INSERT INTO model_calls (call_id, purpose, provider, model, cost_usd)
    VALUES (${f.modelCall}, 'extract', 'none', 'none', 0)`;
  return f;
}

/** The append-only tables, with a column to "change" and the row's key. */
function appendOnlyTargets(
  f: Fixtures,
): { table: string; column: string; key: string; id: string }[] {
  return [
    { table: 'events', column: 'metadata', key: 'event_id', id: f.event },
    { table: 'event_content', column: 'body', key: 'event_id', id: f.event },
    { table: 'evidence_spans', column: 'quote', key: 'span_id', id: f.span },
    { table: 'activity_log', column: 'reason', key: 'entry_id', id: f.activity },
    { table: 'belief_version_claims', column: 'relation', key: 'claim_id', id: f.claim },
    { table: 'model_calls', column: 'latency_ms', key: 'call_id', id: f.modelCall },
  ];
}

async function checkGrantLayer(tx: TransactionSql, f: Fixtures, add: Add): Promise<void> {
  for (const t of appendOnlyTargets(f)) {
    add(
      `app: UPDATE ${t.table} denied (${PERMISSION_DENIED})`,
      await expectCode(
        tx,
        'app',
        PERMISSION_DENIED,
        (q) =>
          q`UPDATE ${q(t.table)} SET ${q(t.column)} = ${q(t.column)} WHERE ${q(t.key)} = ${t.id}`,
      ),
    );
    add(
      `app: DELETE ${t.table} denied (${PERMISSION_DENIED})`,
      await expectCode(
        tx,
        'app',
        PERMISSION_DENIED,
        (q) => q`DELETE FROM ${q(t.table)} WHERE ${q(t.key)} = ${t.id}`,
      ),
    );
  }

  const truncatable: string[] = [];
  for (const table of TABLES) {
    const detail = await expectCode(tx, 'app', PERMISSION_DENIED, (q) => q`TRUNCATE ${q(table)}`);
    if (detail) truncatable.push(`${table}: ${detail}`);
  }
  add(
    `app: TRUNCATE denied on all 18 tables (${PERMISSION_DENIED})`,
    truncatable.join('; ') || undefined,
  );

  add(
    'app: closing belief_versions.expired_at succeeds once',
    await expectRows(
      tx,
      'app',
      1,
      true,
      (q) =>
        q`UPDATE belief_versions SET expired_at = now() WHERE version_id = ${f.versionApp} RETURNING 1`,
    ),
  );
  add(
    `app: a second expired_at close is blocked by the trigger (${RAISE_EXCEPTION})`,
    await expectCode(
      tx,
      'app',
      RAISE_EXCEPTION,
      (q) => q`UPDATE belief_versions SET expired_at = now() WHERE version_id = ${f.versionApp}`,
    ),
  );
  add(
    `app: UPDATE any other belief_versions column denied (${PERMISSION_DENIED})`,
    await expectCode(
      tx,
      'app',
      PERMISSION_DENIED,
      (q) =>
        q`UPDATE belief_versions SET status = 'retracted' WHERE version_id = ${f.versionOwner}`,
    ),
  );
  add(
    'app: UPDATE claims SET status succeeds',
    await expectRows(
      tx,
      'app',
      1,
      false,
      (q) =>
        q`UPDATE claims SET status = 'held', status_reason = 'a5 check' WHERE claim_id = ${f.claim} RETURNING 1`,
    ),
  );
  add(
    `app: UPDATE claims SET text denied (${PERMISSION_DENIED})`,
    await expectCode(
      tx,
      'app',
      PERMISSION_DENIED,
      (q) => q`UPDATE claims SET text = 'edited' WHERE claim_id = ${f.claim}`,
    ),
  );
  add(
    'app: INSERT into jobs succeeds (sequence grant)',
    await expectRows(
      tx,
      'app',
      1,
      false,
      (q) => q`INSERT INTO jobs (kind, ref_id) VALUES ('a5-check', ${f.event}) RETURNING job_id`,
    ),
  );
  add(
    `app: ALTER TABLE events DISABLE TRIGGER ALL denied (${PERMISSION_DENIED})`,
    await expectCode(
      tx,
      'app',
      PERMISSION_DENIED,
      (q) => q`ALTER TABLE events DISABLE TRIGGER ALL`,
    ),
  );
}

async function checkTriggerLayer(tx: TransactionSql, f: Fixtures, add: Add): Promise<void> {
  for (const t of appendOnlyTargets(f)) {
    for (const op of ['UPDATE', 'DELETE'] as const) {
      add(
        `owner: ${op} ${t.table} blocked by trigger (${RAISE_EXCEPTION})`,
        await expectCode(
          tx,
          'owner',
          RAISE_EXCEPTION,
          (q) =>
            op === 'UPDATE'
              ? q`UPDATE ${q(t.table)} SET ${q(t.column)} = ${q(t.column)} WHERE ${q(t.key)} = ${t.id}`
              : q`DELETE FROM ${q(t.table)} WHERE ${q(t.key)} = ${t.id}`,
          `table ${t.table} is append-only (${op} blocked)`,
        ),
      );
    }
  }

  add(
    `owner: claims text edit blocked (${RAISE_EXCEPTION})`,
    await expectCode(
      tx,
      'owner',
      RAISE_EXCEPTION,
      (q) => q`UPDATE claims SET text = 'edited' WHERE claim_id = ${f.claim}`,
    ),
  );
  add(
    'owner: claims status change allowed',
    await expectRows(
      tx,
      'owner',
      1,
      false,
      (q) => q`UPDATE claims SET status = 'rejected' WHERE claim_id = ${f.claim} RETURNING 1`,
    ),
  );
  add(
    `owner: DELETE claims blocked (${RAISE_EXCEPTION})`,
    await expectCode(
      tx,
      'owner',
      RAISE_EXCEPTION,
      (q) => q`DELETE FROM claims WHERE claim_id = ${f.claim}`,
    ),
  );

  add(
    `owner: belief_versions edit other than expired_at blocked (${RAISE_EXCEPTION})`,
    await expectCode(
      tx,
      'owner',
      RAISE_EXCEPTION,
      (q) =>
        q`UPDATE belief_versions SET status = 'retracted' WHERE version_id = ${f.versionOwner}`,
    ),
  );
  add(
    'owner: closing belief_versions.expired_at succeeds once',
    await expectRows(
      tx,
      'owner',
      1,
      true,
      (q) =>
        q`UPDATE belief_versions SET expired_at = now() WHERE version_id = ${f.versionOwner} RETURNING 1`,
    ),
  );
  add(
    `owner: a second expired_at close blocked (${RAISE_EXCEPTION})`,
    await expectCode(
      tx,
      'owner',
      RAISE_EXCEPTION,
      (q) => q`UPDATE belief_versions SET expired_at = now() WHERE version_id = ${f.versionOwner}`,
    ),
  );
  add(
    `owner: DELETE belief_versions blocked (${RAISE_EXCEPTION})`,
    await expectCode(
      tx,
      'owner',
      RAISE_EXCEPTION,
      (q) => q`DELETE FROM belief_versions WHERE version_id = ${f.versionOwner}`,
    ),
  );
  add(
    `owner: DELETE extraction_runs blocked (${RAISE_EXCEPTION})`,
    await expectCode(
      tx,
      'owner',
      RAISE_EXCEPTION,
      (q) => q`DELETE FROM extraction_runs WHERE run_id = ${f.run}`,
    ),
  );
}

async function checkConstraintsAndVectors(
  tx: TransactionSql,
  f: Fixtures,
  add: Add,
): Promise<void> {
  add(
    `constraint: duplicate (agent_id, client_event_id) rejected (${UNIQUE_VIOLATION})`,
    await expectCode(
      tx,
      'app',
      UNIQUE_VIOLATION,
      (q) => q`
        INSERT INTO events (event_id, kind, role, source_client, agent_id, client_event_id, observed_at,
                            content_hash, trust_tier)
        VALUES (${`${f.event}_dup`}, 'message', 'user', 'a5-check', ${f.agent}, ${f.clientEventId}, now(),
                sha256('a5 check'::bytea), 'user_typed')`,
    ),
  );

  const unit = (i: number) =>
    `[${Array.from({ length: 1536 }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;
  const query = `[1,0.1${',0'.repeat(1534)}]`;
  add(
    'vector: 1,536-dim insert and ORDER BY embedding <=> work',
    await expectStep(tx, 'app', async (q) => {
      await q`
        INSERT INTO belief_embeddings (version_id, model, embedding)
        VALUES (${f.versionApp}, 'a5-check', ${unit(0)}::vector), (${f.versionOwner}, 'a5-check', ${unit(1)}::vector)`;
      const rows = await q<{ version_id: string }[]>`
        SELECT version_id FROM belief_embeddings WHERE model = 'a5-check'
        ORDER BY embedding <=> ${query}::vector LIMIT 1`;
      if (rows[0]?.version_id !== f.versionApp)
        throw new Error('nearest neighbour is not the expected row');
    }),
  );
}

/** Runs `step` in a savepoint as `actor`, always rolled back. Returns a failure detail, or undefined. */
async function expectCode(
  tx: TransactionSql,
  actor: Actor,
  code: string,
  step: Step,
  message?: string,
): Promise<string | undefined> {
  const err = await attempt(tx, actor, step, false);
  if (err === undefined) return `expected SQLSTATE ${code}, but the statement succeeded`;
  if (!(err instanceof postgres.PostgresError))
    return `expected SQLSTATE ${code}, got ${String(err)}`;
  if (err.code !== code) return `expected SQLSTATE ${code}, got ${err.code} (${err.message})`;
  if (message !== undefined && err.message !== message)
    return `expected message "${message}", got "${err.message}"`;
  return undefined;
}

/** Runs a statement that must succeed and return `count` rows; `keep` leaves its change in place. */
async function expectRows(
  tx: TransactionSql,
  actor: Actor,
  count: number,
  keep: boolean,
  step: (sql: TransactionSql) => Promise<readonly unknown[]>,
): Promise<string | undefined> {
  let rows = -1;
  const err = await attempt(
    tx,
    actor,
    async (q) => {
      rows = (await step(q)).length;
    },
    keep,
  );
  if (err !== undefined) return `expected success, got ${describe(err)}`;
  return rows === count ? undefined : `expected ${count} row(s), got ${rows}`;
}

async function expectStep(
  tx: TransactionSql,
  actor: Actor,
  step: Step,
): Promise<string | undefined> {
  const err = await attempt(tx, actor, step, false);
  return err === undefined ? undefined : describe(err);
}

async function attempt(
  tx: TransactionSql,
  actor: Actor,
  step: Step,
  keep: boolean,
): Promise<unknown> {
  try {
    await tx.savepoint(async (sp) => {
      // SET LOCAL is undone when the savepoint rolls back; RESET covers the kept case.
      if (actor === 'app') await sp`SET LOCAL ROLE nacre_app`;
      await step(sp);
      if (actor === 'app') await sp`RESET ROLE`;
      if (!keep) throw new Rollback();
    });
    return undefined;
  } catch (err) {
    return err instanceof Rollback ? undefined : err;
  }
}

function describe(err: unknown): string {
  return err instanceof postgres.PostgresError ? `${err.code} (${err.message})` : String(err);
}
