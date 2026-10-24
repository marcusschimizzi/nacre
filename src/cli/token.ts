import { parseArgs } from 'node:util';
import { createSql } from '../shared/db/sql.js';
import { ULID_PATTERN } from '../shared/ids.js';
import { createStaticToken, listTokens, revokeToken } from '../shared/tokens.js';

const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TOKEN_ID = new RegExp(`^tok_${ULID_PATTERN}$`);

export class UsageError extends Error {}

/**
 * `nacre token create --agent <id> [--client-kind <kind>] [--note <text>] [--expires-at <iso>]`.
 * stdout gets the token and nothing else (so `> file` captures exactly one line); everything a
 * human should read goes to stderr.
 */
export async function create(
  argv: string[],
  databaseUrl: string,
  pepper: string | undefined,
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'string' },
      'client-kind': { type: 'string' },
      note: { type: 'string' },
      'expires-at': { type: 'string' },
    },
    strict: true,
  });
  if (!values.agent || !AGENT_ID.test(values.agent)) {
    throw new UsageError(
      '--agent <agent_id> is required: lowercase letters, digits and dashes (e.g. claude-code)',
    );
  }
  if (!pepper) throw new UsageError('TOKEN_PEPPER must be set to create tokens');
  let expiresAt: Date | null = null;
  if (values['expires-at']) {
    expiresAt = new Date(values['expires-at']);
    if (Number.isNaN(expiresAt.getTime()))
      throw new UsageError('--expires-at must be an ISO 8601 date-time');
  }

  const sql = createSql(databaseUrl, { max: 1 });
  try {
    const created = await createStaticToken(sql, pepper, {
      agentId: values.agent,
      ...(values['client-kind'] ? { clientKind: values['client-kind'] } : {}),
      note: values.note ?? null,
      expiresAt,
    });
    process.stdout.write(`${created.token}\n`);
    console.error(
      `token_id: ${created.tokenId}\nagent: ${created.agentId}${created.agentCreated ? ' (created)' : ''}\n` +
        'This token is shown once and is not stored. Save it now.',
    );
    if (created.agentDisabled)
      console.error(
        `warning: agent ${created.agentId} is disabled, so this token will be rejected`,
      );
  } finally {
    await sql.end();
  }
}

/** `nacre token revoke <token_id>`. Exit 0 when revoked or already revoked; 1 when not found. */
export async function revoke(argv: string[], databaseUrl: string): Promise<number> {
  const [tokenId] = argv;
  if (!tokenId || !TOKEN_ID.test(tokenId))
    throw new UsageError('usage: nacre token revoke <token_id> (tok_…)');
  const sql = createSql(databaseUrl, { max: 1 });
  try {
    const result = await revokeToken(sql, tokenId);
    const messages = {
      revoked: `revoked ${tokenId}`,
      already_revoked: `${tokenId} was already revoked; nothing changed`,
      not_found: `no token ${tokenId}`,
    };
    console.error(messages[result]);
    return result === 'not_found' ? 1 : 0;
  } finally {
    await sql.end();
  }
}

/** `nacre token list`: ids, agents and dates. Never secrets or hashes. */
export async function list(databaseUrl: string): Promise<void> {
  const sql = createSql(databaseUrl, { max: 1 });
  try {
    const rows = await listTokens(sql);
    const day = (d: Date | null) => (d ? d.toISOString().replace(/\.\d+Z$/, 'Z') : '-');
    const table = [
      ['token_id', 'agent', 'kind', 'created', 'last_used', 'expires', 'revoked'],
      ...rows.map((r) => [
        r.token_id,
        r.agent_id,
        r.kind,
        day(r.created_at),
        day(r.last_used_at),
        day(r.expires_at),
        day(r.revoked_at),
      ]),
    ];
    const widths =
      table[0]?.map((_, i) => Math.max(...table.map((row) => row[i]?.length ?? 0))) ?? [];
    for (const row of table)
      console.log(
        row
          .map((cell, i) => cell.padEnd(widths[i] ?? 0))
          .join('  ')
          .trimEnd(),
      );
  } finally {
    await sql.end();
  }
}
