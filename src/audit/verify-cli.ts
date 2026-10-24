// Run the A5 / grant checks against a live database and print one line per check; exit 1 on any FAIL.
// Locally: `pnpm db:verify`. On Railway it runs after the migrations in api's pre-deploy step
// (`npm run db:predeploy`, compiled as dist/audit/verify-cli.js), so a deploy stops if a guard is broken.
// Needs MIGRATION_DATABASE_URL, an owner (admin) URL that is never printed. Leaves no rows behind:
// everything runs in one transaction that is rolled back (only the jobs id sequence advances).
import { createSql } from '../shared/db/sql.js';
import { verifySchemaGuards } from './schema-guards.js';

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
