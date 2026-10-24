// Railway Infrastructure as Code for the "Nacre" project (spec §12.1). Only Marcus applies it
// (migrations/README.md, "Railway"); it was first applied on Oct 23, 2026.
//
// `railway.json` (Config as Code) is deprecated: new services can't use it, and Railway stops
// reading it on 2026-12-01. This file replaces it. Apply with:
//   railway link        # the existing "Nacre" project
//   railway config plan # review first: see the warning below
//   railway config apply
//
// WARNING: in a single-file project, resources missing from this file are planned for deletion.
// This file is deliberately exhaustive (decided Oct 24, 2026): declare every resource, including
// ones Railway creates itself (like the PITR bucket below), and read each plan before applying.
// Renaming `nacredb` below would plan the database's deletion, so don't. The database stays
// private: nothing here or in the docs needs a public TCP proxy (pre-deploy and `railway ssh` both
// use the private network).
//
// Secrets are `preserve()`: Marcus sets their values in the dashboard (README, "Railway steps for
// task 3" and "for task 3b", "Steps for task 5"), and preserve() keeps them but never creates one, so set them before the first deploy
// that needs them. Variables missing from this file are planned for deletion like resources.
import { bucket, database, defineRailway, github, preserve, project, service } from 'railway/iac';

export default defineRailway(() => {
  const source = github('marcusschimizzi/nacre', { branch: 'main' });
  const build = { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' } as const;

  // Postgres 18 with pgvector 0.8 (Railway's postgres-ssl:18 image installs postgresql-18-pgvector).
  // The SDK's postgres() helper uses this same image today, but only as an SDK default; naming the
  // image here keeps the major version pinned across SDK upgrades.
  const db = database('nacredb', 'postgres', {
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:18',
    output: 'DATABASE_URL',
    defaultMountPath: '/var/lib/postgresql/data',
  });
  // Point-in-time recovery archive (WAL + pgBackRest base backups) for nacredb. Railway creates it
  // when PITR is enabled in the dashboard, so the file must declare it: an undeclared bucket is
  // planned for deletion, which would destroy the backups. Name and region match what Railway made.
  const pitr = bucket('Postgres-PITR', { region: 'iad' });

  const api = service('api', {
    source,
    build,
    deploy: {
      startCommand: 'node dist/api/main.js',
      // Before each deploy, over the private network and as the database owner: apply pending
      // migrations (`nacre db migrate`, with a `system` activity entry), give nacre_app its login
      // from NACRE_APP_DB_PASSWORD, then run the A5 / grant checks (src/audit). Any failure stops
      // the deploy, so merging a migration runs it, and a broken append-only guard never ships.
      preDeployCommand: ['npm run db:predeploy'],
      healthcheckPath: '/healthz',
      healthcheckTimeout: 60,
      // Restart policy type is Railway's default (ON_FAILURE). Railway stores the default as unset,
      // so declaring it explicitly made every plan show a change that never sticks.
      restartPolicyMaxRetries: 5,
      drainingSeconds: 15,
    },
    // MCP and the HTTP API (spec §12.1). Applying this creates the domain on Railway; the CNAME and
    // TXT records it then shows go in nacre.so's DNS (Marcus). With no port the SDK targets 8080,
    // the PORT Railway injects (api logs "listening" on 8080). app.nacre.so is added with the web app.
    domains: ['api.nacre.so'],
    env: {
      LOG_LEVEL: 'info',
      // The owner URL: pre-deploy steps only (migrations, the nacre_app login, the checks).
      MIGRATION_DATABASE_URL: db.env.DATABASE_URL,
      // nacre_app's password; the pre-deploy step applies it, so rotating it rotates the login.
      NACRE_APP_DB_PASSWORD: preserve(),
      // The runtime connection, as nacre_app on nacredb's private host (references the password).
      DATABASE_URL: preserve(),
      // HMAC key for token secrets. Changing it invalidates every token.
      TOKEN_PEPPER: preserve(),
      // The OAuth issuer and /mcp resource base: https://api.nacre.so.
      PUBLIC_API_URL: preserve(),
      // argon2id hash of the owner password (`nacre owner-password hash`), checked on OAuth consent.
      OWNER_PASSWORD_HASH: preserve(),
    },
  });

  const worker = service('worker', {
    source,
    build,
    deploy: {
      startCommand: 'node dist/worker/main.js',
      restartPolicyType: 'ALWAYS',
      drainingSeconds: 15,
    },
    env: {
      LOG_LEVEL: 'info',
      // The runtime connection, as nacre_app: the reference ${{api.DATABASE_URL}}, set by Marcus.
      DATABASE_URL: preserve(),
      // OpenAI key for extraction, set by Marcus. Unset, the worker idles and claims no jobs.
      OPENAI_API_KEY: preserve(),
      // Extraction model (spec §12.3); gpt-5.6-luna is the fallback.
      LLM_MODEL: 'gpt-6-luna',
      // Daily ceiling on all paid model calls, midnight to midnight America/Chicago (spec §12.2).
      DAILY_LLM_BUDGET_USD: '0.50',
    },
  });

  return project('Nacre', { resources: [db, pitr, api, worker] });
});
