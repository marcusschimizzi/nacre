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
// The database is declared here, so a plan keeps it. Renaming `nacredb` below would plan the
// database's deletion, so don't. The database stays private: nothing here or in the docs needs a
// public TCP proxy (pre-deploy and `railway ssh` both use the private network).
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
      // migrations, then run the A5 / grant checks (src/audit). Either failing stops the deploy, so
      // merging a migration runs it, and a broken append-only guard never ships.
      preDeployCommand: ['npm run db:predeploy'],
      healthcheckPath: '/healthz',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      drainingSeconds: 15,
    },
    // PORT is injected by Railway. Custom domains (api.nacre.so, app.nacre.so) are added with DNS.
    env: {
      LOG_LEVEL: 'info',
      NACRE_DEV_TOKEN: preserve(),
      // The owner URL, for migrations only. The runtime DATABASE_URL (as nacre_app) arrives with
      // task 3, after Marcus gives nacre_app a password on Railway.
      MIGRATION_DATABASE_URL: db.env.DATABASE_URL,
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
    },
  });

  return project('Nacre', { resources: [db, pitr, api, worker] });
});
