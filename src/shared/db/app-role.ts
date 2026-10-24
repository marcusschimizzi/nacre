import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Sql } from './sql.js';

const SCRAM_ITERATIONS = 4096; // Postgres's default (scram_iterations)
const SCRAM_VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 5802/7677), computed here as
 * psql's `\password` does, so only the verifier ever reaches the server: the password itself is
 * never sent, so it can't appear in a server log, `pg_stat_activity` or an error message.
 * ASCII-only, because Postgres would SASLprep anything else first.
 */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations: number = SCRAM_ITERATIONS,
): string {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new Error('use a printable-ASCII password without spaces, e.g. openssl rand -hex 32');
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Give nacre_app LOGIN with this password, as the database owner. Idempotent: run on every deploy,
 * so rotating NACRE_APP_DB_PASSWORD rotates the password. The role otherwise keeps NOLOGIN.
 */
export async function setAppLogin(ownerSql: Sql, password: string): Promise<void> {
  const verifier = scramSha256Verifier(password);
  // ALTER ROLE takes no bind parameters. The verifier is base64, digits and `$:`, checked here, so it
  // can't break out of the literal.
  if (!SCRAM_VERIFIER.test(verifier)) throw new Error('unexpected SCRAM verifier format');
  await ownerSql.unsafe(`ALTER ROLE nacre_app WITH LOGIN PASSWORD '${verifier}'`);
}
