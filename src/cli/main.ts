// `nacre`: operator commands. Locally `pnpm nacre …`; in the deployed image `node dist/cli/main.js …`
// (e.g. through `railway ssh --service api`).
//   nacre token create --agent <id> [--client-kind <kind>] [--note <text>] [--expires-at <iso>]
//   nacre token revoke <token_id>
//   nacre token list
//   nacre db migrate      (deploy step, as the owner: dbmate up + a `system` activity entry)
//   nacre db app-login    (deploy step, as the owner: nacre_app LOGIN from NACRE_APP_DB_PASSWORD)
import { existsSync } from 'node:fs';
import { loadDbCliConfig, loadTokenCliConfig } from '../shared/config.js';
import * as db from './db.js';
import * as token from './token.js';

const USAGE = `usage:
  nacre token create --agent <agent_id> [--client-kind <kind>] [--note <text>] [--expires-at <iso>]
  nacre token revoke <token_id>
  nacre token list
  nacre db migrate
  nacre db app-login`;

// Read .env like dbmate does (already-set variables win). The image has no .env.
if (existsSync('.env')) process.loadEnvFile('.env');

async function main(args: string[]): Promise<number> {
  const [group, command, ...rest] = args;
  if (group === 'token') {
    const config = loadTokenCliConfig();
    if (command === 'create') {
      await token.create(rest, config.DATABASE_URL, config.TOKEN_PEPPER);
      return 0;
    }
    if (command === 'revoke') return token.revoke(rest, config.DATABASE_URL);
    if (command === 'list') {
      await token.list(config.DATABASE_URL);
      return 0;
    }
  }
  if (group === 'db') {
    const config = loadDbCliConfig();
    if (command === 'migrate') {
      await db.migrate(config.MIGRATION_DATABASE_URL);
      return 0;
    }
    if (command === 'app-login') {
      await db.appLogin(config.MIGRATION_DATABASE_URL, config.NACRE_APP_DB_PASSWORD);
      return 0;
    }
  }
  console.error(USAGE);
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // Messages only: config errors name variables, never values; postgres.js errors carry no URL.
  console.error(`nacre: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = err instanceof token.UsageError ? 2 : 1;
}
