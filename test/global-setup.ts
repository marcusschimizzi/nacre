import type { TestProject } from 'vitest/node';
import { dbmate, dropDatabase, scratchDatabaseName, withDatabase } from './helpers/db.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin URL of a freshly migrated database, or '' when database tests are skipped. */
    databaseUrl: string;
    /** The TEST_DATABASE_URL the run started from ('' when unset). */
    adminDatabaseUrl: string;
  }
}

// Creates one fresh database per run, migrates it with the real dbmate binary, drops it afterwards.
export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_URL ?? '';
  project.provide('adminDatabaseUrl', adminUrl);
  if (!adminUrl) {
    if (process.env.CI) {
      const message =
        'TEST_DATABASE_URL is not set. The database tests must run in CI, not be skipped.';
      // Vitest 5 mangles errors thrown from global setup while mapping their stack, so say it first.
      console.error(`\n  ${message}\n`);
      throw new Error(message);
    }
    console.warn(
      '\n  TEST_DATABASE_URL is not set: skipping the database tests.\n' +
        '  docker run -d --name nacre-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 54329:5432 pgvector/pgvector:pg18\n' +
        '  export TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres?sslmode=disable\n',
    );
    project.provide('databaseUrl', '');
    return;
  }

  const name = scratchDatabaseName('run');
  const url = withDatabase(adminUrl, name);
  await dbmate(url, 'up');
  project.provide('databaseUrl', url);
  return () => dropDatabase(adminUrl, name);
}
