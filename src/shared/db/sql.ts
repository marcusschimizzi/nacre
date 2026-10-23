import postgres from 'postgres';

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

/** A postgres.js client. Task 3 wires it into api and worker startup; until then only tools use it. */
export function createSql(url: string, options: postgres.Options<Record<string, never>> = {}): Sql {
  // Notices (e.g. "relation already exists, skipping") are noise for an app connection.
  return postgres(url, { onnotice: () => {}, ...options });
}
