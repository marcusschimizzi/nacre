// Railway Infrastructure as Code for the "Nacre" project (spec §12.1). Not applied by tasks 01–02:
// Marcus applies it himself (migrations/README.md, "Railway steps").
//
// `railway.json` (Config as Code) is deprecated: new services can't use it, and Railway stops
// reading it on 2026-12-01. This file replaces it. Apply with:
//   railway link        # the existing "Nacre" project
//   railway config plan # review first: see the warning below
//   railway config apply
//
// WARNING: in a single-file project, resources missing from this file are planned for deletion.
// The database is declared here, so a plan keeps it. Against the old project, a plan proposes
// deleting the old Postgres and the bucket: that is the §12.1 reset, and only Marcus applies it.
// Renaming `nacredb` below would plan the database's deletion too, so don't.
import { database, defineRailway, github, preserve, project, service } from 'railway/iac';

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

  const api = service('api', {
    source,
    build,
    deploy: {
      startCommand: 'node dist/api/main.js',
      // Runs the image's migrations as the database owner before each deploy; a failure stops the
      // deploy. Once this is applied and api deploys from main, merging a migration runs it.
      preDeployCommand: ['npm run db:migrate'],
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

  return project('Nacre', { resources: [db, api, worker] });
});
