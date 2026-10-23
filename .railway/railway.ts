// Railway Infrastructure as Code for the "Nacre" project (spec §12.1). Not applied by task 01.
//
// `railway.json` (Config as Code) is deprecated: new services can't use it, and Railway stops
// reading it on 2026-12-01. This file replaces it. Apply with:
//   railway link        # the existing "Nacre" project
//   railway config plan # review first: see the warning below
//   railway config apply
//
// WARNING: in a single-file project, resources missing from this file are planned for deletion.
// Postgres 18 + pgvector arrives in task 2, so until then a plan against the old project proposes
// deleting the old Postgres and the bucket. That matches the §12.1 reset, but only Marcus applies it.
import { defineRailway, github, preserve, project, service } from 'railway/iac';

export default defineRailway(() => {
  const source = github('marcusschimizzi/nacre', { branch: 'main' });
  const build = { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' } as const;

  const api = service('api', {
    source,
    build,
    deploy: {
      startCommand: 'node dist/api/main.js',
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

  return project('Nacre', { resources: [api, worker] });
});
