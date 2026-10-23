// Run the A5 / grant checks against a live database and print one line per check.
// Usage: MIGRATION_DATABASE_URL=… pnpm db:verify   (an owner/admin URL; it is never printed)
// Leaves no rows behind: everything runs in one transaction that is rolled back.
import { verifySchemaGuards } from '../src/audit/schema-guards.js';
import { createSql } from '../src/shared/db/sql.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('Set MIGRATION_DATABASE_URL to an owner (admin) connection URL.');
  process.exit(2);
}

const sql = createSql(url, { max: 1 });
try {
  const results = await verifySchemaGuards(sql);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `: ${r.detail}`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} catch (err) {
  // Connection and setup errors: report the message only (postgres.js errors don't carry the URL).
  console.error(`db:verify could not run: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
} finally {
  await sql.end();
}
